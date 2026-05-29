"""Generate the static MNQ dashboard HTML."""

from __future__ import annotations

import argparse
import logging
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any, TypeVar

from rithmic_dashboard.audit_trail import (
    add_confluence_break_events,
    add_day_type_events,
    add_level_touch_events,
    add_live_signal_events,
    confluence_state_id,
    dedupe_audit_entries,
    dump_audit_entries,
    load_audit_entries,
)
from rithmic_dashboard.confluence import compute_confluence_groups
from rithmic_dashboard.data_sources import get_current_price, load_envelope
from rithmic_dashboard.features.calibration_log import (
    append_completed_outcomes,
    append_probability_snapshots,
)
from rithmic_dashboard.features.day_type_classifier import (
    append_day_type_outcome,
    compute_day_type_classification,
)
from rithmic_dashboard.features.live_signals import compute_live_signals
from rithmic_dashboard.features.orderflow_pulse import compute_orderflow_pulse
from rithmic_dashboard.features.posture_synthesis import synthesize_active_posture
from rithmic_dashboard.legacy_v1.dashboard_renderer import render_dashboard, render_error_page
from rithmic_dashboard.level_distances import compute_level_distances
from rithmic_dashboard.models import (
    ActivePosture,
    AuditEntry,
    ConfluenceGroup,
    DashboardSession,
    DataWarning,
    DayTypeClassification,
    LevelDistance,
    LiveSignals,
    OrderflowPulse,
    ScenarioState,
    SessionSignals,
)
from rithmic_dashboard.scenario_state import compute_scenario_states, reset_store_for_session
from rithmic_dashboard.session_signals import compute_session_signals
from rithmic_dashboard.session_state import PT, determine_session_state
from rithmic_dashboard.state_store import dashboard_state_paths, load_json_state, save_json_state

