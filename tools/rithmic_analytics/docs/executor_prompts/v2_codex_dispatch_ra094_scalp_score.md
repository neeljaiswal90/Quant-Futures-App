# Codex Dispatch — RA-094: scalp_score contract + backend wiring + UI surface

Coordinator dispatch. Read `v2_codex_handoff.md` for invariants. Pre-build sweep → green-light → build → verify → ship.

**Status:** Pre-staged (RA-093b training in progress; report ETA ~07:00 PT Monday). Numbers marked **TBD/RA-093b** are filled in once `calibration_report.md` lands. The structural work (contract, backend wiring, UI surface) does NOT depend on the numbers and can start immediately on dispatch.

## Why this exists

RA-093b produces the trained, calibrated scalp probability models — one per `(setup, horizon)` cell — but they're sitting in a run-dir nobody reads. The live backend detects setups (RA-092) and ships them in `SignalPayload`s, but it doesn't load the models, score the setups, or surface anything that says "this iceberg-hold has a 62% chance of running +4 ticks in 60s." This ticket closes that loop: load model → score live setup → emit on the wire → render in the dashboard.

Hard sequencing: RA-093b must produce a usable `calibration_report.md` before this dispatch is actionable for the runtime threshold values, but the structural plumbing (contract field, backend module, UI component) can be built and unit-tested with stub model artifacts. Codex should pre-build everything except the thresholds, surfacing the latter as `TBD/RA-093b` constants until coordinator lands the calibration verdict.

## Build

### 1. Contract — `ScalpScore` envelope (additive, non-breaking)

Add to `contracts/realtime/events.py` + `contracts/realtime/events.ts` (parity tripwire green):

```python
class ScalpScorePerHorizon(BaseModel):
    """Calibrated probability for a single (setup, horizon) cell."""
    horizon_seconds: int  # one of [1, 5, 15, 60, 300]
    p_target_run: float = Field(ge=0.0, le=1.0)  # P(forward return >= target_ticks)
    n_train_samples: int = Field(ge=0)  # provenance from training set
    calibration_method: Literal["platt", "isotonic", "uncalibrated"] = "uncalibrated"

class ScalpScorePayload(BaseModel):
    family: Literal["scalp_score"] = "scalp_score"
    setup_id: str  # matches RA-092 setup taxonomy id
    setup_label: str  # human-readable: "zone_rejection", "iceberg_hold", etc.
    headline_horizon_seconds: int = 60  # operator's primary decision window
    headline_score: float = Field(ge=0.0, le=1.0)
    tier: Literal["HIGH", "MEDIUM", "LOW", "INSUFFICIENT_DATA"]
    per_horizon: list[ScalpScorePerHorizon]
    model_run_id: str  # which RA-093b run produced this score
    model_artifact_sha256: str  # for provenance audit
    notes: str | None = None  # e.g. "regime=trending; setup matched at 2026-06-01T13:24:55Z"
```

Tier mapping uses `headline_score` (60s horizon by default) thresholds **TBD/RA-093b** — typical shape `HIGH ≥ ~0.65`, `MEDIUM ≥ ~0.50`, `LOW ≥ ~0.35`, `INSUFFICIENT_DATA` when `n_train_samples < min_positives` for that cell. Final thresholds are read from the calibration report's per-cell reliability diagram, not picked from feel. **Do not invent thresholds; surface them as `TBD/RA-093b` constants until coordinator delivers them.**

Wire-side: this is a NEW payload family, so the existing `Envelope`/discriminated-union machinery must be extended additively in both `events.py` and `events.ts`. Run the parity tripwire test (`contracts/realtime/tests/test_parity.py`).

### 2. Backend — model loader + scorer + emit

New module: `services/realtime_backend/scalp_scorer.py`.

