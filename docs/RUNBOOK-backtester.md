# RUNBOOK: Backtester Data Foundation

## VIX series ingestion

The canonical daily VIX source is FRED series `VIXCLS`. The fetcher requires
`FRED_API_KEY` in the process environment or in the repo-root `.env` file. The key is
gitignored and must never be passed as a CLI argument.

Fetch or refresh the local JSON artifact with:

```powershell
npm run data:fetch-vix -- --out config/research/vix-series.json
```

The output path `config/research/vix-series.json` is intentionally gitignored. Backtests
consume the stored JSON artifact; they do not call FRED at replay time. Re-running the
command without `--force` exits successfully with a skipped status if the output already
exists. To refresh the data, run:

```powershell
npm run data:fetch-vix -- --out config/research/vix-series.json --force
```

Observations with `null` values represent FRED missing-value sentinels, commonly
non-trading days or holidays. They are recorded as missing observations for deterministic
lineage and are not treated as data quality failures by the fetcher.

## Tier policy

The data architecture follows a three-tier taxonomy (ADR-002). Tier
classification is enforced in code at
`apps/strategy_runtime/src/contracts/tier-policy.ts`. `SCHEMA_TIER_MAP`
in that file is the single source of truth; this table is its
human-readable view. Both must agree.

| Schema | Tier | Role |
|---|---|---|
| `mbo` | A | Microstructure ground truth (depth-by-order) |
| `mbp-10` | A | Microstructure (depth-by-price, 10 levels) |
| `mbp-1` | B | L1 ground truth |
| `trades` | B | Aggressor-tagged print tape |
| `tbbo` | B | Trades + top-of-book quotes |
| `bbo` | B | Top-of-book quotes only |
| `ohlcv-1m` | C | Aggregated 1-minute bars |
| `definition` | C (reference) | Contract specs; available all tiers |
| `statistics` | C (reference) | Settlements; available all tiers |
| `status` | C (reference) | Sessions, halts; available all tiers |

Tier requirements (corpus must contain ALL of):

- Tier A: `mbo` AND `mbp-10`
- Tier B: `mbp-1` AND `trades` AND `tbbo`
- Tier C: `ohlcv-1m`

Reference schemas (`definition`, `statistics`, `status`) do NOT affect
tier classification. A corpus is classified by which microstructure
schemas it has, not its reference data depth.

Any change to tier semantics requires updating BOTH this table AND
the `SCHEMA_TIER_MAP` / `TIER_REQUIRED_SCHEMAS` constants atomically.

## Economic calendar maintenance

QFA-111 uses a committed manual YAML calendar at `config/research/economic-calendar.yaml` rather than a network-backed economic-calendar API. This keeps Phase 4/5 event-day features deterministic and reviewable. The calendar covers the defined event universe from 2010 through scheduled 2026 events: FOMC rate-decision dates, BLS CPI releases, BLS Employment Situation/NFP releases, and OPEC/OPEC+ major policy, ministerial, and JMMC decision events.

Event dates are curated from public release schedules: FOMC scheduled meetings, BLS CPI release schedules, BLS Employment Situation/NFP release schedules, and OPEC/OPEC+ ministerial decisions from the OPEC press archive. FOMC events carry per-event Federal Reserve statement URLs of the form `monetary<YYYYMMDD>a.htm`. CPI, NFP, and OPEC/OPEC+ events currently use archive-index URLs in `authoritative_source` because per-event URLs were not curated for QFA-111. Downstream consumers should treat those archive URLs as publishing-institution references, not specific event documentation. Per-event URL curation for CPI/NFP/OPEC is tracked as future curation work under QFA-111b.

Phase 4 HMM training that uses these dates is no worse off than pulling dates from the same archive indexes directly. The calendar adds a reviewed per-event date inventory, stable category labels, deterministic hashing through the loader, and a single committed artifact for downstream feature construction.

The original ticket estimated roughly 700+ events. The completed source-backed curation contains 667 events: FOMC 142, CPI 216, NFP 208, and OPEC/OPEC+ 101. The total is below the rough estimate because OPEC/OPEC+ inclusion is restricted to major policy, ministerial, and JMMC decision events. Lower-signal press releases, commentary, and non-decision items are intentionally excluded so the event universe remains useful for alpha-validation modeling.

To add a new event, edit `config/research/economic-calendar.yaml`, keep `events` sorted by `event_date`, include `authoritative_source`, and run the economic-calendar unit tests. Use `event_time_utc: null` when the official source does not publish a canonical release timestamp; do not invent times. Extend forward-looking FOMC/CPI/NFP coverage every six months, and add OPEC/OPEC+ entries only after an official policy-decision source is available. For calendar errata, update `editorial_notes` instead of silently rewriting history.