T = TypeVar("T")

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ANALYTICS_ROOT = PROJECT_ROOT.parent / "rithmic_analytics"
DEFAULT_OUTPUT = PROJECT_ROOT / "data" / "dashboard" / "index.html"


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""

    args = parse_args(argv)
    start = time.perf_counter()
    output_path = args.output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _configure_logging(output_path.parent)
    logger = logging.getLogger("rithmic_dashboard")
    now_pt = _parse_now(args.now_pt)
    warnings: list[DataWarning] = []

    try:
        session = determine_session_state(
            now_pt=now_pt,
            analytics_root=args.analytics_root,
            trading_date_override=args.trading_date,
            session_override=args.session,
        )
        state_paths = dashboard_state_paths(output_path.parent)
        paused = state_paths["pause"].exists()
        state = load_json_state(state_paths["state"], {})
        scenario_store = load_json_state(state_paths["scenarios"], {})
        scenario_store = reset_store_for_session(scenario_store, session.key)
        audit = load_audit_entries(load_json_state(state_paths["audit"], {"entries": []}))

        envelope, zones_path, envelope_warnings = load_envelope(
            session.zones_path,
            analytics_root=args.analytics_root,
        )
        warnings.extend(envelope_warnings)
        warnings.extend(_freshness_warnings(zones_path, session))

        last_known_price = _last_known_price(state)
        price_snapshot = get_current_price(
            session.capture_path,
            fallback_capture_root=args.analytics_root / "data" / "captures",
            last_known_price=last_known_price,
        )
        warnings.extend(price_snapshot.warnings)
        if price_snapshot.event_time_pt is not None:
            age_min = (session.now_pt - price_snapshot.event_time_pt).total_seconds() / 60.0
            if age_min > 15.0:
                warnings.append(
                    DataWarning("warn", f"Price print is stale: {age_min:.1f} min old.")
                )

        current_price = price_snapshot.price
        if current_price is None and envelope is not None:
            current_price = _number(envelope.get("vpoc"), 0.0)
            warnings.append(DataWarning("warn", "Using VPOC as display price fallback."))

        atr = _resolve_atr(envelope, warnings)
        distances: list[LevelDistance] = _safe(
            "level distances",
            warnings,
            lambda: compute_level_distances(
                envelope or {},
                float(current_price or 0.0),
                atr,
                prior_state=state,
            ),
            [],
        )
        confluence: list[ConfluenceGroup] = _safe(
            "confluence",
            warnings,
            lambda: compute_confluence_groups(envelope or {}),
            [],
        )
        live_signals: LiveSignals | None = _safe(
            "live signals",
            warnings,
            lambda: compute_live_signals(
                capture_path=session.capture_path,
                envelope=envelope,
                session=session,
                dashboard_dir=output_path.parent,
                ewma_calibration_path=args.analytics_root
                / "data"
                / "calibration_corpus"
                / "ewma_decay.json",
            ),
            None,
        )
        if live_signals is not None:
            warnings.extend(live_signals.warnings)
        day_type: DayTypeClassification | None = _safe(
            "day type",
            warnings,
            lambda: compute_day_type_classification(
                session=session,
                live_dir=output_path.parent.parent / "live_analysis",
                current_price=current_price,
            ),
            None,
        )
        if current_price is not None:
            audit = add_level_touch_events(audit, distances, now_pt=session.now_pt)
            audit = add_confluence_break_events(
                audit,
                confluence,
                current_price=current_price,
                prior_state=state,
                now_pt=session.now_pt,
            )
            audit = add_live_signal_events(audit, live_signals, now_pt=session.now_pt)
            audit = add_day_type_events(audit, day_type)

        scenario_audit: list[AuditEntry] = []
        scenarios: list[ScenarioState] = _safe(
            "scenarios",
            warnings,
            lambda: compute_scenario_states(
                envelope or {},
                float(current_price or 0.0),
                atr,
                scenario_audit,
                scenario_store,
                session_key=session.key,
                now_pt=session.now_pt,
                time_into_session_pct=_time_into_session_pct(session),
                live_signals=live_signals,
                day_type=day_type,
            ),
            [],
        )
        audit.extend(scenario_audit)
        audit = dedupe_audit_entries(audit)
        orderflow_pulse: OrderflowPulse | None = _safe(
            "orderflow pulse",
            warnings,
            lambda: compute_orderflow_pulse(
                analytics_root=args.analytics_root,
                dashboard_dir=output_path.parent,
                session=session,
                zones_path=zones_path,
            ),
            None,
        )
        if orderflow_pulse is not None:
            warnings.extend(orderflow_pulse.warnings)
        active_posture: ActivePosture = _safe(
            "active posture",
            warnings,
            lambda: synthesize_active_posture(
                envelope=envelope,
                current_price=current_price,
                atr=atr,
                scenarios=scenarios,
                pulse=orderflow_pulse,
                session=session,
                live_signals=live_signals,
                day_type=day_type,
            ),
            ActivePosture(
                title=f"ACTIVE POSTURE ({session.now_pt.strftime('%H:%M PT')})",
                sentences=("Posture synthesis unavailable; see section warnings.",),
            ),
        )

        signals = _session_signals(envelope, session, current_price, warnings)
        warnings.extend(_sanity_warnings(envelope, current_price, atr))
        html = render_dashboard(
            envelope=envelope,
            current_price=current_price,
            price_snapshot=price_snapshot,
            distances=distances,
            scenarios=scenarios,
            confluence=confluence,
            signals=signals,
            audit=audit,
            orderflow_pulse=orderflow_pulse,
            live_signals=live_signals,
            day_type=day_type,
            active_posture=active_posture,
            session_state=session,
            warnings=warnings,
            zones_path=zones_path,
            output_path=output_path,
            paused=paused,
        )
        _write_text(output_path, html)
        _write_probability_logs(
            output_path.parent,
            session=session,
            scenarios=scenarios,
            scenario_store=scenario_store,
            day_type=day_type,
        )
        _save_state_files(
            state_paths=state_paths,
            state=state,
            distances=distances,
            confluence=confluence,
            current_price=current_price,
            session=session,
            scenario_store=scenario_store,
            audit=audit,
        )
        elapsed = time.perf_counter() - start
        logger.info(
            "generated dashboard path=%s elapsed=%.2fs warnings=%d",
            output_path,
            elapsed,
            len(warnings),
        )
        return 0
    except Exception as exc:  # defensive scheduler contract
        logger.exception("dashboard generation failed")
        html = render_error_page(
            title="Dashboard generation failed",
            message=str(exc),
            output_path=output_path,
            now_pt=now_pt or datetime.now(PT),
            last_good=_last_good_time(output_path),
        )
        _write_text(output_path, html)
        return 1


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-path", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--analytics-root", type=Path, default=DEFAULT_ANALYTICS_ROOT)
    parser.add_argument("--trading-date", default=None)
    parser.add_argument("--session", choices=["rth", "globex", "between"], default=None)
    parser.add_argument("--now-pt", default=None, help=argparse.SUPPRESS)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Accepted for scheduler compatibility.",
    )
    return parser.parse_args(argv)


def _configure_logging(dashboard_dir: Path) -> None:
    dashboard_dir.mkdir(parents=True, exist_ok=True)
    log_path = dashboard_dir / f"generator_{datetime.now(PT).date().isoformat()}.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(log_path, encoding="utf-8"), logging.StreamHandler()],
    )


def _parse_now(value: str | None) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=PT)


def _safe(name: str, warnings: list[DataWarning], fn: Callable[[], T], fallback: T) -> T:
    try:
        return fn()
    except Exception as exc:
        warnings.append(DataWarning("fail", f"{name} section failed: {exc}"))
        return fallback


