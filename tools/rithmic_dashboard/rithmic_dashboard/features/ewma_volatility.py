"""EWMA volatility-regime computation for the live dashboard loop."""

from __future__ import annotations

import json
import math
from dataclasses import asdict
from datetime import UTC, timedelta
from pathlib import Path
from typing import Any

from rithmic_dashboard.models import (
    DashboardSession,
    TradeTick,
    VolatilityRegime,
    VolatilityRegimeEvent,
    VolatilityRegimeName,
)
from rithmic_dashboard.session_state import PT
from rithmic_dashboard.state_store import load_json_state, save_json_state

DEFAULT_OBSERVATION_WINDOW_MINUTES = 15
DEFAULT_BAR_MINUTES = 5
LOW_THRESHOLD = 0.7
HIGH_THRESHOLD = 1.3
REGIME_FACTORS: dict[VolatilityRegimeName, float] = {
    "LOW": 1.0,
    "NORMAL": 1.3,
    "HIGH": 1.6,
    "UNKNOWN": 1.0,
}


def compute_ewma_volatility_regime(
    *,
    session: DashboardSession,
    ticks: list[TradeTick],
    live_dir: Path,
    calibration_path: Path,
    observation_window_minutes: int = DEFAULT_OBSERVATION_WINDOW_MINUTES,
    bar_minutes: int = DEFAULT_BAR_MINUTES,
) -> VolatilityRegime:
    """Update the persisted EWMA volatility state from one live observation."""

    computed_at = session.now_pt.astimezone(PT).strftime("%Y-%m-%d %H:%M:%S PT")
    if not calibration_path.exists():
        return VolatilityRegime(
            trading_date=session.trading_date,
            session=session.session,
            computed_at_pt=computed_at,
            status="unconfigured",
            regime="UNKNOWN",
            observation_window_minutes=observation_window_minutes,
            observation_sigma_pts=None,
            ewma_sigma_pts=None,
            sigma_effective_pts=None,
            corpus_median_sigma_pts=None,
            ratio=None,
            lambda_value=None,
            regime_factor=None,
            calibration_path=calibration_path,
            state_path=None,
            reason=f"EWMA calibration missing at {calibration_path}",
        )

    config = _load_calibration(calibration_path)
    lambda_value = _float(config.get("lambda_value"))
    median_sigma = _float(config.get("corpus_median_sigma_pts"))
    if lambda_value is None or median_sigma is None or median_sigma <= 0.0:
        return VolatilityRegime(
            trading_date=session.trading_date,
            session=session.session,
            computed_at_pt=computed_at,
            status="unconfigured",
            regime="UNKNOWN",
            observation_window_minutes=observation_window_minutes,
            observation_sigma_pts=None,
            ewma_sigma_pts=None,
            sigma_effective_pts=None,
            corpus_median_sigma_pts=median_sigma,
            ratio=None,
            lambda_value=lambda_value,
            regime_factor=None,
            calibration_path=calibration_path,
            state_path=None,
            reason="EWMA calibration is malformed.",
        )

    observation = parkinson_observation_sigma_pts(
        ticks,
        window_minutes=observation_window_minutes,
        bar_minutes=bar_minutes,
    )
    state_path = live_dir / "ewma_volatility_state.json"
    session_state_path = live_dir / f"{session.key}_vol_regime_state.json"
    prior_state = load_json_state(state_path, {})
    prior_session_state = load_json_state(session_state_path, {})
    prior_variance = _float(prior_state.get("variance_pts2"))
    if prior_variance is None or prior_variance <= 0.0:
        prior_variance = median_sigma**2

    if observation is None or observation <= 0.0:
        ewma_sigma = math.sqrt(prior_variance)
        regime = classify_volatility_regime(ewma_sigma, median_sigma)
        factor = REGIME_FACTORS[regime]
        return VolatilityRegime(
            trading_date=session.trading_date,
            session=session.session,
            computed_at_pt=computed_at,
            status="insufficient_data",
            regime=regime,
            observation_window_minutes=observation_window_minutes,
            observation_sigma_pts=None,
            ewma_sigma_pts=ewma_sigma,
            sigma_effective_pts=ewma_sigma * factor,
            corpus_median_sigma_pts=median_sigma,
            ratio=ewma_sigma / median_sigma,
            lambda_value=lambda_value,
            regime_factor=factor,
            calibration_path=calibration_path,
            state_path=state_path,
            reason=(
                f"Need at least two valid {bar_minutes}m bars in the last "
                f"{observation_window_minutes}m."
            ),
            prior_regime=_optional_regime(prior_session_state.get("regime")),
        )

    variance = lambda_value * prior_variance + (1.0 - lambda_value) * observation**2
    ewma_sigma = math.sqrt(max(0.0, variance))
    regime = classify_volatility_regime(ewma_sigma, median_sigma)
    factor = REGIME_FACTORS[regime]
    prior_regime = _optional_regime(prior_session_state.get("regime"))
    event = _regime_change_event(
        session=session,
        computed_at_pt=computed_at,
        prior_regime=prior_regime,
        regime=regime,
        ewma_sigma=ewma_sigma,
        median_sigma=median_sigma,
        observation=observation,
        factor=factor,
        path=live_dir / f"{session.key}_vol_regime.jsonl",
    )

    save_json_state(
        state_path,
        {
            "symbol": "MNQ",
            "trading_date": session.trading_date,
            "session": session.session,
            "updated_at_pt": computed_at,
            "lambda_value": lambda_value,
            "variance_pts2": variance,
            "ewma_sigma_pts": ewma_sigma,
            "last_observation_sigma_pts": observation,
            "corpus_median_sigma_pts": median_sigma,
            "regime": regime,
            "calibration_path": str(calibration_path),
        },
    )
    save_json_state(
        session_state_path,
        {
            "trading_date": session.trading_date,
            "session": session.session,
            "updated_at_pt": computed_at,
            "regime": regime,
            "prior_regime": prior_regime,
            "ratio": ewma_sigma / median_sigma,
            "ewma_sigma_pts": ewma_sigma,
            "sigma_effective_pts": ewma_sigma * factor,
        },
    )

    return VolatilityRegime(
        trading_date=session.trading_date,
        session=session.session,
        computed_at_pt=computed_at,
        status="active",
        regime=regime,
        observation_window_minutes=observation_window_minutes,
        observation_sigma_pts=observation,
        ewma_sigma_pts=ewma_sigma,
        sigma_effective_pts=ewma_sigma * factor,
        corpus_median_sigma_pts=median_sigma,
        ratio=ewma_sigma / median_sigma,
        lambda_value=lambda_value,
        regime_factor=factor,
        calibration_path=calibration_path,
        state_path=state_path,
        reason="EWMA volatility updated from the latest live Parkinson observation.",
        prior_regime=prior_regime,
        events=(event,) if event is not None else (),
    )


