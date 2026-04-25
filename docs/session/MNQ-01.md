# MNQ-01: MNQ Session And Roll Calendar Policy

## Purpose

MNQ-01 defines the offline calendar substrate for V1 replay and simulation. It does not fetch live broker data, Databento data, or orders. Callers provide canonical event timestamps; the helpers classify session state, select the active MNQ contract, and report roll-entry/flatten policy decisions deterministically.

## Config Files

- `config/session/mnq-session-calendar.yaml` contains the CME/MNQ session rules.
- `config/session/mnq-roll-calendar.yaml` contains quarterly H/M/U/Z roll periods and roll-window policy.

Both files use the project strict YAML subset from `simple-yaml.ts`: two-space nested maps, scalar values, no arrays, no anchors, no flow syntax, and no inline comments after values.

## Session Phases

The internal MNQ session helper returns:

- `rth`: regular trading hours, 09:30-16:00 ET.
- `eth`: electronic session outside RTH and outside maintenance.
- `maintenance`: daily maintenance halt, 17:00-18:00 ET Monday through Thursday.
- `closed`: weekend or configured holiday/closed override.

For OBS-01 journal compatibility, `eth` maps to the existing `SessionPhase` value `pre_open`; the richer `session_phase: "eth"` remains available in the MNQ eligibility summary.

Candidate gating is intentionally RTH-only for V1:

- `rth` is eligible.
- `eth` returns `outside_rth`.
- `maintenance` returns `maintenance_halt`.
- `closed` returns `session_closed`.

Holiday and early-close overrides are represented as named map entries. The initial file contains examples only; DATA-06 should replace or extend them with the production calendar.

## Roll Policy

The V1 defaults are:

- Block new entries from 15 minutes before roll cutover through 15 minutes after roll cutover.
- Require flattening from 5 minutes before roll cutover until cutover.
- Promote the active contract at `cutover_ts_ns`.

Reason codes:

- `roll_block_window`
- `roll_flatten_window`
- `maintenance_halt`
- `outside_rth`
- `session_closed`

Roll timestamps are decimal nanosecond strings in the config file. This avoids runtime ISO parsing and keeps the policy aligned with ADR-0001 canonical timestamp handling.

## Helper API

Use `apps/strategy_runtime/src/session/index.ts`:

- `loadMnqSessionCalendarConfig()`
- `loadMnqRollCalendarConfig()`
- `getMnqSessionPhase(config, ts_ns)`
- `getActiveMnqContract(config, ts_ns)`
- `getRollPhase(config, ts_ns)`
- `shouldBlockNewEntriesForRoll(config, ts_ns)`
- `shouldFlattenBeforeRoll(config, ts_ns)`
- `getSessionRiskResetBoundary(config, ts_ns)`
- `evaluateMnqSessionEligibility({ sessionCalendar, rollCalendar, timestamp_ns })`

`evaluateMnqSessionEligibility` is the ORCH-02 integration surface. It returns `active_contract`, optional `next_contract`, `session_phase`, `journal_phase`, `roll_phase`, `candidate_eligible`, `flatten_required`, and stable reason codes.

## ORCH-02 Consumption

ORCH-02 should call the eligibility helper before strategy evaluation. If `candidate_eligible=false`, the runner should not emit new strategy candidates for that tick and should journal the reason through existing STRAT_EVAL/RISK_GATE-style diagnostics as appropriate.

Roll flattening is surfaced as `flatten_required=true`; the actual position-management flatten action remains an ORCH/DATA-06 follow-up because it needs the production roll calendar and open-position context.

## DATA/RSRCH Usage

DATA and RSRCH tickets can use `getActiveMnqContract` and `evaluateMnqSessionEligibility` with `exchange_event_ts_ns` to select the correct front contract in historical and replay windows. No Databento loader is implemented in MNQ-01.

## Deferred

- DATA-01/DATA-06: production calendar evidence, final holiday list, and roll advisories from real data.
- ORCH follow-up: consume `ROLL_ADVISORY` events and flatten/block entries using the same reason codes.
- REL-00/REL-01: verify roll behavior against replay fixtures and launch dry-runs.
