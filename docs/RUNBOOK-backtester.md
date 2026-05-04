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
