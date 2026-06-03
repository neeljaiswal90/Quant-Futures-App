# Scalp Strategy — Comprehensive Review Document

**Status as of 2026-06-03:** trained model artifacts exist for three `zone_rejection` horizons. The production/live gate fails. The system is restricted to offline/shadow scoring only. Reported probabilities are calibrator-transformed scores, not yet validated as well-calibrated live probabilities. This document describes what the strategy IS, what the models DO, how performance is measured, and what's broken / weak. Intended for third-party review.

> **Reviewer's verdict expected**: proceed to shadow accumulation only; block live use; fix validation, labeling, calibration, and cost-aware evaluation before treating any model output as tradable.

---

## 1. Plain-English overview

**The strategy attempts to predict whether a high-confluence detector signal will produce a 4-tick favorable move within 1-300 seconds, then assigns a calibrated probability to each.** It does not generate signals on its own — it CONSUMES signals produced by an upstream detector stack (zones + sweeps + absorption + iceberg + CVD flips + microprice). Each consumed signal is classified into one of 5 setup families, transformed into a 58-feature vector, and run through a per-(setup, horizon) calibrated logistic-regression model. The output is `p_calibrated ∈ [0, 1]` per (setup, horizon) cell.

**What the strategy is not:**
- Not an execution layer — there is no order management, no position sizing, no stops/targets logic. It outputs probabilities.
- Not a feature-discovery layer — features are operator-fixed (`FEATURE_NAMES` tuple, frozen at training time).
- Not a regime-aware ensemble — one model per (setup, horizon), no regime-conditional routing.
- Not yet live — predictions are produced post-session, not on the wire.

**Two gate concepts used throughout this doc — do not conflate:**
- **Production / live gate**: `recommended_action = green_light_live` requires all checks pass AND AUC ≥ 0.55. None of the current models meet this.
- **Shadow / scoring gate**: `recommended_action = green_light_shadow_only` requires only sample-count + Brier sanity to pass. Three zone_rejection cells reach this; they are eligible for offline scoring but NOT for live decision-making.

When this document says "the gate fails," it means the **production/live** gate. Shadow-mode scoring is permitted.

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
                  scalp_models.inference         <── shadow-mode serving
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

### 3.1 `zone_rejection`

**Trigger:** a HIGH or CRITICAL tier zone-firing signal (from the detector that watches v3 σ shelves + structural levels) appears AND the live footprint shows stacked imbalance on the OPPOSITE side from the trade direction.

**Plain-English rule:**
> "Price approached a high-confluence zone (≥2 sources stacked: σ shelf + VAH/VAL/VPOC/LVN/HVN), the signal fired HIGH or CRITICAL tier, AND the orderflow footprint shows aggressors hitting INTO that zone in a way that would get absorbed. Predict whether the next 1-300 seconds produce a 4-tick reversal from the zone."

**Direction:** inherited from the originating zone signal.

**Only setup with enough samples to train** — 142-157 examples per horizon in yesterday's corpus.

### 3.2 `sweep_absorption`

**Trigger:** a sweep event (rapid one-side aggression sweeping through resting orders) immediately followed by an absorption event AT THE SAME PRICE LEVEL within 10 seconds, with price match tolerance of 2 points.

**Plain-English rule:**
> "Aggressors swept the book in one direction, then someone absorbed the continuation right at the level they swept to. This is the canonical 'liquidity grab + reversal' setup. Predict whether the reversal sticks."

**Sample count:** 0 in the training run — gate-failed before training.

### 3.3 `iceberg_hold`

**Trigger:** an iceberg-refill event detected at a level that has zone confluence (≥2 zone sources stacked).

**Plain-English rule:**
> "A hidden refill order is consuming aggressors at a zone-defined level. Holders defending the level. Predict whether they win — i.e. price reverses away from the iceberg side."

**Sample count:** 1/1 in training — gate-failed.

### 3.4 `cvd_flip_at_zone`

**Trigger:** CVD momentum flip (the 15m CVD direction reverses) WHILE price is near a zone.

**Plain-English rule:**
> "Cumulative volume delta direction has just inverted, AND we're at a structural level. The flip might be the start of new auction direction. Predict whether the new direction holds for the next 1-300 seconds."

