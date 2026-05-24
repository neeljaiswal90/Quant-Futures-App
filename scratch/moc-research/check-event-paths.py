#!/usr/bin/env python3
"""Sanity checks for MOC-R2 event-stream and aggregate parquet outputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_DIR = REPO_ROOT / "scratch/moc-research"
MANIFEST_PATH = REPO_ROOT / "scratch/moc-research/event-day-manifest.json"
EVENT_STREAM_ATTESTATION_PATH = REPO_ROOT / "scratch/moc-research/event-stream.sha256.txt"
NS_PER_SECOND = 1_000_000_000
EXPECTED_FILTERED_SESSION_COUNT = 30
EXPECTED_PATH_ROWS_PER_SESSION = 331
HORIZONS = (1, 5, 10, 30, 60, 120, 300)
GOOD_FRIDAY = "2026-04-03"
EVENT_STREAM_FILE_NAME = "event-stream.parquet"


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir)
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    filtered_sessions = [
        row for row in manifest["sessions"]
        if row["data_present"] is True and row["is_rth"] is True
    ]
    if len(filtered_sessions) != EXPECTED_FILTERED_SESSION_COUNT:
        raise AssertionError(f"filtered session count mismatch: {len(filtered_sessions)}")
    if any(row["session_date"] == GOOD_FRIDAY for row in filtered_sessions):
        raise AssertionError("Good Friday leaked into filtered session set")

    stream = read_event_stream_with_attestation(output_dir / EVENT_STREAM_FILE_NAME)
    paths = pq.read_table(output_dir / "event-paths.parquet").to_pylist()
    aggregates = pq.read_table(output_dir / "event-aggregates.parquet").to_pylist()

    if stream is not None:
        assert_required_columns(stream, {
            "session_date", "ts_event_ns", "source_seq", "record_kind",
            "bid_px_pts", "ask_px_pts", "bid_sz", "ask_sz",
            "trade_price_pts", "trade_size", "aggressor_side",
        })
    assert_required_columns(paths, {
        "session_date", "ts_offset_s", "bid_px_pts", "ask_px_pts",
        "bid_sz", "ask_sz", "mid_pts", "microprice_pts", "spread_ticks",
        "trade_count", "volume_contracts", "buy_aggressor_volume",
        "sell_aggressor_volume", "trade_aggressor_imbalance",
        "queue_imbalance_top", "mbp10_bid_depth_5_levels",
        "mbp10_ask_depth_5_levels",
    })
    aggregate_columns = {
        "session_date", "time_to_up_mfe_at_300s_seconds",
        "time_to_down_mfe_at_300s_seconds", "first_5s_range_pts",
        "first_30s_range_pts", "first_60s_range_pts",
        "pre_event_spread_ticks_t_minus_30s",
        "pre_event_spread_ticks_t_minus_10s",
        "pre_event_spread_ticks_t_zero",
        "pre_event_imbalance_t_minus_30s",
        "pre_event_imbalance_t_minus_10s",
        "pre_event_volume_z_score",
    }
    for horizon in HORIZONS:
        aggregate_columns.update({
            f"mfe_signed_pts_at_{horizon}s",
            f"mfe_abs_pts_at_{horizon}s",
            f"mae_signed_pts_at_{horizon}s",
            f"mae_abs_pts_at_{horizon}s",
            f"close_signed_pts_at_{horizon}s",
        })
    assert_required_columns(aggregates, aggregate_columns)

    if len(aggregates) != EXPECTED_FILTERED_SESSION_COUNT:
        raise AssertionError(f"aggregate row count mismatch: {len(aggregates)}")
    if len(paths) != EXPECTED_FILTERED_SESSION_COUNT * EXPECTED_PATH_ROWS_PER_SESSION:
        raise AssertionError(f"path row count mismatch: {len(paths)}")
    rows_for_good_friday_check = (stream or []) + paths + aggregates
    if any(row["session_date"] == GOOD_FRIDAY for row in rows_for_good_friday_check):
        raise AssertionError("Good Friday leaked into R2 outputs")

    verify_path_offsets(paths)
    if stream is not None:
        verify_stream_sort(stream)
    verify_mbp10_null_pattern(paths)
    verify_reference_price_examples()
    verify_mfe_mae_examples()
    if stream is not None:
        verify_stream_completeness(paths, stream)
    verify_aggregate_consistency(paths, aggregates)
    verify_volume_zscore_nulls(aggregates)

    if args.compare_dir:
        compare_parquet_hashes(output_dir, Path(args.compare_dir))

    print("MOC-R2 event-path checks passed")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--compare-dir", default=None)
    return parser.parse_args()


def assert_required_columns(rows: list[dict[str, Any]], expected: set[str]) -> None:
    if not rows:
        raise AssertionError("parquet output has no rows")
    actual = set(rows[0])
    missing = expected - actual
    if missing:
        raise AssertionError(f"missing columns: {sorted(missing)}")


def read_event_stream_with_attestation(path: Path) -> list[dict[str, Any]] | None:
    expected_hash, expected_file_name = read_event_stream_attestation()
    if expected_file_name != EVENT_STREAM_FILE_NAME:
        raise AssertionError(
            f"event-stream attestation filename mismatch: {expected_file_name} != {EVENT_STREAM_FILE_NAME}"
        )
    if not path.exists():
        print(
            "WARNING: event-stream.parquet absent; regenerate with "
            "`npx tsx scratch/moc-research/extract-event-paths.mts` "
            "to run stream-dependent checks."
        )
        return None
    actual_hash = sha256(path)
    if actual_hash != expected_hash:
        raise AssertionError(f"event-stream SHA mismatch: {actual_hash} != {expected_hash}")
    return pq.read_table(path).to_pylist()


def read_event_stream_attestation() -> tuple[str, str]:
    payload = EVENT_STREAM_ATTESTATION_PATH.read_text(encoding="utf-8").strip()
    parts = payload.split()
    if len(parts) != 2:
        raise AssertionError("event-stream.sha256.txt must contain '<sha256>  event-stream.parquet'")
    expected_hash, file_name = parts
    if len(expected_hash) != 64 or any(char not in "0123456789abcdef" for char in expected_hash):
        raise AssertionError(f"invalid event-stream SHA attestation: {expected_hash}")
    return expected_hash, file_name


def verify_path_offsets(paths: list[dict[str, Any]]) -> None:
    by_session: dict[str, list[int]] = {}
    for row in paths:
        by_session.setdefault(row["session_date"], []).append(row["ts_offset_s"])
    for session, offsets in by_session.items():
        expected = list(range(-30, 301))
        if offsets != expected:
            raise AssertionError(f"offset sequence mismatch for {session}")


def verify_stream_sort(stream: list[dict[str, Any]]) -> None:
    previous: tuple[str, int, int] | None = None
    for row in stream:
        key = (row["session_date"], int(row["ts_event_ns"]), row["source_seq"])
        if previous is not None and key < previous:
            raise AssertionError("event-stream row order is not deterministic")
        previous = key


def verify_mbp10_null_pattern(paths: list[dict[str, Any]]) -> None:
    bid_nulls = sum(1 for row in paths if row["mbp10_bid_depth_5_levels"] is None)
    ask_nulls = sum(1 for row in paths if row["mbp10_ask_depth_5_levels"] is None)
    if bid_nulls != len(paths) or ask_nulls != len(paths):
        raise AssertionError(
            "MOC-R2 Option 3 expects deterministic null MBP-10 depth columns "
            f"(bid_nulls={bid_nulls}, ask_nulls={ask_nulls}, rows={len(paths)})"
        )


def verify_reference_price_examples() -> None:
    equal_mid = (100.0 + 101.0) / 2
    equal_micro = microprice(100.0, 101.0, 10, 10)
    if not math.isclose(equal_mid, equal_micro):
        raise AssertionError("equal-size microprice should equal mid")
    asymmetric = microprice(100.0, 101.0, 30, 10)
    if not asymmetric > equal_mid:
        raise AssertionError("larger bid size should pull microprice toward ask")


def verify_mfe_mae_examples() -> None:
    monotone = [100.0, 100.25, 100.5, 100.75, 101.0]
    moves = [value - monotone[0] for value in monotone]
    if max(moves) != 1.0 or min(moves) != 0.0:
        raise AssertionError("monotone-up MFE/MAE synthetic example failed")


def verify_stream_completeness(paths: list[dict[str, Any]], stream: list[dict[str, Any]]) -> None:
    # Recompute MBP-1/trade-derived path fields from the event-stream rows for
    # the first and last sessions plus the FOMC day. This verifies the
    # no-lookahead matrix against actual output without re-reading raw DBN.
    sessions = sorted({row["session_date"] for row in paths})
    sample_sessions = {sessions[0], sessions[-1], "2026-03-18"}
    stream_by_session: dict[str, list[dict[str, Any]]] = {}
    paths_by_session: dict[str, list[dict[str, Any]]] = {}
    for row in stream:
        stream_by_session.setdefault(row["session_date"], []).append(row)
    for row in paths:
        paths_by_session.setdefault(row["session_date"], []).append(row)

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    anchors = {
        row["session_date"]: int(row["imbalance_anchor_ts_ns_i0"])
        for row in manifest["sessions"]
    }
    for session in sorted(sample_sessions):
        events = stream_by_session[session]
        quote_events = [row for row in events if row["record_kind"] == "mbp1_quote"]
        trade_events = [row for row in events if row["record_kind"] == "tbbo_trade"]
        if not quote_events:
            raise AssertionError(f"no quote stream rows for {session}")
        if not trade_events:
            raise AssertionError(f"no trade stream rows for {session}")
        for path_row in paths_by_session[session]:
            offset = path_row["ts_offset_s"]
            bin_close = anchors[session] + offset * NS_PER_SECOND
            prior_quotes = [row for row in quote_events if int(row["ts_event_ns"]) <= bin_close]
            if prior_quotes:
                quote = prior_quotes[-1]
                assert_close(path_row["bid_px_pts"], quote["bid_px_pts"], f"{session} bid {offset}")
                assert_close(path_row["ask_px_pts"], quote["ask_px_pts"], f"{session} ask {offset}")
            prev_close = bin_close - NS_PER_SECOND
            bin_trades = [
                row for row in trade_events
                if prev_close < int(row["ts_event_ns"]) <= bin_close
            ]
            if path_row["trade_count"] != len(bin_trades):
                raise AssertionError(f"trade_count mismatch for {session} offset {offset}")
            if path_row["volume_contracts"] != sum(row["trade_size"] for row in bin_trades):
                raise AssertionError(f"volume mismatch for {session} offset {offset}")


def verify_aggregate_consistency(paths: list[dict[str, Any]], aggregates: list[dict[str, Any]]) -> None:
    paths_by_session: dict[str, list[dict[str, Any]]] = {}
    for row in paths:
        paths_by_session.setdefault(row["session_date"], []).append(row)
    for aggregate in aggregates:
        session = aggregate["session_date"]
        rows = [row for row in paths_by_session[session] if row["ts_offset_s"] >= 0]
        reference = next(row for row in rows if row["ts_offset_s"] == 0)
        moves = {row["ts_offset_s"]: round(row["mid_pts"] - reference["mid_pts"], 10) for row in rows}
        for horizon in HORIZONS:
            values = [value for offset, value in moves.items() if offset <= horizon]
            assert_close(aggregate[f"mfe_signed_pts_at_{horizon}s"], max(values), f"{session} mfe {horizon}")
            assert_close(aggregate[f"mae_signed_pts_at_{horizon}s"], min(values), f"{session} mae {horizon}")
            assert_close(aggregate[f"close_signed_pts_at_{horizon}s"], moves[horizon], f"{session} close {horizon}")


def verify_volume_zscore_nulls(aggregates: list[dict[str, Any]]) -> None:
    non_null = [row for row in aggregates if row["pre_event_volume_z_score"] is not None]
    if non_null:
        raise AssertionError("30-session corpus should have null same-DOW 20-session volume z-scores")


def compare_parquet_hashes(left: Path, right: Path) -> None:
    for name in (EVENT_STREAM_FILE_NAME, "event-paths.parquet", "event-aggregates.parquet"):
        if name == EVENT_STREAM_FILE_NAME and (not (left / name).exists() or not (right / name).exists()):
            print("WARNING: skipping event-stream.parquet compare because one side is absent")
            continue
        left_hash = sha256(left / name)
        right_hash = sha256(right / name)
        if left_hash != right_hash:
            raise AssertionError(f"parquet hash mismatch for {name}: {left_hash} != {right_hash}")


def microprice(bid: float, ask: float, bid_sz: int, ask_sz: int) -> float:
    return (bid * ask_sz + ask * bid_sz) / (bid_sz + ask_sz)


def assert_close(actual: float, expected: float, label: str) -> None:
    if not math.isclose(float(actual), float(expected), rel_tol=0, abs_tol=1e-9):
        raise AssertionError(f"{label}: {actual} != {expected}")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