def parkinson_observation_sigma_pts(
    ticks: list[TradeTick],
    *,
    window_minutes: int = DEFAULT_OBSERVATION_WINDOW_MINUTES,
    bar_minutes: int = DEFAULT_BAR_MINUTES,
) -> float | None:
    """Compute one Parkinson sigma observation from the recent live trade tail."""

    if not ticks:
        return None
    latest = max((tick.timestamp_ns or 0) for tick in ticks)
    cutoff = latest - int(timedelta(minutes=window_minutes).total_seconds() * 1_000_000_000)
    recent = [tick for tick in ticks if (tick.timestamp_ns or 0) >= cutoff and tick.price > 0]
    if len(recent) < 2:
        return None

    total_qty = sum(max(0, tick.quantity) for tick in recent)
    if total_qty <= 0:
        return None
    vwap = sum(tick.price * max(0, tick.quantity) for tick in recent) / total_qty
    bar_ns = int(timedelta(minutes=bar_minutes).total_seconds() * 1_000_000_000)
    bars: dict[int, tuple[float, float]] = {}
    for tick in recent:
        if tick.timestamp_ns is None:
            continue
        bar_id = tick.timestamp_ns // bar_ns
        previous = bars.get(bar_id)
        if previous is None:
            bars[bar_id] = (tick.price, tick.price)
        else:
            bars[bar_id] = (max(previous[0], tick.price), min(previous[1], tick.price))
    if len(bars) < 2:
        return None
    sigma_log_squared = (
        sum(math.log(high / low) ** 2 for high, low in bars.values() if low > 0) / len(bars)
    )
    sigma_log = math.sqrt(sigma_log_squared / (4.0 * math.log(2.0)))
    return sigma_log * vwap