**Sample count:** 5-24 / horizon in training — gate-failed.

### 3.5 `microprice_flip_zone`

**Trigger:** the microprice lean (depth-imbalance-weighted midprice deviation from mid, in ticks) persists at >|0.5| ticks in one direction for ≥2 seconds at a zone level.

**Plain-English rule:**
> "Top-of-book quote pressure has shifted one direction and SUSTAINED, at a zone. Indicates marker-maker conviction. Predict whether price follows the lean."

**Sample count:** 29-68 / horizon — gate-failed.

---

## 4. Forward-return label definition — the "y" in y=f(x)

**Code:** `apps/backtester/src/forward-return-labels/labeler.ts` (TypeScript). Each row has `mfe_ticks`, `mae_ticks`, `realized_ticks`, `status`.

**Binary label conversion** (`scalp_models/dataset.py:144`):

```python
label = 1 if mfe_ticks >= target_ticks else 0
```

**Default `target_ticks = 4.0`**. So `y = 1` means "within `horizon_seconds`, price reached AT LEAST 4 ticks (1 MNQ point) in the predicted direction."

**Critical caveat — the label is path-blind:**
The current label treats ANY favorable excursion ≥ 4 ticks within the horizon as positive, regardless of how much adverse excursion occurred first. A path that went `-20 ticks` then bounced `+4 ticks` labels positive even though no trader using a sane stop could capture it. See §11.14 for the methodology fix this requires.

**Horizons:** `1, 5, 15, 60, 300` seconds.

---

## 5. Feature surface — 58 features

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

### 5.3 One-hot categoricals (37)

- `last_trade_aggressor_{buy,sell,unknown}` — 3 features
- `cvd_session_direction_{bullish,bearish,neutral,unknown}` — 4
- `cvd_last_15m_direction_{bullish,bearish,neutral,unknown}` — 4
- `zone_kind_{sigma,vwap,vpoc,vah,val,hvn,lvn,ib,globex,rth,other,unknown}` — 12
- `regime_{LOW,NORMAL,HIGH,UNKNOWN}` — 4
- `orderflow_quality_{live,inferred,stale_l1,unavailable,unknown}` — 5
- `depth_quality_{live,inferred,stale_l1,unavailable,unknown}` — 5

**Total: 13 + 8 + 3 + 4 + 4 + 12 + 4 + 5 + 5 = 58 features.**

