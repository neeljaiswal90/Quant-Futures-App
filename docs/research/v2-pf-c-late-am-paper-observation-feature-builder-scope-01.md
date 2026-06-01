# V2-PF-C-LATE-AM-PAPER-OBSERVATION-FEATURE-BUILDER-SCOPE-01

## 1. Context and PR #296 evidence gap

This is a scope-only memo for a future causal capture-backed feature builder for:

```text
regime_shock_reversion_short_v2_utc_16_18_exclusion
```

PR #296 concluded:

```text
FEATURE_SNAPSHOT_BRIDGE_BLOCKED_EVIDENCE_GAP
```

The PR #296 bridge preserved the PR #295 bounded normalized OBS replay input and confirmed:

| Field | Value |
|---|---:|
| Bounded OBS replay events | 120 |
| Bounded OBS event mix | `TRADE=120` |
| Bounded OBS replay LF SHA-256 | `52e14d4d72251031886ceb7ce76f1ec2cdd94deef81f7002a5c4ce44d2a42ac6` |
| Feature snapshots emitted | 0 |
| Bounded feature snapshot LF SHA-256 | `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570` |
| `STRAT_EVAL` | 0 |
| `CANDIDATE` | 0 |
| `ORDER_INTENT` | 0 |
| Observation-day eligible | false |
| Observation-day increment | 0 |

PR #296 did the correct thing: it blocked rather than manufacturing snapshots from incomplete capture context. The feature-builder lane now needs to decide what source-data extension or builder design is required before a future bridge can produce real `StrategyFeatureSnapshot` inputs.

## 2. Required `StrategyFeatureSnapshot` field inventory

`StrategyFeatureSnapshot` is schema-rich. Not every field is equally important for this specific v2 UTC 16-18 variant. The distinction below is load-bearing: a field can be schema-required without being v2-logic-required.

| Field family | Schema required | v2 logic required | Candidate pricing required | Diagnostic only | Nullable without behavior change | Current status | Notes |
|---|---|---|---|---|---|---|---|
| `feature_snapshot_id` | yes | yes | yes | no | no | available with new builder | Must be deterministic over bounded input. |
| `source_event_id` | yes | yes | yes | no | no | available_now | Source OBS events carry event IDs. |
| `created_ts_ns` | yes | yes | yes | no | no | available_now | UTC 16-18 gate uses snapshot timestamp. |
| instrument identity | yes | yes | yes | no | no | available_with_join | Can be fixed to MNQ contract metadata only if source provenance proves the contract. |
| session state | yes | yes | yes | no | no | available_with_join | v2 requires RTH/not halt/not roll block. |
| quote bid/ask/mid | yes | indirect | yes | no | no | blocked_missing_source in normalized OBS | v2 entry price uses `snapshot.quote.mid_px`. |
| last trade price | yes | no | helpful | yes | no | available_now | `TRADE=120` exposes trade prices. |
| bar OHLCV context | yes | no | yes via indicators | yes | no | available_with_new_builder | Needed to derive `sigma_pts`, VWAP, and signed shock. |
| `indicators.sigma_pts` | no map field, but runtime required | yes | yes | no | no | available_with_new_builder | v2 throws if `sigma_pts` is missing or non-finite. |
| regime label | yes | yes | no | no | no | available_with_join | v2 blocks on `unknown` or non-trading regime. |
| signed shock VWAP | yes | yes | no | no | no | available_with_new_builder | v2 blocks on null shock. |
| signed shock recent values | yes | no | no | diagnostic | yes | defer_not_required_for_v2 | Important for other variants, not v2 gate. |
| VIX value | yes | no | no | diagnostic | yes | available_with_join | Not consumed by v2 logic, but useful for observation diagnostics. |
| VIX freshness | yes | no | no | diagnostic | yes | available_with_join | Not consumed by v2 logic. |
| VIX prior-close percentile | yes | no | no | diagnostic | yes | available_with_join | v3 consumes this; v2 does not. |
| primary percentile | no direct v2 field | no | no | diagnostic | yes | available_with_join | Can be joined from regime labels if needed for reporting. |
| VXN percentile | no direct v2 field | no | no | diagnostic | yes | available_with_join | Diagnostic only for this v2 lane. |
| spread bucket | not direct schema field | no | maybe | diagnostic | yes | blocked_missing_source in normalized OBS | Requires quote/depth context. |
| queue-ahead bucket | not direct schema field | no | no | diagnostic | yes | blocked_missing_source | Requires depth/order-book context. |
| config lineage | yes | yes | yes | no | no | available_now | Use dedicated paper config lineage. |

