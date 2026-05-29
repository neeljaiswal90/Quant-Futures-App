"""Test bootstrap + shared fixture helpers for the RA-060 backend.

Puts both ``services/`` (so ``import realtime_backend``) and the repo root (so
``import contracts.realtime``) on ``sys.path``, regardless of where pytest is
invoked from. ``rithmic_dashboard`` is installed editable so it needs no help.

The trade/MBO/envelope helpers mirror
``tools/rithmic_dashboard/tests/{conftest,test_live_signals}.py`` so the
synthesized parity fixture exercises the real detectors.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest

_SERVICES_DIR = Path(__file__).resolve().parents[2]
_REPO_ROOT = _SERVICES_DIR.parent
for _p in (str(_SERVICES_DIR), str(_REPO_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

PT = ZoneInfo("America/Los_Angeles")


def write_raw(path: Path, rows: list[dict[str, object]]) -> None:
    """Write JSONL rows to ``path`` (mirrors rithmic_dashboard test helper)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def trade(ts: int, price: float, qty: int, side: str = "buy") -> dict[str, object]:
    """One LAST_TRADE raw capture row."""
    return {
        "stream": "LAST_TRADE",
        "exchange_event_ts_ns": ts,
        "price": price,
        "size": qty,
        "aggressor": side,
    }


def mbo(ts: int, action: str, order_id: str, size: int = 30, price: float = 29425.0) -> dict[str, object]:
    """One MBO order-lifecycle raw row."""
    return {
        "event_ts_ns": ts,
        "sequence": 1,
        "action": action,
        "side": "A",
        "price": price,
        "size": size,
        "order_id": order_id,
    }


def sample_envelope() -> dict[str, Any]:
    """Analytics envelope with VPOC/VAH/VAL reference lines for sweep levels."""
    return {
        "schema_version": 1,
        "symbol": "MNQ",
        "timeframe": "globex",
        "vpoc": 29400.0,
        "vah": 29425.0,
        "val": 29375.0,
        "atr_14": 40.0,
        "bin_size_ticks": 10,
        "zones": [],
        "reference_lines": [
            {"price": 29400.0, "text": "VPOC 29400", "source": "vpoc"},
            {"price": 29425.0, "text": "VAH 29425", "source": "vah"},
            {"price": 29375.0, "text": "VAL 29375", "source": "val"},
        ],
    }


@pytest.fixture
def base_ns() -> int:
    """A globex-session ns timestamp consistent with now_pt 2026-05-21 20:00."""
    return int(datetime(2026, 5, 21, 19, 5, tzinfo=PT).timestamp() * 1_000_000_000)


@pytest.fixture
def now_pt() -> datetime:
    return datetime(2026, 5, 21, 20, 0, tzinfo=PT)
