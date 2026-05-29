"""Trade-log loaders: Tradesea CSV export + manual JSON log.

Two loaders, one downstream shape:

- :func:`load_tradesea_csv` parses Tradesea's order-history CSV export. Returns
  ``(filled_trades, cancelled_orders)`` — the cancellation list feeds
  cancellation-rate analytics in the replay report.
- :func:`load_manual_log` parses a stdlib-JSON file the trader maintains by
  hand for fills that didn't land in Tradesea (mobile orders, paper sims).

Both emit :class:`TradeFill` dataclasses with timestamps converted to UTC
``int64`` nanoseconds so they join cleanly against ``event_ts_ns`` on the
trades DataFrame returned by ``core.loader``.

Tradesea-specific behaviours documented in :func:`load_tradesea_csv` and
visible via ``WARNING`` log lines:

- Reverse-chronological → sorted ascending by ``fill_ts_ns``.
- ``"CME:MNQ"`` symbol → root ``"MNQ"``.
- ``"Buy"``/``"Sell"`` → ``"buy"``/``"sell"``.
- Pacific time (``PDT`` or ``PST``) → UTC. The TZ label is sanity-checked
  against ``ZoneInfo("America/Los_Angeles")`` for the parsed date; mismatch
  warns but parsing proceeds with the date-derived offset (more reliable).
- Missing-decimal recovery for prices ≥ 6 digits with no ``.``:
  6-digit → ÷10, 7-digit → ÷100, ≥8-digit → ``None`` + ``quarantined=True``.
- Statuses other than ``"Filled"`` route to ``CancelledOrder`` (a known
  ``"Cancelled (by trader)"`` is silent; unknown statuses warn but still
  route to the cancelled list).
"""

from __future__ import annotations

import csv
import json
import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

import jsonschema

_LOG = logging.getLogger("rithmic_analytics.trade_log")

TradeSide = Literal["buy", "sell"]
OrderType = Literal["limit", "market", "stop", "stop_limit"]

_PACIFIC: ZoneInfo = ZoneInfo("America/Los_Angeles")
_NS_PER_SECOND: int = 10**9

# Schema for the manual-log JSON file. Inline rather than a sidecar resource —
# small + colocated reads better than chasing a separate file. If it grows,
# split out alongside zone_schema.json.
_MANUAL_LOG_SCHEMA: dict[str, object] = {
    "type": "object",
    "required": ["fills"],
    "properties": {
        "fills": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["fill_ts", "symbol", "side", "price", "quantity"],
                "properties": {
                    "fill_ts": {"type": "string"},
                    "symbol": {"type": "string"},
                    "side": {"enum": ["buy", "sell"]},
                    "price": {"type": "number"},
                    "quantity": {"type": "integer", "minimum": 1},
                    "order_type": {
                        "enum": ["limit", "market", "stop", "stop_limit"],
                    },
                    "fill_id": {"type": "string"},
                    "notes": {"type": "string"},
                },
                "additionalProperties": False,
            },
        },
    },
}


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TradeFill:
    """A single filled trade — produced by both loaders.

    Attributes:
        fill_ts_ns: UTC ``int64`` nanoseconds (matches ``event_ts_ns`` on the
            trades DataFrame). Used as the join key in :func:`replay_session`.
        symbol: Root symbol (``"MNQ"``), stripped of any exchange prefix.
        side: ``"buy"`` or ``"sell"`` (lowercase, matches OBS-01's
            ``aggressor_side`` convention).
        price: Tradesea's ``Avg Price`` (post-execution fill price).
        quantity: Contract count.
        order_type: ``"limit"``/``"market"``/``"stop"``/``"stop_limit"``
            (lowercase).
        fill_id: Loader-assigned ID — Tradesea CSV uses the CSV row index
            since the export carries no per-order ID; manual log allows an
            explicit ``fill_id`` field, falling back to ``"manual-{i}"``.
        notes: Free-form annotation. ``""`` when absent.
        quarantined: ``True`` when decimal-recovery failed (≥8-digit raw
            price). The price field is ``nan`` in that case; consumers
            should skip PnL on quarantined fills.
    """

    fill_ts_ns: int
    symbol: str
    side: TradeSide
    price: float
    quantity: int
    order_type: OrderType
    fill_id: str
    notes: str = ""
    quarantined: bool = False


