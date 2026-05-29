"""Tests for ``rithmic_analytics.core.trade_log`` (RA-026)."""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import jsonschema
import pytest

from rithmic_analytics.core.trade_log import (
    CancelledOrder,
    TradeFill,
    load_manual_log,
    load_tradesea_csv,
)

_PACIFIC = ZoneInfo("America/Los_Angeles")
_NS_PER_SECOND = 10**9


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _expected_ns(month: int, day: int, year: int, hour: int, minute: int, second: int) -> int:
    """Build the expected UTC ns for a Pacific-local datetime."""
    dt = datetime(year, month, day, hour, minute, second, tzinfo=_PACIFIC)
    return int(dt.timestamp() * _NS_PER_SECOND)


def _write_tradesea_csv(path: Path, rows: list[dict[str, str]]) -> None:
    """Write a Tradesea-shaped CSV with the canonical header row."""
    header = (
        '"Time","Symbol","Qty","Side","Order Type","Limit Price","Stop Price",'
        '"Avg Price","Commission","Status"'
    )
    lines = [header]
    for r in rows:
        lines.append(
            ",".join(
                [
                    f'"{r["time"]}"',
                    f'"{r["symbol"]}"',
                    str(r["qty"]),
                    f'"{r["side"]}"',
                    f'"{r["order_type"]}"',
                    str(r.get("limit_price", "")),
                    str(r.get("stop_price", "")),
                    str(r.get("avg_price", "")),
                    str(r.get("commission", "")),
                    f'"{r["status"]}"',
                ]
            )
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Tradesea CSV — happy path
# ---------------------------------------------------------------------------


def test_load_tradesea_csv_happy_path(tmp_path: Path) -> None:
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "5/19/2026, 8:48:35 AM PDT",
                "symbol": "CME:MNQ",
                "qty": "1",
                "side": "Buy",
                "order_type": "Market",
                "avg_price": "27381.25",
                "commission": "0.50",
                "status": "Filled",
            }
        ],
    )

    fills, cancels = load_tradesea_csv(csv)

    assert len(fills) == 1
    assert len(cancels) == 0
    f = fills[0]
    assert f.symbol == "MNQ"
    assert f.side == "buy"
    assert f.order_type == "market"
    assert f.price == 27381.25
    assert f.quantity == 1
    assert f.fill_ts_ns == _expected_ns(5, 19, 2026, 8, 48, 35)
    assert f.fill_id == "tradesea-1"
    assert f.quarantined is False


def test_load_tradesea_csv_reverse_chronological_sorts_ascending(tmp_path: Path) -> None:
    """Tradesea emits newest-first; loader must sort ascending."""
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            # Newest first (Tradesea's actual ordering)
            {
                "time": "5/19/2026, 10:00:00 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Sell",
                "order_type": "Market", "avg_price": "27400.00",
                "status": "Filled",
            },
            {
                "time": "5/19/2026, 8:48:35 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Market", "avg_price": "27381.25",
                "status": "Filled",
            },
        ],
    )

    fills, _ = load_tradesea_csv(csv)

    assert len(fills) == 2
    assert fills[0].fill_ts_ns < fills[1].fill_ts_ns
    assert fills[0].side == "buy"
    assert fills[1].side == "sell"


def test_load_tradesea_csv_symbol_strips_cme_prefix(tmp_path: Path) -> None:
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "5/19/2026, 8:00:00 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Market", "avg_price": "27000.00",
                "status": "Filled",
            }
        ],
    )

    fills, _ = load_tradesea_csv(csv)
    assert fills[0].symbol == "MNQ"


def test_load_tradesea_csv_handles_bare_symbol_without_prefix(tmp_path: Path) -> None:
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "5/19/2026, 8:00:00 AM PDT",
                "symbol": "MNQ", "qty": "1", "side": "Buy",
                "order_type": "Market", "avg_price": "27000.00",
                "status": "Filled",
            }
        ],
    )

    fills, _ = load_tradesea_csv(csv)
    assert fills[0].symbol == "MNQ"


# ---------------------------------------------------------------------------
# Tradesea CSV — filled vs cancelled routing
# ---------------------------------------------------------------------------


