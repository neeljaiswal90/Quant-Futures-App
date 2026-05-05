# ADR-0007: Backtest Lineage Block

## Status

Accepted

## Context

Every backtest run produced by `apps/backtester` must be reproducible from
its journal alone. A reader picking up a journal file months after the run
completed should be able to:

- Identify exactly which corpus bytes the run consumed (manifest hash + verified-report hash)
- Identify exactly which config bytes the run consumed (per-config hash + version)
- Identify exactly which runner code the run executed against (git SHA + dirty flag)
- Reconstruct the deterministic identity of the run (a hash that distinguishes byte-different inputs from byte-identical ones)

The existing `ConfigLineageRef` type at `contracts/lineage.ts` records a
single `(config_hash, config_version)` pair. That is necessary but not
sufficient: a backtest typically consumes multiple configs (per-strategy,
risk, management, venue cost, session, calendar) plus one or more corpus
inputs, plus has a code-commit identity. A single-pair `ConfigLineageRef`
cannot anchor a multi-input run.

A second concern is determinism contract. RunSpec hashing must be
independent of caller object key insertion order, must reject (not coerce)
out-of-domain values like `BigInt` and `undefined`, must enforce array
ordering for inputs that are semantically a set with a stable presentation
order (`corpus_inputs`, `config_inputs`), and must preserve array ordering
for inputs that are semantically ordered (`strategy_ids`). Reusing the
generic `stableJsonStringify` from `contracts/serialization.ts` is
inappropriate because that helper coerces `bigint` to a string via
`unixNsToJsonString`, which violates the RunSpec invariant that no bigint
appears in the spec.

A third concern is journal observability. Run identity must be the first
event in the journal so any consumer (formatter, replay parity check,
journal query CLI) can reconstruct lineage without reading external files.

## Decision

QFA-115 establishes the **Backtest Lineage Block** as a small set of
contract types, a deterministic canonicalization profile, a run-id grammar,
and a journal event type that emits as the first record of every run.

### Type surface

The contract surface lives in `apps/strategy_runtime/src/contracts/`:

- `run-spec.ts` — `RunSpec` interface, `BacktestWindow`, role enums (`ConfigInputRole`, `CorpusInputRole`), nested refs (`NamedConfigLineageRef`, `CorpusInputRef`, `CorpusTierClassificationRef`), and the role-order constants (`CORPUS_INPUT_ROLE_ORDER`, `CONFIG_INPUT_ROLE_ORDER`).
- `run-spec-validate.ts` — `validateRunSpec` plus internal helpers; throws `RunSpecValidationError` with aggregated `{ path, message }` issues. Mirrors the `ConfigValidationError` pattern from `config/errors.ts`.
- `run-spec-hash.ts` — `canonicalizeRunSpec` and `computeRunSpecHash`. RunSpec-specific JCS profile (RFC 8785-aligned). **Does not import from `serialization.ts`** by explicit prohibition.
- `run-id.ts` — `deriveRunId` plus tokenization helpers (`deriveBarToken`, `deriveWindowToken`, `deriveStrategyToken`).
- `backtest-run-meta.ts` — `BacktestRunMetaPayload` event payload type. Extends `RunSpec` with two payload-only fields (`run_spec_hash: string`, `run_started_at_ns: UnixNs`).

### Determinism contract

`canonicalizeRunSpec` runs `validateRunSpec` first; only validated
RunSpecs reach canonicalization. The walker then:

1. Throws on `bigint` anywhere (RunSpec contains no bigint by design; the
   sole bigint-typed field, `run_started_at_ns`, lives outside RunSpec on
   the payload envelope).
2. Throws on non-finite numbers.
3. Throws on `undefined` values (RunSpec has no optional fields by design,
   so `undefined` indicates a bug; the canonicalizer does **not** silently
   filter undefined keys).
4. Sorts object keys lexicographically.
5. Preserves array element order (`strategy_ids` is semantically ordered;
   `corpus_inputs` and `config_inputs` have validation-enforced ordering
   so two callers passing logically-equivalent inputs in different orders
   either both succeed with the same hash, or both fail with the same
   ordering error).
6. Emits no insignificant whitespace.
7. Outputs UTF-8.

String surrogate well-formedness is enforced by `validateRunSpec` (every
string field iterates code units and rejects lone surrogates) before
canonicalization reaches strings.

### Run-ID grammar

```
bt-{instrument_root}-{bar_token}-{window_token}-{strategy_token}-{hash12}
```

