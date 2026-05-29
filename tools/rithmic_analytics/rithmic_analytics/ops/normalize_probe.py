"""Probe → OBS-01 normalization bridge — RA-029.

The live capture wrapper invokes ``capture-rithmic-probe.py`` with
``--parity-payload`` (default ON after RA-029), producing JSONL records like::

    {"stream":"LAST_TRADE", "exchange_event_ts_ns":"...", "sidecar_recv_ts_ns":"...",
     "price":27381.25, "size":1, "aggressor":"sell", "sequence":"6875892387204", ...}

The downstream :func:`load_obs01_trades` expects a different envelope shape::

    {"type":"TRADE", "session_id":"mnq-YYYY-MM-DD-rth",
     "payload":{"exchange_event_ts_ns":"...", "price":..., "quantity":...,
                "aggressor_side":"...", "trade_id":"...", ...}}

This module is the bridge. Pure transformation — no protobuf parsing, no
base64 decode, since parity records already carry the trade fields as JSON.

Stream routing:
    - ``LAST_TRADE`` → emit OBS-01 TRADE envelope.
    - ``MBO`` with ``action == "T"`` → emit OBS-01 TRADE envelope. (Today's
      probe parity normalizer doesn't emit ``action="T"`` for MBO — it only
      maps update_type ∈ {new, change, delete}. The branch exists for
      forward-compat if a future probe version, or QFA-sidecar-processed
      input, includes MBO trades.)
    - All other streams → silently dropped, counted in :class:`NormalizeReport`.

Unrecoverable-capture guard: if the first N records have ``raw_present: false``
AND no parity fields (today's 2026-05-19 file matches this), the normalizer
refuses to process — exits with a clear error rather than silently producing
empty output.

Architectural decision D-006 in ``docs/architecture.md`` documents this
bridge as the capture-pipeline step between probe-raw JSONL and analytics.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

_LOG = logging.getLogger("rithmic_analytics.normalize_probe")

_OBS01_SCHEMA_VERSION: int = 1
_RECOVERABILITY_SAMPLE_SIZE: int = 100
_REQUIRED_PARITY_FIELDS_FOR_TRADE: tuple[str, ...] = ("price", "size")
_TRADING_DAY_DIR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CAPTURE_FILENAME_RE = re.compile(
    r"^(?P<root>[A-Z][A-Z0-9]*)_(?P<session>rth|globex)\.jsonl$"
)


class UnrecoverableCaptureError(Exception):
    """Raised when input file is metadata-only (raw_present:false + no parity)."""


@dataclass(slots=True)
class NormalizeReport:
    """Per-file normalization summary.

    Attributes:
        records_read: Total non-blank lines parsed.
        trades_emitted: OBS-01 TRADE envelopes written.
        mbp1_records_emitted: MBP1 envelopes written (L1_QUOTE → MBP1).
            Always 0 when ``mbp1_out_path`` is None.
        skipped_wrong_stream: Records whose stream wasn't LAST_TRADE/MBO
            (or wasn't L1_QUOTE when MBP1 output is enabled).
        skipped_no_timestamp: ``exchange_event_ts_ns`` was null (probe
            emits these on early-session prints where Rithmic hasn't
            provided a timestamp yet). Aggregated across trade + MBP1
            normalization.
        skipped_missing_payload: Required parity fields absent on an
            MBO action=T record (defensive — unexpected for trades).
        skipped_last_trade_no_payload: Envelope-only LAST_TRADE records.
            Per the Rithmic protocol, a single ``LastTrade`` proto can
            carry a trade print (LAST_TRADE bit), running net-change,
            volume, VWAP, or any combo via ``presence_bits``. The probe
            extracts only ``trade_price/trade_size/aggressor``, so
            messages with only NET_CHANGE/VOLUME/VWAP bits arrive as
            envelope-only records and are dropped here. **Expected
            protocol behavior, not data loss** — typically 30-40% of
            LAST_TRADE records in a Globex/RTH session.
        skipped_zero_quantity: ``size == 0`` on a LAST_TRADE/MBO record.
        skipped_mbo_non_trade: MBO records with ``action != "T"``.
        skipped_l1quote_missing_quote: L1_QUOTE record with no bid/ask
            (one-sided pre-open prints; tracked separately for MBP1
            health monitoring).
        skipped_decode_error: Lines that failed ``json.loads``.
        mbp1_forward_filled: RA-041 — count of MBP1 records where at least
            one side was substituted from cached prior state (the
            steady-state delta-stream case; predicted ~99% of L1_QUOTE
            records in practice).
        mbp1_first_record_one_sided: RA-041 — count of MBP1 records where
            at least one side hit the no-cache edge (very first records
            of a session, before both sides have been quoted). Predicted
            1-5 per session; deviation >>20 is a probe-side anomaly worth
            investigating per the RA-041 sweep notes.
        session_id: Derived or supplied session ID stamped on emitted
            OBS-01 records (MBP1 records don't carry session_id).
        run_id: Stamped on emitted OBS-01 records.
    """

    records_read: int = 0
    trades_emitted: int = 0
    mbp1_records_emitted: int = 0
    mbo_records_emitted: int = 0
    skipped_wrong_stream: int = 0
    skipped_no_timestamp: int = 0
    skipped_missing_payload: int = 0
    skipped_last_trade_no_payload: int = 0
    skipped_zero_quantity: int = 0
    skipped_mbo_non_trade: int = 0
    skipped_mbo_no_sequence: int = 0
    skipped_mbo_missing_orders: int = 0
    skipped_mbo_unknown_action: int = 0
    skipped_mbo_unknown_side: int = 0
    skipped_l1quote_missing_quote: int = 0
    skipped_decode_error: int = 0
    mbp1_forward_filled: int = 0
    mbp1_first_record_one_sided: int = 0
    session_id: str = ""
    run_id: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "records_read": self.records_read,
            "trades_emitted": self.trades_emitted,
            "mbp1_records_emitted": self.mbp1_records_emitted,
            "mbo_records_emitted": self.mbo_records_emitted,
            "skipped_wrong_stream": self.skipped_wrong_stream,
            "skipped_no_timestamp": self.skipped_no_timestamp,
            "skipped_missing_payload": self.skipped_missing_payload,
            "skipped_last_trade_no_payload": self.skipped_last_trade_no_payload,
            "skipped_zero_quantity": self.skipped_zero_quantity,
            "skipped_mbo_non_trade": self.skipped_mbo_non_trade,
            "skipped_mbo_no_sequence": self.skipped_mbo_no_sequence,
            "skipped_mbo_missing_orders": self.skipped_mbo_missing_orders,
            "skipped_mbo_unknown_action": self.skipped_mbo_unknown_action,
            "skipped_mbo_unknown_side": self.skipped_mbo_unknown_side,
            "skipped_l1quote_missing_quote": self.skipped_l1quote_missing_quote,
            "skipped_decode_error": self.skipped_decode_error,
            "mbp1_forward_filled": self.mbp1_forward_filled,
            "mbp1_first_record_one_sided": self.mbp1_first_record_one_sided,
            "session_id": self.session_id,
            "run_id": self.run_id,
        }


# ---------------------------------------------------------------------------
# Path → session_id derivation
# ---------------------------------------------------------------------------


def session_id_from_path(path: Path) -> str | None:
    """Derive ``mnq-YYYY-MM-DD-rth`` from ``data/captures/YYYY-MM-DD/MNQ_rth.jsonl``.

    Returns ``None`` if the path doesn't follow the canonical layout OR
    the date component isn't a real calendar date (e.g. ``2026-13-99``).
    """
    parent_match = _TRADING_DAY_DIR_RE.match(path.parent.name)
    name_match = _CAPTURE_FILENAME_RE.match(path.name)
    if parent_match is None or name_match is None:
        return None
    # Regex matched structure; now validate it's a real date.
    try:
        date.fromisoformat(path.parent.name)
    except ValueError:
        return None
    return (
        f"{name_match.group('root').lower()}-{path.parent.name}-{name_match.group('session')}"
    )


# ---------------------------------------------------------------------------
# Per-record transformation
# ---------------------------------------------------------------------------


def _is_parity_trade_record(rec: dict[str, Any]) -> bool:
    """A parity-mode trade record has the parity fields present."""
    return all(k in rec for k in _REQUIRED_PARITY_FIELDS_FOR_TRADE)


def parity_record_to_obs01_dict(
    rec: dict[str, Any],
    *,
    session_id: str,
    run_id: str,
    counter: int,
) -> dict[str, Any] | tuple[None, str]:
    """Transform one parity-mode record into an OBS-01 TRADE envelope dict.

    Returns the dict on success, or ``(None, reason)`` when the record is
    not a trade or is missing required fields. The reason string maps to
    one of :class:`NormalizeReport`'s ``skipped_*`` counters.

    Args:
        rec: Parsed parity-mode JSON record.
        session_id: Session ID to stamp on the envelope. Required —
            ``load_obs01_trades`` reads this field.
        run_id: Stamped onto ``run_id`` and used to build ``event_id``.
        counter: Monotonic per-run trade counter for the synthetic
            ``event_id``. Pad to 12 digits to match the validated fixture.

    Returns:
        OBS-01 envelope dict, or ``(None, reason)`` tuple.
    """
    stream = rec.get("stream")
    if stream == "LAST_TRADE":
        pass  # primary path
    elif stream == "MBO":
        if rec.get("action") != "T":
            return None, "mbo_non_trade"
    else:
        return None, "wrong_stream"

    ts_raw = rec.get("exchange_event_ts_ns")
    if ts_raw is None:
        return None, "no_timestamp"
    if not _is_parity_trade_record(rec):
        # LAST_TRADE without trade_price/size is expected Rithmic protocol
        # behavior — the LastTrade proto carries non-trade auxiliary updates
        # (net_change, volume, vwap) via presence_bits the probe doesn't
        # extract. MBO action=T without payload is a real anomaly. Separate
        # counters so analyst can distinguish protocol noise from data bugs.
        if stream == "LAST_TRADE":
            return None, "last_trade_no_payload"
        return None, "missing_payload"

    size_raw = rec.get("size")
    try:
        size = int(size_raw) if size_raw is not None else 0
    except (TypeError, ValueError):
        return None, "missing_payload"
    if size <= 0:
        return None, "zero_quantity"

    price_raw = rec.get("price")
    try:
        price = float(price_raw) if price_raw is not None else None
    except (TypeError, ValueError):
        return None, "missing_payload"
    if price is None:
        return None, "missing_payload"

    # aggressor / side — probe uses "buy"/"sell" lowercase; default to "unknown"
    aggressor = rec.get("aggressor") or rec.get("side")
    if aggressor not in ("buy", "sell"):
        aggressor = "unknown"

    # trade_id: prefer sequence (Rithmic canonical), fall back to exchange_order_id
    trade_id = rec.get("sequence") or rec.get("exchange_order_id") or ""
    trade_id = str(trade_id)

    # recv timestamp — usually present; default to event_ts if absent
    recv_ts = rec.get("sidecar_recv_ts_ns") or ts_raw

    ts_str = str(ts_raw)
    return {
        "event_id": f"trade-{run_id}-{counter:012d}",
        "payload": {
            "aggressor_side": aggressor,
            "exchange_event_ts_ns": ts_str,
            "price": price,
            "quantity": size,
            "sidecar_recv_ts_ns": str(recv_ts),
            "trade_id": trade_id,
        },
        "run_id": run_id,
        "schema_version": _OBS01_SCHEMA_VERSION,
        "session_id": session_id,
        "ts_ns": ts_str,
        "type": "TRADE",
    }


def parity_l1quote_record_to_mbp1_dict(
    rec: dict[str, Any],
) -> dict[str, Any] | tuple[None, str]:
    """Transform a parity L1_QUOTE record into a databento-flat MBP1 envelope.

    Field map (parity → MBP1):
        ``exchange_event_ts_ns`` → ``ts_event_ns``
        ``sidecar_recv_ts_ns``   → ``ts_recv_ns``
        ``bid_px``               → ``bid_px_00``
        ``bid_sz``               → ``bid_sz_00``
        ``bid_orders``           → ``bid_ct_00``
        ``ask_px``               → ``ask_px_00``
        ``ask_sz``               → ``ask_sz_00``
        ``ask_orders``           → ``ask_ct_00``

    Returns the envelope dict on success, or ``(None, reason)`` on drop.
    Drop reasons (map to NormalizeReport counters):
        - ``"wrong_stream"`` — not an L1_QUOTE record.
        - ``"no_timestamp"`` — ``exchange_event_ts_ns`` null (early-prints).
        - ``"missing_quote"`` — neither bid nor ask present.

    One-sided quotes (only bid OR only ask) are emitted with the missing
    side as 0/0.0 — ``load_mbp1`` reads these as ``bid_sz_00=0`` etc.
    which downstream consumers can detect.
    """
    if rec.get("stream") != "L1_QUOTE":
        return None, "wrong_stream"

    ts_event = rec.get("exchange_event_ts_ns")
    if ts_event is None:
        return None, "no_timestamp"

    bid_px = rec.get("bid_px")
    ask_px = rec.get("ask_px")
    if bid_px is None and ask_px is None:
        return None, "missing_quote"

    # recv timestamp — default to event_ts if absent (consistent with OBS-01 path)
    ts_recv = rec.get("sidecar_recv_ts_ns") or ts_event

    # Emit zero for absent side; consumers detect one-sided via sz/px=0
    return {
        "ts_event_ns": str(ts_event),
        "ts_recv_ns": str(ts_recv),
        "bid_px_00": float(bid_px) if bid_px is not None else 0.0,
        "bid_sz_00": int(rec.get("bid_sz") or 0),
        "bid_ct_00": int(rec.get("bid_orders") or 0),
        "ask_px_00": float(ask_px) if ask_px is not None else 0.0,
        "ask_sz_00": int(rec.get("ask_sz") or 0),
        "ask_ct_00": int(rec.get("ask_orders") or 0),
    }


# ---------------------------------------------------------------------------
# RA-041: L1_QUOTE forward-fill (delta-stream → snapshot-stream conversion)
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _L1QuoteForwardFiller:
    """Maintain per-side last-known full state and forward-fill the
    unchanged side of an L1_QUOTE delta record (RA-041).

    The on-disk parity L1_QUOTE stream is delta-shaped: when only the bid
    moves, the ask fields are absent from the input JSON; the pure
    converter :func:`parity_l1quote_record_to_mbp1_dict` fills the missing
    side with ``0.0``/``0``/``0``. Before RA-041, this produced an MBP1
    sibling where ~99.8% of MNQ Globex rows were one-sided — unusable for
    absorption analytics that need both inside prices.

    This filler post-processes each pure-converter output: if a side is at
    ``0.0`` AND we have prior state for that side → substitute. Otherwise
    (very first records of a session, before both sides have been quoted)
    → emit ``None`` for the price (which JSON-serializes to ``null``; the
    loader reads as NaN; RA-040's spread filter already treats NaN as
    one-sided correctly) and leave size/count at ``0`` because the
    loader's int32 cast cannot accept NaN (RA-041 sweep decision Q-RA041-2 (a)).

    Forward-fill is **unconditional across reconnects**: a stale cache
    after a long gap is preferred over NaN, since downstream consumers
    already treat MBP1 as best-effort and stale-but-plausible depth is
    more useful than no depth (RA-041 sweep decision Q-RA041-3 (a)).
    Gap-detection + reset is a v2 candidate — if the post-shipping
    diagnostic counters reveal a real problem, add it then.

    State per side is a triple ``(px, sz, ct)``. The two diagnostic
    counters surface to :class:`NormalizeReport` so ops can verify the
    forward-fill is operating in the expected regime (~99% filled,
    1-5 first-record one-sided per session).

    Attributes:
        bid_state: Last seen ``(bid_px, bid_sz, bid_ct)`` triple, or
            ``None`` if no bid has been observed yet this session.
        ask_state: Symmetric ask counterpart.
        forward_filled_count: Records where at least one side was
            substituted from cache.
        first_record_one_sided_count: Records where at least one side
            hit the no-cache edge and was emitted as ``null``.
    """

    bid_state: tuple[float, int, int] | None = None
    ask_state: tuple[float, int, int] | None = None
    forward_filled_count: int = 0
    first_record_one_sided_count: int = 0

    def fill(self, mbp1_dict: dict[str, Any]) -> dict[str, Any]:
        """Substitute cached state for any side missing from this record.

        Mutates and returns ``mbp1_dict``. Internal counters are bumped
        by side: each record contributes at most ``+1`` to each counter
        regardless of how many sides triggered the corresponding path.
        """
        bid_px = mbp1_dict["bid_px_00"]
        ask_px = mbp1_dict["ask_px_00"]

        filled_this_record = False
        first_record_this_record = False

        # --- Bid side ---
        if bid_px == 0.0:
            if self.bid_state is not None:
                px, sz, ct = self.bid_state
                mbp1_dict["bid_px_00"] = px
                mbp1_dict["bid_sz_00"] = sz
                mbp1_dict["bid_ct_00"] = ct
                filled_this_record = True
            else:
                # No prior state — emit JSON null for the price; size/ct
                # stay at 0 so the loader's int32 cast doesn't choke.
                mbp1_dict["bid_px_00"] = None
                first_record_this_record = True
        else:
            # Fresh bid value — update cache.
            self.bid_state = (
                float(bid_px),
                int(mbp1_dict["bid_sz_00"]),
                int(mbp1_dict["bid_ct_00"]),
            )

        # --- Ask side ---
        if ask_px == 0.0:
            if self.ask_state is not None:
                px, sz, ct = self.ask_state
                mbp1_dict["ask_px_00"] = px
                mbp1_dict["ask_sz_00"] = sz
                mbp1_dict["ask_ct_00"] = ct
                filled_this_record = True
            else:
                mbp1_dict["ask_px_00"] = None
                first_record_this_record = True
        else:
            self.ask_state = (
                float(ask_px),
                int(mbp1_dict["ask_sz_00"]),
                int(mbp1_dict["ask_ct_00"]),
            )

        if filled_this_record:
            self.forward_filled_count += 1
        if first_record_this_record:
            self.first_record_one_sided_count += 1

        return mbp1_dict


# ---------------------------------------------------------------------------
# MBO routing (RA-035)
# ---------------------------------------------------------------------------


# Parity → databento-flat MBO action enum translation.
# Probe emits {"new", "change", "delete"} for update_type ∈ {1, 2, 3}.
# Databento-flat MBO uses {A=Add, M=Modify, C=Cancel, F=Fill, T=Trade}.
# F and T are forward-compat; today's probe never emits them.
_MBO_ACTION_MAP: dict[str, str] = {
    "new": "A",
    "change": "M",
    "delete": "C",
    # forward-compat passthrough for future probe schema growth
    "F": "F",
    "T": "T",
    "A": "A",
    "M": "M",
    "C": "C",
}

# Parity → databento-flat MBO side enum. "buy" → "B" (bid side), "sell" → "A" (ask side).
_MBO_SIDE_MAP: dict[str, str] = {
    "buy": "B",
    "sell": "A",
    "B": "B",
    "A": "A",
}


def _translate_mbo_action(parity_action: object) -> str | None:
    """Returns translated databento action, or ``None`` on unrecognised input."""
    if not isinstance(parity_action, str):
        return None
    return _MBO_ACTION_MAP.get(parity_action)


def _translate_mbo_side(parity_side: object) -> str | None:
    """Returns translated databento side, or ``None`` on unrecognised input."""
    if not isinstance(parity_side, str):
        return None
    return _MBO_SIDE_MAP.get(parity_side)


def parity_mbo_record_to_mbo_dicts(
    rec: dict[str, Any],
) -> list[dict[str, Any]] | tuple[None, str]:
    """Transform a parity MBO record into one-or-more databento-flat MBO rows.

    A single parity record can carry multiple orders in its ``orders`` array
    (batch updates). Each order produces one databento-flat row. Most
    records have a single order; ``orders`` may also be absent — in that
    case we use the top-level hoisted fields (per probe convention).

    Field map (parity → databento-flat MBO):
        ``exchange_event_ts_ns`` → ``ts_event_ns``
        ``sidecar_recv_ts_ns``   → ``ts_recv_ns``
        ``sequence``             → ``sequence``
        ``action`` ("new"/"change"/"delete") → ``action`` ("A"/"M"/"C")
        ``side`` ("buy"/"sell")  → ``side`` ("B"/"A")
        ``price``                → ``price`` (NaN-tolerated)
        ``size``                 → ``size``
        ``order_id``             → ``order_id``

    Returns:
        On success: a list of MBO row dicts (length ≥ 1).
        On drop: ``(None, reason)``. Reasons:
            - ``"wrong_stream"`` — not an MBO record.
            - ``"no_timestamp"`` — ``exchange_event_ts_ns`` null.
            - ``"no_sequence"`` — sequence field missing (load_mbo's int64 cast would fail).
            - ``"missing_orders"`` — neither ``orders[]`` nor top-level fields present.
            - ``"unknown_action"`` — action not in the recognised enum.
            - ``"unknown_side"`` — side not in the recognised enum.

    NaN price tolerated per ``core/loader.load_mbo`` contract.
    """
    if rec.get("stream") != "MBO":
        return None, "wrong_stream"

    ts_event = rec.get("exchange_event_ts_ns")
    if ts_event is None:
        return None, "no_timestamp"

    sequence = rec.get("sequence")
    if sequence is None:
        return None, "no_sequence"

    ts_recv = rec.get("sidecar_recv_ts_ns") or ts_event

    # Resolve order list — prefer the ``orders`` array if present, else
    # fall back to top-level hoisted fields (single order).
    orders_field = rec.get("orders")
    if isinstance(orders_field, list) and orders_field:
        orders = orders_field
    elif "action" in rec or "price" in rec or "size" in rec or "order_id" in rec:
        orders = [{
            "action": rec.get("action"),
            "side": rec.get("side"),
            "price": rec.get("price"),
            "size": rec.get("size"),
            "order_id": rec.get("order_id"),
        }]
    else:
        return None, "missing_orders"

    rows: list[dict[str, Any]] = []
    for order in orders:
        if not isinstance(order, dict):
            continue
        action = _translate_mbo_action(order.get("action"))
        if action is None:
            return None, "unknown_action"
        side = _translate_mbo_side(order.get("side"))
        if side is None:
            return None, "unknown_side"

        size_raw = order.get("size")
        try:
            size = int(size_raw) if size_raw is not None else 0
        except (TypeError, ValueError):
            return None, "unknown_action"  # malformed size → defensive drop

        price_raw = order.get("price")
        if price_raw is None:
            # MBO permits NaN price per Rithmic spec (T/C events sometimes).
            price = float("nan")
        else:
            try:
                price = float(price_raw)
            except (TypeError, ValueError):
                price = float("nan")

        order_id = str(order.get("order_id") or "")

        rows.append({
            "ts_event_ns": str(ts_event),
            "ts_recv_ns": str(ts_recv),
            "sequence": str(sequence),
            "action": action,
            "side": side,
            "price": price,
            "size": size,
            "order_id": order_id,
        })

    if not rows:
        return None, "missing_orders"
    return rows


# ---------------------------------------------------------------------------
# Whole-file normalization
# ---------------------------------------------------------------------------


def _check_recoverable(in_path: Path) -> tuple[bool, str]:
    """Sample the first N records; return ``(recoverable, reason_if_not)``.

    A capture is unrecoverable when **every** sampled record has
    ``raw_present: false`` AND lacks parity fields. That matches today's
    2026-05-19 capture exactly — metadata-only.
    """
    found_any_parity = False
    found_any_raw = False
    with in_path.open("r", encoding="utf-8") as f:
        for i, raw in enumerate(f):
            if i >= _RECOVERABILITY_SAMPLE_SIZE:
                break
            line = raw.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("raw_present") is True:
                found_any_raw = True
                break
            if "price" in rec or "size" in rec:
                # parity field present on at least one record → recoverable
                found_any_parity = True
                break
    if found_any_parity or found_any_raw:
        return True, ""
    return False, (
        "all sampled records have raw_present: false AND no parity fields "
        "(price/size). Capture was made without --parity-payload OR --raw; "
        "trade-level fields were never persisted to disk. Recapture with "
        "--parity-payload (RA-029 default) to recover."
    )


def normalize_probe_to_obs01(
    in_path: Path,
    out_path: Path,
    *,
    mbp1_out_path: Path | None = None,
    mbo_out_path: Path | None = None,
    session_id: str | None = None,
    run_id: str | None = None,
    overwrite: bool = False,
) -> NormalizeReport:
    """Normalize a probe-parity JSONL into OBS-01 (+ optional MBP1 + MBO) envelopes.

    Single-pass: walks the input once, routing each record by stream:

    - ``LAST_TRADE`` / ``MBO action=T`` → OBS-01 TRADE envelope → ``out_path``.
    - ``L1_QUOTE`` → MBP1 envelope → ``mbp1_out_path`` (if provided).
    - ``MBO`` (non-T actions) → databento-flat MBO envelope → ``mbo_out_path``
      (if provided; RA-035). Action enum translated: new→A, change→M,
      delete→C. A single parity MBO record can emit multiple rows when
      its ``orders`` array carries batch updates.
    - Everything else → dropped, counted in :class:`NormalizeReport`.

    When ``mbp1_out_path`` is None, L1_QUOTE records count as
    ``skipped_wrong_stream`` (legacy behavior). When provided, they route
    to MBP1 and increment ``mbp1_records_emitted`` instead.

    When ``mbo_out_path`` is None, MBO non-trade records count as
    ``skipped_mbo_non_trade`` (legacy behavior). When provided, they
    route to MBO and increment ``mbo_records_emitted``.

    Args:
        in_path: Source JSONL (probe-parity output).
        out_path: Destination JSONL (OBS-01 envelopes).
        mbp1_out_path: Optional destination JSONL for MBP1 envelopes
            (RA-030).
        mbo_out_path: Optional destination JSONL for MBO envelopes
            (RA-035). When supplied, MBO non-T records route there.
        session_id: Session ID to stamp on emitted OBS-01 records. If
            ``None``, derives from ``in_path`` via
            :func:`session_id_from_path`. Raises ``ValueError`` if neither
            provided nor derivable.
        run_id: ``run_id`` field on emitted OBS-01 records + ``event_id``
            prefix. Defaults to ``f"normalize-{session_id}"``.
        overwrite: Refuse to clobber existing outputs unless True.

    Returns:
        :class:`NormalizeReport`.

    Raises:
        FileNotFoundError: ``in_path`` doesn't exist.
        FileExistsError: An output path exists and ``overwrite=False``.
        UnrecoverableCaptureError: Input has no parity fields.
        ValueError: ``session_id`` not provided and not derivable.
    """
    if not in_path.exists():
        raise FileNotFoundError(f"normalize input not found: {in_path}")
    if out_path.exists() and not overwrite:
        raise FileExistsError(
            f"normalize output already exists: {out_path}. "
            f"Use overwrite=True (or --force on CLI) to replace."
        )
    if mbp1_out_path is not None and mbp1_out_path.exists() and not overwrite:
        raise FileExistsError(
            f"normalize mbp1 output already exists: {mbp1_out_path}. "
            f"Use overwrite=True (or --force on CLI) to replace."
        )
    if mbo_out_path is not None and mbo_out_path.exists() and not overwrite:
        raise FileExistsError(
            f"normalize mbo output already exists: {mbo_out_path}. "
            f"Use overwrite=True (or --force on CLI) to replace."
        )

    if session_id is None:
        session_id = session_id_from_path(in_path)
        if session_id is None:
            raise ValueError(
                f"cannot derive session_id from path {in_path}; "
                f"explicitly pass session_id=... or use the canonical "
                f"data/captures/YYYY-MM-DD/<ROOT>_<session>.jsonl layout"
            )

    if run_id is None:
        run_id = f"normalize-{session_id}"

    recoverable, reason = _check_recoverable(in_path)
    if not recoverable:
        raise UnrecoverableCaptureError(reason)

    report = NormalizeReport(session_id=session_id, run_id=run_id)
    counter = 1
    # RA-041: per-session forward-fill state. The L1_QUOTE parity stream
    # is delta-shaped (only the changed side carries its fields);
    # without this, ~99.8% of MNQ Globex MBP1 records would land
    # one-sided downstream.
    l1q_filler = _L1QuoteForwardFiller()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    mbp1_handle = None
    if mbp1_out_path is not None:
        mbp1_out_path.parent.mkdir(parents=True, exist_ok=True)
        mbp1_handle = mbp1_out_path.open("w", encoding="utf-8")
    mbo_handle = None
    if mbo_out_path is not None:
        mbo_out_path.parent.mkdir(parents=True, exist_ok=True)
        mbo_handle = mbo_out_path.open("w", encoding="utf-8")

    try:
        with in_path.open("r", encoding="utf-8") as f_in, \
                out_path.open("w", encoding="utf-8") as f_out:
            for raw in f_in:
                line = raw.strip()
                if not line:
                    continue
                report.records_read += 1
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    report.skipped_decode_error += 1
                    continue

                stream = rec.get("stream")

                # Route L1_QUOTE to MBP1 sibling when requested
                if stream == "L1_QUOTE" and mbp1_handle is not None:
                    mbp1_result = parity_l1quote_record_to_mbp1_dict(rec)
                    if isinstance(mbp1_result, tuple):
                        _, mbp1_reason = mbp1_result
                        if mbp1_reason == "no_timestamp":
                            report.skipped_no_timestamp += 1
                        elif mbp1_reason == "missing_quote":
                            report.skipped_l1quote_missing_quote += 1
                        # "wrong_stream" can't happen here (we gated on it above)
                        continue
                    # RA-041: forward-fill the unchanged side from cached
                    # prior state so the on-disk MBP1 reads as a snapshot
                    # stream rather than a delta tape.
                    mbp1_result = l1q_filler.fill(mbp1_result)
                    mbp1_handle.write(json.dumps(mbp1_result, separators=(",", ":")) + "\n")
                    report.mbp1_records_emitted += 1
                    continue

                # Route MBO non-trade actions to MBO sibling when requested.
                # MBO action=T is kept on the OBS-01 path so the trade tape
                # still gets it. Non-T actions (new/change/delete) go to MBO.
                if (
                    stream == "MBO"
                    and mbo_handle is not None
                    and rec.get("action") != "T"
                ):
                    mbo_result = parity_mbo_record_to_mbo_dicts(rec)
                    if isinstance(mbo_result, tuple):
                        _, mbo_reason = mbo_result
                        if mbo_reason == "no_timestamp":
                            report.skipped_no_timestamp += 1
                        elif mbo_reason == "no_sequence":
                            report.skipped_mbo_no_sequence += 1
                        elif mbo_reason == "missing_orders":
                            report.skipped_mbo_missing_orders += 1
                        elif mbo_reason == "unknown_action":
                            report.skipped_mbo_unknown_action += 1
                        elif mbo_reason == "unknown_side":
                            report.skipped_mbo_unknown_side += 1
                        continue
                    for row in mbo_result:
                        mbo_handle.write(json.dumps(row, separators=(",", ":")) + "\n")
                        report.mbo_records_emitted += 1
                    continue

                # OBS-01 path for everything else
                result = parity_record_to_obs01_dict(
                    rec, session_id=session_id, run_id=run_id, counter=counter,
                )
                if isinstance(result, tuple):
                    _, reason_tag = result
                    if reason_tag == "wrong_stream":
                        report.skipped_wrong_stream += 1
                    elif reason_tag == "no_timestamp":
                        report.skipped_no_timestamp += 1
                    elif reason_tag == "missing_payload":
                        report.skipped_missing_payload += 1
                    elif reason_tag == "last_trade_no_payload":
                        report.skipped_last_trade_no_payload += 1
                    elif reason_tag == "zero_quantity":
                        report.skipped_zero_quantity += 1
                    elif reason_tag == "mbo_non_trade":
                        report.skipped_mbo_non_trade += 1
                    continue

                f_out.write(json.dumps(result, separators=(",", ":")) + "\n")
                report.trades_emitted += 1
                counter += 1
    finally:
        if mbp1_handle is not None:
            mbp1_handle.close()
        if mbo_handle is not None:
            mbo_handle.close()

    # RA-041: aggregate forward-fill diagnostic counters into the report.
    report.mbp1_forward_filled = l1q_filler.forward_filled_count
    report.mbp1_first_record_one_sided = l1q_filler.first_record_one_sided_count

    sibling_clause = ""
    if mbp1_out_path is not None:
        sibling_clause += (
            f" + {report.mbp1_records_emitted} mbp1 "
            f"(ff={report.mbp1_forward_filled}, "
            f"edge={report.mbp1_first_record_one_sided})"
        )
    if mbo_out_path is not None:
        sibling_clause += f" + {report.mbo_records_emitted} mbo"
    _LOG.info(
        f"normalized {in_path.name} → {out_path.name}{sibling_clause}: "
        f"{report.trades_emitted} trades from {report.records_read} records "
        f"(dropped: {report.skipped_wrong_stream} wrong-stream, "
        f"{report.skipped_no_timestamp} no-ts, "
        f"{report.skipped_missing_payload} missing-payload, "
        f"{report.skipped_last_trade_no_payload} lt-no-payload "
        f"[expected Rithmic protocol noise], "
        f"{report.skipped_zero_quantity} zero-qty, "
        f"{report.skipped_mbo_non_trade} mbo-non-trade, "
        f"{report.skipped_mbo_no_sequence} mbo-no-seq, "
        f"{report.skipped_mbo_missing_orders} mbo-no-orders, "
        f"{report.skipped_mbo_unknown_action} mbo-unk-action, "
        f"{report.skipped_mbo_unknown_side} mbo-unk-side, "
        f"{report.skipped_l1quote_missing_quote} l1q-missing-quote, "
        f"{report.skipped_decode_error} decode-err)"
    )
    return report