@dataclass(frozen=True, slots=True)
class CancelledOrder:
    """A non-filled order pulled from Tradesea — for cancellation-rate analytics.

    ``intended_price`` is deliberately not collapsed — stop-limit orders carry
    both ``limit_price`` and ``stop_price``, and the right one depends on the
    consumer's question. Consumers pick whichever they need.
    """

    cancel_ts_ns: int
    symbol: str
    side: TradeSide
    order_type: OrderType
    limit_price: float | None
    stop_price: float | None
    quantity: int
    status: str  # raw status string for forward-compat with new Tradesea states
    quarantined: bool = False


# ---------------------------------------------------------------------------
# Tradesea CSV
# ---------------------------------------------------------------------------


def _parse_tradesea_time(s: str) -> int:
    """``"5/19/2026, 8:48:35 AM PDT"`` → UTC ``int64`` ns.

    ZoneInfo handles PDT/PST automatically by date. The CSV's TZ suffix is
    a sanity check: if Tradesea labels a row "PST" on a date that's actually
    PDT, we warn but trust the date-derived offset.
    """
    cleaned = s.strip().strip('"')
    if cleaned.endswith(" PDT"):
        tz_label = "PDT"
        cleaned = cleaned[: -len(" PDT")]
    elif cleaned.endswith(" PST"):
        tz_label = "PST"
        cleaned = cleaned[: -len(" PST")]
    else:
        raise ValueError(f"unrecognised Tradesea timestamp (no PDT/PST suffix): {s!r}")

    dt_naive = datetime.strptime(cleaned, "%m/%d/%Y, %I:%M:%S %p")
    dt_local = dt_naive.replace(tzinfo=_PACIFIC)

    actual_offset = dt_local.utcoffset()
    if actual_offset is not None:
        expected_label = "PST" if actual_offset.total_seconds() == -8 * 3600 else "PDT"
        if expected_label != tz_label:
            _LOG.warning(
                f"Tradesea timestamp TZ-label mismatch: row says {tz_label} but "
                f"date {dt_naive.date().isoformat()} implies {expected_label} — "
                f"trusting date-derived offset. Raw value: {s!r}"
            )

    return int(dt_local.timestamp() * _NS_PER_SECOND)


def _recover_price(raw: str, *, row_idx: int, field: str) -> tuple[float | None, bool]:
    """Parse a Tradesea price string. Returns ``(value, quarantined)``.

    Decimal-recovery rule per Q1:
        - Empty string → ``(None, False)``.
        - Contains ``"."`` → standard ``float()`` parse, no recovery.
        - 6 digits no decimal → ÷10, warn.
        - 7 digits no decimal → ÷100, warn.
        - ≥8 digits no decimal → ``(None, True)``, warn at ERROR.
    """
    s = raw.strip().strip('"')
    if not s:
        return None, False
    if "." in s:
        return float(s), False

    # No decimal — apply recovery heuristic
    if not s.lstrip("-").isdigit():
        _LOG.warning(
            f"Tradesea row {row_idx}: non-numeric {field}={s!r}; "
            f"returning None + quarantining"
        )
        return None, True

    digit_count = len(s.lstrip("-"))
    if digit_count <= 5:
        # Short ints are typically intentional whole-point prices — no recovery needed.
        return float(s), False
    if digit_count == 6:
        recovered = float(s) / 10
        _LOG.warning(
            f"Tradesea row {row_idx}: missing-decimal recovery on {field} "
            f"(6 digits, ÷10): raw={s!r} → {recovered}"
        )
        return recovered, False
    if digit_count == 7:
        recovered = float(s) / 100
        _LOG.warning(
            f"Tradesea row {row_idx}: missing-decimal recovery on {field} "
            f"(7 digits, ÷100): raw={s!r} → {recovered}"
        )
        return recovered, False
    # 8+ digits — too ambiguous; quarantine
    _LOG.error(
        f"Tradesea row {row_idx}: cannot recover decimal for {field}={s!r} "
        f"({digit_count} digits); quarantining order"
    )
    return None, True


