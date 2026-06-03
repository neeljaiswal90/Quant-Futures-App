# Scalp Strategy — Comprehensive Review Document

**Status as of 2026-06-03:** trained models exist, calibration gate FAILS, system in shadow-mode only. This document describes what the strategy IS, what the models DO, how performance is measured, and what's broken / weak. Intended for third-party review.

---

## 1. Plain-English overview

**The strategy attempts to predict whether a high-confluence detector signal will produce a 4-tick favorable move within 1-300 seconds, then assigns a calibrated probability to each.** It does not generate signals on its own — it CONSUMES signals produced by an upstream detector stack (zones + sweeps + absorption + iceberg + CVD flips + microprice). Each consumed signal is classified into one of 5 setup families, transformed into a 58-feature vector, and run through a per-(setup, horizon) calibrated logistic-regression model. The output is `p_calibrated ∈ [0, 1]` per (setup, horizon) cell.

**What the strategy is not:**
- Not an execution layer — there is no order management, no position sizing, no stops/targets logic. It outputs probabilities.
- Not a feature-discovery layer — features are operator-fixed (`FEATURE_NAMES` tuple, frozen at training time).
- Not a regime-aware ensemble — one model per (setup, horizon), no regime-conditional routing.
- Not yet live — predictions are produced post-session, not on the wire.

---

## 2. Architecture (data flow)

```
Rithmic probe ──► raw .jsonl  ──► obs01 normalizer ──► obs01.jsonl
                                                       │
                                                       ▼
                                          replay.runner.run_replay
                                                       │  produces ↓
                                            signals.jsonl + setups.jsonl
                                                       │
              ┌────────────────────────────────────────┼──────────────────────────┐
              │                                        │                          │
              ▼                                        ▼                          ▼
  forward-return-labels CLI               scalp_models.dataset                scalp_models.features
  (TypeScript, apps/backtester)           load_training_dataset()             build_feature_vector()
              │                                        │                          │
              ▼                                        ▼                          ▼
       labels.jsonl                          TrainingExample list           58-feature vector
              │                                        │
              └──────────────┬─────────────────────────┘
                             ▼
                  scalp_models.trainer
                  (per (setup, horizon) cell:
                    walk-forward folds → C-grid sweep
                    → Platt vs isotonic calibrator selection
                    → final fit on train, calibrate on hold-out)
                             │
                             ▼
            model_runs/<run_id>/models/<setup_type>_<horizon>s.joblib
                             │
                             ▼
                  scalp_models.inference         <── This is shadow-mode serving
                  ScalpModelInferenceBundle.score()
                             │
                             ▼
                  ScoreResult{p_raw, p_calibrated}
                             │
                             ▼
                  scalp_models.evaluate
                  performance.md + sidecar JSON
```

**File references** (for code-review traceability):
- Detectors / setup derivation: `services/replay/replay/setups.py:199-358`
- Feature builder: `services/scalp_models/scalp_models/features.py:63-125`
- Label join: `services/scalp_models/scalp_models/dataset.py:95-158`
- Trainer: `services/scalp_models/scalp_models/trainer.py:60-308`
- Gate policy: `services/scalp_models/scalp_models/gate.py:18-26`
- Inference: `services/scalp_models/scalp_models/inference.py`
- Evaluator: `services/scalp_models/scalp_models/evaluate.py`

---

## 3. Setup types (5 families) — what triggers each

Defined at `services/scalp_models/scalp_models/dataset.py:15-21` and derived from raw detector signals at `services/replay/replay/setups.py`. Each setup is one (timestamp, direction, level) candidate decision point.

### 3.1 `zone_rejection` — `setups.py:199-222`

**Trigger:** a HIGH or CRITICAL tier zone-firing signal (from the detector that watches v3 σ shelves + structural levels) appears AND the live footprint shows stacked imbalance on the OPPOSITE side from the trade direction.

**Plain-English rule:**
> "Price approached a high-confluence zone (≥2 sources stacked: σ shelf + VAH/VAL/VPOC/LVN/HVN), the signal fired HIGH or CRITICAL tier, AND the orderflow footprint shows aggressors hitting INTO that zone in a way that would get absorbed. Predict whether the next 1-300 seconds produce a 4-tick reversal from the zone."

