from __future__ import annotations

import csv
import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT / "scratch" / "moc-research"
BACKLOG = ROOT / "docs" / "plan" / "new_app_v1_ticket_backlog_v6.csv"
PARQUET = SRC_DIR / "long-only-counterfactual.parquet"
MEMO = SRC_DIR / "long-only-vs-bilateral-comparison.md"
TRIGGERED = SRC_DIR / "triggered-events.parquet"
EXPECTED_ROWS = 90_720
EXPECTED_COLUMNS = 26
EXPECTED_BACKLOG_ROW = [
    "MOC-LO-COUNTERFACTUAL",
    "P3",
    "1.5",
    "MOC-R7",
    "Long-only counterfactual on Plan A R3 triggered-events: recompute expectancy assuming unilateral buy-stop arming (no sell-leg); test whether 11.5x buy/sell asymmetry signal (1840 vs 160 buy/sell-only triggers) survives bootstrap + DSR; emits long-only-counterfactual.parquet + comparison memo",
    "new_research_tier_carryforward",
]
OUTPUT_COLUMNS = [
    "pt_pts",
    "stop_pts",
    "cost_scenario",
    "latency_bucket_ms",
    "instrument",
    "arm_time_s",
    "trigger_offset_pts",
    "reference",
    "stop_limit_protection_pts",
    "n_events_total",
    "n_triggered_one_side",
    "n_triggered_both_sides",
    "n_triggered_neither",
    "p_triggered_one_side",
    "p_both_side_false_trigger",
    "p_pt_hit_before_stop",
    "p_stop_hit_before_pt",
    "p_time_stop",
    "p_stop_limit_miss",
    "expectancy_per_trade_usd",
    "expectancy_per_trade_pts",
    "trade_frequency_per_session",
    "expected_daily_pnl_usd",
    "n_long_entered",
    "p_long_entered",
    "exit_reason_share",
]
COST_ORDER = {"mnq_low": 0, "mnq_mid": 1, "mnq_high": 2}
REFERENCE_ORDER = {"bid_ask": 0, "microprice": 1, "mid": 2}
PROTECTION_ORDER = {"null": 0, "0.5": 1, "1.0": 2, "1.5": 3}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def assert_backlog() -> None:
    raw = BACKLOG.read_text(encoding="utf-8")
    assert raw.endswith("\n"), "backlog file must end in LF"
    rows = list(csv.reader(raw.splitlines()))
    assert all(len(row) == 6 for row in rows), "all backlog rows must have 6 columns"
    matches = [row for row in rows if row and row[0] == "MOC-LO-COUNTERFACTUAL"]
    assert matches == [EXPECTED_BACKLOG_ROW], "MOC-LO-COUNTERFACTUAL backlog row mismatch or duplicate"


def assert_parquet() -> pd.DataFrame:
    table = pq.read_table(PARQUET)
    assert table.num_rows == EXPECTED_ROWS, f"expected {EXPECTED_ROWS} rows, got {table.num_rows}"
    assert table.num_columns == EXPECTED_COLUMNS, f"expected {EXPECTED_COLUMNS} columns, got {table.num_columns}"
    assert table.schema.names[-3:] == ["n_long_entered", "p_long_entered", "exit_reason_share"], "long-only columns must be appended"
    assert str(table.schema.field("exit_reason_share").type).startswith("struct<"), "exit_reason_share must be a struct"
    df = table.to_pandas()
    sortable = df.copy()
    sortable["cost_rank"] = sortable["cost_scenario"].map(COST_ORDER)
    sortable["reference_rank"] = sortable["reference"].map(REFERENCE_ORDER)
    sortable["protection_rank"] = sortable["stop_limit_protection_pts"].apply(lambda x: PROTECTION_ORDER["null"] if pd.isna(x) else PROTECTION_ORDER[f"{float(x):.1f}"])
    sorted_df = sortable.sort_values(
        [
            "pt_pts",
            "stop_pts",
            "cost_rank",
            "latency_bucket_ms",
            "arm_time_s",
            "trigger_offset_pts",
            "reference_rank",
            "protection_rank",
            "instrument",
        ],
        kind="mergesort",
    ).reset_index(drop=True)
    pd.testing.assert_frame_equal(df.reset_index(drop=True), sorted_df[OUTPUT_COLUMNS], check_dtype=False)
    assert (df["n_triggered_both_sides"] == 0).all(), "long-only output must not emit bilateral both-side triggers"
    assert (df["p_both_side_false_trigger"] == 0.0).all(), "long-only false-trigger share must be zero"
    assert ((df["n_long_entered"] >= 0) & (df["n_long_entered"] <= 30)).all(), "n_long_entered out of range"
    assert ((df["p_long_entered"] >= 0.0) & (df["p_long_entered"] <= 1.0)).all(), "p_long_entered out of range"
    return df