def _normalise_side(raw: str) -> TradeSide:
    s = raw.strip().strip('"').lower()
    if s not in ("buy", "sell"):
        raise ValueError(f"unrecognised side: {raw!r}")
    return s  # type: ignore[return-value]


def _normalise_order_type(raw: str) -> OrderType:
    """``"Limit"``/``"Market"``/``"Stop"``/``"Stop Limit"`` → lowercase, underscored."""
    s = raw.strip().strip('"').lower()
    if s == "stop limit":
        return "stop_limit"
    if s in ("limit", "market", "stop"):
        return s  # type: ignore[return-value]
    raise ValueError(f"unrecognised order type: {raw!r}")


def _normalise_symbol(raw: str) -> str:
    """``"CME:MNQ"`` → ``"MNQ"``; bare ``"MNQ"`` passes through."""
    s = raw.strip().strip('"')
    if ":" in s:
        return s.split(":", 1)[1]
    return s


def load_tradesea_csv(
    path: Path,
) -> tuple[list[TradeFill], list[CancelledOrder]]:
    """Load Tradesea's order-history CSV export.

    See the module docstring for the full set of Tradesea-specific
    behaviours (TZ handling, decimal recovery, status routing).

    Args:
        path: Path to the CSV export.

    Returns:
        ``(filled_trades, cancelled_orders)`` — both lists sorted ascending
        by timestamp.

        ``filled_trades`` carries every ``Status="Filled"`` row as a
        :class:`TradeFill`. The CSV provides no per-order ID, so
        ``fill_id`` is the string ``"tradesea-{csv_row_idx}"``.

        ``cancelled_orders`` carries every non-Filled row. Known statuses
        (``"Cancelled (by trader)"``) are silent; unknown statuses log a
        ``WARNING`` but still route to this list. ``quarantined=True``
        marks rows where decimal-recovery failed.

    Raises:
        FileNotFoundError: If ``path`` does not exist.
        ValueError: If a row's ``Time``, ``Side``, or ``Order Type`` is
            unparseable. Decimal-recovery failures do NOT raise — they
            quarantine the row.

    Example:
        >>> from pathlib import Path
        >>> fills, cancels = load_tradesea_csv(Path("orders_2026-05-19.csv"))
        >>> sum(f.quantity for f in fills if f.side == "buy")
    """
    if not path.exists():
        raise FileNotFoundError(f"Tradesea CSV not found: {path}")

    fills: list[TradeFill] = []
    cancels: list[CancelledOrder] = []

    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row_idx, row in enumerate(reader, start=1):
            ts_raw = (row.get("Time") or "").strip()
            if not ts_raw:
                _LOG.warning(f"Tradesea row {row_idx}: empty Time — skipping row")
                continue

            try:
                fill_ts_ns = _parse_tradesea_time(ts_raw)
            except ValueError as exc:
                _LOG.warning(f"Tradesea row {row_idx}: {exc} — skipping row")
                continue

            try:
                side = _normalise_side(row.get("Side", ""))
                order_type = _normalise_order_type(row.get("Order Type", ""))
            except ValueError as exc:
                _LOG.warning(f"Tradesea row {row_idx}: {exc} — skipping row")
                continue

            symbol = _normalise_symbol(row.get("Symbol", ""))
            qty_raw = (row.get("Qty") or "").strip()
            try:
                quantity = int(qty_raw)
            except ValueError:
                _LOG.warning(
                    f"Tradesea row {row_idx}: non-integer Qty={qty_raw!r} — skipping row"
                )
                continue

            limit_price, lim_quar = _recover_price(
                row.get("Limit Price", ""), row_idx=row_idx, field="Limit Price"
            )
            stop_price, stop_quar = _recover_price(
                row.get("Stop Price", ""), row_idx=row_idx, field="Stop Price"
            )
            avg_price, avg_quar = _recover_price(
                row.get("Avg Price", ""), row_idx=row_idx, field="Avg Price"
            )

            status = (row.get("Status") or "").strip().strip('"')

            if status == "Filled":
                if avg_price is None:
                    # Quarantine but keep — operator may want to fix manually.
                    _LOG.error(
                        f"Tradesea row {row_idx}: Status=Filled but Avg Price "
                        f"unrecoverable; including as quarantined fill"
                    )
                    fills.append(
                        TradeFill(
                            fill_ts_ns=fill_ts_ns,
                            symbol=symbol,
                            side=side,
                            price=float("nan"),
                            quantity=quantity,
                            order_type=order_type,
                            fill_id=f"tradesea-{row_idx}",
                            notes="",
                            quarantined=True,
                        )
                    )
                else:
                    fills.append(
                        TradeFill(
                            fill_ts_ns=fill_ts_ns,
                            symbol=symbol,
                            side=side,
                            price=avg_price,
                            quantity=quantity,
                            order_type=order_type,
                            fill_id=f"tradesea-{row_idx}",
                            notes="",
                            quarantined=avg_quar,
                        )
                    )
            else:
                if status not in ("Cancelled (by trader)", "Cancelled"):
                    _LOG.warning(
                        f"Tradesea row {row_idx}: unknown status {status!r} — "
                        f"routing to cancelled list (forward-compat)"
                    )
                cancels.append(
                    CancelledOrder(
                        cancel_ts_ns=fill_ts_ns,
                        symbol=symbol,
                        side=side,
                        order_type=order_type,
                        limit_price=limit_price,
                        stop_price=stop_price,
                        quantity=quantity,
                        status=status,
                        quarantined=(lim_quar or stop_quar),
                    )
                )

    fills.sort(key=lambda f: f.fill_ts_ns)
    cancels.sort(key=lambda c: c.cancel_ts_ns)
    return fills, cancels


