# CYCLE4-R1-V3-VIX-GATE-SCOPE-01 discovery

## 1. Context

This discovery scopes the VIX-percentile gate hypothesis for `regime_shock_reversion_short_v3`.

Current governance state:

- `ACTIVE_STRATEGY_IDS` is empty.
- `CANDIDATE_STRATEGY_IDS` is empty.
- `regime_shock_reversion_short_v3` is REGISTERED_INACTIVE.
- v3 is generator-backed through explicit `getStrategyGenerator(...)` replay.
- v3 has no paper-observation, broker, live, ACTIVE-roster, or Phase 6 authority.

Important current-state correction: v3 is already the VIX-percentile gated variant. The current v3 generator consumes `snapshot.context.vix_prior_close_percentile`, fails closed when it is unavailable, and blocks the configured overfire band.

Known current VIX surfaces:

- `StrategyFeatureSnapshot.context` already includes `vix_value`, `vix_fresh`, and `vix_prior_close_percentile`.
- `artifacts/regime/regime-labels.json` includes `primary_percentile` for all 62 labels and also includes `vxn_percentile`.

This memo is discovery-only. It does not authorize implementation, activation, paper observation, broker dispatch, Phase 6, or roster mutation.

## 2. Current v3 governance and evidence state

`regime_shock_reversion_short_v3` is registered inactive and generator-backed:

| Surface | Current state |
|---|---|
| Roster | `REGISTERED_INACTIVE_STRATEGY_IDS` |
| `enabled_in_v1` | `false` |
| `ACTIVE_STRATEGY_IDS` | `[]` |
| Generator | present in `STRATEGY_GENERATORS` |
| Active execution listing | excluded because active generator map is empty |
| Setup family | `regime_shock_reversion` |
| Direction | short |

v3 relationship to the adjacent variants:

| Variant | Relationship |
|---|---|
| v2 | v3 mirrors v2 signal construction and adds a VIX-percentile overfire-band gate. |
| v4 delay | v4 delay tests producer-owned signed-shock delay confirmation; it does not include the v3 VIX gate. |
| v4 persist | v4 persist tests producer-owned signed-shock persistence confirmation; it does not include the v3 VIX gate. |
| v5 strict/trail | v5 variants are management-axis deadline-extension variants; they do not test VIX gating. |

Known evidence state:

| Evidence | Result |
|---|---|
| Track B informational v3 artifact | `363` trades, PF `1.215465`, annualized Sharpe `2.194210`, DSR probability `0.860884` |
| Track B solo informational verdict | `REJECT` |
| Track B solo failed thresholds | `hurdle_pass`, `pf_pass`, `sensitivity_audit_pass` |
| Cycle4 v4 inference | both v4 variants `REJECT` |
| Cycle4 v5 inference/reconcile | both v5 variants `REJECT`; deadline behavior unresolved because zero deadline exposure |

## 3. VIX-percentile hypothesis

The original hypothesis was that `regime_shock_reversion_short_v3` may need a VIX-percentile or volatility-regime gate to avoid weak or over-fired volatility contexts.

Current v3 implements the concrete overfire-band version:

| Parameter | Value |
|---|---:|
| `vix_pct_overfire_lower_bound` | `0.67` |
| `vix_pct_overfire_upper_bound` | `0.85` |

Gate semantics:

- Missing or non-finite `vix_prior_close_percentile` blocks entry.
- `0.67 <= vix_prior_close_percentile < 0.85` blocks entry with `regime_shock_reversion_short_v3:vix_in_overfire_band`.
- Percentiles below `0.67` or at/above `0.85` continue through the inherited v2-style session, regime, signed-shock, target, and stop checks.

Why it might help v3 specifically:

- v2/v3 are short-side regime shock-reversion strategies.
- The intended v3 thesis is that a middle-high VIX percentile band may overfire short shock-reversion entries without providing the extreme-volatility follow-through needed for robust edge.
- v3 does not change management; any improvement must come from entry filtering, not exit semantics.

## 4. Existing volatility/regime data inventory

