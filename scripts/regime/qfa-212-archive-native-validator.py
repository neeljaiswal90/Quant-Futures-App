#!/usr/bin/env python
"""QFA-212 VIX-primary regime substrate and archive-native validation."""

from __future__ import annotations

import hashlib
import json
import math
import random
import sys
from pathlib import Path
from typing import Any

import databento as db

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = Path("D:/qfa-cache/databento/tier-a-feb-mar-2026")
SNAPSHOT = ROOT / "config/research/vix-vxn-daily-2025-09-to-2026-04.json"
THRESHOLDS = ROOT / "config/sim03/corpus-integrity-thresholds.json"
LABELS_OUT = ROOT / "artifacts/regime/regime-labels.json"
REPORT_OUT = ROOT / "docs/research/qfa-212-archive-native-validation.md"
JSON_OUT = ROOT / ".tmp/qfa-212-archive-native-validation.json"
RV_CACHE = ROOT / ".tmp/qfa-212-rv-cache.json"

HASHES = {
    "2026-02": "05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c",
    "2026-03": "cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f",
}
FIVE_MIN_NS = 300_000_000_000
FULL_RTH_NS = 23_400_000_000_000
VIX_WINDOW = 60
RV_SMOOTH = 10
RV_ROLLING_REQUIRED = 70
BLOCK = 5
BOOT = 2000
PROXY_RV20 = 0.5
MAX_DIVERGENCE = 0.2
LABELS = ("low", "mid", "high")


def main() -> int:
    snapshot = read_snapshot()
    thresholds = read_json(THRESHOLDS)
    sessions = read_sessions()
    quality_exclusions = thresholds.get("quality_exclusions", {})
    rv_by_session = compute_all_rv(sessions)
    labels = build_labels(snapshot, sessions, quality_exclusions, rv_by_session)
    validation = build_validation(snapshot, sessions, labels, rv_by_session)
    artifact = build_label_artifact(snapshot, sessions, labels, validation)
    report = render_report(snapshot, sessions, labels, validation)
    write_json(LABELS_OUT, artifact)
    write_json(JSON_OUT, validation)
    REPORT_OUT.parent.mkdir(parents=True, exist_ok=True)
    REPORT_OUT.write_text(report, encoding="utf-8")
    rate = validation["archive_native_validation"]["vix_vs_mnq_rv"]["agreement_rate"]
    material = rate is None or abs(rate - PROXY_RV20) > MAX_DIVERGENCE
    print(json.dumps({
        "status": "material_divergence" if material else "ok",
        "agreement_rate": rate,
        "labels": str(LABELS_OUT),
        "validation_markdown": str(REPORT_OUT),
        "validation_json": str(JSON_OUT),
    }, indent=2))
    return 2 if material else 0


def read_snapshot() -> dict[str, Any]:
    if not SNAPSHOT.exists():
        raise SystemExit(f"missing pinned VIX/VXN snapshot: {SNAPSHOT}")
    snapshot = read_json(SNAPSHOT)
    if snapshot.get("schema_version") != 1:
        raise ValueError("snapshot schema_version must be 1")
    for series_id in ("VIXCLS", "VXNCLS"):
        rows = snapshot.get("series", {}).get(series_id)
        if not isinstance(rows, list) or len(rows) < 100:
            raise ValueError(f"{series_id} missing warmup-sized rows")
        if snapshot.get("row_counts", {}).get(series_id) != len(rows):
            raise ValueError(f"{series_id} row_counts mismatch")
        prior = ""
        for row in rows:
            if not isinstance(row.get("date"), str) or len(row["date"]) != 10:
                raise ValueError(f"{series_id} invalid date")
            if not isinstance(row.get("value"), (int, float)) or not math.isfinite(row["value"]):
                raise ValueError(f"{series_id} invalid value at {row.get('date')}")
            if prior and row["date"] <= prior:
                raise ValueError(f"{series_id} rows must be sorted")
            prior = row["date"]
    return snapshot


