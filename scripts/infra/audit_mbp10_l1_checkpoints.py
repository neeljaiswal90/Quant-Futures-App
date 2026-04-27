"""Disk-backed MBP10 vs reconstructed L1 BBO checkpoint audit.

This script is intentionally narrower than audit-rithmic-mbp10-extraction.ts. It
answers the full-probe trust question without keeping millions of records in Node
heap: reconstruct Rithmic L1 BBO checkpoints, reconstruct MBP10 book state in
exchange-time order, and compare the MBP10 top of book at each L1 checkpoint.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Literal

SCHEMA_VERSION = 1
TICKET_ID = "DATA-PARITY-04E"
DEFAULT_TICK_SIZE = 0.25
DEFAULT_TRUSTED_PCT = 99.0
DEFAULT_MISMATCH_LIMIT = 50
EVENT_INSERT_BATCH_SIZE = 10_000

BookSide = Literal["bid", "ask"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Audit MBP10 extraction against reconstructed Rithmic L1 BBO checkpoints."
    )
    parser.add_argument("--probe", required=True, help="Rich Rithmic probe JSONL")
    parser.add_argument("--out", required=True, help="Report JSON output path")
    parser.add_argument("--work-db", help="Optional sqlite work DB path")
    parser.add_argument("--keep-work-db", action="store_true", help="Keep sqlite work DB after the run")
    parser.add_argument("--tick-size", type=float, default=DEFAULT_TICK_SIZE)
    parser.add_argument("--trusted-pct", type=float, default=DEFAULT_TRUSTED_PCT)
    parser.add_argument("--mismatch-limit", type=int, default=DEFAULT_MISMATCH_LIMIT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = audit_checkpoint_parity(
        probe_path=Path(args.probe),
        out_path=Path(args.out),
        work_db_path=Path(args.work_db) if args.work_db else None,
        keep_work_db=bool(args.keep_work_db),
        tick_size=float(args.tick_size),
        trusted_pct=float(args.trusted_pct),
        mismatch_limit=int(args.mismatch_limit),
    )
    print(
        "\n".join(
            [
                f"MBP10 reconstructed L1 checkpoint audit: {report['status']}",
                f"mbp10_extraction_trusted={str(report['mbp10_extraction_trusted']).lower()}",
                f"classification={report['classification']}",
                f"l1_checkpoints={report['l1_checkpoint_count']}",
                f"compared_checkpoints={report['parity']['compared_checkpoint_count']}",
                f"within_1_tick_pct={report['parity']['within_1_tick_pct']}",
                "DATA-01B remains blocked.",
            ]
        )
    )
    return 0 if report["status"] == "analysis_only" else 2


def audit_checkpoint_parity(
    *,
    probe_path: Path,
    out_path: Path,
    work_db_path: Path | None,
    keep_work_db: bool,
    tick_size: float,
    trusted_pct: float,
    mismatch_limit: int,
) -> dict[str, Any]:
    if not probe_path.exists():
        raise SystemExit(f"Missing probe: {probe_path}")

    db_path = work_db_path or out_path.with_suffix(".sqlite")
    if db_path.exists():
        db_path.unlink()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(str(db_path))
    try:
        setup_db(connection)
        parse_report = load_probe_events(connection, probe_path)
        parity = compare_checkpoint_parity(connection, tick_size=tick_size, mismatch_limit=mismatch_limit)
    finally:
        connection.close()
        if not keep_work_db and db_path.exists():
            db_path.unlink()

    within_pct = parity["within_1_tick_pct"]
    trusted = within_pct is not None and within_pct >= trusted_pct and parity["compared_checkpoint_count"] > 0
    classification = "state_stream_incremental_valid" if trusted else "extraction_bug_suspected"
    report = {
        "schema_version": SCHEMA_VERSION,
        "ticket_id": TICKET_ID,
        "status": "analysis_only" if trusted else "fail",
        "data01_status": "blocked",
        "data01b_eligible": False,
        "mbp10_extraction_trusted": trusted,
        "classification": classification,
        "comparison_rule": "exchange_ordered_mbp10_state_at_reconstructed_l1_bbo_checkpoints",
        "inputs": {
            "probe_path": str(probe_path.resolve()),
            "tick_size": tick_size,
            "trusted_within_1_tick_pct": trusted_pct,
        },
        **parse_report,
        "parity": parity,
        "recommendation": (
            "proceed_to_databento_mbp10_parity_only_after_internal_rithmic_l1_mbp10_parity_passes"
            if trusted
            else "inspect_rithmic_l1_mbp10_checkpoint_mismatches"
        ),
        "notes": [
            "This audit is offline evidence only and never unblocks DATA-01B by itself.",
            "L1_QUOTE checkpoints are reconstructed from side-specific bid/ask updates before comparison.",
            "MBP10/MBO Databento parity is still required before DATA-01B can proceed.",
        ],
    }
    out_path.write_text(json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    return report


def setup_db(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA journal_mode=OFF")
    connection.execute("PRAGMA synchronous=OFF")
    connection.execute("PRAGMA temp_store=FILE")
    connection.execute(
        """
        CREATE TABLE events (
          ts_ns INTEGER NOT NULL,
          event_order INTEGER NOT NULL,
          record_index INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL
        )
        """
    )
    connection.execute("CREATE INDEX events_order_idx ON events(ts_ns, event_order, record_index)")
    connection.commit()


def load_probe_events(connection: sqlite3.Connection, probe_path: Path) -> dict[str, Any]:
    total_rows = 0
    l1_rows = 0
    l1_rows_with_exchange_ts = 0
    l1_warming_rows = 0
    l1_checkpoint_count = 0
    mbp10_rows = 0
    mbp10_null_exchange_ts_rows = 0
    mbp10_timestamped_rows = 0
    mbp10_rows_with_bids = 0
    mbp10_rows_with_asks = 0
    mbp10_rows_with_both_sides = 0
    mbp10_rows_with_one_side_only = 0
    mbp10_timestamped_rows_with_levels = 0

    l1_bid: dict[str, float | int | None] | None = None
    l1_ask: dict[str, float | int | None] | None = None
    batch: list[tuple[int, int, int, str, str]] = []

    with probe_path.open("r", encoding="utf-8", errors="replace") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            total_rows += 1
            row = json.loads(line)
            if not isinstance(row, dict):
                continue
            stream = str(row.get("stream") or row.get("stream_id") or "")

            if stream == "L1_QUOTE":
                l1_rows += 1
                ts_ns = decimal_ns(row.get("exchange_event_ts_ns"))
                if ts_ns is None:
                    continue
                l1_rows_with_exchange_ts += 1
                bid_update = quote_side_update(row, "bid")
                ask_update = quote_side_update(row, "ask")
                if bid_update is not None:
                    l1_bid = None if non_positive_size(bid_update.get("sz")) else bid_update
                if ask_update is not None:
                    l1_ask = None if non_positive_size(ask_update.get("sz")) else ask_update
                if bid_update is None and ask_update is None:
                    l1_warming_rows += 1
                    continue
                if l1_bid is None or l1_ask is None:
                    l1_warming_rows += 1
                    continue
                l1_checkpoint_count += 1
                add_event(
                    batch,
                    ts_ns=ts_ns,
                    event_order=1,
                    record_index=line_number,
                    kind="L1",
                    payload={
                        "bid_px": l1_bid["px"],
                        "ask_px": l1_ask["px"],
                        "bid_sz": l1_bid.get("sz"),
                        "ask_sz": l1_ask.get("sz"),
                    },
                )
            elif stream == "MBP10":
                mbp10_rows += 1
                ts_ns = decimal_ns(row.get("exchange_event_ts_ns"))
                bids = normalize_levels(row.get("bids"))
                asks = normalize_levels(row.get("asks"))
                has_bids = len(bids) > 0
                has_asks = len(asks) > 0
                if ts_ns is None:
                    mbp10_null_exchange_ts_rows += 1
                    continue
                mbp10_timestamped_rows += 1
                if has_bids:
                    mbp10_rows_with_bids += 1
                if has_asks:
                    mbp10_rows_with_asks += 1
                if has_bids and has_asks:
                    mbp10_rows_with_both_sides += 1
                if (has_bids or has_asks) and not (has_bids and has_asks):
                    mbp10_rows_with_one_side_only += 1
                if not has_bids and not has_asks:
                    continue
                mbp10_timestamped_rows_with_levels += 1
                add_event(
                    batch,
                    ts_ns=ts_ns,
                    event_order=0,
                    record_index=line_number,
                    kind="MBP10",
                    payload={"bids": bids, "asks": asks},
                )

            if len(batch) >= EVENT_INSERT_BATCH_SIZE:
                flush_events(connection, batch)

    flush_events(connection, batch)
    return {
        "probe_parsing": {
            "total_rows": total_rows,
            "l1_quote_rows": l1_rows,
            "l1_quote_rows_with_exchange_ts": l1_rows_with_exchange_ts,
            "l1_quote_reconstructed_checkpoint_count": l1_checkpoint_count,
            "l1_quote_warming_rows": l1_warming_rows,
            "mbp10_rows": mbp10_rows,
            "mbp10_null_exchange_ts_rows": mbp10_null_exchange_ts_rows,
            "mbp10_timestamped_rows": mbp10_timestamped_rows,
            "mbp10_timestamped_rows_with_levels": mbp10_timestamped_rows_with_levels,
            "mbp10_rows_with_bids": mbp10_rows_with_bids,
            "mbp10_rows_with_asks": mbp10_rows_with_asks,
            "mbp10_rows_with_both_sides": mbp10_rows_with_both_sides,
            "mbp10_rows_with_one_side_only": mbp10_rows_with_one_side_only,
        },
        "l1_checkpoint_count": l1_checkpoint_count,
        "mbp10_timestamped_update_count": mbp10_timestamped_rows_with_levels,
    }


def compare_checkpoint_parity(
    connection: sqlite3.Connection,
    *,
    tick_size: float,
    mismatch_limit: int,
) -> dict[str, Any]:
    bids: dict[str, dict[str, float | int | None]] = {}
    asks: dict[str, dict[str, float | int | None]] = {}
    checkpoint_count = 0
    compared_checkpoint_count = 0
    missing_mbp10_best_count = 0
    comparable_side_count = 0
    within_1_tick_side_count = 0
    mismatch_count = 0
    first_mismatches: list[dict[str, Any]] = []

    cursor = connection.execute(
        "SELECT ts_ns, record_index, kind, payload FROM events ORDER BY ts_ns, event_order, record_index"
    )
    for ts_ns, record_index, kind, payload_text in cursor:
        payload = json.loads(payload_text)
        if kind == "MBP10":
            apply_mbp10_updates(bids, payload.get("bids", []), side="bid")
            apply_mbp10_updates(asks, payload.get("asks", []), side="ask")
            continue

        checkpoint_count += 1
        best_bid = best_bid_level(bids)
        best_ask = best_ask_level(asks)
        if best_bid is None or best_ask is None:
            missing_mbp10_best_count += 1
            continue
        compared_checkpoint_count += 1
        for side, mbp10_px, l1_px in [
            ("bid", float(best_bid["px"]), float(payload["bid_px"])),
            ("ask", float(best_ask["px"]), float(payload["ask_px"])),
        ]:
            comparable_side_count += 1
            delta = abs(mbp10_px - l1_px)
            if delta <= tick_size + 1e-9:
                within_1_tick_side_count += 1
            else:
                mismatch_count += 1
                if len(first_mismatches) < mismatch_limit:
                    first_mismatches.append(
                        {
                            "l1_checkpoint_ts_ns": str(ts_ns),
                            "l1_record_index": record_index,
                            "side": side,
                            "mbp10_px": mbp10_px,
                            "l1_px": l1_px,
                            "delta_points": round(delta, 6),
                        }
                    )

    return {
        "checkpoint_count": checkpoint_count,
        "compared_checkpoint_count": compared_checkpoint_count,
        "missing_mbp10_best_count": missing_mbp10_best_count,
        "comparable_side_count": comparable_side_count,
        "within_1_tick_side_count": within_1_tick_side_count,
        "within_1_tick_pct": pct(within_1_tick_side_count, comparable_side_count),
        "mismatch_count": mismatch_count,
        "first_mismatches": first_mismatches,
    }


def add_event(
    batch: list[tuple[int, int, int, str, str]],
    *,
    ts_ns: str,
    event_order: int,
    record_index: int,
    kind: str,
    payload: dict[str, Any],
) -> None:
    batch.append((int(ts_ns), event_order, record_index, kind, json.dumps(payload, separators=(",", ":"))))


def flush_events(connection: sqlite3.Connection, batch: list[tuple[int, int, int, str, str]]) -> None:
    if not batch:
        return
    connection.executemany(
        "INSERT INTO events(ts_ns, event_order, record_index, kind, payload) VALUES (?, ?, ?, ?, ?)",
        batch,
    )
    connection.commit()
    batch.clear()


def quote_side_update(row: dict[str, Any], side: BookSide) -> dict[str, float | int | None] | None:
    px = finite_number(row.get(f"{side}_px"))
    if px is None:
        return None
    return {"px": px, "sz": finite_number(row.get(f"{side}_sz", row.get(f"{side}_qty")))}


def normalize_levels(value: Any) -> list[dict[str, float | int | None]]:
    if not isinstance(value, list):
        return []
    levels: list[dict[str, float | int | None]] = []
    for index, entry in enumerate(value):
        if not isinstance(entry, dict):
            continue
        px = finite_number(entry.get("px", entry.get("price")))
        sz = finite_number(entry.get("sz", entry.get("size")))
        if px is None or sz is None:
            continue
        level = finite_integer(entry.get("level"))
        order_count = finite_integer(entry.get("order_count", entry.get("orders", entry.get("count"))))
        levels.append({"level": index if level is None else level, "px": px, "sz": sz, "order_count": order_count})
    return levels


def apply_mbp10_updates(
    state: dict[str, dict[str, float | int | None]],
    levels: Iterable[dict[str, float | int | None]],
    *,
    side: BookSide,
) -> None:
    for level in levels:
        px = level.get("px")
        sz = level.get("sz")
        if px is None or sz is None:
            continue
        key = price_key(float(px))
        if non_positive_size(sz):
            state.pop(key, None)
        else:
            state[key] = level


def best_bid_level(state: dict[str, dict[str, float | int | None]]) -> dict[str, float | int | None] | None:
    if not state:
        return None
    return state[max(state.keys(), key=float)]


def best_ask_level(state: dict[str, dict[str, float | int | None]]) -> dict[str, float | int | None] | None:
    if not state:
        return None
    return state[min(state.keys(), key=float)]


def price_key(value: float) -> str:
    return f"{value:.10f}"


def non_positive_size(value: float | int | None) -> bool:
    return value is not None and value <= 0


def decimal_ns(value: Any) -> str | None:
    if isinstance(value, int) and value >= 0:
        return str(value)
    if isinstance(value, str) and value.isdecimal():
        return value
    return None


def finite_number(value: Any) -> float | int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value == value and value not in (float("inf"), float("-inf")):
        return value
    return None


def finite_integer(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def pct(numerator: int, denominator: int) -> float | None:
    if denominator == 0:
        return None
    return round((numerator / denominator) * 100, 6)


if __name__ == "__main__":
    raise SystemExit(main())