Minimum behavior-bearing set for this strategy is therefore:

```text
created_ts_ns
session.is_rth/session.is_halt/session.is_roll_block
quote.mid_px
instrument.tick_size
indicators.sigma_pts
context.regime_label
context.signed_shock_vwap.value
config lineage
```

VIX, VXN, primary percentile, signed-shock recent values, spread bucket, and queue bucket remain important diagnostics, but they are not standalone blockers for v2 behavior if explicitly serialized as unavailable and not fabricated. Regime and signed-shock VWAP are blockers.

## 3. Current capture and analytics surfaces inventory

| Surface | Current role | Useful fields | Limitation |
|---|---|---|---|
| Raw Rithmic capture | Market-data capture source | L1 quote, best bid/offer, MBO/depth, trade-like messages if preserved | Large live-growing files; not yet the bounded replay source for PR #296. |
| Normalized `obs01` JSONL | Current paper bridge source | `TRADE` journal events in the PR #296 bounded sample | Current bounded sample has no quote/bar/VIX/regime/signed-shock context. |
| zones/probability/absorption outputs | Dashboard analytics | Session/profile style derived analytics | May be aggregate or post-hoc; unsafe as strategy input unless timestamp causality is proven. |
| PR #291 paper wrapper/config | Dedicated paper runtime control | Exact strategy ID, mock adapter, paper-only explicit strategy set | Does not build features. |
| PR #295 live-capture bridge | Normalized event ingestion proof | Bounded OBS hash and replay plumbing | Event ingestion only; no strategy snapshots. |
| PR #296 feature-snapshot bridge | Evidence-gap proof | Bounded snapshot payload hash and missing-context list | Correctly emits zero snapshots. |
| `rel-00c` controlled-live-sim builder | Reference implementation | Builds snapshots from quote/trade state and synthetic/simple indicators | Null-fills or synthesizes several fields; not acceptable as evidence unless capture-backed for v2-critical fields. |
| real-archive execution builder | Canonical archive feature path | Bars, quote fallback, sigma/ATR, session context, VIX/regime seed, signed-shock calculation | Archive-specific; should guide, not be blindly reused for live capture. |

The most important boundary: the raw capture may contain enough source material, but the current normalized `obs01` bounded sample does not. A future builder should not pretend `obs01` is sufficient just because raw capture files elsewhere contain richer streams.

## 4. Field-by-field causal derivation plan

| Feature family | Classification | Source surface | Timestamp basis | Causality rule | Lookahead risk | Missing-data behavior | Test requirement |
|---|---|---|---|---|---|---|---|
| event timestamp / `created_ts_ns` | available_now | source event | event `ts_ns` | snapshot timestamp must equal or follow latest consumed source event | low | reject malformed timestamp | bounded timestamp fixture test |
| price / mark / bid / ask | available_with_new_builder | raw quote/BBO plus trades | latest quote at or before snapshot timestamp | bid/ask must come from quote event no later than snapshot | medium | fail closed if no quote | no-lookahead quote join test |
| bar OHLCV context | available_with_new_builder | trade stream plus optional quote stream | bar close/end timestamp | bar includes only events with timestamp <= bar end | high | no snapshot until minimum bars exist | bar builder causality test |
| spread bucket | available_with_new_builder | quote/BBO or depth | latest quote at snapshot timestamp | spread from bid/ask no later than snapshot | medium | null/deferred if no quote | spread bucket deterministic test |
| queue-ahead bucket | blocked_missing_source | MBO/depth | depth event timestamp | queue estimate only from depth state <= snapshot | high | unavailable/deferred | depth lineage test if implemented |
| regime label | available_with_join | regime labels/session calendar | prior-close or session label timestamp | session label must be known before session use | medium | fail closed for v2 if unknown | regime join test |
| primary percentile | available_with_join | regime labels | prior-close/session label | join only from pre-session or session-static label | medium | nullable diagnostic | diagnostic join test |
| VXN percentile | available_with_join | regime labels | prior-close/session label | join only from pre-session or session-static label | medium | nullable diagnostic | diagnostic join test |
| VIX value | available_with_join | VIX series loader | prior close or latest value timestamp | value timestamp must be <= snapshot timestamp | medium | nullable diagnostic for v2 | VIX freshness test |
| VIX freshness | available_with_join | VIX series loader | VIX value timestamp | freshness computed from age threshold | medium | false if missing/stale | missing VIX test |
| VIX prior-close percentile | available_with_join | VIX quartiles/series | prior close | prior-close only, no same-day future percentiles | medium | nullable diagnostic for v2 | prior-close join test |
| signed_shock_vwap | available_with_new_builder | causal bar/VWAP/sigma state | current snapshot timestamp | VWAP and sigma use only completed/current causal data | high | fail closed for v2 if null | signed shock no-lookahead test |
| signed_shock_vwap_recent_values | available_with_new_builder | same signed-shock builder | per-bar timestamps | each recent value uses only prior/current bars | high | nullable for v2 | recent-values ordering test |
| session_id | available_with_join | calendar/session resolver | source timestamp | derived from exchange/session calendar using timestamp | low | fail closed if unresolved | session resolver test |
| UTC entry-time gate context | available_now | `created_ts_ns` | snapshot timestamp | compute UTC hour from `created_ts_ns`, not fill/exit/local time | low | fail closed on invalid timestamp | boundary test 16:00/18:00 UTC |