def test_load_tradesea_csv_filtered_filled_and_cancelled_routing(tmp_path: Path) -> None:
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "5/19/2026, 8:00:00 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Limit", "limit_price": "27380.00",
                "avg_price": "27380.00", "status": "Filled",
            },
            {
                "time": "5/19/2026, 8:15:00 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Sell",
                "order_type": "Limit", "limit_price": "27420.00",
                "avg_price": "", "status": "Cancelled (by trader)",
            },
        ],
    )

    fills, cancels = load_tradesea_csv(csv)

    assert len(fills) == 1
    assert len(cancels) == 1
    assert cancels[0].status == "Cancelled (by trader)"
    assert cancels[0].limit_price == 27420.00
    assert cancels[0].stop_price is None


def test_load_tradesea_csv_unknown_status_warns_but_routes_to_cancelled(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "5/19/2026, 8:00:00 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Limit", "limit_price": "27380.00",
                "status": "Expired",  # Hypothetical future Tradesea status
            }
        ],
    )

    with caplog.at_level(logging.WARNING, logger="rithmic_analytics.trade_log"):
        fills, cancels = load_tradesea_csv(csv)

    assert len(fills) == 0
    assert len(cancels) == 1
    assert cancels[0].status == "Expired"
    assert any("unknown status" in r.message for r in caplog.records)


def test_load_tradesea_csv_stop_limit_order_type(tmp_path: Path) -> None:
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "5/19/2026, 8:00:00 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Stop Limit",
                "limit_price": "27400.00", "stop_price": "27395.00",
                "status": "Cancelled (by trader)",
            }
        ],
    )

    _, cancels = load_tradesea_csv(csv)
    assert cancels[0].order_type == "stop_limit"
    assert cancels[0].limit_price == 27400.00
    assert cancels[0].stop_price == 27395.00


# ---------------------------------------------------------------------------
# Tradesea CSV — decimal recovery
# ---------------------------------------------------------------------------


def test_load_tradesea_csv_decimal_recovery_6_digits(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """6-digit raw → divide by 10."""
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "5/19/2026, 8:00:00 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Stop", "stop_price": "288760",
                "status": "Cancelled (by trader)",
            }
        ],
    )

    with caplog.at_level(logging.WARNING, logger="rithmic_analytics.trade_log"):
        _, cancels = load_tradesea_csv(csv)

    assert cancels[0].stop_price == 28876.0
    assert cancels[0].quarantined is False
    assert any("÷10" in r.message for r in caplog.records)


def test_load_tradesea_csv_decimal_recovery_7_digits(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """7-digit raw → divide by 100."""
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "5/19/2026, 8:00:00 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Stop", "stop_price": "2887625",
                "status": "Cancelled (by trader)",
            }
        ],
    )

    with caplog.at_level(logging.WARNING, logger="rithmic_analytics.trade_log"):
        _, cancels = load_tradesea_csv(csv)

    assert cancels[0].stop_price == 28876.25
    assert cancels[0].quarantined is False
    assert any("÷100" in r.message for r in caplog.records)


def test_load_tradesea_csv_decimal_recovery_8_digits_quarantines(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """8+ digit raw → None + quarantined=True."""
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "5/19/2026, 8:00:00 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Stop", "stop_price": "28876250",
                "status": "Cancelled (by trader)",
            }
        ],
    )

    with caplog.at_level(logging.ERROR, logger="rithmic_analytics.trade_log"):
        _, cancels = load_tradesea_csv(csv)

    assert cancels[0].stop_price is None
    assert cancels[0].quarantined is True
    assert any("cannot recover" in r.message for r in caplog.records)


def test_load_tradesea_csv_short_integer_price_no_recovery(tmp_path: Path) -> None:
    """5-digit no-decimal → treated as whole-point price, no recovery applied."""
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "5/19/2026, 8:00:00 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Stop", "stop_price": "28876",
                "status": "Cancelled (by trader)",
            }
        ],
    )

    _, cancels = load_tradesea_csv(csv)
    assert cancels[0].stop_price == 28876.0
    assert cancels[0].quarantined is False


