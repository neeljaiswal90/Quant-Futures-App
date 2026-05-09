#!/usr/bin/env python
"""QFA-420 cross-regime queue-fidelity stratification.

This script keeps the statistical layer in Python while preserving the
locked QFA-402 queue-fidelity implementation by generating a temporary
TypeScript session runner from the QFA-402d streaming helper. The generated
runner is not committed; it exists only to compute per-session summaries
against ADR-0012's locked probe policy.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
import shutil
import statistics
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = Path("D:/qfa-cache/databento/tier-a-feb-mar-2026")
LABELS_IN = ROOT / "artifacts/regime/regime-labels.json"
TS_TEMPLATE = ROOT / "scripts/backtester/qfa-402d-probe-policy-sweep.mts"
TS_RUNNER = ROOT / "scripts/regime/.qfa-420-session-runner.mts"
SESSION_CACHE = ROOT / ".tmp/qfa-420-session-cache"
JSON_OUT = ROOT / "artifacts/regime-fidelity/regime-stratified-fidelity-v1.json"
REPORT_OUT = ROOT / "docs/research/qfa-420-cross-regime-fidelity.md"

HASHES = {
    "2026-02": "05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c",
    "2026-03": "cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f",
    "2026-04": "e37d01b3a3976f2f2614c2a85171ce4cc8b6b5ad069bf782f55285b0e7721a2c",
}
MANIFEST_SHORT_NAMES = {
    "2026-02": "feb",
    "2026-03": "mar",
    "2026-04": "apr",
}

POLICY = {
    "mode": "mbp_trades_proxy",
    "fill_horizon_ns": "15000000000",
    "depletion_lookback_ns": "60000000000",
    "sample_interval": "1s",
    "order_quantity": "1",
    "tolerance_ppm": 100_000,
    "threshold_ppm": 800_000,
}
SESOI_PPM = 50_000
BOOTSTRAP_REPLICATIONS = 10_000
BOOTSTRAP_BLOCK_LENGTHS = [3, 5, 7]
BOOTSTRAP_SEED = 420
MID_ANOMALY_THRESHOLD_PPM = 200_000
TWENTY_ONE_PLUS_WARNING_DELTA_PPM = 500_000
TWENTY_ONE_PLUS_WARNING_MIN_PROBES = 100
REGIME_ORDER = ["high", "mid", "low"]
PPM_DENOMINATOR = 1_000_000


def main() -> int:
    args = parse_args()
    started = time.perf_counter()
    ensure_inputs()
    labels_artifact = read_json(LABELS_IN)
    verify_manifest_hashes(labels_artifact)
    eligible, excluded = calibration_sessions(labels_artifact)
    expected_counts = Counter(row["confirmed_label"] for row in eligible)
    if dict(expected_counts) != {"high": 43, "mid": 3, "low": 11}:
        raise ValueError(f"unexpected calibration counts: {dict(expected_counts)}")

    print(f"[qfa-420] calibration sessions: {dict(expected_counts)}")
    session_results = []
    for index, label in enumerate(eligible, start=1):
        print(f"[qfa-420] session {index}/{len(eligible)} {label['session_id']} {label['confirmed_label']}")
        session_results.append(load_or_compute_session(label, no_cache=args.no_cache))

    per_session = build_per_session(session_results)
    equal_weight = build_equal_weight(per_session)
    probe_weighted = build_probe_weighted(per_session)
    high_low = build_high_low_delta(per_session)
    mid = build_mid_descriptive(per_session, equal_weight)
    twenty_one = build_twenty_one_plus(per_session, probe_weighted)
    primary_verdict = final_primary_verdict(high_low)
    mid_anomaly_flag = bool(
        mid["mean"] is not None
        and (
            abs(mid["mean"] - equal_weight["high"]["mean"]) > MID_ANOMALY_THRESHOLD_PPM
            or abs(mid["mean"] - equal_weight["low"]["mean"]) > MID_ANOMALY_THRESHOLD_PPM
        )
    )

    artifact = {
        "methodology_id": "adr-0015-v1",
        "input_substrate_hash": sha256_file(LABELS_IN),
        "input_manifest_hashes": HASHES,
        "probe_policy": POLICY,
        "sesoi_ppm": SESOI_PPM,
        "per_session": per_session,
        "per_regime_equal_weight": equal_weight,
        "per_regime_probe_weighted": probe_weighted,
        "high_low_delta": high_low,
        "mid_descriptive": mid,
        "twenty_one_plus_diagnostic": twenty_one["by_regime"],
        "twenty_one_plus_warning_flag": twenty_one["warning_flag"],
        "mid_anomaly_flag": mid_anomaly_flag,
        "primary_verdict": primary_verdict,
        "mid_regime_status": "screening_floor",
        "mid_regime_inference": "descriptive_only",
        "bootstrap_replications": BOOTSTRAP_REPLICATIONS,
        "bootstrap_block_lengths_tested": BOOTSTRAP_BLOCK_LENGTHS,
        "bootstrap_seed": BOOTSTRAP_SEED,
        "quality_excluded_sessions": excluded,
        "runtime_seconds": round(time.perf_counter() - started, 3),
        "generated_at_note": "Deterministic archive analysis script; no wall-clock timestamp emitted.",
    }

    write_json(JSON_OUT, artifact)
    REPORT_OUT.parent.mkdir(parents=True, exist_ok=True)
    REPORT_OUT.write_text(render_report(artifact), encoding="utf-8")
    print(json.dumps({
        "status": "ok",
        "primary_verdict": primary_verdict,
        "block_length_stability_flag": high_low["block_length_stability_flag"],
        "mid_anomaly_flag": mid_anomaly_flag,
        "twenty_one_plus_warning_flag": twenty_one["warning_flag"],
        "json": rel(JSON_OUT),
        "report": rel(REPORT_OUT),
        "runtime_seconds": artifact["runtime_seconds"],
    }, indent=2))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-cache", action="store_true", help="recompute every session cache")
    return parser.parse_args()


def ensure_inputs() -> None:
    for path in [LABELS_IN, TS_TEMPLATE]:
        if not path.exists():
            raise FileNotFoundError(path)
    if not ARCHIVE.exists():
        raise FileNotFoundError(ARCHIVE)


def verify_manifest_hashes(labels_artifact: dict[str, Any]) -> None:
    if labels_artifact.get("source_manifests") != HASHES:
        raise ValueError("regime-labels source_manifests do not match QFA-119d hashes")
    for month, expected in HASHES.items():
        short = MANIFEST_SHORT_NAMES[month]
        path = ARCHIVE / f"manifest-{short}-2026.json"
        actual = sha256_file(path)
        if actual != expected:
            raise ValueError(f"manifest hash mismatch for {month}: expected {expected}, actual {actual}")


def calibration_sessions(labels_artifact: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    eligible = []
    excluded = []
    for row in labels_artifact["labels"]:
        reason = row.get("quality_exclusion_reason")
        if row.get("quality_excluded") or row.get("use_for_calibration") is False:
            excluded.append({
                "session_id": row["session_id"],
                "confirmed_label": row.get("confirmed_label"),
                "quality_excluded": bool(row.get("quality_excluded")),
                "quality_exclusion_reason": reason,
                "use_for_calibration": bool(row.get("use_for_calibration")),
            })
            continue
        if row.get("confirmed_label") in {"high", "mid", "low"} and row.get("label_status") == "available":
            eligible.append(row)
    return sorted(eligible, key=lambda item: item["session_id"]), sorted(excluded, key=lambda item: item["session_id"])


def load_or_compute_session(label: dict[str, Any], no_cache: bool) -> dict[str, Any]:
    session_id = label["session_id"]
    cache_path = SESSION_CACHE / f"{session_id}.json"
    if not no_cache and cache_path.exists():
        cached = read_json(cache_path)
        session = cached["sessions"][0]
        if valid_cached_session(session, label):
            return session
    SESSION_CACHE.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["NODE_OPTIONS"] = "--max-old-space-size=8192"
    try:
        write_ts_runner(label, cache_path, path_overrides=None)
        run_ts_runner(env)
    except subprocess.CalledProcessError:
        print(f"[qfa-420] Node DBN read failed for {session_id}; retrying with Python-normalized DBN files")
        overrides, normalized_dir = normalize_session_dbn_files(label)
        try:
            write_ts_runner(label, cache_path, path_overrides=overrides)
            run_ts_runner(env)
        finally:
            remove_normalized_dir(normalized_dir)
    finally:
        if TS_RUNNER.exists():
            TS_RUNNER.unlink()
    generated = read_json(cache_path)
    session = generated["sessions"][0]
    if not valid_cached_session(session, label):
        raise ValueError(f"generated cache did not validate for {session_id}")
    return session


def valid_cached_session(session: dict[str, Any], label: dict[str, Any]) -> bool:
    return (
        session.get("session_id") == label["session_id"]
        and session.get("regime") == label["confirmed_label"]
        and session.get("policy_cell", {}).get("fill_horizon_ns") == POLICY["fill_horizon_ns"]
        and session.get("policy_cell", {}).get("depletion_lookback_ns") == POLICY["depletion_lookback_ns"]
    )


def run_ts_runner(env: dict[str, str]) -> None:
    subprocess.run(
        ["npm.cmd" if os.name == "nt" else "npm", "exec", "--", "tsx", rel(TS_RUNNER)],
        cwd=ROOT,
        env=env,
        check=True,
    )


def normalize_session_dbn_files(label: dict[str, Any]) -> tuple[dict[str, str], Path]:
    import zstandard as zstd

    session = manifest_session(label["session_id"])
    normalized_dir = ROOT / ".tmp/qfa-420-normalized-dbn" / label["session_id"]
    normalized_dir.mkdir(parents=True, exist_ok=True)
    overrides: dict[str, str] = {}
    for schema_name in ["mbo", "mbp-1", "trades"]:
        schema = session["schemas"][schema_name]
        source = schema_path(schema["path"])
        target = normalized_dir / f"{schema_name}.dbn"
        with source.open("rb") as source_file, target.open("wb") as target_file:
            reader = zstd.ZstdDecompressor().stream_reader(source_file)
            try:
                shutil.copyfileobj(reader, target_file)
            finally:
                reader.close()
        overrides[str(source)] = str(target)
    return overrides, normalized_dir


def remove_normalized_dir(path: Path) -> None:
    resolved = path.resolve()
    tmp_root = (ROOT / ".tmp").resolve()
    if tmp_root not in resolved.parents:
        raise ValueError(f"refusing to remove normalized path outside .tmp: {resolved}")
    shutil.rmtree(resolved, ignore_errors=True)


def manifest_session(session_id: str) -> dict[str, Any]:
    month = session_id[:7]
    short = MANIFEST_SHORT_NAMES[month]
    manifest = read_json(ARCHIVE / f"manifest-{short}-2026.json")
    for session in manifest["sessions"]:
        if session["session_id"] == session_id:
            return session
    raise ValueError(f"session not found in manifest: {session_id}")


def schema_path(path_text: str) -> Path:
    path = Path(path_text)
    return path if path.is_absolute() else ARCHIVE / path


def write_ts_runner(label: dict[str, Any], output_path: Path, path_overrides: dict[str, str] | None) -> None:
    source = TS_TEMPLATE.read_text(encoding="utf-8")
    session_id = label["session_id"]
    month = month_short(session_id)
    regime = label["confirmed_label"]
    config = f"""const SESSION_CONFIGS: readonly SessionConfig[] = Object.freeze([
  Object.freeze({{
    label: '{session_id}',
    regime: '{regime}',
    month: '{month}',
    session_id: '{session_id}',
    scope: 'full_rth',
    prefix_duration_ns: null,
    fill_horizon_ns: 15_000_000_000n,
    depletion_lookback_ns: 60_000_000_000n,
    rationale: 'QFA-420 calibration-eligible {regime} regime session.',
  }}),
]);"""
    source = source.replace(
        "const OUTPUT_PATH = join(REPO_ROOT, '.tmp', 'qfa-402d-probe-policy-sweep.json');",
        f"const OUTPUT_PATH = join(REPO_ROOT, '.tmp', 'qfa-420-session-cache', '{session_id}.json');",
    )
    source = source.replace(
        "const SCRATCH_ROOT = join(REPO_ROOT, 'scratch', 'qfa-402d');",
        "const SCRATCH_ROOT = join(REPO_ROOT, '.tmp', 'qfa-420-unused-scratch');",
    )
    override_rows = ",\n".join(
        f"  [{json.dumps(left)}, {json.dumps(right)}]"
        for left, right in sorted((path_overrides or {}).items())
    )
    source = source.replace(
        "const ARCHIVE_ROOT = 'D:/qfa-cache/databento/tier-a-feb-mar-2026';",
        "const ARCHIVE_ROOT = 'D:/qfa-cache/databento/tier-a-feb-mar-2026';\n"
        f"const PATH_OVERRIDES = new Map<string, string>([\n{override_rows}\n]);",
    )
    source = re.sub(
        r"const FILL_HORIZON_GRID_NS = Object\.freeze\(\[[\s\S]*?\]\);",
        "const FILL_HORIZON_GRID_NS = Object.freeze([\n  15_000_000_000n,\n]);",
        source,
        count=1,
    )
    source = re.sub(
        r"const DEPLETION_LOOKBACK_GRID_NS = Object\.freeze\(\[[\s\S]*?\]\);",
        "const DEPLETION_LOOKBACK_GRID_NS = Object.freeze([\n  60_000_000_000n,\n]);",
        source,
        count=1,
    )
    source = re.sub(
        r"const LOCKED_MANIFEST_HASHES = Object\.freeze\(\{[\s\S]*?\n\}\);",
        """const LOCKED_MANIFEST_HASHES = Object.freeze({
  feb: '05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c',
  mar: 'cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f',
  apr: 'e37d01b3a3976f2f2614c2a85171ce4cc8b6b5ad069bf782f55285b0e7721a2c',
});""",
        source,
        count=1,
    )
    source = source.replace("readonly month: 'feb' | 'mar';", "readonly month: 'feb' | 'mar' | 'apr';")
    source = source.replace("function readManifest(month: 'feb' | 'mar'): CorpusManifest {", "function readManifest(month: 'feb' | 'mar' | 'apr'): CorpusManifest {")
    source = source.replace(
        "function fullSchemaPath(schema: ManifestSessionSchema): string {\n  if (isAbsolute(schema.path)) {\n    return schema.path;\n  }\n  return join(ARCHIVE_ROOT, schema.path);\n}",
        "function fullSchemaPath(schema: ManifestSessionSchema): string {\n  const resolved = isAbsolute(schema.path) ? schema.path : join(ARCHIVE_ROOT, schema.path);\n  return PATH_OVERRIDES.get(resolved) ?? resolved;\n}",
    )
    source = re.sub(
        r"const SESSION_BASES = Object\.freeze\([\s\S]*?\nfunction nowMs\(\): number \{",
        f"{config}\n\nfunction nowMs(): number {{",
        source,
        count=1,
    )
    source = source.replace(
        "  const manifests = Object.freeze({\n    feb: readManifest('feb'),\n    mar: readManifest('mar'),\n  });",
        "  const manifests = Object.freeze({\n    feb: readManifest('feb'),\n    mar: readManifest('mar'),\n    apr: readManifest('apr'),\n  });",
    )
    source = source.replace("    ticket: 'QFA-402d',", "    ticket: 'QFA-420-session-runner',")
    source = source.replace("    repo_head_expected: 'c0d709ad205afa6e95f234c15eb09cd939556eb8',", "    repo_head_expected: 'e0b06e0',")
    source = source.replace("  writeCellScratch(config, result);\n", "  // QFA-420 writes only the requested per-session cache artifact.\n")
    TS_RUNNER.write_text(source, encoding="utf-8")
    output_path.parent.mkdir(parents=True, exist_ok=True)


def build_per_session(session_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for result in sorted(session_results, key=lambda item: item["session_id"]):
        summary = result["summary"]
        queue_21 = queue_bucket(result, "21_plus")
        out.append({
            "session_id": result["session_id"],
            "regime": result["regime"],
            "share_ppm": summary["within_tolerance_share_ppm"],
            "comparable_probes": summary["comparable_probes"],
            "within_tolerance_probes": summary["within_tolerance_probes"],
            "total_probes": summary["total_probes"],
            "status": summary["status"],
            "twenty_one_plus_comparable_probes": queue_21["comparable_probes"],
            "twenty_one_plus_within_tolerance_probes": queue_21["within_tolerance_probes"],
            "twenty_one_plus_share_ppm": queue_21["within_tolerance_share_ppm"],
        })
    return out


def queue_bucket(session_result: dict[str, Any], bucket: str) -> dict[str, Any]:
    rows = session_result["analysis"]["stratifications"]["queue_ahead"]
    for row in rows:
        if row["bucket"] == bucket:
            return row
    raise ValueError(f"missing queue bucket {bucket} for {session_result['session_id']}")


def build_equal_weight(per_session: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for regime in REGIME_ORDER:
        rows = [row for row in per_session if row["regime"] == regime]
        shares = [row["share_ppm"] for row in rows]
        out[regime] = {
            "mean": round_int(mean(shares)),
            "median": round_int(statistics.median(shares)),
            "min": min(shares),
            "max": max(shares),
            "n": len(rows),
            "sessions": [row["session_id"] for row in rows],
        }
    return out


def build_probe_weighted(per_session: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for regime in REGIME_ORDER:
        rows = [row for row in per_session if row["regime"] == regime]
        comparable = sum(row["comparable_probes"] for row in rows)
        within = sum(row["within_tolerance_probes"] for row in rows)
        out[regime] = {
            "pooled_share": share_ppm(within, comparable),
            "comparable_probes": comparable,
            "within_tolerance_probes": within,
            "n": len(rows),
        }
    return out


def build_high_low_delta(per_session: list[dict[str, Any]]) -> dict[str, Any]:
    high = [row["share_ppm"] for row in per_session if row["regime"] == "high"]
    low = [row["share_ppm"] for row in per_session if row["regime"] == "low"]
    point = round_int(mean(high) - mean(low))
    sensitivity: dict[str, dict[str, Any]] = {}
    for block in BOOTSTRAP_BLOCK_LENGTHS:
        deltas = bootstrap_deltas(high, low, block)
        ci90 = [round_int(nearest(deltas, 0.05)), round_int(nearest(deltas, 0.95))]
        ci95 = [round_int(nearest(deltas, 0.025)), round_int(nearest(deltas, 0.975))]
        sensitivity[str(block)] = {
            "block_length": block,
            "ci_90_lower": ci90[0],
            "ci_90_upper": ci90[1],
            "ci_95_lower": ci95[0],
            "ci_95_upper": ci95[1],
            "verdict": verdict_for_ci(ci90),
        }
    primary = sensitivity["5"]
    verdicts = [sensitivity[str(block)]["verdict"] for block in BOOTSTRAP_BLOCK_LENGTHS]
    stable = len(set(verdicts)) == 1 and verdicts[0] != "D"
    return {
        "equal_weight_delta_ppm": point,
        "ci_90_lower": primary["ci_90_lower"],
        "ci_90_upper": primary["ci_90_upper"],
        "ci_95_lower": primary["ci_95_lower"],
        "ci_95_upper": primary["ci_95_upper"],
        "block_length_5_verdict": sensitivity["5"]["verdict"],
        "block_length_3_verdict": sensitivity["3"]["verdict"],
        "block_length_7_verdict": sensitivity["7"]["verdict"],
        "block_length_stability_flag": stable,
        "block_length_sensitivity": sensitivity,
    }


def bootstrap_deltas(high: list[int], low: list[int], block: int) -> list[float]:
    rng = random.Random(BOOTSTRAP_SEED + block)
    out = []
    for _ in range(BOOTSTRAP_REPLICATIONS):
        high_sample = moving_block_sample(high, block, rng)
        low_sample = moving_block_sample(low, block, rng)
        out.append(mean(high_sample) - mean(low_sample))
    out.sort()
    return out


def moving_block_sample(values: list[int], block: int, rng: random.Random) -> list[int]:
    if len(values) < block:
        return [rng.choice(values) for _ in values]
    starts = list(range(0, len(values) - block + 1))
    sample: list[int] = []
    while len(sample) < len(values):
        start = rng.choice(starts)
        sample.extend(values[start : start + block])
    return sample[: len(values)]


def verdict_for_ci(ci90: list[int]) -> str:
    lower, upper = ci90
    if lower >= -SESOI_PPM and upper <= SESOI_PPM:
        return "A"
    if lower > SESOI_PPM:
        return "B_high"
    if upper < -SESOI_PPM:
        return "B_low"
    return "D"


def final_primary_verdict(high_low: dict[str, Any]) -> str:
    verdicts = [
        high_low["block_length_3_verdict"],
        high_low["block_length_5_verdict"],
        high_low["block_length_7_verdict"],
    ]
    if len(set(verdicts)) == 1 and verdicts[0] == "A":
        return "A"
    if len(set(verdicts)) == 1 and verdicts[0] in {"B_high", "B_low"}:
        return "B"
    return "D"


def build_mid_descriptive(per_session: list[dict[str, Any]], equal_weight: dict[str, dict[str, Any]]) -> dict[str, Any]:
    rows = [row for row in per_session if row["regime"] == "mid"]
    shares = [row["share_ppm"] for row in rows]
    loo = []
    for drop in range(len(rows)):
        kept = [row for index, row in enumerate(rows) if index != drop]
        loo.append({
            "excluded_session_id": rows[drop]["session_id"],
            "mean": round_int(mean([row["share_ppm"] for row in kept])),
            "sessions": [row["session_id"] for row in kept],
        })
    return {
        "sessions": [{"session_id": row["session_id"], "share_ppm": row["share_ppm"]} for row in rows],
        "mean": equal_weight["mid"]["mean"],
        "median": equal_weight["mid"]["median"],
        "min": equal_weight["mid"]["min"],
        "max": equal_weight["mid"]["max"],
        "loo_pair_means": loo,
    }


def build_twenty_one_plus(per_session: list[dict[str, Any]], probe_weighted: dict[str, dict[str, Any]]) -> dict[str, Any]:
    by_regime = {}
    warning = False
    for regime in REGIME_ORDER:
        rows = [row for row in per_session if row["regime"] == regime]
        comparable = sum(row["twenty_one_plus_comparable_probes"] for row in rows)
        within = sum(row["twenty_one_plus_within_tolerance_probes"] for row in rows)
        pooled = share_ppm(within, comparable)
        overall = probe_weighted[regime]["pooled_share"]
        triggered = (
            pooled is not None
            and overall is not None
            and pooled <= overall - TWENTY_ONE_PLUS_WARNING_DELTA_PPM
            and comparable >= TWENTY_ONE_PLUS_WARNING_MIN_PROBES
        )
        warning = warning or triggered
        by_regime[regime] = {
            "pooled_share": pooled,
            "comparable_probes": comparable,
            "within_tolerance_probes": within,
            "overall_pooled_share": overall,
            "warning_triggered": triggered,
            "warning_delta_ppm": TWENTY_ONE_PLUS_WARNING_DELTA_PPM,
            "warning_min_comparable_probes": TWENTY_ONE_PLUS_WARNING_MIN_PROBES,
        }
    return {"by_regime": by_regime, "warning_flag": warning}


def render_report(artifact: dict[str, Any]) -> str:
    eq = artifact["per_regime_equal_weight"]
    pw = artifact["per_regime_probe_weighted"]
    hl = artifact["high_low_delta"]
    mid = artifact["mid_descriptive"]
    twenty_one = artifact["twenty_one_plus_diagnostic"]
    return "\n".join([
        "# QFA-420 cross-regime queue-fidelity stratification",
        "",
        "## Status",
        "",
        f"Primary verdict: **{artifact['primary_verdict']}**.",
        "",
        "QFA-420 v1 applies ADR-0015 exactly: high-vs-low is the only",
        "load-bearing contrast, mid is descriptive-only, and the TOST",
        f"SESOI is +/-{SESOI_PPM:,} ppm.",
        "",
        "## Scope discipline",
        "",
        "- ADR-0011 threshold/tolerance preserved: 800,000 ppm / +/-100,000 ppm.",
        "- ADR-0012 probe policy preserved: 15s fill horizon, 60s depletion lookback, mbp_trades_proxy.",
        "- ADR-0013 / ADR-0014 regime substrate consumed as-is from `artifacts/regime/regime-labels.json`.",
        "- No QFA-105, QFA-402 formula, RunSpec, journal, or determinism-gate changes.",
        "- `regime-labels.json` remains research-tier; LD-420-7 promotion is a follow-up path only.",
        "",
        "## Source inputs",
        "",
        f"- Regime substrate hash: `{artifact['input_substrate_hash']}`",
        *[f"- {month} manifest: `{value}`" for month, value in artifact["input_manifest_hashes"].items()],
        "",
        "## Calibration-eligible session counts",
        "",
        "| Regime | Sessions |",
        "|---|---:|",
        *[f"| {regime} | {eq[regime]['n']} |" for regime in REGIME_ORDER],
        "",
        "## Per-regime equal-weight summary",
        "",
        "| Regime | n | Mean ppm | Median ppm | Min ppm | Max ppm |",
        "|---|---:|---:|---:|---:|---:|",
        *[
            f"| {regime} | {eq[regime]['n']} | {eq[regime]['mean']:,} | {eq[regime]['median']:,} | {eq[regime]['min']:,} | {eq[regime]['max']:,} |"
            for regime in REGIME_ORDER
        ],
        "",
        "## Per-regime probe-weighted sensitivity",
        "",
        "| Regime | Pooled share ppm | Comparable probes | Within-tolerance probes |",
        "|---|---:|---:|---:|",
        *[
            f"| {regime} | {pw[regime]['pooled_share']:,} | {pw[regime]['comparable_probes']:,} | {pw[regime]['within_tolerance_probes']:,} |"
            for regime in REGIME_ORDER
        ],
        "",
        "## High-vs-low TOST bootstrap",
        "",
        f"Equal-weight delta(high - low): `{hl['equal_weight_delta_ppm']:,}` ppm.",
        "",
        "| Block length | 90% CI lower | 90% CI upper | 95% CI lower | 95% CI upper | Verdict |",
        "|---:|---:|---:|---:|---:|---|",
        *[
            f"| {block} | {hl['block_length_sensitivity'][str(block)]['ci_90_lower']:,} | {hl['block_length_sensitivity'][str(block)]['ci_90_upper']:,} | {hl['block_length_sensitivity'][str(block)]['ci_95_lower']:,} | {hl['block_length_sensitivity'][str(block)]['ci_95_upper']:,} | {hl['block_length_sensitivity'][str(block)]['verdict']} |"
            for block in BOOTSTRAP_BLOCK_LENGTHS
        ],
        "",
        f"Block-length stability flag: `{str(hl['block_length_stability_flag']).lower()}`.",
        "",
        "## Mid-regime descriptive statistics",
        "",
        "- mid_regime_status: `screening_floor`",
        "- mid_regime_inference: `descriptive_only`",
        f"- mid_anomaly_flag: `{str(artifact['mid_anomaly_flag']).lower()}`",
        "",
        "| Session | Share ppm |",
        "|---|---:|",
        *[f"| {row['session_id']} | {row['share_ppm']:,} |" for row in mid["sessions"]],
        "",
        "| Statistic | Value ppm |",
        "|---|---:|",
        f"| mean | {mid['mean']:,} |",
        f"| median | {mid['median']:,} |",
        f"| min | {mid['min']:,} |",
        f"| max | {mid['max']:,} |",
        "",
        "Leave-one-out pair means:",
        "",
        "| Excluded session | Pair mean ppm | Pair sessions |",
        "|---|---:|---|",
        *[
            f"| {row['excluded_session_id']} | {row['mean']:,} | {', '.join(row['sessions'])} |"
            for row in mid["loo_pair_means"]
        ],
        "",
        "## 21+ visible-queue-ahead diagnostic",
        "",
        f"Warning flag: `{str(artifact['twenty_one_plus_warning_flag']).lower()}`.",
        "",
        "| Regime | 21+ pooled share ppm | 21+ comparable probes | Overall pooled share ppm | Warning |",
        "|---|---:|---:|---:|---|",
        *[
            f"| {regime} | {fmt_ppm(twenty_one[regime]['pooled_share'])} | {twenty_one[regime]['comparable_probes']:,} | {fmt_ppm(twenty_one[regime]['overall_pooled_share'])} | {str(twenty_one[regime]['warning_triggered']).lower()} |"
            for regime in REGIME_ORDER
        ],
        "",
        "## Per-session results",
        "",
        "| Session | Regime | Share ppm | Comparable probes | Within-tolerance probes | 21+ comparable | 21+ share ppm |",
        "|---|---|---:|---:|---:|---:|---:|",
        *[
            f"| {row['session_id']} | {row['regime']} | {row['share_ppm']:,} | {row['comparable_probes']:,} | {row['within_tolerance_probes']:,} | {row['twenty_one_plus_comparable_probes']:,} | {fmt_ppm(row['twenty_one_plus_share_ppm'])} |"
            for row in artifact["per_session"]
        ],
        "",
        "## Downstream implication",
        "",
        downstream(artifact),
        "",
    ])


def downstream(artifact: dict[str, Any]) -> str:
    verdict = artifact["primary_verdict"]
    if verdict == "A":
        return "Outcome A: QFA-510 readiness review and QFA-420-h1 determinism promotion are the next coordinator actions per ADR-0015 LD-420-7."
    if verdict == "B":
        return "Outcome B: coordinator walkthrough required before QFA-510; material high-vs-low divergence is stable at the SESOI scale."
    return "Outcome D: inconclusive at the SESOI scale; coordinator decision required between accept-as-v1 and ADR-0014 LD-212-9 reactivation."


def month_short(session_id: str) -> str:
    month = session_id[:7]
    if month not in MANIFEST_SHORT_NAMES:
        raise ValueError(f"unknown session month: {session_id}")
    return MANIFEST_SHORT_NAMES[month]


def mean(values: list[int]) -> float:
    return sum(values) / len(values)


def round_int(value: float) -> int:
    return int(round(value))


def nearest(sorted_values: list[float], q: float) -> float:
    index = min(len(sorted_values) - 1, max(0, math.ceil(len(sorted_values) * q) - 1))
    return sorted_values[index]


def share_ppm(within: int, comparable: int) -> int | None:
    if comparable == 0:
        return None
    return (within * PPM_DENOMINATOR) // comparable


def fmt_ppm(value: int | None) -> str:
    return "n/a" if value is None else f"{value:,}"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


if __name__ == "__main__":
    raise SystemExit(main())
