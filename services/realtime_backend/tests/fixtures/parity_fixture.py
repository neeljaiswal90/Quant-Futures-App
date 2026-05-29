"""Build a deterministic on-disk analytics fixture for the parity gate.

No parity fixture ships in the repo, so we synthesize one here using the same
raw-capture shape the real probe emits (LAST_TRADE rows + an MBO sibling). The
fixture is written into a caller-supplied tmp analytics root so it is hermetic
and leaves no residue under the owned package directory.

The detector-as-library parity gate (``tests/test_parity.py``) runs
``compute_live_signals`` over this fixture twice — once fresh, once after the
detector has persisted its JSONL — and asserts the in-process
``LiveSignals`` → contract-payload projection is byte-identical to the
projection rebuilt from the reloaded JSONL state. That is the "library output
== JSONL-path output on a fixed fixture" contract.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

PT = ZoneInfo("America/Los_Angeles")

# now_pt for the fixture session (globex active on the prior calendar day).
FIXTURE_NOW_PT = datetime(2026, 5, 21, 20, 0, tzinfo=PT)
FIXTURE_TRADING_DATE = "2026-05-22"
FIXTURE_SESSION = "globex"

_VAH = 29425.0
_VPOC = 29400.0
_VAL = 29375.0


@dataclass(frozen=True)
class ParityFixture:
    """Resolved paths + session inputs for a synthesized capture."""

    analytics_root: Path
    capture_path: Path
    zones_path: Path
    now_pt: datetime
    trading_date: str
    session: str


def _trade(ts: int, price: float, qty: int, side: str) -> dict[str, object]:
    return {
        "stream": "LAST_TRADE",
        "exchange_event_ts_ns": ts,
        "price": price,
        "size": qty,
        "aggressor": side,
    }


def _mbo(ts: int, action: str, order_id: str, size: int = 30) -> dict[str, object]:
    return {
        "event_ts_ns": ts,
        "sequence": 1,
        "action": action,
        "side": "A",
        "price": _VAH,
        "size": size,
        "order_id": order_id,
    }


def _envelope() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "symbol": "MNQ",
        "timeframe": FIXTURE_SESSION,
        "vpoc": _VPOC,
        "vah": _VAH,
        "val": _VAL,
        "atr_14": 40.0,
        "bin_size_ticks": 10,
        "zones": [],
        "reference_lines": [
            {"price": _VPOC, "text": "VPOC 29400", "source": "vpoc"},
            {"price": _VAH, "text": "VAH 29425", "source": "vah"},
            {"price": _VAL, "text": "VAL 29375", "source": "val"},
        ],
    }


def build_parity_fixture(analytics_root: Path) -> ParityFixture:
    """Write a capture (with a real sweep + iceberg) + zones into ``analytics_root``."""

    base = int(datetime(2026, 5, 21, 19, 5, tzinfo=PT).timestamp() * 1_000_000_000)
    capture_dir = analytics_root / "data" / "captures" / FIXTURE_TRADING_DATE
    capture_dir.mkdir(parents=True, exist_ok=True)
    capture_path = capture_dir / f"MNQ_{FIXTURE_SESSION}.jsonl"
    mbo_path = capture_path.with_name(f"MNQ_{FIXTURE_SESSION}.mbo.jsonl")

    rows: list[dict[str, object]] = []
    # ~50 min of baseline two-sided flow so the 60m windows are well covered.
    for i in range(95):
        ts = base + i * 30_000_000_000
        rows.append(_trade(ts, _VPOC + (i % 5) - 2, 4 + (i % 3), "buy" if i % 2 == 0 else "sell"))

    # A decisive upward sweep clearing VAH near the tail (drives a SweepEvent).
    sweep_base = base + 96 * 30_000_000_000
    for i in range(8):
        rows.append(_trade(sweep_base + i * 1_000_000_000, _VAH + i * 0.25, 80, "buy"))

    capture_path.write_text(
        "\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8"
    )

    # MBO refill/cancel cycles at the ask defending VAH (drives an IcebergEvent),
    # each followed by an aggressive trade consuming the level.
    mbo_rows: list[dict[str, object]] = []
    iceberg_base = base + 90 * 30_000_000_000
    for idx in range(3):
        add_ts = iceberg_base + idx * 5_000_000_000
        cancel_ts = add_ts + 10_000_000
        mbo_rows.append(_mbo(add_ts, "A", f"ask-{idx}"))
        mbo_rows.append(_mbo(cancel_ts, "C", f"ask-{idx}"))
        rows.append(_trade(cancel_ts + 20_000_000, _VAH, 30, "buy"))
    # Re-write capture so the iceberg-consuming trades are present too.
    capture_path.write_text(
        "\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8"
    )
    mbo_path.write_text(
        "\n".join(json.dumps(r) for r in mbo_rows) + "\n", encoding="utf-8"
    )

    zones_dir = analytics_root / "data" / "zones"
    zones_dir.mkdir(parents=True, exist_ok=True)
    zones_path = zones_dir / f"{FIXTURE_TRADING_DATE}_MNQ_{FIXTURE_SESSION}.json"
    zones_path.write_text(json.dumps(_envelope()), encoding="utf-8")

    return ParityFixture(
        analytics_root=analytics_root,
        capture_path=capture_path,
        zones_path=zones_path,
        now_pt=FIXTURE_NOW_PT,
        trading_date=FIXTURE_TRADING_DATE,
        session=FIXTURE_SESSION,
    )


def envelope() -> dict[str, Any]:
    """Expose the fixture envelope (used by snapshot tests)."""
    return _envelope()