def test_load_tradesea_csv_filled_with_unrecoverable_avg_price_quarantines(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Filled order with 8-digit Avg Price → kept as quarantined fill (nan price)."""
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "5/19/2026, 8:00:00 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Market", "avg_price": "28876250",
                "status": "Filled",
            }
        ],
    )

    with caplog.at_level(logging.ERROR, logger="rithmic_analytics.trade_log"):
        fills, _ = load_tradesea_csv(csv)

    assert len(fills) == 1
    assert fills[0].quarantined is True
    import math
    assert math.isnan(fills[0].price)


# ---------------------------------------------------------------------------
# Tradesea CSV — timezone handling
# ---------------------------------------------------------------------------


def test_load_tradesea_csv_pdt_timestamp(tmp_path: Path) -> None:
    """PDT summer date → UTC offset -7."""
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "7/15/2026, 10:00:00 AM PDT",  # July → DST active
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Market", "avg_price": "27000.00",
                "status": "Filled",
            }
        ],
    )

    fills, _ = load_tradesea_csv(csv)
    # 10:00 PDT = 17:00 UTC
    expected = datetime(2026, 7, 15, 17, 0, 0, tzinfo=ZoneInfo("UTC"))
    assert fills[0].fill_ts_ns == int(expected.timestamp() * _NS_PER_SECOND)


def test_load_tradesea_csv_pst_timestamp(tmp_path: Path) -> None:
    """PST winter date → UTC offset -8."""
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "1/15/2026, 10:00:00 AM PST",  # January → standard time
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Market", "avg_price": "27000.00",
                "status": "Filled",
            }
        ],
    )

    fills, _ = load_tradesea_csv(csv)
    # 10:00 PST = 18:00 UTC
    expected = datetime(2026, 1, 15, 18, 0, 0, tzinfo=ZoneInfo("UTC"))
    assert fills[0].fill_ts_ns == int(expected.timestamp() * _NS_PER_SECOND)


def test_load_tradesea_csv_tz_label_mismatch_warns(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Row labeled PST on a PDT date → warning logged, parsed with date offset."""
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "7/15/2026, 10:00:00 AM PST",  # July labeled PST = bug
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Market", "avg_price": "27000.00",
                "status": "Filled",
            }
        ],
    )

    with caplog.at_level(logging.WARNING, logger="rithmic_analytics.trade_log"):
        fills, _ = load_tradesea_csv(csv)

    assert len(fills) == 1
    assert any("TZ-label mismatch" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# Tradesea CSV — error handling
# ---------------------------------------------------------------------------


def test_load_tradesea_csv_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_tradesea_csv(tmp_path / "does_not_exist.csv")


def test_load_tradesea_csv_empty_file_returns_empty_lists(tmp_path: Path) -> None:
    """Empty CSV (just header, no rows) → ([], [])."""
    csv = tmp_path / "orders.csv"
    csv.write_text(
        '"Time","Symbol","Qty","Side","Order Type","Limit Price",'
        '"Stop Price","Avg Price","Commission","Status"\n',
        encoding="utf-8",
    )

    fills, cancels = load_tradesea_csv(csv)
    assert fills == []
    assert cancels == []


def test_load_tradesea_csv_bad_row_skips_without_crashing(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """One bad row (unrecognised side) skipped; valid rows still load."""
    csv = tmp_path / "orders.csv"
    _write_tradesea_csv(
        csv,
        [
            {
                "time": "5/19/2026, 8:00:00 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Hodl",
                "order_type": "Market", "avg_price": "27000.00",
                "status": "Filled",
            },
            {
                "time": "5/19/2026, 9:00:00 AM PDT",
                "symbol": "CME:MNQ", "qty": "1", "side": "Buy",
                "order_type": "Market", "avg_price": "27100.00",
                "status": "Filled",
            },
        ],
    )

    with caplog.at_level(logging.WARNING, logger="rithmic_analytics.trade_log"):
        fills, _ = load_tradesea_csv(csv)

    assert len(fills) == 1
    assert fills[0].price == 27100.00


# ---------------------------------------------------------------------------
# Manual JSON log
# ---------------------------------------------------------------------------


def test_load_manual_log_happy_path(tmp_path: Path) -> None:
    log = tmp_path / "fills.json"
    log.write_text(
        json.dumps({
            "fills": [
                {
                    "fill_ts": "2026-05-19T08:48:35-07:00",
                    "symbol": "MNQ", "side": "buy", "price": 27381.25,
                    "quantity": 1, "order_type": "market",
                    "fill_id": "m-001", "notes": "hvn reclaim",
                }
            ]
        }),
        encoding="utf-8",
    )

    fills = load_manual_log(log)

    assert len(fills) == 1
    f = fills[0]
    assert f.symbol == "MNQ"
    assert f.side == "buy"
    assert f.price == 27381.25
    assert f.quantity == 1
    assert f.order_type == "market"
    assert f.fill_id == "m-001"
    assert f.notes == "hvn reclaim"
    # 08:48:35 -07:00 = 15:48:35 UTC
    expected = datetime(2026, 5, 19, 15, 48, 35, tzinfo=ZoneInfo("UTC"))
    assert f.fill_ts_ns == int(expected.timestamp() * _NS_PER_SECOND)


def test_load_manual_log_sorts_ascending(tmp_path: Path) -> None:
    log = tmp_path / "fills.json"
    log.write_text(
        json.dumps({
            "fills": [
                {"fill_ts": "2026-05-19T10:00:00-07:00", "symbol": "MNQ",
                 "side": "sell", "price": 27400.0, "quantity": 1},
                {"fill_ts": "2026-05-19T08:00:00-07:00", "symbol": "MNQ",
                 "side": "buy", "price": 27380.0, "quantity": 1},
            ]
        }),
        encoding="utf-8",
    )

    fills = load_manual_log(log)
    assert fills[0].side == "buy"
    assert fills[1].side == "sell"
    assert fills[0].fill_ts_ns < fills[1].fill_ts_ns


def test_load_manual_log_naive_timestamp_raises(tmp_path: Path) -> None:
    log = tmp_path / "fills.json"
    log.write_text(
        json.dumps({
            "fills": [
                {"fill_ts": "2026-05-19T08:48:35", "symbol": "MNQ",
                 "side": "buy", "price": 27381.25, "quantity": 1}
            ]
        }),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="naive fill_ts"):
        load_manual_log(log)


def test_load_manual_log_invalid_schema_raises(tmp_path: Path) -> None:
    log = tmp_path / "fills.json"
    log.write_text(
        json.dumps({
            "fills": [
                {"fill_ts": "2026-05-19T08:00:00-07:00", "symbol": "MNQ",
                 "side": "buy"}  # missing price + quantity
            ]
        }),
        encoding="utf-8",
    )

    with pytest.raises(jsonschema.ValidationError):
        load_manual_log(log)


def test_load_manual_log_empty_fills_returns_empty_list(tmp_path: Path) -> None:
    log = tmp_path / "fills.json"
    log.write_text(json.dumps({"fills": []}), encoding="utf-8")
    assert load_manual_log(log) == []


def test_load_manual_log_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_manual_log(tmp_path / "does_not_exist.json")


def test_load_manual_log_defaults_order_type_and_fill_id(tmp_path: Path) -> None:
    """Optional fields fall back to defaults."""
    log = tmp_path / "fills.json"
    log.write_text(
        json.dumps({
            "fills": [
                {"fill_ts": "2026-05-19T08:00:00-07:00", "symbol": "MNQ",
                 "side": "buy", "price": 27380.0, "quantity": 1},
            ]
        }),
        encoding="utf-8",
    )

    fills = load_manual_log(log)
    assert fills[0].order_type == "market"
    assert fills[0].fill_id == "manual-0"
    assert fills[0].notes == ""


# ---------------------------------------------------------------------------
# Dataclass invariants
# ---------------------------------------------------------------------------


def test_trade_fill_is_frozen() -> None:
    import dataclasses
    f = TradeFill(
        fill_ts_ns=0, symbol="MNQ", side="buy", price=1.0,
        quantity=1, order_type="market", fill_id="x",
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        f.price = 2.0  # type: ignore[misc]


def test_cancelled_order_is_frozen() -> None:
    import dataclasses
    c = CancelledOrder(
        cancel_ts_ns=0, symbol="MNQ", side="buy", order_type="limit",
        limit_price=1.0, stop_price=None, quantity=1, status="Cancelled",
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        c.status = "Filled"  # type: ignore[misc]