**Direction:** inherited from the originating zone signal (`direction` field on the detector output).

**This is the only setup that actually trained on yesterday's 4-session corpus** because it had the most volume. 142-157 samples per horizon.

### 3.2 `sweep_absorption` — `setups.py:225-257`

**Trigger:** a sweep event (rapid one-side aggression sweeping through resting orders) immediately followed by an absorption event AT THE SAME PRICE LEVEL within 10 seconds (`sweep_absorption_window_seconds = 10.0`), with price match tolerance of 2 points.

**Plain-English rule:**
> "Aggressors swept the book in one direction, then someone absorbed the continuation right at the level they swept to. This is the canonical 'liquidity grab + reversal' setup. Predict whether the reversal sticks."

**Direction:** taken from the absorption event's direction (or sweep's if absorption is unclear).

**Sample count:** 0 in the training run — gate-failed before training. Probably needs absorption + sweep detector tuning before it can produce enough examples.

### 3.3 `iceberg_hold` — `setups.py:260-279`

**Trigger:** an iceberg-refill event detected at a level that has zone confluence (≥2 zone sources stacked).

**Plain-English rule:**
> "A hidden refill order is consuming aggressors at a zone-defined level. Holders defending the level. Predict whether they win — i.e. price reverses away from the iceberg side."

**Direction:** from the iceberg detector (bid-side iceberg → long, ask-side iceberg → short).

**Sample count:** 1/1 in training — gate-failed.

### 3.4 `cvd_flip_at_zone` — `setups.py:282-310`

**Trigger:** CVD momentum flip (the 15m CVD direction reverses) WHILE price is near a zone.

**Plain-English rule:**
> "Cumulative volume delta direction has just inverted, AND we're at a structural level. The flip might be the start of new auction direction. Predict whether the new direction holds for the next 1-300 seconds."

**Direction:** taken from the new 15m CVD direction (bullish flip → long, bearish flip → short).

**Sample count:** 5-24 / horizon in training — gate-failed (insufficient).

### 3.5 `microprice_flip_zone` — `setups.py:313-358`

**Trigger:** the microprice lean (depth-imbalance-weighted midprice deviation from mid, in ticks) persists at >|0.5| ticks in one direction for ≥2 seconds at a zone level.

**Plain-English rule:**
> "Top-of-book quote pressure has shifted one direction and SUSTAINED, at a zone. Indicates marker-maker conviction. Predict whether price follows the lean."

**Direction:** from the lean direction (lean ≥ +0.5 → long, ≤ -0.5 → short).

**Sample count:** 29-68 / horizon — gate-failed (insufficient).

---

## 4. Forward-return label definition — the "y" in y=f(x)

**Code:** `apps/backtester/src/forward-return-labels/labeler.ts` (TypeScript, the recently-V8-stringcap-fixed module) emits one label row per (signal, horizon). Each row has:

- `mfe_ticks` — Maximum Favorable Excursion, the best price reached IN THE DIRECTION OF THE SETUP within the horizon
- `mae_ticks` — Maximum Adverse Excursion, the worst against
- `realized_ticks` — net move at horizon expiry
- `status` — `ok` if labellable; else one of `no_trades_in_horizon`, `tape_eof_before_horizon`, `neutral_direction`, `invalid_signal`, `no_post_signal_trade`

**Binary label conversion** (`scalp_models/dataset.py:144`):

```python
label = 1 if mfe_ticks >= target_ticks else 0
```

**Default `target_ticks = 4.0`**. So `y = 1` means "within `horizon_seconds`, price reached AT LEAST 4 ticks (1 MNQ point) in the predicted direction."

**Why MFE not realized:** the strategy is intended for scalping where you'd exit at the target. Using MFE captures "could you have hit the target with optimal exit timing" — generous. Using realized would capture "what was the final P&L if you held to time-stop". The choice biases the model toward predicting "did the move EXIST at all" rather than "was holding-to-time the right play".

**Horizons:** `1, 5, 15, 60, 300` seconds (`dataset.py:33`).