def classify_volatility_regime(
    ewma_sigma_pts: float,
    corpus_median_sigma_pts: float,
) -> VolatilityRegimeName:
    """Classify EWMA sigma against corpus median thresholds."""

    if corpus_median_sigma_pts <= 0.0 or ewma_sigma_pts <= 0.0:
        return "UNKNOWN"
    ratio = ewma_sigma_pts / corpus_median_sigma_pts
    if ratio < LOW_THRESHOLD:
        return "LOW"
    if ratio > HIGH_THRESHOLD:
        return "HIGH"
    return "NORMAL"


def _regime_change_event(
    *,
    session: DashboardSession,
    computed_at_pt: str,
    prior_regime: VolatilityRegimeName | None,
    regime: VolatilityRegimeName,
    ewma_sigma: float,
    median_sigma: float,
    observation: float,
    factor: float,
    path: Path,
) -> VolatilityRegimeEvent | None:
    if prior_regime is None or prior_regime == regime:
        return None
    ratio = ewma_sigma / median_sigma if median_sigma > 0 else 0.0
    event = VolatilityRegimeEvent(
        timestamp_pt=computed_at_pt,
        timestamp_ns=int(session.now_pt.astimezone(UTC).timestamp() * 1_000_000_000),
        event_type="vol_regime_changed",
        level_id=None,
        level_text=None,
        level_price=None,
        direction="neutral",
        description=(
            f"Volatility regime changed {prior_regime} -> {regime}: "
            f"EWMA sigma {ewma_sigma:.2f}pt, observation {observation:.2f}pt, "
            f"median {median_sigma:.2f}pt ({ratio:.2f}x), factor {factor:.2f}x"
        ),
        intensity=ratio,
        confidence="high",
        metadata={
            "prior_regime": prior_regime,
            "regime": regime,
            "ewma_sigma_pts": ewma_sigma,
            "observation_sigma_pts": observation,
            "corpus_median_sigma_pts": median_sigma,
            "ratio": ratio,
            "regime_factor": factor,
        },
    )
    _append_event_once(path, event)
    return event


def _append_event_once(path: Path, event: VolatilityRegimeEvent) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    key = (
        f"{event.timestamp_pt}|"
        f"{event.metadata.get('prior_regime')}|"
        f"{event.metadata.get('regime')}"
    )
    existing_keys: set[str] = set()
    if path.exists():
        for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            try:
                row = json.loads(raw)
            except json.JSONDecodeError:
                continue
            metadata = row.get("metadata") if isinstance(row, dict) else None
            if not isinstance(metadata, dict):
                continue
            existing_keys.add(
                f"{row.get('timestamp_pt')}|{metadata.get('prior_regime')}|{metadata.get('regime')}"
            )
    if key in existing_keys:
        return
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(asdict(event), sort_keys=True) + "\n")


def _load_calibration(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _optional_regime(value: object) -> VolatilityRegimeName | None:
    raw = str(value or "").upper()
    if raw in {"LOW", "NORMAL", "HIGH", "UNKNOWN"}:
        return raw  # type: ignore[return-value]
    return None


def _float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None
