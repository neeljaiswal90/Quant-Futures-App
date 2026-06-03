"""Shadow-mode inference helper for RA-093 trained scalp models.

Loads a run's ``model_runs/<run_id>/`` artifacts and serves per-setup-row
calibrated probabilities. The bundle is read-only after construction:
all joblib loads happen up-front so per-call serving never touches disk.

This is the foundation for RA-094's live serving path. It is NOT yet wired
to the realtime backend's signal-emit hook — that integration is a separate
deliberate change. The bundle is safe to call in isolation for:

* Offline backtesting / sanity-check of trained models against historical
  setups (validates the model can produce coherent probabilities on the
  same setup row schema used in training).
* A future live integration point that intercepts SignalPayload emission,
  builds the corresponding setup_row projection, and populates a
  probability field on the wire.

Output is intentionally a structured ``ScoreResult`` not a bare float so
callers see both ``p_raw`` (uncalibrated pipeline output) and
``p_calibrated`` (post-isotonic). The calibration report's reliability
curve is keyed to ``p_calibrated``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

import joblib

from scalp_models.features import FEATURE_NAMES, build_feature_vector


@dataclass(frozen=True, slots=True)
class ScoreResult:
    """One model's prediction for a single setup row.

    Fields:
      setup_type        — the firing setup family (e.g. ``"zone_rejection"``)
      horizon_seconds   — forward-return horizon this model was trained on
      p_raw             — uncalibrated base_pipeline ``predict_proba(...)[:, 1]``
      p_calibrated      — post-isotonic-calibrator probability (the one to USE)
      feature_count     — number of features the model consumed (audit aid)
    """
    setup_type: str
    horizon_seconds: int
    p_raw: float
    p_calibrated: float
    feature_count: int


class ScalpModelInferenceBundle:
    """Loads + serves all trained models from one ``model_runs/<run_id>/`` dir.

    Layout consumed:
      <run_dir>/config.json
      <run_dir>/features.json
      <run_dir>/models/<setup_type>_<horizon>s.joblib   ← one per (setup, horizon)
      <run_dir>/metadata/<setup_type>_<horizon>s.json   ← optional, not loaded here

    Constructor raises ``FileNotFoundError`` if the directory layout is
    missing essential pieces. Empty ``models/`` dir is allowed — the bundle
    just has no scorable keys (caller must check ``available_setups``).
    """

    def __init__(self, run_dir: Path) -> None:
        self.run_dir = Path(run_dir)
        if not self.run_dir.is_dir():
            raise FileNotFoundError(f"run_dir does not exist: {self.run_dir}")
        models_dir = self.run_dir / "models"
        if not models_dir.is_dir():
            raise FileNotFoundError(f"missing models/ subdir in {self.run_dir}")
        config_path = self.run_dir / "config.json"
        if not config_path.is_file():
            raise FileNotFoundError(f"missing config.json in {self.run_dir}")
        self._config: dict[str, Any] = json.loads(
            config_path.read_text(encoding="utf-8")
        )
        self._tick_size: float = float(self._config.get("tick_size", 0.25))
        # Models keyed by (setup_type, horizon_seconds). Tuple key matches
        # how trainer.py keys per-trial metadata.
        self._models: dict[tuple[str, int], dict[str, Any]] = {}
        for joblib_path in sorted(models_dir.glob("*.joblib")):
            payload = joblib.load(joblib_path)
            if not isinstance(payload, dict):
                # Defensive — trainer.py always saves a dict, but a future
                # refactor could change this shape. Don't crash; warn-skip.
                continue
            setup_type = payload.get("setup_type")
            horizon = payload.get("horizon_seconds")
            if not isinstance(setup_type, str) or not isinstance(horizon, int):
                continue
            self._models[(setup_type, horizon)] = payload

    @property
    def available_setups(self) -> list[tuple[str, int]]:
        """Sorted list of ``(setup_type, horizon_seconds)`` keys the bundle
        can score. Caller should check this before calling ``score`` if it
        wants to know which models are loaded."""
        return sorted(self._models.keys())

    @property
    def tick_size(self) -> float:
        return self._tick_size

    @property
    def config(self) -> dict[str, Any]:
        """Read-only copy of the training-run config (sklearn version,
        target_ticks, hashes, etc.). Useful for audit logging."""
        return dict(self._config)

    def score(
        self,
        setup_row: Mapping[str, Any],
        *,
        setup_type: str,
        horizon_seconds: int,
        tick_size: float | None = None,
    ) -> ScoreResult | None:
        """Score one setup row for a given (setup_type, horizon) combo.

        Returns None if the requested key isn't in the bundle (rather than
        raising) so callers can defensively probe multiple horizons without
        try/except churn.

        ``tick_size`` defaults to the value pinned in the training config
        for reproducibility. Override only if the live tick size differs
        from what the model was trained against (it shouldn't).
        """
        key = (setup_type, int(horizon_seconds))
        m = self._models.get(key)
        if m is None:
            return None
        ts = tick_size if tick_size is not None else self._tick_size

        # Build the feature dict using the same builder that produced the
        # training inputs, then index in the EXACT order the model captured
        # at training time. If a feature name in m["feature_names"] is
        # missing from the dict (shouldn't happen with FEATURE_NAMES, but
        # defensive against future trainer refactors), default to 0.0 —
        # matches build_feature_vector's own zero-init for unset names.
        feature_names_at_train = list(m.get("feature_names") or FEATURE_NAMES)
        vec = build_feature_vector(setup_row, tick_size=ts)
        x = [[float(vec.get(name, 0.0)) for name in feature_names_at_train]]

        pipeline = m["base_pipeline"]
        # predict_proba on a binary classifier returns shape (n_samples, 2);
        # we want column index 1 (positive class probability).
        raw = float(pipeline.predict_proba(x)[0, 1])

        calibrator = m.get("calibrator")
        if calibrator is None:
            calibrated = raw
        else:
            # IsotonicRegression.transform takes a 1-D array.
            calibrated = float(calibrator.transform([raw])[0])

        return ScoreResult(
            setup_type=setup_type,
            horizon_seconds=int(horizon_seconds),
            p_raw=raw,
            p_calibrated=calibrated,
            feature_count=len(feature_names_at_train),
        )

    def score_all_horizons(
        self,
        setup_row: Mapping[str, Any],
        *,
        setup_type: str,
        tick_size: float | None = None,
    ) -> list[ScoreResult]:
        """Score one setup row against every horizon available for its setup_type.

        Returns an empty list if no models for ``setup_type`` are loaded.
        Results are sorted by ``horizon_seconds`` ascending.
        """
        results: list[ScoreResult] = []
        for (st, h) in self.available_setups:
            if st != setup_type:
                continue
            r = self.score(
                setup_row,
                setup_type=setup_type,
                horizon_seconds=h,
                tick_size=tick_size,
            )
            if r is not None:
                results.append(r)
        return results


__all__ = ["ScoreResult", "ScalpModelInferenceBundle"]