---

## 5. Feature surface — 58 features

**Code:** `services/scalp_models/scalp_models/features.py`. All defined in `FEATURE_NAMES` tuple, frozen at training time.

### 5.1 Numeric (13)

| Feature | Source | Description |
|---|---|---|
| `cvd_session_cvd` | orderflow.cvd | Session-cumulative delta |
| `cvd_last_60m_cvd` | orderflow.cvd | Trailing-60m delta |
| `cvd_last_15m_cvd` | orderflow.cvd | Trailing-15m delta |
| `cvd_momentum_flip` | orderflow.cvd | 1 if 15m direction != session direction |
| `v_delta` | orderflow | Volume delta on the firing bar |
| `footprint_imbalance` | orderflow.footprint | Imbalance ratio of stacked-aggressor side |
| `confluence_stack_size` | setup_row | Count of zone sources stacked at the level (1-N) |
| `distance_to_zone_ticks` | zone_context.distance_pts ÷ tick_size | Ticks between price and the targeted zone |
| `sigma` | features | Current σ envelope (volatility regime) |
| `atr_14` | features | ATR(14) — volatility |
| `depth_top3_bid_ratio` | computed from depth_snapshot | bid_size / (bid+ask) over top-3 levels |
| `depth_total_visible_size` | depth_snapshot | Top-N total visible size |
| `microprice_lean_ticks` | features OR depth_snapshot | Microprice deviation from mid |

### 5.2 Aggressor-flow windows × 4 horizons × 2 measures (8)

For each of (60s, 300s, 900s, 3600s):
- `aggressor_<W>s_net` — net signed aggressor volume
- `aggressor_<W>s_ratio` — buy/(buy+sell) ratio

### 5.3 One-hot categoricals

- `last_trade_aggressor_{buy,sell,unknown}` — 3 features
- `cvd_session_direction_{bullish,bearish,neutral,unknown}` — 4
- `cvd_last_15m_direction_{bullish,bearish,neutral,unknown}` — 4
- `zone_kind_{sigma,vwap,vpoc,vah,val,hvn,lvn,ib,globex,rth,other,unknown}` — 12
- `regime_{LOW,NORMAL,HIGH,UNKNOWN}` — 4
- `orderflow_quality_{live,inferred,stale_l1,unavailable,unknown}` — 5
- `depth_quality_{live,inferred,stale_l1,unavailable,unknown}` — 5

**Total: 13 + 8 + 3 + 4 + 4 + 12 + 4 + 5 + 5 = 58 features.**