def assert_sell_only_preserved(df: pd.DataFrame) -> None:
    triggered = pq.read_table(TRIGGERED, columns=["outcome", "buy_triggered_ts_offset_ns"]).to_pandas()
    sell_only = int((triggered["outcome"] == "sell_only").sum())
    assert sell_only == 160, f"expected 160 sell_only cells, got {sell_only}"
    assert triggered.loc[triggered["outcome"] == "sell_only", "buy_triggered_ts_offset_ns"].isna().all(), "sell_only rows unexpectedly have buy trigger ts"
    assert int(df["n_triggered_one_side"].max()) <= 30, "buy attempts exceed session count"


def assert_memo() -> None:
    text = MEMO.read_text(encoding="utf-8")
    required = [
        "# MOC-LO long-only counterfactual comparison",
        "## Verdict",
        "## Long-only top 10 by expected_daily_pnl_usd",
        "## Bilateral R4 top 10 by expected_daily_pnl_usd",
        "## Direct A/B at long-only top-10 coordinates",
        "## Buy/sell asymmetry",
        "## Both-sides buy-first resolution",
        "## Bootstrap and DSR diagnostics",
        "## Plan A R7 criterion comparison",
        "## Binary recommendation",
    ]
    for needle in required:
        assert needle in text, f"memo missing section: {needle}"
    assert "Bootstrap:" in text and "ci_low=" in text, "memo must report bootstrap CI"
    assert "DSR:" in text, "memo must report DSR computed or honest fail"
    assert "| Criterion | Bilateral R7 | Long-only | Evidence |" in text, "verdict criteria table missing"
    assert any(v in text for v in ["SCOPE FULL MOC-LO RESEARCH STREAM", "ACCEPT LONG-ONLY ALSO FAILS"]), "binary verdict missing"
    assert "90,720 rows" in text, "memo must document corrected 90,720-row R4-compatible shape"
    assert "recomputes every long-side entry" in text, "memo must document both-sides buy-side recomputation"


def assert_determinism() -> None:
    tmp = SRC_DIR / ".tmp-long-only-determinism"
    if tmp.exists():
        for child in tmp.iterdir():
            child.unlink()
    else:
        tmp.mkdir(parents=True)
    env = os.environ.copy()
    env["MOC_LO_OUTPUT_DIR"] = str(tmp)
    subprocess.run([sys.executable, str(SRC_DIR / "long-only-counterfactual.py")], cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
    assert sha256_file(PARQUET) == sha256_file(tmp / "long-only-counterfactual.parquet"), "parquet SHA differs across runs"
    assert sha256_file(MEMO) == sha256_file(tmp / "long-only-vs-bilateral-comparison.md"), "memo SHA differs across runs"
    for child in tmp.iterdir():
        child.unlink()
    tmp.rmdir()


def main() -> None:
    assert_backlog()
    df = assert_parquet()
    assert_sell_only_preserved(df)
    assert_memo()
    assert_determinism()
    print(f"OK rows={len(df)} columns={len(df.columns)} parquet_sha={sha256_file(PARQUET)} memo_sha={sha256_file(MEMO)}")


if __name__ == "__main__":
    main()