def read_sessions() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for month, short in (("2026-02", "feb"), ("2026-03", "mar")):
        path = ARCHIVE / f"manifest-{short}-2026.json"
        actual = sha256_file(path)
        if actual != HASHES[month]:
            raise ValueError(f"manifest hash mismatch for {month}: {actual}")
        manifest = read_json(path)
        for session in manifest["sessions"]:
            mbp1 = session.get("schemas", {}).get("mbp-1")
            if session.get("status") != "complete" or not mbp1 or mbp1.get("status") != "available":
                continue
            out.append({
                "session_id": session["session_id"],
                "month": month,
                "symbol": session["symbol"],
                "split": session["split"],
                "rth_start_ns": int(session["rth_window"]["start_ts_ns"]),
                "rth_end_ns": int(session["rth_window"]["end_ts_ns"]),
                "mbp1_path": str(Path(mbp1["path"]) if Path(mbp1["path"]).is_absolute() else ARCHIVE / mbp1["path"]),
                "mbp1_byte_count": mbp1["byte_count"],
            })
    return sorted(out, key=lambda item: item["session_id"])


def compute_all_rv(sessions: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    cache = read_json(RV_CACHE) if RV_CACHE.exists() else {}
    cache_key = hashlib.sha256(json.dumps({"hashes": HASHES, "sessions": [s["session_id"] for s in sessions]}, sort_keys=True).encode()).hexdigest()
    if cache.get("cache_key") != cache_key:
        cache = {"cache_key": cache_key, "rv_by_session": {}}
    rv_by_session: dict[str, dict[str, Any]] = dict(cache.get("rv_by_session", {}))
    for session in sessions:
        sid = session["session_id"]
        if sid in rv_by_session:
            print(f"[qfa-212] RV {sid} cached")
            continue
        print(f"[qfa-212] RV {sid}")
        rv_by_session[sid] = compute_session_rv(session)
        cache["rv_by_session"] = rv_by_session
        write_json(RV_CACHE, cache)
    return rv_by_session

def compute_session_rv(session: dict[str, Any]) -> dict[str, Any]:
    closes: dict[int, float] = {}
    scanned = 0
    store = db.DBNStore.from_file(session["mbp1_path"])
    for record in store:
        scanned += 1
        ts_event = int(record.ts_event)
        if ts_event < session["rth_start_ns"] or ts_event >= session["rth_end_ns"]:
            continue
        if not record.levels:
            continue
        bid = int(record.levels[0].bid_px)
        ask = int(record.levels[0].ask_px)
        if bid <= 0 or ask <= 0:
            continue
        bucket = session["rth_start_ns"] + ((ts_event - session["rth_start_ns"]) // FIVE_MIN_NS) * FIVE_MIN_NS
        closes[bucket] = (bid + ask) / 2.0
    bars = sorted(closes.items())
    if len(bars) < 2:
        return {
            "session_id": session["session_id"],
            "raw_rv": None,
            "bar_count": len(bars),
            "return_count": 0,
            "first_bar_ts_ns": str(bars[0][0]) if bars else None,
            "last_bar_ts_ns": str(bars[-1][0]) if bars else None,
            "mbp1_records_scanned": scanned,
        }
    sum_sq = 0.0
    for index in range(1, len(bars)):
        prior = bars[index - 1][1]
        current = bars[index][1]
        ret = math.log(current / prior)
        sum_sq += ret * ret
    return {
        "session_id": session["session_id"],
        "raw_rv": round(math.sqrt(sum_sq), 12),
        "bar_count": len(bars),
        "return_count": len(bars) - 1,
        "first_bar_ts_ns": str(bars[0][0]),
        "last_bar_ts_ns": str(bars[-1][0]),
        "mbp1_records_scanned": scanned,
    }


def build_labels(snapshot: dict[str, Any], sessions: list[dict[str, Any]], exclusions: dict[str, Any], rv_by_session: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    smooth = smoothed_rv(sessions, rv_by_session)
    smooth_values = sorted(value for value in smooth.values() if value is not None)
    confirmed: str | None = None
    pending_target: str | None = None
    pending_count = 0
    out: list[dict[str, Any]] = []
    for session in sessions:
        session_date = session["session_id"][:10]
        primary = prior_observation(snapshot["series"]["VIXCLS"], session_date)
        primary_percentile = rolling_percentile(snapshot["series"]["VIXCLS"], primary["date"], VIX_WINDOW) if primary else None
        raw_label = label_from_percentile(primary_percentile) if primary_percentile is not None else None
        label_status = "available" if raw_label is not None else "warmup_unavailable"
        transition_pending = False
        if raw_label is not None:
            confirmed, pending_target, pending_count, transition_pending = apply_hysteresis(
                confirmed,
                raw_label,
                primary_percentile,
                pending_target,
                pending_count,
            )
        vxn = prior_observation(snapshot["series"]["VXNCLS"], session_date)
        vxn_percentile = rolling_percentile(snapshot["series"]["VXNCLS"], vxn["date"], VIX_WINDOW) if vxn else None
        secondary_value = smooth.get(session["session_id"])
        secondary_percentile = percentile_within_sorted(smooth_values, secondary_value) if secondary_value is not None else None
        quality = exclusions.get(session["session_id"])
        partial = session["rth_end_ns"] - session["rth_start_ns"] < FULL_RTH_NS
        out.append({
            "session_id": session["session_id"],
            "label_status": label_status,
            "confirmed_label": confirmed if label_status == "available" else None,
            "raw_label": raw_label,
            "primary_value": primary["value"] if primary else None,
            "primary_percentile": primary_percentile,
            "primary_prior_close_date": primary["date"] if primary else None,
            "vxn_value": vxn["value"] if vxn else None,
            "vxn_percentile": vxn_percentile,
            "vxn_raw_label": label_from_percentile(vxn_percentile) if vxn_percentile is not None else None,
            "secondary_value": secondary_value,
            "secondary_raw_rv": rv_by_session[session["session_id"]]["raw_rv"],
            "secondary_percentile": secondary_percentile,
            "secondary_label": label_from_percentile(secondary_percentile) if secondary_percentile is not None else None,
            "secondary_percentile_basis": "within_window" if secondary_value is not None else None,
            "secondary_percentile_window_sessions": len(smooth_values) if secondary_value is not None else None,
            "secondary_status": "available" if secondary_value is not None else "warmup_unavailable",
            "disagreement_score": round(abs(primary_percentile - secondary_percentile), 6) if primary_percentile is not None and secondary_percentile is not None else None,
            "transition_pending": transition_pending,
            "partial_session": partial,
            "quality_excluded": quality is not None,
            "quality_exclusion_reason": quality.get("reason") if isinstance(quality, dict) else None,
            "use_for_calibration": label_status == "available" and not partial and quality is None,
        })
    return out


def smoothed_rv(sessions: list[dict[str, Any]], rv_by_session: dict[str, dict[str, Any]]) -> dict[str, float | None]:
    raw = [rv_by_session[session["session_id"]]["raw_rv"] for session in sessions]
    out: dict[str, float | None] = {}
    for index, session in enumerate(sessions):
        if index + 1 < RV_SMOOTH:
            out[session["session_id"]] = None
            continue
        window = raw[index + 1 - RV_SMOOTH : index + 1]
        out[session["session_id"]] = None if any(value is None for value in window) else round(sum(window) / len(window), 12)
    return out


def apply_hysteresis(confirmed: str | None, raw_label: str, percentile: float, pending_target: str | None, pending_count: int) -> tuple[str, str | None, int, bool]:
    if confirmed is None:
        return raw_label, None, 0, False
    if raw_label == confirmed:
        return confirmed, None, 0, False
    target = adjacent_target(confirmed, raw_label)
    ok = transition_condition(confirmed, target, percentile)
    next_count = (pending_count + 1 if pending_target == target else 1) if ok else 0
    if next_count >= 2:
        return target, None, 0, False
    return confirmed, target, next_count, True


def adjacent_target(current: str, raw_label: str) -> str:
    current_index = LABELS.index(current)
    raw_index = LABELS.index(raw_label)
    return LABELS[current_index + (1 if raw_index > current_index else -1)]


def transition_condition(current: str, target: str, percentile: float) -> bool:
    if current == "low" and target == "mid":
        return percentile >= 0.40
    if current == "mid" and target == "high":
        return percentile >= 0.70
    if current == "high" and target == "mid":
        return percentile <= 0.60
    if current == "mid" and target == "low":
        return percentile <= 0.30
    return False

def build_validation(snapshot: dict[str, Any], sessions: list[dict[str, Any]], labels: list[dict[str, Any]], rv_by_session: dict[str, dict[str, Any]]) -> dict[str, Any]:
    calibration = [label for label in labels if label["use_for_calibration"]]
    vix_rv_pairs = [(label["raw_label"], label["secondary_label"]) for label in calibration if label["raw_label"] and label["secondary_label"]]
    vix_vxn_pairs = [(label["raw_label"], label["vxn_raw_label"]) for label in calibration if label["raw_label"] and label["vxn_raw_label"]]
    vix_rv = agreement(vix_rv_pairs)
    vix_vxn = agreement(vix_vxn_pairs)
    primary_values = [label["primary_value"] for label in calibration if label["primary_value"] is not None]
    secondary_values = [label["secondary_value"] for label in calibration if label["secondary_value"] is not None]
    disagreements = [label["disagreement_score"] for label in calibration if label["disagreement_score"] is not None]
    return {
        "schema_version": 1,
        "ticket": "QFA-212",
        "methodology": ["ADR-0013", "ADR-0014"],
        "source_snapshot": {
            "path": rel(SNAPSHOT),
            "sha256": sha256_file(SNAPSHOT),
            "fetched_at_utc": snapshot["fetched_at_utc"],
            "source": snapshot["source"],
            "row_counts": snapshot["row_counts"],
        },
        "archive": {
            "root": str(ARCHIVE),
            "source_manifests": HASHES,
            "sessions_total": len(sessions),
            "session_range": {"first": sessions[0]["session_id"], "last": sessions[-1]["session_id"]},
        },
        "secondary_basis": {
            "selected_basis": "within_window",
            "reason": "ADR-0014: 41-session archive cannot populate rolling 60-session secondary percentile",
            "smoother_sessions": RV_SMOOTH,
            "smoothed_available_sessions": sum(1 for label in labels if label["secondary_status"] == "available"),
            "rolling_60_available_sessions": max(0, len(sessions) - (RV_ROLLING_REQUIRED - 1)),
        },
        "label_counts": {
            "confirmed": count_labels([label["confirmed_label"] for label in labels]),
            "raw_primary": count_labels([label["raw_label"] for label in labels]),
            "secondary": count_labels([label["secondary_label"] for label in labels]),
            "vxn": count_labels([label["vxn_raw_label"] for label in labels]),
            "transition_pending": sum(1 for label in labels if label["transition_pending"]),
            "quality_excluded": sum(1 for label in labels if label["quality_excluded"]),
            "use_for_calibration": sum(1 for label in labels if label["use_for_calibration"]),
            "partial_session": sum(1 for label in labels if label["partial_session"]),
        },
        "archive_native_validation": {
            "public_proxy_reference": {
                "vix_vs_public_proxy_rv20_agreement": PROXY_RV20,
                "material_divergence_threshold_percentage_points": MAX_DIVERGENCE,
            },
            "vix_vs_mnq_rv": vix_rv,
            "vix_vs_vxn": vix_vxn,
            "material_divergence": vix_rv["agreement_rate"] is None or abs(vix_rv["agreement_rate"] - PROXY_RV20) > MAX_DIVERGENCE,
        },
        "distributions": {
            "primary_value": distribution(primary_values),
            "secondary_value": distribution(secondary_values),
            "disagreement_score": distribution(disagreements),
            "mean_primary_minus_secondary_percentile": mean_or_none([
                round(label["primary_percentile"] - label["secondary_percentile"], 6)
                for label in calibration
                if label["primary_percentile"] is not None and label["secondary_percentile"] is not None
            ]),
        },
        "cut_value_bootstrap_ci_95": {
            "primary_vix_33": bootstrap_quantile_ci(primary_values, 0.33),
            "primary_vix_67": bootstrap_quantile_ci(primary_values, 0.67),
            "secondary_rv10_33": bootstrap_quantile_ci(secondary_values, 0.33),
            "secondary_rv10_67": bootstrap_quantile_ci(secondary_values, 0.67),
        },
        "rv_diagnostics": [rv_by_session[session["session_id"]] for session in sessions],
    }


def build_label_artifact(snapshot: dict[str, Any], sessions: list[dict[str, Any]], labels: list[dict[str, Any]], validation: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "methodology": ["ADR-0013", "ADR-0014"],
        "label_scope": "per_session",
        "source_manifests": HASHES,
        "source_series": {
            "path": rel(SNAPSHOT),
            "sha256": sha256_file(SNAPSHOT),
            "fetched_at_utc": snapshot["fetched_at_utc"],
            "source": snapshot["source"],
            "source_endpoint_template": snapshot["source_endpoint_template"],
            "fetch_parameters": snapshot["fetch_parameters"],
            "row_counts": snapshot["row_counts"],
        },
        "primary_substrate": {
            "series_id": "VIXCLS",
            "value_timing": "previous_trading_day_close",
            "percentile_basis": "rolling_60_sessions",
            "raw_cutpoints": {"low_mid": 0.33, "mid_high": 0.67},
            "hysteresis": {"confirmation_sessions": 2, "low_to_mid": 0.40, "mid_to_high": 0.70, "high_to_mid": 0.60, "mid_to_low": 0.30},
        },
        "secondary_substrate": {
            "source": "MNQ RTH MBP-1 mid-quote",
            "bar_interval_minutes": 5,
            "smoother_sessions": RV_SMOOTH,
            "percentile_basis": "within_window",
            "percentile_window_sessions": sum(1 for label in labels if label["secondary_status"] == "available"),
            "rolling_60_available_sessions": max(0, len(sessions) - (RV_ROLLING_REQUIRED - 1)),
            "adr_0014_caveat": "within-window captures within-archive stratification, not rolling-60 regime drift",
        },
        "validation_summary": validation["archive_native_validation"],
        "labels": labels,
    }

def render_report(snapshot: dict[str, Any], sessions: list[dict[str, Any]], labels: list[dict[str, Any]], validation: dict[str, Any]) -> str:
    vix_rv = validation["archive_native_validation"]["vix_vs_mnq_rv"]
    vix_vxn = validation["archive_native_validation"]["vix_vs_vxn"]
    material = validation["archive_native_validation"]["material_divergence"]
    basis = validation["secondary_basis"]
    session_rows = [
        f"| {label['session_id']} | {label['confirmed_label'] or 'n/a'} | {label['raw_label'] or 'n/a'} | {fmt(label['primary_percentile'])} | {label['secondary_label'] or 'n/a'} | {fmt(label['secondary_percentile'])} | {fmt(label['disagreement_score'])} | {'yes' if label['quality_excluded'] else 'no'} | {'yes' if label['use_for_calibration'] else 'no'} |"
        for label in labels
    ]
    lines = [
        "# QFA-212 archive-native regime substrate validation",
        "",
        "## Status",
        "",
        "Research finding: archive-native VIX vs MNQ-RV agreement diverges materially from the public-proxy reference. QFA-420 remains blocked pending ADR-0014 review." if material else "PASS: archive-native validation is within the ADR-0014 20 percentage-point divergence bound. QFA-420 dispatch is unblocked from the substrate-validation perspective.",
        "",
        "## Scope discipline",
        "",
        "- ADR-0013 methodology applied with ADR-0014 archive-size refinement.",
        "- Primary label is VIX previous trading day close with rolling 60-session percentile.",
        "- Secondary diagnostic is MNQ RTH MBP-1 mid-quote RV, 5-minute bars, 10-session smoother.",
        "- Secondary percentile basis is explicitly `within_window` because the archive has 41 sessions.",
        "- No QFA-105, QFA-402, RunSpec, journal, corpus manifest, or determinism-gate changes.",
        "",
        "## Source inputs",
        "",
        f"- VIX/VXN snapshot: `{rel(SNAPSHOT)}`",
        f"- Snapshot vintage: `{snapshot['fetched_at_utc']}`",
        f"- VIX rows: {snapshot['row_counts']['VIXCLS']}",
        f"- VXN rows: {snapshot['row_counts']['VXNCLS']}",
        f"- Archive sessions: {len(sessions)} ({sessions[0]['session_id']} to {sessions[-1]['session_id']})",
        f"- Feb manifest: {HASHES['2026-02']}",
        f"- Mar manifest: {HASHES['2026-03']}",
        "",
        "## Secondary basis",
        "",
        f"- selected_basis: `{basis['selected_basis']}`",
        f"- smoothed_available_sessions: {basis['smoothed_available_sessions']}",
        f"- rolling_60_available_sessions: {basis['rolling_60_available_sessions']}",
        "- caveat: within-window captures within-archive stratification, not rolling-60 regime drift.",
        "",
        "## Archive-native contingency validation",
        "",
        "| Matrix | Comparable sessions | Agreement | 95% CI | Reference | Result |",
        "|---|---:|---:|---:|---:|---|",
        f"| VIX vs MNQ-RV | {vix_rv['comparable_sessions']} | {rate(vix_rv['agreement_rate'])} | {ci(vix_rv['bootstrap_ci_95'])} | public-proxy RV20 50.0% +/- 20pp | {'material divergence' if material else 'within bound'} |",
        f"| VIX vs VXN | {vix_vxn['comparable_sessions']} | {rate(vix_vxn['agreement_rate'])} | {ci(vix_vxn['bootstrap_ci_95'])} | proxy diagnostic ~97.6% | diagnostic only |",
        "",
        "### VIX vs MNQ-RV matrix",
        "",
        matrix(vix_rv["matrix"]),
        "",
        "### VIX vs VXN matrix",
        "",
        matrix(vix_vxn["matrix"]),
        "",
        "## Counts",
        "",
        "```json",
        json.dumps(validation["label_counts"], indent=2),
        "```",
        "",
        "## Distribution diagnostics",
        "",
        "```json",
        json.dumps(validation["distributions"], indent=2),
        "```",
        "",
        "## Cut value bootstrap CIs",
        "",
        "```json",
        json.dumps(validation["cut_value_bootstrap_ci_95"], indent=2),
        "```",
        "",
        "## Per-session labels",
        "",
        "| Session | Confirmed | Raw VIX | VIX percentile | RV label | RV percentile | Disagreement | Quality excluded | Calibration |",
        "|---|---|---|---:|---|---:|---:|---|---|",
        *session_rows,
        "",
        "## Recommendation",
        "",
        "Do not dispatch QFA-420 yet. Run ADR-0014 review because archive-native agreement breached the preserved 20pp divergence threshold." if material else "Proceed to QFA-420. The substrate validation reproduces the public-proxy pattern within the ADR-0014 divergence bound, with the secondary basis caveat carried explicitly.",
        "",
    ]
    return "\n".join(lines)


def agreement(pairs: list[tuple[str, str]]) -> dict[str, Any]:
    mat = empty_matrix()
    agree = 0
    for left, right in pairs:
        mat[left][right] += 1
        if left == right:
            agree += 1
    return {
        "comparable_sessions": len(pairs),
        "agreement_count": agree,
        "agreement_rate": round(agree / len(pairs), 6) if pairs else None,
        "bootstrap_ci_95": bootstrap_agreement_ci(pairs) if pairs else None,
        "matrix": mat,
    }


def bootstrap_agreement_ci(pairs: list[tuple[str, str]]) -> list[float]:
    starts = [i for i in range(0, max(1, len(pairs) - BLOCK + 1))]
    if not starts:
        point = sum(1 for left, right in pairs if left == right) / len(pairs)
        return [round(point, 6), round(point, 6)]
    rng = random.Random(212008)
    values = []
    blocks = math.ceil(len(pairs) / BLOCK)
    for _ in range(BOOT):
        sample: list[tuple[str, str]] = []
        for _block in range(blocks):
            start = rng.choice(starts)
            for offset in range(BLOCK):
                if len(sample) >= len(pairs):
                    break
                sample.append(pairs[start + offset])
        values.append(sum(1 for left, right in sample if left == right) / len(sample))
    values.sort()
    return [round(nearest(values, 0.025), 6), round(nearest(values, 0.975), 6)]


def bootstrap_quantile_ci(values: list[float], q: float) -> list[float] | None:
    if not values:
        return None
    sorted_values = sorted(values)
    if len(sorted_values) < BLOCK:
        point = nearest(sorted_values, q)
        return [round(point, 12), round(point, 12)]
    starts = [i for i in range(0, len(sorted_values) - BLOCK + 1)]
    rng = random.Random(212009 + round(q * 1000))
    blocks = math.ceil(len(sorted_values) / BLOCK)
    boot = []
    for _ in range(BOOT):
        sample: list[float] = []
        for _block in range(blocks):
            start = rng.choice(starts)
            for offset in range(BLOCK):
                if len(sample) >= len(sorted_values):
                    break
                sample.append(sorted_values[start + offset])
        boot.append(nearest(sorted(sample), q))
    boot.sort()
    return [round(nearest(boot, 0.025), 12), round(nearest(boot, 0.975), 12)]

def rolling_percentile(series: list[dict[str, Any]], date: str, count: int) -> float | None:
    index = next((i for i, row in enumerate(series) if row["date"] == date), -1)
    if index < count - 1:
        return None
    window = sorted(row["value"] for row in series[index + 1 - count : index + 1])
    return percentile_within_sorted(window, series[index]["value"])


def percentile_within_sorted(sorted_values: list[float], value: float) -> float:
    return round(sum(1 for candidate in sorted_values if candidate <= value) / len(sorted_values), 6)


def prior_observation(series: list[dict[str, Any]], date: str) -> dict[str, Any] | None:
    candidate = None
    for row in series:
        if row["date"] >= date:
            break
        candidate = row
    return candidate


def label_from_percentile(percentile: float) -> str:
    if percentile < 0.33:
        return "low"
    if percentile < 0.67:
        return "mid"
    return "high"


def distribution(values: list[float]) -> dict[str, Any]:
    sorted_values = sorted(values)
    return {
        "count": len(sorted_values),
        "mean": mean_or_none(sorted_values),
        "min": sorted_values[0] if sorted_values else None,
        "p33": round(nearest(sorted_values, 0.33), 12) if sorted_values else None,
        "median": round(nearest(sorted_values, 0.5), 12) if sorted_values else None,
        "p67": round(nearest(sorted_values, 0.67), 12) if sorted_values else None,
        "max": sorted_values[-1] if sorted_values else None,
    }


def count_labels(values: list[str | None]) -> dict[str, int]:
    return {
        "low": sum(1 for value in values if value == "low"),
        "mid": sum(1 for value in values if value == "mid"),
        "high": sum(1 for value in values if value == "high"),
        "null": sum(1 for value in values if value is None),
    }


def empty_matrix() -> dict[str, dict[str, int]]:
    return {"low": {"low": 0, "mid": 0, "high": 0}, "mid": {"low": 0, "mid": 0, "high": 0}, "high": {"low": 0, "mid": 0, "high": 0}}


def matrix(mat: dict[str, dict[str, int]]) -> str:
    return "\n".join([
        "| VIX \\ Other | low | mid | high |",
        "|---|---:|---:|---:|",
        *[f"| {row} | {mat[row]['low']} | {mat[row]['mid']} | {mat[row]['high']} |" for row in LABELS],
    ])


def mean_or_none(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 12) if values else None


def nearest(sorted_values: list[float], q: float) -> float:
    return sorted_values[min(len(sorted_values) - 1, max(0, math.ceil(len(sorted_values) * q) - 1))]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def fmt(value: Any) -> str:
    return "n/a" if value is None else f"{float(value):.6f}"


def rate(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def ci(value: list[float] | None) -> str:
    return "n/a" if value is None else f"{rate(value[0])} - {rate(value[1])}"


if __name__ == "__main__":
    raise SystemExit(main())
