# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-HALT-ROLL-CALENDAR-SOURCE-EXTEND-01

Determination: `HALT_ROLL_CALENDAR_SOURCE_READY_FOR_FEATURE_BUILDER`

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SNAPSHOT-BUILDER-IMPL-01`

## Target event

- Strategy: `regime_shock_reversion_short_v2_utc_16_18_exclusion`
- Target timestamp: `1780423199835478000` / `2026-06-02T17:59:59.835478000Z`
- Source path: `D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.mbp1.jsonl`
- Latest finite mid: `30628`

## Field readiness

| Field | Status | Value | Mapped from | Notes |
| --- | --- | --- | --- | --- |
| session.is_halt | READY | false | getMnqSessionPhase(...).is_maintenance_halt // journal_phase === halted | At the PR #303 bounded target timestamp, the explicit MNQ session calendar classifies the event as RTH, with no maintenance halt or closed-session reason. This proves calendar-backed halt readiness only; no StrategyFeatureSnapshot is emitted. |
| session.is_roll_block | READY | false | evaluateRoll(...).block_new_entries | At the PR #303 bounded target timestamp, the explicit MNQ roll calendar classifies roll_phase as normal, outside any configured roll window, with no roll_block_window reason. |

## Explicit calendar provenance

| Field | Repo path | Symbol/function | Calendar source | Date basis | Target timestamp basis | Value | Why causal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| session.is_halt | apps/strategy_runtime/src/session/mnq-session-calendar.ts; config/session/mnq-session-calendar.yaml | getMnqSessionPhase(...).is_maintenance_halt and journal_phase | MNQ session calendar | target session 2026-06-02-rth; local date 2026-06-02; trading date 2026-06-02 | PR #303 latest finite mid quote timestamp 1780423199835478000 / 2026-06-02T17:59:59.835478000Z | false | The PR #303 bounded target event timestamp is evaluated directly by the repo MNQ session calendar loaded from config/session/mnq-session-calendar.yaml. The timestamp is in the 2026-06-02 RTH session, the derived phase is rth, journal_phase is rth, reasons are empty, and is_maintenance_halt is false. No script-local calendar rule substitutes for the repo helper. |
| session.is_roll_block | apps/strategy_runtime/src/session/mnq-roll-calendar.ts; config/session/mnq-roll-calendar.yaml; apps/strategy_runtime/src/session/mnq-session-policy.ts | evaluateRoll(...).block_new_entries | MNQ roll calendar | target session 2026-06-02-rth; roll calendar timestamp evaluation in UTC ns | PR #303 latest finite mid quote timestamp 1780423199835478000 / 2026-06-02T17:59:59.835478000Z | false | The same PR #303 bounded target event timestamp is evaluated directly by the repo MNQ roll calendar loaded from config/session/mnq-roll-calendar.yaml. The timestamp is outside configured roll windows, roll_phase is normal, in_roll_window is false, block_new_entries is false, flatten_required is false, and reasons are empty. No script-local roll rule substitutes for evaluateRoll. |

## Session calendar evidence

- Session ID: `2026-06-02-rth`
- Trading date: `2026-06-02`
- Local time: `2026-06-02 13:59 America/New_York`
- Phase: `rth`
- Journal phase: `rth`
- is_rth: `true`
- is_maintenance_halt: `false`
- is_halt calendar value for builder: `false`
- Reasons: `none`

## Roll calendar evidence

- Active contract: `MNQM6`
- Roll phase: `normal`
- In roll window: `false`
- block_new_entries: `false`
- flatten_required: `false`
- is_roll_block calendar value for builder: `false`
- Reasons: `none`

## Source anchors

| Source | Path | SHA |
| --- | --- | --- |
| Session calendar config | config/session/mnq-session-calendar.yaml | 31fba43927801cd179e23f6997ba824928fdd0d984473f3c61ce05db1004f7b4 |
| Session calendar code | apps/strategy_runtime/src/session/mnq-session-calendar.ts | 4420ed9a6e167f2ea3c8c17dd1f5f2b6517ecdd1e7a1739902d3cf8cb19dac05 |
| Roll calendar config | config/session/mnq-roll-calendar.yaml | 06101663bb47d7798ec430be17801df0531469269e76a29c24eb080afd486207 |
| Roll calendar code | apps/strategy_runtime/src/session/mnq-roll-calendar.ts | 1ea59f1eb2c55955e66be7b3ab985923eb17e7a9b09534e465eabed7a657ebbc |
| Session policy code | apps/strategy_runtime/src/session/mnq-session-policy.ts | 689b8030c058f56cbd65f13307bcd531361794e57cdb15a4d235982bf2e0e2f1 |
| PR #306 feature-source recheck report | artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-feature-source-recheck-01/feature-source-recheck-report.json | cfa13a3e1e6f160c7e0fc4d2c34c53170c2688047a7e25f06bec449a38ebc4b1 |

## Non-overclaim boundary

This proves calendar-backed halt/roll source readiness for the 2026-06-02 bounded target event only. It does not materialize `StrategyFeatureSnapshot`, does not emit strategy runtime markers, does not run qfa-410b/qfa-611, does not award observation-day credit, and creates no paper/live/broker/Phase 6/roster authority.

## Feature-builder readiness delta

resolves last known source-readiness blocker from PR #306; feature builder implementation may now be scoped, but this PR does not authorize implementation or observation-day credit.