| Surface | Availability | Notes |
|---|---|---|
| `StrategyFeatureSnapshot.context.vix_value` | available | Runtime context field exists. |
| `StrategyFeatureSnapshot.context.vix_fresh` | available | Runtime context field exists, but current v3 does not explicitly gate on freshness. |
| `StrategyFeatureSnapshot.context.vix_prior_close_percentile` | available | Current v3 consumes this directly. |
| `artifacts/regime/regime-labels.json.primary_percentile` | available | Present for all 62 labels; observed min/max `0.1` to `1.0`. |
| `artifacts/regime/regime-labels.json.vxn_percentile` | available | Present for all 62 labels; potentially useful for Nasdaq-specific proxy research. |
| FRED VIX series contract | available | `VixSeries` / `VixObservation` contracts exist. |
| VIX quartile helpers | available | Deterministic boundaries, quartile bucketing, and date lookup exist. |
| VIX loader | available | Validates normalized FRED VIXCLS artifacts. |
| VIX fetcher | available | `scripts/research/fetch-vix-series.py` fetches normalized FRED VIXCLS when `FRED_API_KEY` is supplied. |

The repository already has technical VIX support for a session-level prior-close percentile gate. It does not need an in-strategy VIX recomputation.

## 5. Runtime feature feasibility

Technical support exists for the current v3 gate:

- The strategy snapshot schema includes `vix_prior_close_percentile`.
- The real-archive snapshot producer carries `vix_value`, `vix_fresh`, `vix_prior_close_percentile`, and `regime_label` through `SnapshotContextSeed` and `SnapshotContextState`.
- The v3 generator consumes `snapshot.context.vix_prior_close_percentile` rather than recomputing VIX inside the strategy.
- The v3 generator fails closed when the percentile is unavailable.

Technical gaps for future refinements:

- Current v3 does not explicitly require `vix_fresh === true`; missing percentile blocks, but stale/fresh semantics are not separately enforced by the generator.
- The held-out artifact does not serialize per-evaluation VIX gate blocked counts, so post-run evidence can show emitted trades that passed the gate but not all blocked opportunities.
- Bar-level or intraday volatility gates would require a new producer-owned context design; the current field is session/prior-close oriented.

## 6. Candidate gate designs

| Design | Feasibility | Comment |
|---|---|---|
| Current overfire-band exclusion | already implemented | Blocks `0.67 <= percentile < 0.85`; this is current v3. |
| High-volatility-only gate | feasible with existing percentile | Would allow only high percentile contexts, for example `>= 0.85`; needs evidence before implementation. |
| Low-volatility exclusion gate | feasible with existing percentile | Would block low percentile contexts; not currently supported by v3 evidence. |
| Percentile band gate | feasible with existing percentile | Generalization of current v3; must be a new registered-inactive variant if parameter values change. |
| Regime-label proxy gate | feasible with existing `regime_label` | Coarser than percentile and already partly present through high/low/mid regime logic. |
| Session-level VIX prior-close gate | current approach | Causally cleaner and already schema-supported. |
| Bar-level/intraday volatility gate | requires upstream work | Would need producer-owned feature/substrate work and no-lookahead tests. |
| VXN percentile proxy | feasible for research discovery | `vxn_percentile` exists in regime labels, but runtime strategy context does not currently expose it as a first-class field. |

## 7. Fail-closed semantics

Required fail-closed behavior for any future VIX or volatility gate:

| Condition | Expected behavior |
|---|---|
| Missing percentile | block entry |
| Null percentile | block entry |
| Non-finite percentile | block entry |
| Stale VIX data | block entry if freshness is part of the gate contract |
| Insufficient lookback for percentile | block entry |
| Out-of-session or unmatched session context | block entry |
| Unknown regime when using regime proxy | block entry |

Current v3 already blocks missing/null/non-finite `vix_prior_close_percentile`. A future implementation that claims freshness discipline should also test `vix_fresh === false` explicitly.

## 8. Implementation options

### Option A: Do not implement another VIX gate; reconcile current v3 evidence

Recommended.