- Loads pickled sklearn calibrated classifiers from a specified `--model-run-dir` at backend startup, indexed by `(setup_id, horizon_seconds)`.
- Public method `score_signal(signal: SignalPayload) -> ScalpScorePayload | None`:
  - Resolve the signal's setup_id via the RA-092 setup mapping (already detected upstream in `live_signals.py`).
  - Extract the feature vector the trainer expects (the trainer's input shape is documented in `services/scalp_models/scalp_models/dataset.py` / `trainer.py` — reuse the exact feature extraction, do not re-derive).
  - For each `horizon ∈ {1, 5, 15, 60, 300}`, call `model.predict_proba(X)[0, 1]` to get the calibrated P(target_run).
  - Pick `headline_score` from the `headline_horizon_seconds` cell (default 60s; configurable via env).
  - Tier from threshold table.
  - Stamp `model_run_id` + `model_artifact_sha256` from the loader's manifest.
  - Return `None` if no model exists for that setup_id (insufficient data per RA-093b).
- Env vars (with defaults):
  - `RA94_MODEL_RUN_DIR` (path; required for scoring to be enabled — backend boots fine without it and just doesn't emit scores)
  - `RA94_HEADLINE_HORIZON_SECONDS` (default 60)
  - `RA94_TIER_THRESHOLDS` (JSON `{"HIGH":0.65,"MEDIUM":0.50,"LOW":0.35}`; **TBD/RA-093b**; loader's defaults are intentionally pessimistic so an unconfigured backend never emits HIGH)

Wire-up:
- In the existing live-signal dispatcher (`services/realtime_backend/watcher.py` or wherever `SignalPayload`s are emitted), when a setup detection fires, also call `scalp_scorer.score_signal(signal)` and emit the resulting `ScalpScorePayload` as a SIBLING envelope (same `ts_ns`, separate envelope) — DO NOT mutate `SignalPayload` to add a score field. Keeps the existing contract additive.
- Honor `RA94_MODEL_RUN_DIR` not being set: skip scoring, no warning spam (info-log once at startup).
- The bookmap-backfill REST does NOT include scalp_score history — out of scope for this ticket. Live emission only.

### 3. UI surface

Two surfaces, both UI-only, both `apps/dashboard_ui/src/`:

**A. LiveFeed item annotation**
- When a `ScalpScorePayload` arrives in the WS stream, store it on the `FeedItem` matching the same `setup_id` + within a 5s `ts_ns` window (or the seq immediately preceding — coordinate via the existing setup-detection seq).
- Render the headline score as a probability badge to the right of the feed item title: `P(4t/60s) = 0.62 [HIGH]`. Tier color codes:
  - HIGH: `#3fb950` (green — exempt from RA-103's "green/red only for executions" rule because tier badges are tagged with `data-tier` and clearly labeled, not chart-overlay)
  - MEDIUM: `#e3b341` (yellow)
  - LOW: `#8b949e` (muted)
  - INSUFFICIENT_DATA: hide badge entirely (don't render uncertainty as a tier)
- Hover tooltip: full per-horizon breakdown table.

**B. Chart bubble enhancement (additive to RA-103)**
- The setup-detection event bubble (already shipped via RA-103) gets a subtle inner ring whose stroke width scales with `headline_score`:
  - HIGH: 2.5px ring, full opacity
  - MEDIUM: 1.5px ring, 0.6 opacity
  - LOW: no ring change
- Color stays from RA-103's family palette (cyan/purple/etc) — the score modulates emphasis, not hue.
- Hover tooltip includes the headline score and tier.

Visibility toggle: extend the existing `chart-layer-controls` with a "Scores on" / "Scores off" toggle. Default ON.

### 4. Tests

Path-scoped:

- `contracts/realtime/tests/test_parity.py`: extend with `ScalpScorePayload` round-trip + envelope discriminated-union resolution.
- `services/realtime_backend/tests/test_scalp_scorer.py` (new): fixture model artifact + known signal → expected score. Cover "no model for setup_id" returning None.
- `apps/dashboard_ui/src/contract/render.test.ts`: extend with score → FeedItem projection.
- `apps/dashboard_ui/src/components/LiveFeed.test.tsx`: assert tier badge renders with correct color + hide-on-INSUFFICIENT_DATA.
- `apps/dashboard_ui/src/chart/eventBubbles.test.ts`: assert score-driven ring stroke width.

## Hard invariants

- **Additive contract only.** New `ScalpScorePayload` family; do NOT mutate `SignalPayload`. Parity tripwire green. Frozen-contract additive-only rule (per `v2_codex_handoff.md`).
- **No detector changes.** Detection lives in `live_signals.py` (single source of truth); this ticket consumes detections, never modifies them.
- **No capture/probe/scheduler/.env changes.** Never edit `scripts/infra/capture-rithmic-probe.py`, the scheduler entries, `.env`, normalization ownership.
- **Decision support only — no order execution.** The score informs the operator; it does not trigger trades. Zero broker/order/execution surface. (Per `v2_codex_handoff.md` decision-support invariant.)
- **Models are read-only.** Backend loads pickled sklearn artifacts; it does NOT retrain online, does NOT mutate them. Retraining is RA-093b's job; this ticket consumes its output.
- **Exactly-one-normalizer rule unchanged.** Backend self-normalize + refresh loop with `-SkipNormalize`. This ticket does not interact with normalization.
- **`green/red` palette rule preserved.** Per RA-100/RA-103: green/red are reserved for trade executions. Tier badges in the LiveFeed are clearly labeled and `data-tier`-annotated, which is the only carve-out. Chart bubble ring scaling stays in RA-103's family palette (no green/red hue change).
- **`Math.min(...arr)` and autoscale re-entrancy.** Per memory entries; if the ring scaling is implemented via a new chart primitive, autoscaleInfo MUST return null (`[[lightweight-charts-autoscale-reentrancy]]`).
- Surgical path-scoped commit. The worktree dirties easily; stage only RA-094 files. Three commits acceptable: (1) contract + tests, (2) backend scorer + tests, (3) UI surface + tests.

## Pre-build sweep gate

Sweep must cover:
1. **Discriminated-union strategy** in `Envelope`. Show the `events.py` + `events.ts` diff for adding `ScalpScorePayload` to the union — proves no breaking change to existing payload consumers.
2. **Feature-vector extraction** — point to the EXACT code in `services/scalp_models/scalp_models/dataset.py` that the trainer uses, and confirm the live backend has access to the same fields on `SignalPayload`. If a feature isn't available live, FLAG IT — that's a contract gap.
3. **Model artifact loading interface** — pickle? joblib? sklearn version coupling? Confirm load path + that the trainer's `metadata_paths` + `model_paths` (per RA-093b's `TrainingRunResult`) are stable + read-only.
4. **Tier threshold sourcing** — surface as `TBD/RA-093b` constants in the contract module with a coordinator-locked comment. List which calibration-report values will replace them.
5. **Setup-id ↔ scalp-score correlation in UI** — propose the exact key + time window for matching a `ScalpScorePayload` to the originating `SignalPayload` FeedItem. (If `model_artifact_sha256` + `setup_id` + `ts_ns_window` aren't unique enough, propose adding a `signal_seq` field on `ScalpScorePayload` — additive.)
6. **Confirmation of no detector/capture/probe touch.**

## Acceptance

- New `ScalpScorePayload` round-trips py ⇄ ts. Parity tripwire green.
- Backend loads a fixture model + emits `ScalpScorePayload` for a known setup detection. Sample WS frame shown in ship report.
- UI renders the tier badge in LiveFeed + the inner ring on the chart bubble. Before/after screenshots required.
- All tests green: vitest, pytest, tsc, lint, ruff, mypy targeted.
- The `--model-run-dir` flag picks up the actual RA-093b training run from `scratch/ra093b-run1/quiet-window-2026-05-31/.../model_runs/scalp_models/` — confirmed by smoke run against the real artifact.
- Tier thresholds locked from `calibration_report.md` (coordinator delivers post-RA-093b).
- Ship report includes a 30-second smoke video (or sequence of screenshots) showing live signals firing in the dashboard with scores attached.

## Coordinator review focus

The structural commits (contract, backend wiring, UI surface) land independent of the calibration verdict. The threshold-locking commit comes after coordinator reviews the RA-093b report and provides the specific tier cut-offs. Codex should ship the structural work as soon as it's clean, then wait for the threshold values rather than guessing them.

If `calibration_report.md` shows `insufficient_samples` for most cells (the expected outcome for a 4-session training set per RA-093b's expectations), the scorer correctly emits `INSUFFICIENT_DATA` tier and the UI suppresses the badge. The contract + plumbing still ship; we just don't see scores until more sessions are captured. That's the correct degenerate state, not a regression.

## Priority

Queue immediately after RA-093b report lands and is reviewed. RA-094 unblocks operator-visible scalp probability surface. RA-094a (threshold lock-in) is a fast follow.

## Future option (out of scope; for the operator)

If the calibration report shows that some setups deserve REGIME-stratified models (per RA-093's stratification work), RA-094b can add `regime: str` to the score key and load per-regime model artifacts. Hold for now — single model per (setup, horizon) is the v1 shape.