## 5. Fields unavailable or deferred

The following should be considered deferred until a source-data extension or builder proves them causal:

| Field | Deferred reason |
|---|---|
| quote bid/ask/mid from normalized `obs01` | PR #296 bounded sample contained `TRADE=120` only. |
| spread bucket | Requires quote/BBO state. |
| queue-ahead bucket | Requires MBO/depth state and a defined queue model. |
| signed_shock_vwap | Requires causal VWAP, bar, and sigma/ATR state. |
| signed_shock_vwap_recent_values | Requires causal rolling shock state. |
| regime label | Needs explicit session/prior-close join. |
| VIX/VXN/primary percentile diagnostics | Need explicit prior-close/session join and freshness semantics. |

For v2 behavior, the blocking fields are quote mid, `sigma_pts`, regime label, signed-shock VWAP, and session state. VIX/VXN/primary percentile are useful observation diagnostics but should not block a v2-only builder if they are absent and explicitly serialized as unavailable.

## 6. No-lookahead contract

Future implementation must satisfy all of these rules:

- Every snapshot must record the bounded source input hash and feature snapshot payload hash.
- Every snapshot must carry enough lineage to identify the max source timestamp used.
- For every snapshot, `max_source_event_ts_ns_used <= snapshot.created_ts_ns`.
- No dashboard aggregate, session summary, absorption output, or probability-card field may be used unless its own timestamp proves it existed at or before `snapshot.created_ts_ns`.
- Raw capture joins must be bounded and deterministic; full live-file SHA remains point-in-time only.
- The UTC exclusion gate must use `snapshot.created_ts_ns`, not fill timestamp, exit timestamp, local time, session label text, or dashboard time.
- Synthetic fixtures and controlled-live-sim placeholders may be used for tests only; they must not be labeled capture-backed evidence.

## 7. Missing-data and stale-data fail-closed rules

Future builder behavior should be:

| Missing/stale field | Behavior |
|---|---|
| quote bid/ask/mid | Do not emit a behavior-bearing snapshot. |
| session state | Do not emit a behavior-bearing snapshot. |
| `sigma_pts` | Do not emit a behavior-bearing snapshot. |
| regime label | Do not emit a behavior-bearing v2 snapshot; v2 blocks on unknown regime. |
| signed-shock VWAP | Do not emit a behavior-bearing v2 snapshot; v2 blocks on null shock. |
| VIX/VXN/primary percentile | May emit for v2 only if explicitly null/diagnostic and not used as a gate. |
| spread/queue diagnostics | May emit null/deferred diagnostics if not used by v2 logic. |
| source timestamp ordering | Reject snapshot and report causality failure. |
| ambiguous contract/session | Reject snapshot and report source-data gap. |

## 8. Candidate implementation paths

| Path | Assessment | Recommendation |
|---|---|---|
| Reuse `rel-00c` builder | Useful reference for quote/trade state plumbing and `processFeatureSnapshot`, but it null-fills VIX/regime/signed-shock context and can synthesize bars. | Do not reuse as evidence unless modified/proven capture-backed for v2-critical fields. |
| New paper-only builder | Cleaner authority boundary; can be dedicated to mock/paper replay and exact strategy ID. | Preferred after source-data extension defines quote/bar/VIX/regime inputs. |
| Extend normalized OBS | Most direct blocker fix. `obs01` should expose bounded quote/BBO and enough causal bar/session input, or point to a bounded raw-capture slice. | Recommended next lane. |
| Join analytics outputs | Risky because zones/probability/absorption can be session aggregate or post-hoc. | Only allow fields with explicit availability timestamp and no-lookahead proof. |
| Join VIX/regime series | Plausible for prior-close/session-static diagnostics and regime gate input. | Include in source-data extension if timestamps and freshness semantics are explicit. |
| Reuse real-archive builder concepts | Good reference for `sigma_pts`, signed-shock, session context, and VIX/regime seeds. | Use as design guide, not direct live-capture implementation. |