| Segment | Source |
|---|---|
| `bt-` | literal prefix identifying a backtest run-ID |
| `instrument_root` | `RunSpec.instrument_root` lowercased (`MNQ` → `mnq`) |
| `bar_token` | time-bars pass through (`1m`, `5m`, `1h`); tick-derived → `tick<N>`/`vol<N>`/`dol<N>` |
| `window_token` | session: `s` + `YYYYMMDD` (single) or `YYYYMMDD-YYYYMMDD` (range); instant: `i` + canonical UTC ISO-8601 (no fractional seconds per Q-2.4) |
| `strategy_token` | single: abbreviation from `STRATEGY_ID_TO_RUN_ID_ABBREV`; multi: `multi{count}` |
| `hash12` | first 12 lower-case hex characters of `run_spec_hash` |

Examples:

```
bt-mnq-1m-s20260202-20260206-tp_long-6f3862c2b101
bt-mnq-5m-s20260415-multi4-7c4b1029aa91
```

### BACKTEST_RUN_META event

Registered as a runtime event type in
`contracts/events/event-types.ts` and classified as a system-control
event (not a derived event; no causation_id requirement). Mapped to the
`CONFIG` channel since both share the "low-frequency lineage facts for
replay and provenance" cadence. The first event of every backtest journal
is a `BACKTEST_RUN_META` carrying the entire RunSpec inline plus
`run_spec_hash` and `run_started_at_ns`.

The payload type (`BacktestRunMetaPayload`) extends `RunSpec` so all
RunSpec fields appear in the journal verbatim. The schema validator
explicitly rejects payloads that duplicate envelope fields (`event_id`,
`type`, `ts_ns`, `run_id`, `session_id`, `schema_version`) — those are
owned by `JournalEventEnvelope` and must not be repeated on the payload.

## Consequences

**Positive:**

- Reproducibility: byte-identical inputs produce byte-identical
  `run_spec_hash`. Two backtest runs with the same RunSpec emit the same
  run_id and produce semantically-equivalent journals.
- Lineage tracing: every backtest journal points back, via the hashes
  inside the RunSpec, to specific bytes of every consumed input. A
  reviewer can take a journal file and ask "what corpus did this read?
  what config? what code?" and get authoritative answers without
  consulting external metadata.
- Self-contained journals: `BACKTEST_RUN_META` carries the full RunSpec
  inline, so replay tools and lineage queries work against the journal
  alone.
- Operator readability: the run-ID grammar is human-scannable. An
  operator reading a journal can identify the instrument, bar, window,
  and strategy class without dereferencing the full RunSpec.

**Negative / constraints:**

- One extra event per run. Trivially small cost (sub-millisecond,
  sub-kilobyte).
- The runner must construct a fully-resolved RunSpec before run
  begins. Late-binding any input (e.g., reading a config mid-run) is a
  reproducibility violation.
- A dirty git tree (`runner_code_dirty: true`) cannot pass
  validation/OOS gates. The lineage block records dirty runs but cannot
  identify the exact uncommitted code bytes; the hash signals "dirty"
  but does not anchor the code state.
- The locked `STRATEGY_ID_TO_RUN_ID_ABBREV` table must be extended
  atomically with any expansion of the `StrategyId` union. Phase 5
  mean-reversion strategies (`mr_long_rth`, `mr_short_rth`, planned in
  QFA-601 / QFA-602) will add both the union member and the
  abbreviation entry in a single PR; the compiler enforces completeness.

## Implementation

Implemented across QFA-115 sessions:

- **Session 2a** (PR #115, commit `fdb5bc4`): contract surface (5 source
  files in `contracts/`), validation, canonicalization, run-id derivation,
  payload type, fixtures, 5 test files (123 tests).
- **Session 2a fidelity-fix** (PR #116, commit `96361a3`): three
  post-merge corrections — strict instant-mode regex (no fractional
  seconds), `UnixNs` branding for `run_started_at_ns`, removal of silent
  undefined filter from canonicalizer.
- **Session 2b** (this session): event registry integration —
  `BACKTEST_RUN_META` token in `event-types.ts`, payload mapping in
  `payloads.ts`, schema validator in `schema.ts`, channel mapping in
  `channels.ts`, contract barrel re-exports in `contracts/index.ts`,
  formatter case in `operator/formatter.ts`, this ADR, and the runbook
  "## Backtest run identity" section.

## References

- QFA-115 walkthrough decisions Q-1 through Q-7 (locked design).
- RFC 8785 — JSON Canonicalization Scheme. The RunSpec JCS profile is
  aligned with RFC 8785 with one explicit deviation: NFC Unicode
  normalization is not applied. RFC 8785 also leaves Unicode
  normalization to the caller; the RunSpec profile rejects lone
  surrogates rather than normalizing.
- ADR-0001 — Canonical Event Time. Establishes the `UnixNs` branded
  bigint convention used here for `run_started_at_ns`.
- ADR-0002 — Cross-source market-data parity / data-tier taxonomy.
  `CorpusInputRef.tier` and `CorpusTierClassificationRef` integrate with
  the QFA-106 tier-policy module.
