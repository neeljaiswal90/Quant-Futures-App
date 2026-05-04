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