# ---------------------------------------------------------------------------
# Manual JSON log
# ---------------------------------------------------------------------------


def load_manual_log(path: Path) -> list[TradeFill]:
    """Load a hand-maintained JSON log of fills.

    File shape::

        {
          "fills": [
            {"fill_ts": "2026-05-19T14:32:15-04:00", "symbol": "MNQ",
             "side": "buy", "price": 27381.25, "quantity": 1,
             "order_type": "market", "fill_id": "m-001",
             "notes": "hvn reclaim"},
            ...
          ]
        }

    ISO-8601 timestamps with an explicit offset are required — naive
    timestamps would be ambiguous about the trader's local timezone.

    Args:
        path: Path to the JSON log.

    Returns:
        List of :class:`TradeFill`, sorted ascending by ``fill_ts_ns``.

    Raises:
        FileNotFoundError: If ``path`` does not exist.
        jsonschema.ValidationError: If the file doesn't match the schema.
        ValueError: If a ``fill_ts`` is not ISO-8601 with offset.
    """
    if not path.exists():
        raise FileNotFoundError(f"manual trade log not found: {path}")

    payload = json.loads(path.read_text(encoding="utf-8"))
    jsonschema.validate(payload, _MANUAL_LOG_SCHEMA)

    fills: list[TradeFill] = []
    for i, entry in enumerate(payload["fills"]):
        ts_str = entry["fill_ts"]
        dt = datetime.fromisoformat(ts_str)
        if dt.tzinfo is None:
            raise ValueError(
                f"manual log entry {i} has naive fill_ts={ts_str!r}; "
                f"include an explicit offset (e.g., -04:00)"
            )
        fill_ts_ns = int(dt.timestamp() * _NS_PER_SECOND)
        fills.append(
            TradeFill(
                fill_ts_ns=fill_ts_ns,
                symbol=str(entry["symbol"]),
                side=entry["side"],
                price=float(entry["price"]),
                quantity=int(entry["quantity"]),
                order_type=entry.get("order_type", "market"),
                fill_id=str(entry.get("fill_id", f"manual-{i}")),
                notes=str(entry.get("notes", "")),
                quarantined=False,
            )
        )

    fills.sort(key=lambda f: f.fill_ts_ns)
    return fills