def _resolve_atr(envelope: dict[str, Any] | None, warnings: list[DataWarning]) -> float:
    if envelope is None:
        warnings.append(DataWarning("fail", "No envelope available; ATR unavailable."))
        return 40.0
    atr = _number(envelope.get("atr_14"), 0.0)
    if atr <= 0:
        fallback = max(5.0, _number(envelope.get("bin_size_ticks"), 20.0) * 0.25)
        warnings.append(DataWarning("warn", f"ATR missing; using {fallback:.2f}pt fallback."))
        return fallback
    return atr


def _session_signals(
    envelope: dict[str, Any] | None,
    session: DashboardSession,
    current_price: float | None,
    warnings: list[DataWarning],
) -> SessionSignals | None:
    session_start = session.session_start_pt
    if envelope is None or current_price is None or session_start is None:
        return None
    if not session.first_30min:
        return None
    return _safe(
        "session signals",
        warnings,
        lambda: compute_session_signals(
            envelope,
            session.capture_path,
            current_price,
            session_start,
        ),
        None,
    )


def _freshness_warnings(zones_path: Path | None, session: DashboardSession) -> list[DataWarning]:
    warnings: list[DataWarning] = []
    if zones_path is None:
        return warnings
    age_min = (session.now_pt.timestamp() - zones_path.stat().st_mtime) / 60.0
    if age_min > 24 * 60:
        warnings.append(DataWarning("warn", f"Zones JSON is {age_min / 1440:.1f} days old."))
    return warnings


def _sanity_warnings(
    envelope: dict[str, Any] | None,
    current_price: float | None,
    atr: float,
) -> list[DataWarning]:
    if envelope is None or current_price is None:
        return []
    vwap = _first_line(envelope, "vwap_", _number(envelope.get("vpoc"), current_price))
    if atr > 0 and abs(current_price - vwap) > 10.0 * atr:
        return [DataWarning("fail", "PRICE OUTLIER: current price is more than 10 ATR from VWAP.")]
    return []


def _save_state_files(
    *,
    state_paths: dict[str, Path],
    state: dict[str, Any],
    distances: list[LevelDistance],
    confluence: list[ConfluenceGroup],
    current_price: float | None,
    session: DashboardSession,
    scenario_store: dict[str, Any],
    audit: list[AuditEntry],
) -> None:
    next_state: dict[str, Any] = {
        "_meta": {
            "session_key": session.key,
            "last_price": current_price,
            "last_update_pt": session.now_pt.isoformat(),
        }
    }
    for distance in distances:
        next_state[distance.level_id] = {
            "last_distance_pts": distance.distance_pts,
            "last_check_pt": session.now_pt.isoformat(),
        }
    for group in confluence:
        next_state[confluence_state_id(group)] = {
            "last_distance_pts": group.center_price - float(current_price or 0.0),
            "last_check_pt": session.now_pt.isoformat(),
        }
    save_json_state(state_paths["state"], next_state)
    save_json_state(state_paths["scenarios"], scenario_store)
    save_json_state(state_paths["audit"], dump_audit_entries(audit))


def _write_probability_logs(
    dashboard_dir: Path,
    *,
    session: DashboardSession,
    scenarios: list[ScenarioState],
    scenario_store: dict[str, Any],
    day_type: DayTypeClassification | None,
) -> None:
    live_dir = dashboard_dir.parent / "live_analysis"
    append_probability_snapshots(
        live_dir / "probability_snapshots.jsonl",
        session=session,
        scenarios=scenarios,
    )
    append_completed_outcomes(
        live_dir / "probability_outcomes.jsonl",
        session=session,
        scenarios=scenarios,
        scenario_store=scenario_store,
    )
    append_day_type_outcome(
        live_dir / "day_type_outcomes.jsonl",
        session=session,
        day_type=day_type,
        scenarios=scenarios,
    )


def _time_into_session_pct(session: DashboardSession) -> float:
    if session.session_start_pt is None or session.session_end_pt is None:
        return 0.0
    total = (session.session_end_pt - session.session_start_pt).total_seconds()
    elapsed = (session.now_pt - session.session_start_pt).total_seconds()
    if total <= 0:
        return 0.0
    return max(0.0, min(1.0, elapsed / total))


def _last_known_price(state: dict[str, Any]) -> float | None:
    meta = state.get("_meta")
    if not isinstance(meta, dict):
        return None
    return _optional_number(meta.get("last_price"))


def _last_good_time(output_path: Path) -> str | None:
    if not output_path.exists():
        return None
    return datetime.fromtimestamp(output_path.stat().st_mtime, tz=PT).strftime(
        "%Y-%m-%d %H:%M:%S PT"
    )


def _first_line(envelope: dict[str, Any], fragment: str, default: float) -> float:
    for line in envelope.get("reference_lines", []):
        if isinstance(line, dict) and fragment in str(line.get("source", "")):
            return _number(line.get("price"), default)
    return default


def _number(value: Any, default: float) -> float:
    parsed = _optional_number(value)
    return default if parsed is None else parsed


def _optional_number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