## Backtest run identity

Every backtest run emits a `BACKTEST_RUN_META` event as the first journal
event. This event carries the run's deterministic identity: the canonical
`RunSpec`, its hash, and a human-readable `run_id`. Consumers can
reconstruct full lineage from the journal alone — no external metadata
lookups required.

The contract surface lives at:

- `apps/strategy_runtime/src/contracts/run-spec.ts` (types)
- `apps/strategy_runtime/src/contracts/run-spec-validate.ts` (invariants)
- `apps/strategy_runtime/src/contracts/run-spec-hash.ts` (canonicalization)
- `apps/strategy_runtime/src/contracts/run-id.ts` (run-ID derivation)
- `apps/strategy_runtime/src/contracts/backtest-run-meta.ts` (event payload)

### Pipeline

The runner constructs the RunSpec, validates it, derives the run-ID, and
emits the meta event before any other journal output. Pseudocode (the
backtester runner ticket QFA-201 will implement; QFA-115 ships the
contract):

```typescript
// Resolve every input deterministically: corpus manifests + verified reports,
// every config artifact, runner code commit SHA. No late-binding allowed.
const spec: RunSpec = constructRunSpec({
  /* fully-resolved corpus, config, code provenance */
});

// Throws on any invariant violation (bigint, undefined, non-finite,
// lone surrogate, bad array order, unknown StrategyId, ...).
validateRunSpec(spec);

// Deterministic identity. run_spec_hash is independent of caller object key
// insertion order; identical inputs always produce identical run_id.
const { run_id, run_spec_hash } = deriveRunId(spec);

const payload: BacktestRunMetaPayload = {
  ...spec,
  run_spec_hash,
  run_started_at_ns: ns(BigInt(Date.now()) * 1_000_000n),
};

journal.emit({
  type: 'BACKTEST_RUN_META',
  event_id: deriveEventId(run_id, 0),
  ts_ns: payload.run_started_at_ns,
  run_id,
  session_id: deriveSessionId(run_id),
  payload,
});
```

### Run-ID grammar

```
bt-{instrument_root}-{bar_token}-{window_token}-{strategy_token}-{hash12}
```

- `bt-`: literal prefix identifying this is a backtest run-ID
- `instrument_root`: `RunSpec.instrument_root` lowercased (e.g., `mnq`)
- `bar_token`: time-bar (`1m`, `5m`, `1h`, `1d`, `30s`) or tick-derived
  (`tick100`, `vol1000`, `dol50000`)
- `window_token`: session (`s20260202` or `s20260202-20260206`) or
  instant (`i20260202T143000Z` or `i20260202T143000Z-20260202T210000Z`;
  no fractional seconds)
- `strategy_token`: single-strategy abbreviation (`tp_long`, `tp_short`,
  `bro_long`, `bro_short`) or `multi{count}` for multi-strategy runs
- `hash12`: first 12 lower-case hex characters of `run_spec_hash`

Examples:

```
bt-mnq-1m-s20260202-20260206-tp_long-6f3862c2b101
bt-mnq-5m-s20260415-multi4-7c4b1029aa91
```

### Channel mapping

`BACKTEST_RUN_META` is mapped to the `CONFIG` channel. It is registered
as a system-control event (not a derived event; no `causation_id`
requirement). The payload validator rejects any payload that duplicates
envelope fields (`event_id`, `type`, `ts_ns`, `run_id`, `session_id`,
`schema_version`) — those are owned by `JournalEventEnvelope` and must
not be repeated on the payload.

### Reproducibility caveats

The `run_spec_hash` is a complete reproducibility anchor only when
`runner_code_dirty === false`. Dirty exploratory runs can be journaled,
but they cannot pass validation/OOS gates. The hash distinguishes "dirty"
from "clean" but cannot identify the exact uncommitted code bytes.

Adding a new strategy to `StrategyId` requires extending
`STRATEGY_ID_TO_RUN_ID_ABBREV` in `run-id.ts` atomically — the compiler
enforces this through `Record<StrategyId, string>` typing. Phase 5
mean-reversion strategies (`mr_long_rth`, `mr_short_rth`) will add both
in a single PR under QFA-601 / QFA-602.

See [ADR-0007](./adr/ADR-0007-backtest-lineage-block.md) for the full
design rationale, determinism contract, and consequences.