Because current v3 already implements the VIX overfire-band gate, the next useful ticket should not duplicate implementation. Instead, route a governance/evidence memo that reconciles current v3 status:

- v3 is REGISTERED_INACTIVE.
- v3 is VIX-gated.
- Track B informational v3 evidence was `REJECT`.
- v3 has no activation or paper authority.
- Any future VIX parameter change requires a new registered-inactive variant or governance-authorized parameter-lock amendment.

Candidate ticket name:

`CYCLE4-R1-V3-VIX-GATE-RECONCILE-01`

### Option B: Implement VIX freshness hardening as a new registered-inactive variant

Only if coordinator/operator wants explicit `vix_fresh` enforcement. This would likely be a new variant, not a mutation of existing v3, unless governance explicitly authorizes a v3 contract change.

### Option C: Abandon additional VIX work

Reasonable if current v3 `REJECT` is considered sufficient closure for the CYCLE4-R1 hypothesis.

### Option D: Use an existing volatility/regime proxy instead of VIX

Possible options include `regime_label`, `vxn_percentile` research, or secondary realized-volatility fields in the regime artifact. Runtime exposure and causality would need separate verification.

## 9. Expected test scope

If a future implementation changes VIX gating, expected tests include:

| Surface | Expected tests |
|---|---|
| Strategy unit tests | arms below lower bound, blocks within band, arms at upper-bound boundary, blocks missing/null/non-finite percentile |
| Freshness tests | blocks `vix_fresh === false` if freshness is part of the contract |
| Parameter parser | validates lower/upper bounds, rejects inverted/out-of-range bounds |
| Snapshot producer | proves prior-close percentile is producer-owned and no-lookahead |
| Registry/config | registers any new variant as REGISTERED_INACTIVE only |
| Explicit replay | `getStrategyGenerator(...)` works while `listExecutableStrategyIds()` remains empty |
| Artifact evidence | documents that blocked gate opportunities are unavailable unless a new evidence surface is added |
| Determinism | same-worktree byte-equality and PROCESS-03 classification |

If the next ticket is a reconciliation memo only, no tests are required beyond scope/status verification.

## 10. PROCESS-03 hash-impact expectations

| Change class | Expected hash impact |
|---|---|
| Discovery/reconciliation memo only | no runtime hash impact; docs/backlog only |
| New registered-inactive VIX variant | config-input lineage drift likely from new YAML/ranking/run-id surfaces; active behavior should remain unchanged |
| Existing v3 parameter mutation | not recommended; would alter strategy fingerprint/evidence lineage and likely require governance authorization |
| Snapshot schema/producer change | evidence-surface or runtime/journal drift possible; requires no-lookahead tests and same-worktree baseline classification |
| New held-out inference artifacts | evidence-surface drift by design; must be byte-stable and isolated from active-roster behavior changes |

No hash repins are authorized by this discovery ticket.

## 11. Recommendation

Recommended next ticket:

`CYCLE4-R1-V3-VIX-GATE-RECONCILE-01`

Recommended scope:

- Memo/backlog only.
- Record that current v3 already implements the CYCLE4-R1 VIX overfire-band gate.
- Reconcile Track B informational v3 evidence as `REJECT`.
- Preserve registered-inactive status and no-authority posture.
- Decide whether CYCLE4-R1 is closed or whether a separate new variant should test a different VIX/freshness/proxy hypothesis.

I do not recommend implementing another v3 VIX-percentile gate as the immediate next step, because the current v3 generator already implements the specific `0.67` to `0.85` overfire-band gate.

## 12. Open coordinator/operator decisions

| Decision | Owner |
|---|---|
| Whether current v3 `REJECT` evidence closes CYCLE4-R1 | Operator/coords |
| Whether to draft `CYCLE4-R1-V3-VIX-GATE-RECONCILE-01` | Operator/coords |
| Whether to explore VIX freshness hardening as a new variant | Operator/coords |
| Whether to explore VXN or realized-volatility proxy gating | Operator/coords |
| Whether blocked-gate opportunity counts are worth adding to a future evidence surface | Operator/coords |

No implementation or authority change is recommended by this discovery memo.
