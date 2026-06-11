# 10 AM opening-range box strategies — build plan

Formalize the 10 AM ET 5-min box strategies (breakout, fade, regime-gated) into
`strategy_runtime` and validate over the Feb–Mar–Apr 2026 corpus (62 sessions).

## Status
- ✅ **Phase 1 (box engine) — committed `031ccb0`.** `StrategyFeatureSnapshotContext`
  now carries `ten_am_box_high/low/ready` (the 10:00 ET first-5-min box = `[30,35)`
  min after the 09:30 RTH open), accumulated in `updateSnapshotContextForBar`. Tested.
- 📝 **Breakout-long generator drafted** — `opening_range_box_breakout_long.ts.draft`
  (this dir). Working strategy logic modeled on `vwap_overnight_reversal_long.ts`;
  needs the registration surface below before it compiles.
- ⬜ Fade + regime-gated variants, registration, YAMLs, fixtures, backtest, gate.

## Design decisions (locked)
- **Box** = 10:00 ET first 5-min candle, `[30,35)` min from RTH open (Phase 1).
- **Breakout**: arm long when price closes above box high + `breakout_buffer_ticks`
  and within `max_chase_ticks`; stop at the opposite box edge − `stop_buffer_ticks`;
  pt1/pt2 by RR. Fade = the inverse (poke beyond an edge, close back inside → fade).
- **Regime-gated**: dispatch breakout-vs-fade by `snapshot.structure.trend` +
  `snapshot.indicators.adx_14` (NOT the volatility `regime_label` — that's vol, not
  trend/range). Trend (ADX ≥ `adx_trend_min`) → breakout; range → fade.
- **Verdicts** are `ADVANCE_TO_PAPER / RESEARCH_FURTHER / REJECT` (Python QFA-611) +
  `pass/fail/blocked/insufficient_evidence` (TS gate). No DEPLOY/CONDITIONAL/AVOID in code.

## Registration surface (exhaustive `Record<StrategyId>` — all ids at once)
Add 6 ids (`opening_range_box_{breakout,fade,regime}_{long,short}`) to
`contracts/strategy-ids.ts:ACTIVE_STRATEGY_IDS`, then satisfy every exhaustive map:

1. `contracts/candidate.ts` — add `'opening_range_box'` to `CandidateSetupFamily`.
2. `strategies/types.ts` — add `'opening_range_box'` to `StrategySetupFamily`; add 6
   `StrategyFixtureId`s; extend `extraction_ticket` union if used.
3. `config/strategy-config.ts` — `OpeningRangeBoxStrategyParameters` interface;
   `DEFAULT_OPENING_RANGE_BOX_*_CONFIG` (6); add 6 keys to `StrategyConfigById`,
   `DEFAULT_STRATEGY_CONFIGS`, `STRATEGY_CONFIG_FILE_NAMES`, the `loadStrategyConfigs`
   reader block, and the `strategy_priority` Record; add a `parseOpeningRangeBoxConfig`
   + a `getStrategyParameters` overload returning `OpeningRangeBoxStrategyParameters`.
4. `strategies/registry.ts` — 6 `STRATEGY_REGISTRY_ENTRIES` (`setup_family:
   'opening_range_box'`, `implementation_status:'active'`, a `synthetic_fixture_id`,
   `enabled_in_v1: true`) + 6 entries in `ACTIVE_STRATEGY_GENERATORS`.
5. `strategies/index.ts` — export the 6 generator files.
6. `strategies/opening_range_box_common.ts` — shared helpers the drafts import:
   `clampBox`, `round4Box`, `roundToTickBox`, `getBoxAtr14Pts` (`snapshot.indicators.atr_14_pts`),
   `rewardRiskBox(price,entry,risk,dir)`, `buildOpeningRangeBoxTargets({...})` → `PriceTarget[]`
   (pt1/pt2, two 0.5 legs summing to 1.0), `validateOpeningRangeBoxParameters`.
7. `apps/backtester/src/.../run-spec-builder.ts` — 6 `STRATEGY_CONFIG_PATHS` entries.
8. `config/strategies/shared.yaml` — 6 `strategy_priority` keys; + 6 per-strategy YAMLs
   in `config/strategies/`.
9. `apps/strategy_runtime/tests/fixtures/strategies/synthetic-feature-snapshots.ts` —
   6 fixtures (set `ten_am_box_high/low` + `ten_am_box_ready:true`, RTH, a regime).
10. Unit tests mirroring `tests/unit/strategies/vwap-overnight-reversal-*.test.ts`
    (armed/blocked paths). `validateStrategyRegistry()` + the fixture-id check fail CI
    otherwise.

## Backtest + gate (the #3 bigger-sample validation)
Corpus already on disk + manifested: `config/research/manifests/manifest-{feb,mar,apr}-2026.json`
→ `D:\qfa-cache\databento\tier-a-feb-mar-2026\` (62 sessions). Then:

```
tsx scripts/qfa-410b-execute.mts --run-id orb-box-cycle1 \
  --manifests config/research/manifests/manifest-feb-2026.json config/research/manifests/manifest-mar-2026.json config/research/manifests/manifest-apr-2026.json \
  --regime-labels artifacts/regime/regime-labels.json --output-dir artifacts/held-out-validation \
  --strategy-ids opening_range_box_breakout_long ... (all 6)

python scripts/strategy-selection/qfa-611-strategy-selection.py \
  --held-out-dir artifacts/held-out-validation \
  --lock-manifest artifacts/strategy-selection/qfa611-cycle1-parameter-locks.json \
  --json-out artifacts/strategy-selection/strategy-selection-orb.json --md-out ...orb.md
```
(Add a parameter-lock-hash per new id, or `--skip-runtime-parameter-hash` while iterating.)
Verdicts land in `artifacts/strategy-selection/`.

## Suggested order
Build all 6 generators + the common, then do the registration surface in ONE pass
(each exhaustive map edited once with all 6 ids), typecheck-iterate to clean, add
fixtures + tests, then run the backtest + gate. The map edits are the tax — doing
all 6 together costs the same as one.
