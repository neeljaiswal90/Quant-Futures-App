# EWMA Volatility Calibration Methodology

RA-053 calibrates an adaptive MNQ volatility estimate from the Databento corpus
and feeds the dashboard a single rolling sigma value. It replaces manual
volatility multipliers with a reproducible, walk-forward calibration.

## Corpus Inputs

The calibration CLI scans both roots:

- `D:\qfa-cache\databento`
- `D:\Quant-futures-app\data\databento\sim03_corpus`

It accepts directories containing `trades.dbn.zst`, parses the date/session
from the directory name, dedupes by `YYYY-MM-DD_session`, and rejects malformed
or duplicate sessions. At runtime it prints and persists:

```text
corpus_loaded: X verified sessions from N total directories (rejected M: reasons)
```

The same provenance is written to `data/calibration_corpus/ewma_decay.json`
under `corpus_provenance`.

## Parkinson Sigma

For each session, trades are streamed from Databento DBN chunks. The loader does
not materialize the full corpus in memory. Five-minute high/low bars are built
from trade prices, and the Parkinson estimator is computed in log-return units:

```python
sigma_log_squared = mean((log(H / L)) ** 2)
sigma_log = sqrt(sigma_log_squared / (4 * log(2)))
sigma_pts = sigma_log * vwap_session
```

The final multiplication converts the dimensionless log-return estimate into
MNQ price points using that session's volume-weighted average price.

## Walk-Forward EWMA

Sessions are sorted chronologically and split 80/20. Lambda is chosen on the
validation slice from the grid `[0.85, 0.99]`, default step `0.01`.

For each observation:

```python
prediction_t = sqrt(variance_t)
variance_t_plus_1 = lambda * variance_t + (1 - lambda) * sigma_observation_t**2
```

The initial variance is seeded with the corpus median `sigma_pts`. The CLI
writes training RMSE, validation RMSE, validation/training RMSE ratio, chosen
lambda, and median corpus sigma to `ewma_decay.json`.

## Live Dashboard Flow

The dashboard consumes `ewma_decay.json` on each 5-minute refresh:

1. Read the last 15 minutes of live trade ticks from the bounded tail.
2. Build five-minute high/low bars and compute one Parkinson
   `sigma_observation`.
3. Update the persisted EWMA variance:
   `sigma2_t = lambda * sigma2_t_minus_1 + (1 - lambda) * sigma_observation**2`.
4. Persist the single rolling state in `data/live_analysis/ewma_volatility_state.json`.
5. Classify the regime against the corpus median:
   `LOW < 0.7x`, `NORMAL = 0.7x-1.3x`, `HIGH > 1.3x`.

The 15-minute window is the observation granularity, not the EWMA memory. EWMA
memory is governed by lambda and persists across dashboard ticks.

## Artifacts

- `data/calibration_corpus/per_session_stats.parquet`
- `data/calibration_corpus/ewma_decay.json`
- `tools/rithmic_dashboard/data/live_analysis/ewma_volatility_state.json`
- `tools/rithmic_dashboard/data/live_analysis/<date>_<session>_vol_regime.jsonl`

`vol_regime_changed` events use the RA-050 generic signal schema and appear in
Recent Signals without a level id. They are session-level context, so they do
not create Distance Grid badges or same-zone stack alerts.
