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