## 9. Proposed implementation surfaces

Recommended future source-data extension surfaces, subject to actual implementation review:

```text
scripts/paper/run-v2-pf-c-late-am-feature-snapshot-bridge.ts
scripts/paper/run-v2-pf-c-late-am-live-capture-bridge.ts
apps/strategy_runtime/src/paper-trading/
apps/strategy_runtime/src/strategies/types.ts
apps/backtester/src/real-archive-execution/snapshot-features.ts
apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts
```

Possible new helper surface:

```text
scripts/paper/v2-pf-c-late-am-capture-feature-builder.ts
```

If normalized OBS source-data needs extension, likely surfaces include the Rithmic analytics normalizer under:

```text
tools/rithmic_analytics/
```

This memo does not authorize any of those changes. It only scopes the next dependency.

## 10. Proposed tests

Future implementation should include tests for:

| Test | Purpose |
|---|---|
| bounded input hash stability | Prove the replay source sample is deterministic. |
| feature snapshot payload hash stability | Prove the exact runtime input is deterministic. |
| no-lookahead timestamp joins | Assert every source event used is at or before `created_ts_ns`. |
| missing quote fails closed | Prevent trade-only snapshots from fabricating bid/ask/mid. |
| missing regime fails closed for v2 | Preserve v2 gate semantics. |
| missing signed-shock fails closed for v2 | Preserve v2 gate semantics. |
| VIX diagnostic nullable path | Confirm VIX can be absent without changing v2 behavior if not consumed. |
| synthetic source cannot be labeled capture-backed | Prevent fixture/control data from becoming observation evidence. |
| exact strategy set | Keep runtime target exactly `regime_shock_reversion_short_v2_utc_16_18_exclusion`. |
| active/candidate rosters empty | Preserve zero-active governance. |
| observation-day credit locked to false for bridge/control runs | Preserve 45/60 day accounting boundary. |

## 11. Determinism and bounded replay hash expectations

Future bridge evidence should report all three hash scopes:

| Hash | Scope | Authority |
|---|---|---|
| full live source SHA | `point_in_time_full_file` | Informational only because live capture can grow. |
| bounded source event LF SHA | exact bounded source sample | Authoritative source input hash. |
| bounded feature snapshot payload LF SHA | exact `processFeatureSnapshot` input payload | Authoritative runtime input hash. |

The PR #296 bounded OBS replay hash should remain a comparison anchor when the same 120-event sample is used:

```text
52e14d4d72251031886ceb7ce76f1ec2cdd94deef81f7002a5c4ce44d2a42ac6
```

If a future ticket changes the bounded sample definition, it must state why the hash changed and preserve the full-file hash as point-in-time only.

## 12. Authority caveat

This scope memo creates no broker/live authority, no Phase 6 authority, no active-roster authority, no candidate-roster authority, and no paper-observation day credit.

Required observation accounting remains:

```text
observation_day_eligible = false
observation_day_increment = 0
```

qfa-611 evidence and paper-observation governance remain evidence inputs, not operational authority by themselves.

## 13. Recommended next ticket

Recommendation:

```text
SOURCE_DATA_EXTENSION_REQUIRED_BEFORE_BUILDER_IMPL
```

A feature builder is technically plausible, but implementation is premature until the capture-backed source-data contract is extended or proven to provide the behavior-bearing fields v2 actually needs: quote mid, causal bar/sigma state, regime label, signed-shock VWAP, session state, and deterministic config/source lineage.

Recommended next ticket:

```text
V2-PF-C-LATE-AM-PAPER-OBSERVATION-SOURCE-DATA-EXTEND-01
```

Purpose: extend or prove the bounded source-data surface for quote/BBO, causal bar state, session/regime joins, VIX diagnostics, and signed-shock inputs before a future `FEATURE-BUILDER-IMPL` ticket attempts to emit capture-backed `StrategyFeatureSnapshot` payloads.