**Notable absences worth questioning during review:**
- **Setup direction is NOT a feature.** The setup carries a `direction` (long/short) field, but it is NOT encoded in `FEATURE_NAMES`. The label is computed in the setup's direction (so the model implicitly predicts "the favorable move in THIS direction"), but the model has no direct way to learn long-vs-short asymmetries. See §11.5.
- No price-distance to value-area boundaries (VAH/VAL only encoded via `zone_kind`, not as continuous distance)
- No time-of-day feature (no encoding of session-open vs mid-session vs close)
- No prior-touch / persistence features (model doesn't know if the zone has been touched before today)
- No σ-shelf cap-binding state (the new methodology-rework diagnostic isn't a feature)
- No live VWAP-distance feature
- No spread feature (the MBP1 spread isn't fed in)
- No book-aggression count (only ratio)
- No as-of zone snapshot identifier (see §11.13 for the lineage risk)

---

## 6. Training methodology

One model is trained per `(setup_type, horizon)` cell — so up to 5 × 5 = **25 models**, though most are skipped for insufficient samples.

### 6.1 Per-cell flow

For each `(setup_type, horizon)`:

1. **Sample gate:** Default `min_positives = 30`, `min_negatives = 30`. If either is below, cell marked `insufficient_samples`, `recommended_action = block`. No model file written.

2. **Walk-forward fold construction:**
   - Examples sorted by `(session_key, ts_ns)` first — chronological.
   - **If ≥ 5 sessions in the corpus:** sliding-window walk-forward — 60% train, 20% validation, 20% test, sliding by 1 session per fold.
   - **Else (today's case — only 4 sessions):** ONE fold with 60/20/20 split by row index. **Known weakness — temporal leakage risk if same session crosses train/val/test.**

3. **C-grid sweep:** `c_grid = (0.01, 0.1, 1.0, 10.0)` for logistic-regression `C`. For each `C`, average per-fold validation Brier. Pick lowest.

4. **Calibrator selection:** Two candidates per fold: **Platt scaling** (logistic on decision-function scores) vs **isotonic regression** (monotonic, non-parametric). Pick the method with lower average validation Brier across folds. Yesterday's run picked isotonic for all three trained cells.

5. **Final-model fit:** 80% of examples used for the pipeline fit, last 20% for calibrator fit. `Pipeline([StandardScaler, LogisticRegression(C=best_c)])`. Saved as joblib dict.

6. **Per-fold test metrics:** AUC, Brier, calibration error, reliability curve, `hit_rate_at_predicted_ge_0_6`.

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
- **Isotonic regression** — non-parametric monotonic mapping. Strictly more flexible but needs more data to avoid step-function pathologies.

**Today's actuals:** all three trained models picked `isotonic`.

The isotonic step-functions are visible in yesterday's reliability curves — predictions cluster at values like 0.389 / 0.583 / 0.833 because those are the boundary values where the isotonic fit's "steps" landed on small calibration data.

---

## 8. Gate criteria

```python
class ModelGatePolicy:
    min_test_folds: int = 1
    min_test_samples_total: int = 20
    min_test_samples_per_fold: int = 5
    max_brier_score: float = 0.30
    min_auc: float = 0.50
    max_calibration_error: float = 0.25
```

**Recommendation logic:**

| Gate status | All gates pass + AUC ≥ 0.55 | At least sample/Brier gates pass | Otherwise |
|---|---|---|---|
| `recommended_action` | `green_light_live` | `green_light_shadow_only` | `block` |

**Yesterday's actual outcome:** all three trained zone_rejection cells got `green_light_shadow_only` — passed sample-count gates, but `min_auc ≥ 0.55` and/or `max_calibration_error` were not met. Insufficient-sample cells got `block`.

**Critically: `min_auc = 0.50` is the THRESHOLD, not the target.** AUC 0.50 is random-coin-flip discrimination. The gate accepts random models as shadow-eligible. This is a known weakness — the gate is too permissive at the threshold layer.

---

## 9. Live scoring

For a setup_row and (setup_type, horizon):

1. Build feature vector via `features.build_feature_vector(setup_row, tick_size)` — yields a dict keyed by FEATURE_NAMES.
2. Look up the (setup_type, horizon) joblib dict in the bundle.
3. Order the vector by the MODEL's captured `feature_names`.
4. `p_raw = base_pipeline.predict_proba(x)[:, 1][0]` — uncalibrated.
5. `p_calibrated = calibrator.transform([p_raw])[0]` — post-isotonic (or Platt).
6. Return `ScoreResult(setup_type, horizon_seconds, p_raw, p_calibrated, feature_count)`.

**Inference cost:** ~13 ms per setup row when scoring the loaded horizon set (≈3.8 ms per individual `(row, horizon)` score). Scoring 200 rows × 3 horizons takes ~2.3 seconds wall clock.

**This is not yet wired to the live realtime backend** — that requires a separate setup-row builder that mirrors the replay setup-row schema. Currently scoring is offline-batch only.

---

## 10. Performance evaluation

### 10.1 Metrics — what we compute and on what

| Metric | Range / interpretation | Healthy direction | Gate-target | Computed on |
|---|---|---|---|---|
| **Sample counts** (total / + / -) | n, n_positive, n_negative | balanced ideally | ≥30 each class | — |
| **AUC** (ROC) | 0.5 = random, 1.0 = perfect | higher | ≥0.60 (gate min 0.50) | **`p_calibrated`** (current code) |
| **Brier score** | 0 = perfect; baseline = p·(1-p) | lower than baseline | <0.20 (gate max 0.30) | `p_calibrated` |
| **Brier skill score** | `1 - brier/base_brier`; >0 = better than base rate | positive | >0 | `p_calibrated` vs base rate |
| **Log loss** | 0 = perfect | lower | — (not gated) | `p_calibrated` |
| **Calibration error** | mean \|predicted − realized\| over decile bins | lower | <0.05 (gate max 0.25) | `p_calibrated` |
| **Reliability curve** | per-decile (predicted, realized) | diagonal | visual diagnostic | `p_calibrated` |
| **Hit rate @ threshold** | `mean(y \| p≥T)` and lift over base rate | lift > 0 | — | `p_calibrated` |

**AUC source clarification — known issue:** the current evaluator computes AUC on `p_calibrated` only. Isotonic calibration can create ties (multiple inputs map to the same step value), which **degrades AUC's discrimination measurement**. The 15s cell's exact-0.500 AUC may partly reflect this rather than the underlying ranking quality. **Required follow-up:** the evaluator should report BOTH `auc_raw` (on `p_raw`) and `auc_calibrated` so ranking quality is separated from calibration mechanics.

**Confidence intervals — not yet implemented but required for promotion decisions:** with n=142-157 per cell, point estimates are not trustworthy. Reports should include **bootstrap confidence intervals (≥1000 resamples) for AUC, Brier, calibration error, and hit-rate lift, clustered by session** (not naive row-level — setup rows are autocorrelated within a session). Until clustered bootstrap CIs land, treat every point estimate below as a single sample from a noisy distribution.

### 10.1.1 Brier interpretation against the base rate (CRITICAL)

A constant predictor that always outputs the realized positive rate `p` achieves Brier `p·(1-p)`. **Brier alone — without comparing to this base rate — can be misleading on imbalanced labels.** Brier skill score:

```
brier_skill = 1 - (model_brier / base_rate_brier)
```

Positive = model improves over the constant base-rate predictor. Zero = no skill. Negative = model is WORSE than just outputting the average rate.

### 10.2 Same-corpus internal validation — yesterday's numbers

These numbers are from evaluating yesterday's models on the **same 4-session corpus they were trained on** (no held-out session). They are NOT out-of-sample. The scheduled task at 13:10 PT 2026-06-03 produces the first genuine out-of-sample evaluation.

| Cell | n (+ / -) | Realized rate | Mean predicted | AUC (p_calibrated) | Brier | Base-rate Brier `p(1-p)` | **Brier skill** | Calibration err |
|---|---|---|---|---|---|---|---|---|
| zone_rejection 1s | 142 (+35 / -107) | 24.6% | 38.0% | **0.547** | 0.200 | 0.186 | **−7.5%** | 0.185 |
| zone_rejection 5s | 157 (+80 / -77) | 51.0% | 66.2% | **0.734** | 0.243 | 0.250 | **+2.8%** | 0.159 |
| zone_rejection 15s | 157 (+113 / -44) | 72.0% | 83.3% | **0.500** | 0.215 | 0.202 | **−6.6%** | 0.154 |

**Reading these together:**
- The 5s model has the only promising AUC, but its **Brier skill is barely positive (+2.8%)** — it improves over a constant base-rate predictor only marginally.
- **The 1s and 15s cells have NEGATIVE Brier skill** — they are *worse* than a constant predictor of the base rate. The 15s cell's exact-0.500 AUC suggests near-constant predictions (possibly amplified by isotonic step-function ties — see AUC source note above).
- All three over-predict by 11-15 pp.
- Calibration errors 0.15-0.19 are HIGH — the isotonic fits produced step-function output.
- These are **same-corpus internal validation** numbers — out-of-sample on a fresh session will likely be worse.

The headline takeaway for review: **5s has ranking promise but only slight Brier skill; 1s and 15s are currently worse than the base-rate predictor.**

### 10.3 Acceptance criteria for promotion to live

Across **multiple held-out sessions** (not the training corpus):

| Criterion | Threshold |
|---|---|
| AUC (p_raw AND p_calibrated) | ≥ 0.60 sustained per cell |
| **Brier skill score vs base rate** | **> +0.05 (i.e. ≥5% better than constant base-rate predictor)** |
| Calibration error | < 0.05 |
| Hit-rate-at-p≥0.6 lift | > +0.05 over base rate |
| Sample count per cell | ≥ 100 total and ≥ 30 per class across the held-out evaluation window |
| Session concentration | No single session contributes > 40% of cell samples |
| **Stability** | Same cells passing across 3+ sessions |
| **Net expectancy after cost / slippage** | > 0 per trade under explicit spread + commission + slippage assumptions |
| **Median adverse excursion before target** | Within defined risk tolerance per trade |
| **Coverage at decision threshold** | Enough above-threshold events per session to be material |
| **Clustered bootstrap CI** | AUC lower bound > 0.55, Brier skill lower bound > 0 |

**A model cannot be promoted on AUC, Brier, or hit rate alone.** It must show **positive net expectancy under explicit spread + commission + slippage assumptions**, validated on **held-out sessions** with **session-clustered bootstrap confidence intervals** that don't include zero. For MNQ, a 4-tick target is small enough that round-trip execution friction (typically 0.5-1 tick of spread + slippage + commission) can erase most of the apparent edge.

None of yesterday's cells meet these.

---

## 11. Known limitations / risks

### 11.1 Tiny training corpus
4 sessions of which 1 is a holiday. Most setup types had 0-5 samples. Need 15-30+ normal-day sessions before sample-count alone is reasonable.

### 11.2 Walk-forward fold logic degrades to non-temporal on small corpora
When `< 5 sessions`, falls back to row-index 60/20/20 split. Can leak SAME-SESSION samples between train and test. **Required fix:** refuse to train when `n_sessions < 5` rather than fall back to row-index split.

### 11.3 Isotonic calibration on tiny folds produces step functions
Yesterday's reliability curves show 1s predictions ALL at 0.389 and 15s predictions ALL at 0.833. That's not calibration — that's the isotonic regressor outputting a single step. Need larger calibration sets OR switch to Platt for low-sample cells (e.g. "isotonic only when N > 500").

### 11.4 Gate threshold of `min_auc = 0.50` is too permissive
Accepts random models as shadow-eligible. Should be ≥ 0.55 for shadow, ≥ 0.60 for production.

### 11.5 Direction is the label-frame but not a feature
Each setup carries a direction (long/short), and the label is computed in that direction (so a positive `y=1` means a 4-tick favorable move in THE SETUP's pre-declared direction). **But `setup_direction` is NOT in `FEATURE_NAMES`.** This means:
- The model cannot learn long-vs-short asymmetries directly.
- If absorption / sweep / zone-rejection behavior is asymmetric by side (e.g. floor defenses behave differently from ceiling defenses), the model conflates them.
- The model has no way to flag "the setup direction looks wrong" — predictions are always conditional on the upstream direction call being right.

**Fix paths:** add `setup_direction_{long,short}` to `FEATURE_NAMES`, OR train a separate model per direction, OR add direction × feature interaction terms. Choosing among these requires more data.

### 11.6 No regime conditioning
One model for LOW, NORMAL, HIGH regimes. Regime is a feature, but the slope/intercept on other features may need to change with regime. A regime-conditional ensemble would likely improve.

### 11.7 No time-of-day / session-time features
Setups during cash-open vs lunch-lull vs close behave differently. Not encoded.

### 11.8 No cap-binding state in features
The σ-shelf cap-binding diagnostic (RA-112e step 10) is a known regime indicator. Not in the feature set — though `sigma` and `atr_14` partially proxy.

### 11.9 No held-out / out-of-sample evaluation YET
The scheduled task at 13:10 PT 2026-06-03 produces the first genuine out-of-sample run. All numbers in §10.2 are same-corpus internal validation.

### 11.10 No multi-session aggregation report
Each session's report stands alone. No "trailing-N-session AUC trend" report exists. Needed before going live.

### 11.11 V8 string-cap bug only just fixed (2026-06-03)
Labels stage crashed on the prior training run for sessions whose obs01 tape exceeded 512 MB. Fixed by streaming reads/writes. Worth re-running training once the corpus grows to confirm reproducibility.

### 11.12 Overlapping-label / autocorrelation risk
Signals are not independent IID samples. Multiple setup rows can occur during the same local auction, same zone touch, or same volatility burst. Their forward-return horizons overlap, so labels can be mechanically correlated. A row-level train/test split can overstate performance even when ordered chronologically.

**Required fix:** cluster or de-duplicate related setup rows; use **purged + embargoed** temporal validation so no training sample's label horizon overlaps the validation/test period. For a 300s horizon, the embargo must be ≥ 300s between any train and test sample. Same-zone-touch clusters should be split as units, not as individual rows.

### 11.13 As-of feature lineage risk
Every feature must be computed strictly from information available at signal time. This is especially important for zone-derived features because end-of-session profile levels, final session VWAP, or post-hoc zone snapshots can leak future information into training rows.

**Required fix:** every setup row must reference an **as-of zone snapshot ID or input cutoff timestamp**. Training should fail closed if any feature source lacks as-of provenance. Given the recent `feedback_stale_analytics_envelope.md` memory note documenting that end-of-session envelopes routinely differ by 90-140pt from early-session ones, this is not optional — it is central.

### 11.14 MFE label ignores target-before-stop ordering
The current binary label treats any eventual +4 tick favorable excursion within the horizon as positive, regardless of how much adverse movement occurred first. **This can label untradeable paths as winners** (e.g. a path that goes −20 ticks first, then bounces +4, labels positive but is uncapturable with any sane stop).

**Required comparison labels (P0 for any path to live):**
1. MFE-hit-within-horizon (current label — keep for compatibility).
2. **Target-before-stop barrier label** — `y=1` iff target reached before a defined adverse threshold.
3. Net realized ticks after assumed cost/slippage.
4. Time-to-target AND max adverse excursion before target.

Train against (2) at minimum; report (3) and (4) alongside. Until this is done, every reported hit-rate / probability is overstating tradable edge.

### 11.15 Cost-aware evaluation is not yet implemented
For MNQ, a 4-tick target with a typical round-trip friction of 0.5-1 tick (bid-ask spread + slippage + commission) leaves a slim net edge. No metric in this document or the evaluator accounts for cost. **A positive Brier skill score does NOT mean positive trading expectancy.** Cost-aware net expectancy is a P0 promotion blocker — see §10.3.

---

## 12. Operational workflow ("running in shadow mode")

```powershell
.\end_of_session_pipeline.ps1 -TradingDate 2026-06-03 -Session rth
```

Chains 5 stages:
1. `post_capture_rotate.ps1` — refresh analytics envelope + tail-cap calibrations + bounce backend
2. `python -m replay` — produce signals.jsonl + setups.jsonl from today's obs01
3. `tsx forward-return-labels/cli.ts` — produce labels.jsonl with realized MFE
4. `python -m scalp_models score` — predictions.jsonl
5. `python -m scalp_models evaluate` — performance.md (+ JSON sidecar)

Outputs land under:
- `data/shadow_runs/<DATE>_<SESSION>/` — signals, setups, labels
- `data/predictions/<DATE>_<SESSION>.jsonl`
- `data/performance/<DATE>_<SESSION>.md` + sidecar

---

## 13. File index

| File | Lines | Purpose |
|---|---|---|
| `services/replay/replay/setups.py` | 602 | Setup detection logic |
| `services/scalp_models/scalp_models/dataset.py` | ~250 | Setup×label join |
| `services/scalp_models/scalp_models/features.py` | ~165 | FEATURE_NAMES + builder |
| `services/scalp_models/scalp_models/trainer.py` | ~500 | Walk-forward training |
| `services/scalp_models/scalp_models/gate.py` | ~120 | Gate policy |
| `services/scalp_models/scalp_models/inference.py` | ~190 | Live serving |
| `services/scalp_models/scalp_models/evaluate.py` | ~280 | Performance metrics |
| `apps/backtester/src/forward-return-labels/labeler.ts` | ~260 | MFE/MAE computation |
| `apps/backtester/src/forward-return-labels/writer.ts` | ~150 | Labels writer (V8-cap-safe) |
| `end_of_session_pipeline.ps1` | ~180 | 5-stage chain |
| `score_and_evaluate.ps1` | ~125 | Score + evaluate only |

---

## 14. Trained-model state as of 2026-06-03

Run dir: `D:\Quant-futures-app\scratch\ra093b-run1\quiet-window-2026-05-31\model_runs\quiet-window-2026-05-31\`

```
models/
├── zone_rejection_1s.joblib   ← production_gate=fail · recommended_action=shadow_only · AUC 0.547 same-corpus internal validation · Brier skill −7.5%
├── zone_rejection_5s.joblib   ← production_gate=fail · recommended_action=shadow_only · AUC 0.734 same-corpus internal validation · Brier skill +2.8%
└── zone_rejection_15s.joblib  ← production_gate=fail · recommended_action=shadow_only · AUC 0.500 same-corpus internal validation · Brier skill −6.6%
```

Other setup types have NO model files because they hit the `min_positives=30 AND min_negatives=30` gate.

---

## 15. Pointed questions a reviewer should ask

1. **Is `target_ticks = 4.0` (1 MNQ point) realistic for the 1-second horizon?** Probably not — 4 ticks in 1 second is extreme. The 1s model trains on a label that's essentially "did a tick spike occur in the right direction." This may explain the near-random AUC at 1s.

2. **Why MFE-based label instead of target-before-stop?** MFE captures optimal exit timing that no real trader can replicate, and it labels paths with deep adverse excursion as wins. Train and compare against a barrier label (see §11.14).

3. **Why one model per (setup, horizon) instead of one model with horizon as a feature?** Cross-horizon information sharing might help, given that some horizons have tiny samples.

4. **Should the model emit a direction-conditional probability?** Currently the model predicts `P(MFE ≥ target)` in the setup's pre-declared direction, but `setup_direction` is not a feature. If the upstream direction call is wrong, the model has no way to flag it. See §11.5.

5. **Calibration via isotonic on n=80 samples is barely meaningful.** Should the threshold for isotonic vs Platt be more conservative — e.g. "isotonic only when N > 500"?

6. **Why is the 15s AUC exactly near random despite a 72% positive base rate?** Possible causes: (a) the model collapsed to a near-constant ranking on this cell; (b) the features lack the relevant state for the 15s horizon; (c) label imbalance dominates the AUC computation; (d) isotonic calibration introduced ranking-degrading ties (the current evaluator computes AUC on `p_calibrated`, so ties matter). Required follow-up: compute AUC on `p_raw` AND `p_calibrated` separately to isolate which.

7. **Why `min_auc = 0.50` in the gate at all?** Should be ≥ 0.55 minimum for shadow, ≥ 0.60 for live. Random models shouldn't pass even the shadow gate.

8. **What's the false-positive cost of a high-confidence wrong prediction in trading vs the missed-trade cost of a low-confidence right prediction?** This isn't encoded anywhere. Probabilities optimize Brier, but trading optimizes EV given costs.

9. **No accounting for trading cost / slippage anywhere.** A 4-tick MFE doesn't mean a 4-tick realized P&L. Round-trip friction for MNQ is typically 0.5-1 tick. Net expectancy is the only credible promotion metric — see §10.3, §11.15.

10. **Why no regime conditioning?** The methodology rework (RA-112e step 10) explicitly diagnosed that LOW vs HIGH regimes have very different cap-binding behavior. Models likely need per-regime training or interaction features.

11. **Are the reported metrics computed with confidence intervals?** With n=142-157 per cell, the point estimates have wide uncertainty bands. Until session-clustered bootstrap CIs are computed (§10.1), every estimate is a single noisy sample.

12. **Is there as-of provenance on every feature?** The recent `feedback_stale_analytics_envelope.md` finding shows envelopes routinely diverge from end-of-session values by 90-140pt. If any feature was computed against the end-of-session envelope rather than as-of-signal envelope, training has subtle look-ahead leakage. See §11.13.

---

## 16. Reviewer's verdict template

```
Setup family adequacy:        [ ] adequate [ ] needs revision
Feature surface completeness: [ ] adequate [ ] missing: ___
Label definition:             [ ] adequate [ ] revise to: ___
Calibration choice:           [ ] adequate [ ] use: ___
Gate thresholds:              [ ] adequate [ ] tighten: ___
Sample-size adequacy:         [ ] adequate [ ] need N more sessions
As-of feature lineage:        [ ] verified [ ] required before train
Validation methodology:       [ ] purged/embargo'd [ ] required before train
Label methodology:            [ ] target-before-stop ready [ ] required before promotion
Cost-aware evaluation:        [ ] implemented [ ] required before live
Confidence intervals:         [ ] reported [ ] required before promotion
Reviewer recommendation:      [ ] proceed to shadow accumulation [ ] block and revise

Specific blockers / questions:
1. ___
2. ___
3. ___
```