**Notable absences worth questioning during review:**
- No price-distance to value-area boundaries (VAH/VAL only encoded via `zone_kind`, not as continuous distance)
- No time-of-day feature (no encoding of session-open vs mid-session vs close)
- No prior-touch / persistence features (model doesn't know if the zone has been touched before today)
- No σ-shelf cap-binding state (the new methodology-rework diagnostic isn't a feature)
- No live VWAP-distance feature
- No spread feature (the MBP1 spread isn't fed in)
- No book-aggression count (only ratio)

---

## 6. Training methodology

**Code:** `services/scalp_models/scalp_models/trainer.py:60-308`. One model is trained per `(setup_type, horizon)` cell — so up to 5 × 5 = **25 models**, though most are skipped for insufficient samples.

### 6.1 Per-cell flow

For each `(setup_type, horizon)`:

1. **Sample gate** (`trainer.py:138-159`):
   - Default `min_positives = 30`, `min_negatives = 30`. If either is below, cell is marked `insufficient_samples` and `recommended_action = block`. No model file written.

2. **Walk-forward fold construction** (`trainer.py:371-405`):
   - Examples sorted by `(session_key, ts_ns)` first — chronological.
   - **If ≥ 5 sessions in the corpus:** sliding-window walk-forward — 60% train, 20% validation, 20% test, sliding by 1 session per fold.
   - **Else (today's case — only 4 sessions):** ONE fold with 60/20/20 split by row index. **This is a known weakness — temporal leakage risk if same session crosses train/val/test.**

3. **C-grid sweep** (`trainer.py:206-222`):
   - `c_grid = (0.01, 0.1, 1.0, 10.0)` for logistic-regression `C` (inverse regularization).
   - For each `C`, average per-fold validation Brier. Pick lowest.

4. **Calibrator selection** (`trainer.py:224-244, 282`):
   - Two candidates per fold: **Platt scaling** (logistic on decision-function scores) vs **isotonic regression** (monotonic, non-parametric).
   - Pick the method with lower average validation Brier across folds.
   - The yesterday's quiet-window-2026-05-31 run picked isotonic for all three trained cells.

5. **Final-model fit** (`trainer.py:283-307`):
   - 80% of examples used for the pipeline fit, last 20% for calibrator fit (`_final_train_calibration_split`).
   - `Pipeline([StandardScaler, LogisticRegression(C=best_c)])`.
   - Calibrator (Platt or isotonic) fit on the held-out 20%.
   - Saved as joblib dict: `{base_pipeline, calibrator, calibration_method, feature_names, setup_type, horizon_seconds, target_ticks, ...}`.

6. **Per-fold test metrics** computed:
   - AUC, Brier, calibration error (per `calibration_curve` quantile bins), reliability curve, `hit_rate_at_predicted_ge_0_6`.

7. **Gate evaluation** (next section).

### 6.2 Inputs / outputs / hashes

The training run pins for reproducibility (config.json):
- `setup_path`, `labels_path` + sha256 of each
- `sklearn` version (today: scikit-learn 1.5.2, joblib 1.4.2)
- `c_grid`, `random_state` (default 930), `target_ticks`, `min_positives`, `min_negatives`, `horizons_seconds`

---

## 7. Calibration

Two methods evaluated per cell, lower-Brier wins:

- **Platt scaling** — sigmoid `1/(1+exp(-(a·score+b)))` fit on decision-function scores. Assumes calibration distortion is monotonic and sigmoid-shaped.
- **Isotonic regression** — non-parametric monotonic mapping. Strictly more flexible but needs more data to avoid step-function pathologies (one of yesterday's failure modes — see §10).

**Today's actuals:** all three trained models picked `isotonic`.

The isotonic step-functions are visible in yesterday's reliability curves — predictions cluster at values like 0.389 / 0.583 / 0.833 because those are the boundary values where the isotonic fit's "steps" landed on small calibration data.

---

## 8. Gate criteria — when does a model get green-lit?

**Code:** `services/scalp_models/scalp_models/gate.py:18-26`.

```python
class ModelGatePolicy:
    min_test_folds: int = 1
    min_test_samples_total: int = 20
    min_test_samples_per_fold: int = 5
    max_brier_score: float = 0.30
    min_auc: float = 0.50
    max_calibration_error: float = 0.25
```

**Recommendation logic** (`trainer.py:472-477`):

| Gate status | All gates pass + AUC ≥ 0.55 | At least sample/Brier gates pass | Otherwise |
|---|---|---|---|
| `recommended_action` | `green_light_live` | `green_light_shadow_only` | `block` |

**Yesterday's actual outcome:** all three trained zone_rejection cells got `green_light_shadow_only` — passed sample-count gates, but `min_auc` and/or `max_calibration_error` were borderline. Insufficient sample cells got `block`.

**Critically: `min_auc = 0.50` is the THRESHOLD, not the target.** AUC 0.50 is random-coin-flip discrimination. The gate accepts random models as shadow-eligible. The operator must judge using AUC well above 0.50 (≥ 0.60 for "interesting"). This is a known weakness — the gate is too permissive at the threshold layer.

---

## 9. Live scoring — how a probability is produced

**Code:** `services/scalp_models/scalp_models/inference.py`. Loaded via `ScalpModelInferenceBundle(run_dir)`.

For a setup_row and (setup_type, horizon):

1. Build feature vector via `features.build_feature_vector(setup_row, tick_size)` — yields a dict keyed by FEATURE_NAMES.
2. Look up the (setup_type, horizon) joblib dict in the bundle.
3. Order the vector by the MODEL's captured `feature_names` (defensive against future trainer refactors that change feature order — uses the model's stored list, not the live FEATURE_NAMES tuple).
4. `p_raw = base_pipeline.predict_proba(x)[:, 1][0]` — uncalibrated.
5. `p_calibrated = calibrator.transform([p_raw])[0]` — post-isotonic (or Platt).
6. Return `ScoreResult(setup_type, horizon_seconds, p_raw, p_calibrated, feature_count)`.

**Inference cost:** ~13 ms per row on yesterday's bundle. Scoring 200 rows × 3 horizons takes 2.3 seconds.

**This is not yet wired to the live realtime backend** — that requires a separate setup-row builder that mirrors the replay setup-row schema. Currently scoring is offline-batch only.

---

## 10. Performance evaluation — how we know if the strategy is working

**Code:** `services/scalp_models/scalp_models/evaluate.py`. Per (setup_type, horizon) cell:

| Metric | Range / interpretation | Healthy direction | Gate-target |
|---|---|---|---|
| **Sample counts** (total / + / -) | n, n_positive, n_negative | balanced ideally | ≥30 each class |
| **AUC** (ROC) | 0.5 = random, 1.0 = perfect | higher | ≥0.60 (gate min 0.50) |
| **Brier score** | 0 = perfect, 0.25 = random for 50/50 | lower | <0.20 (gate max 0.30) |
| **Log loss** | 0 = perfect | lower | — (not gated) |
| **Calibration error** | mean \|predicted − realized\| over decile bins | lower | <0.05 (gate max 0.25) |
| **Reliability curve** | per-decile (predicted, realized) | diagonal | visual diagnostic |
| **Hit rate @ threshold** | `mean(y | p≥T)` and lift over base rate | lift > 0 | — |

**Reading the metrics together:**
- High AUC + high calibration error = model can sort but probabilities are mislabeled. Calibrator needs more data.
- Low AUC + low calibration error = model is poorly discriminating but calibrated (predicts the base rate). Worthless.
- High AUC + low calibration error = real edge. The goal.

### 10.1 Yesterday's in-sample numbers (for context)

In-sample evaluation on the same 4-session corpus the models were trained on:

| Cell | n | AUC | Brier | Calibration error | Realized | Mean predicted |
|---|---|---|---|---|---|---|
| zone_rejection 1s | 142 (+35 / -107) | **0.547** | 0.200 | 0.185 | 24.6% | 38.0% |
| zone_rejection 5s | 157 (+80 / -77) | **0.734** | 0.243 | 0.159 | 51.0% | 66.2% |
| zone_rejection 15s | 157 (+113 / -44) | **0.500** | 0.215 | 0.154 | 72.0% | 83.3% |

**Reading:**
- 5s is the only horizon with meaningful discrimination.
- 1s is near-random; 15s is random.
- All three over-predict by 11-15 pp.
- Calibration errors 0.15-0.19 are HIGH — the isotonic fits produced step-function output.
- These are **in-sample** numbers — out-of-sample on a fresh session will likely be worse.

### 10.2 Acceptance criteria for promotion to live

Production-flip should require, across **multiple held-out sessions**:

| Criterion | Threshold |
|---|---|
| AUC | ≥ 0.60 sustained per cell |
| Calibration error | < 0.05 |
| Hit-rate-at-p≥0.6 lift | > +0.05 over base rate |
| Sample count per cell | ≥ 30 / class per session |
| Stability | Same cells passing across 3+ sessions |

None of yesterday's cells meet these.

---

## 11. Known limitations / risks (for review focus)

### 11.1 Tiny training corpus
4 sessions of which 1 is a holiday. Most setup types had 0-5 samples. Need 15-30+ normal-day sessions before sample-count alone is reasonable.

### 11.2 Walk-forward fold logic degrades to non-temporal on small corpora
`trainer.py:396-405` — when `< 5 sessions`, falls back to row-index 60/20/20 split. This can leak SAME-SESSION samples between train and test if all 4 sessions stack into one ordered list. The current run used this path (4 sessions → 1 fold by row).

### 11.3 Isotonic calibration on tiny folds produces step functions
Yesterday's reliability curves show 1s predictions ALL at 0.389 and 15s predictions ALL at 0.833. That's not calibration — that's the isotonic regressor outputting a single step for the entire range. Need larger calibration sets OR switch to Platt for low-sample cells.

### 11.4 Gate threshold of `min_auc = 0.50` is too permissive
Accepts random models as shadow-eligible. Should be ≥ 0.55 for shadow, ≥ 0.60 for production.

### 11.5 Direction-side conflation
Each setup carries a `direction` (long/short), but the binary label uses MFE in that direction. There's no separate model per direction — features include direction-indicating one-hots (`cvd_session_direction_*`, `last_trade_aggressor_*`) but the response is direction-asymmetric in ways the model can't fully encode.

### 11.6 No regime conditioning
One model for LOW, NORMAL, HIGH regimes. Regime is a feature, but the slope/intercept on other features may need to change with regime. A regime-conditional ensemble (or interaction features) would likely improve.

### 11.7 No time-of-day / session-time features
Setups during cash-open vs lunch-lull vs close behave differently. Not encoded.

### 11.8 No cap-binding state in features
The σ-shelf cap-binding diagnostic (RA-112e step 10) is a known regime indicator (when cap binds 100%, expected dispersion is suppressed). Not in the feature set — though `sigma` and `atr_14` partially proxy.

### 11.9 No held-out / out-of-sample evaluation YET
The scheduled task at 13:10 PT today produces the first out-of-sample run (today's session against yesterday's models). Until that lands, all metrics are in-sample.

### 11.10 No multi-session aggregation report
Each session's `data/performance/<DATE>_<SESSION>.md` stands alone. No "trailing-N-session AUC trend" report exists. Needed before going live.

### 11.11 V8 string-cap bug only just fixed (2026-06-03)
The labels stage crashed on the prior training run for sessions whose obs01 tape exceeded 512 MB. Fixed by streaming reads/writes (commit `9ce0004`). Existing trained models were trained on the corpus that included this fix's recovery. Worth re-running training once the corpus has grown a few sessions to confirm reproducibility.

---

## 12. Operational workflow ("running in shadow mode")

After each completed session, the operator can either fire the scheduled task or run manually:

```powershell
# Manual one-command shadow-mode pipeline
.\end_of_session_pipeline.ps1 -TradingDate 2026-06-03 -Session rth
```

This chains 5 stages:
1. `post_capture_rotate.ps1` — refresh analytics envelope + tail-cap calibrations + bounce backend
2. `python -m replay` — produce signals.jsonl + setups.jsonl from today's obs01
3. `tsx forward-return-labels/cli.ts` — produce labels.jsonl with realized MFE
4. `python -m scalp_models score` — predictions.jsonl
5. `python -m scalp_models evaluate` — performance.md (+ JSON sidecar)

Outputs land under:
- `data/shadow_runs/<DATE>_<SESSION>/` — signals, setups, labels
- `data/predictions/<DATE>_<SESSION>.jsonl` — per-(row, horizon) calibrated probabilities
- `data/performance/<DATE>_<SESSION>.md` — human-readable performance report
- `data/performance/<DATE>_<SESSION>.md.json` — machine-readable sidecar

---

## 13. File index (for code review)

| File | Lines | Purpose |
|---|---|---|
| `services/replay/replay/setups.py` | 602 | Setup detection logic — the 5 setup_type derivations |
| `services/scalp_models/scalp_models/dataset.py` | ~250 | Setup×label join, TrainingExample, label binarization |
| `services/scalp_models/scalp_models/features.py` | ~165 | FEATURE_NAMES + build_feature_vector |
| `services/scalp_models/scalp_models/trainer.py` | ~500 | Walk-forward folds, C-sweep, calibrator selection, joblib emit |
| `services/scalp_models/scalp_models/gate.py` | ~120 | Gate policy + status decision logic |
| `services/scalp_models/scalp_models/inference.py` | ~190 | Live-serving bundle, ScoreResult |
| `services/scalp_models/scalp_models/evaluate.py` | ~280 | Performance metrics + markdown report |
| `apps/backtester/src/forward-return-labels/labeler.ts` | ~260 | MFE/MAE computation per signal × horizon |
| `apps/backtester/src/forward-return-labels/writer.ts` | ~150 | Labels writer (streaming, V8-cap-safe per 2026-06-03 fix) |
| `end_of_session_pipeline.ps1` | ~180 | Shadow-mode 5-stage chain |
| `score_and_evaluate.ps1` | ~125 | Score + evaluate only (no replay+labels) |

---

## 14. Trained-model state as of 2026-06-03

Run dir: `D:\Quant-futures-app\scratch\ra093b-run1\quiet-window-2026-05-31\model_runs\quiet-window-2026-05-31\`

```
models/
├── zone_rejection_1s.joblib   ← gate=fail · shadow-only · AUC 0.547 in-sample
├── zone_rejection_5s.joblib   ← gate=fail · shadow-only · AUC 0.734 in-sample
└── zone_rejection_15s.joblib  ← gate=fail · shadow-only · AUC 0.500 in-sample

metadata/
├── *_<horizon>s.json          ← per-cell calibration_report-style metadata

trial_reports/
├── *_<horizon>s_fold1.json    ← per-fold metrics

calibration_report.md          ← human-readable trainer output
config.json                    ← repro hashes pinned (setup_sha256, labels_sha256, sklearn versions)
features.json                  ← FEATURE_NAMES + categorical-vocab snapshot
```

**Other setup types have NO model files** because they hit the `min_positives=30 AND min_negatives=30` gate. The training corpus didn't have enough samples.

---

## 15. Pointed questions a reviewer should ask

1. **Is `target_ticks = 4.0` (1 MNQ point) realistic for the 1-second horizon?** Probably not — 4 ticks in 1 second is extreme. The 1s model trains on a label that's essentially "did a tick spike occur in the right direction." This may explain the near-random AUC at 1s.

2. **Why MFE-based label instead of realized return at horizon?** MFE captures optimal exit timing the trader couldn't replicate. Try training both and compare.

3. **Why one model per (setup, horizon) instead of one model with horizon as a feature?** Cross-horizon information sharing might help, given that some horizons have tiny samples.

4. **Should the model emit a direction-conditional probability?** Currently the model predicts `P(MFE ≥ target)` in the setup's pre-declared direction. If the setup direction is wrong (price moves the opposite way), the model has no way to flag it.

5. **Calibration via isotonic on n=80 samples is barely meaningful.** Should the threshold for isotonic vs Platt be more conservative — e.g. "isotonic only when N > 500"?

6. **The "near-random AUC 0.50" at 15s is suspicious — that's TOO neat.** Suggests either (a) the model collapsed to a constant prediction, (b) all the labels at 15s are determined by something the model doesn't have access to. Worth investigating which.

7. **Why `min_auc = 0.50` in the gate at all?** Should be ≥ 0.55 minimum for shadow, ≥ 0.60 for live. Random models shouldn't pass.

8. **What's the false-positive cost of a high-confidence wrong prediction in trading vs the missed-trade cost of a low-confidence right prediction?** This isn't encoded anywhere. Probabilities optimize Brier, but trading optimizes EV given costs.

9. **No accounting for trading cost / slippage anywhere.** A 4-tick MFE doesn't mean a 4-tick realized P&L. Need to subtract round-trip cost (typically 0.5-1 tick on MNQ).

10. **Why no regime conditioning?** The methodology rework (RA-112e step 10) explicitly diagnosed that LOW vs HIGH regimes have very different cap-binding behavior. Models likely need per-regime training or interaction features.

---

## 16. Reviewer's verdict template

For the reviewer to fill in:

```
Setup family adequacy:        [ ] adequate [ ] needs revision
Feature surface completeness: [ ] adequate [ ] missing: ___
Label definition:             [ ] adequate [ ] revise to: ___
Calibration choice:           [ ] adequate [ ] use: ___
Gate thresholds:              [ ] adequate [ ] tighten: ___
Sample-size adequacy:         [ ] adequate [ ] need N more sessions
Reviewer recommendation:      [ ] proceed to shadow accumulation [ ] block and revise

Specific blockers / questions:
1. ___
2. ___
3. ___
```
