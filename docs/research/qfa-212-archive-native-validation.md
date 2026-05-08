# QFA-212 archive-native regime substrate validation

## Status

PASS: archive-native validation is within the ADR-0014 20 percentage-point divergence bound. QFA-420 dispatch is unblocked from the substrate-validation perspective.

## Scope discipline

- ADR-0013 methodology applied with ADR-0014 archive-size refinement.
- Primary label is VIX previous trading day close with rolling 60-session percentile.
- Secondary diagnostic is MNQ RTH MBP-1 mid-quote RV, 5-minute bars, 10-session smoother.
- Secondary percentile basis is explicitly `within_window` because the archive has 41 sessions.
- No QFA-105, QFA-402, RunSpec, journal, corpus manifest, or determinism-gate changes.

## Source inputs

- VIX/VXN snapshot: `config/research/vix-vxn-daily-2025-09-to-2026-04.json`
- Snapshot vintage: `2026-05-08T18:13:11Z`
- VIX rows: 171
- VXN rows: 167
- Archive sessions: 41 (2026-02-02-rth to 2026-03-31-rth)
- Feb manifest: 05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c
- Mar manifest: cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f

## Secondary basis

- selected_basis: `within_window`
- smoothed_available_sessions: 32
- rolling_60_available_sessions: 0
- caveat: within-window captures within-archive stratification, not rolling-60 regime drift.

## Archive-native contingency validation

| Matrix | Comparable sessions | Agreement | 95% CI | Reference | Result |
|---|---:|---:|---:|---:|---|
| VIX vs MNQ-RV | 28 | 39.3% | 10.7% - 67.9% | public-proxy RV20 50.0% +/- 20pp | within bound |
| VIX vs VXN | 37 | 100.0% | 100.0% - 100.0% | proxy diagnostic ~97.6% | diagnostic only |

### VIX vs MNQ-RV matrix

| VIX \ Other | low | mid | high |
|---|---:|---:|---:|
| low | 0 | 0 | 0 |
| mid | 0 | 0 | 0 |
| high | 9 | 8 | 11 |

### VIX vs VXN matrix

| VIX \ Other | low | mid | high |
|---|---:|---:|---:|
| low | 0 | 0 | 0 |
| mid | 0 | 1 | 0 |
| high | 0 | 0 | 36 |

## Counts

```json
{
  "confirmed": {
    "low": 0,
    "mid": 0,
    "high": 41,
    "null": 0
  },
  "raw_primary": {
    "low": 0,
    "mid": 1,
    "high": 40,
    "null": 0
  },
  "secondary": {
    "low": 10,
    "mid": 11,
    "high": 11,
    "null": 9
  },
  "vxn": {
    "low": 0,
    "mid": 2,
    "high": 39,
    "null": 0
  },
  "transition_pending": 1,
  "quality_excluded": 4,
  "use_for_calibration": 37,
  "partial_session": 0
}
```

## Distribution diagnostics

```json
{
  "primary_value": {
    "count": 37,
    "mean": 22.265675675676,
    "min": 16.34,
    "p33": 19.62,
    "median": 21.15,
    "p67": 24.23,
    "max": 31.05
  },
  "secondary_value": {
    "count": 28,
    "mean": 0.0094808675,
    "min": 0.008072451209,
    "p33": 0.009189600094,
    "median": 0.009600908407,
    "p67": 0.009908672251,
    "max": 0.011197879994
  },
  "disagreement_score": {
    "count": 28,
    "mean": 0.411830321429,
    "min": 0.004167,
    "p33": 0.197917,
    "median": 0.314583,
    "p67": 0.59375,
    "max": 0.952083
  },
  "mean_primary_minus_secondary_percentile": 0.404985107143
}
```

## Cut value bootstrap CIs

```json
{
  "primary_vix_33": [
    17.79,
    24.23
  ],
  "primary_vix_67": [
    19.62,
    27.19
  ],
  "secondary_rv10_33": [
    0.008297055584,
    0.009908672251
  ],
  "secondary_rv10_67": [
    0.009189600094,
    0.010309923249
  ]
}
```

## Per-session labels

| Session | Confirmed | Raw VIX | VIX percentile | RV label | RV percentile | Disagreement | Quality excluded | Calibration |
|---|---|---|---:|---|---:|---:|---|---|
| 2026-02-02-rth | high | high | 0.733333 | n/a | n/a | n/a | no | yes |
| 2026-02-03-rth | high | mid | 0.466667 | n/a | n/a | n/a | no | yes |
| 2026-02-04-rth | high | high | 0.816667 | n/a | n/a | n/a | no | yes |
| 2026-02-05-rth | high | high | 0.833333 | n/a | n/a | n/a | no | yes |
| 2026-02-06-rth | high | high | 0.916667 | n/a | n/a | n/a | no | yes |
| 2026-02-09-rth | high | high | 0.766667 | n/a | n/a | n/a | no | yes |
| 2026-02-10-rth | high | high | 0.733333 | n/a | n/a | n/a | no | yes |
| 2026-02-11-rth | high | high | 0.800000 | n/a | n/a | n/a | no | yes |
| 2026-02-12-rth | high | high | 0.783333 | n/a | n/a | n/a | no | yes |
| 2026-02-13-rth | high | high | 0.933333 | high | 0.937500 | 0.004167 | no | yes |
| 2026-02-17-rth | high | high | 0.966667 | high | 1.000000 | 0.033333 | no | yes |
| 2026-02-18-rth | high | high | 0.916667 | high | 0.968750 | 0.052083 | no | yes |
| 2026-02-19-rth | high | high | 0.900000 | high | 0.906250 | 0.006250 | no | yes |
| 2026-02-20-rth | high | high | 0.916667 | high | 0.718750 | 0.197917 | no | yes |
| 2026-02-23-rth | high | high | 0.866667 | high | 0.687500 | 0.179167 | no | yes |
| 2026-02-24-rth | high | high | 0.966667 | high | 0.750000 | 0.216667 | no | yes |
| 2026-02-25-rth | high | high | 0.850000 | mid | 0.593750 | 0.256250 | no | yes |
| 2026-02-26-rth | high | high | 0.766667 | mid | 0.562500 | 0.204167 | no | yes |
| 2026-02-27-rth | high | high | 0.783333 | mid | 0.468750 | 0.314583 | no | yes |
| 2026-03-02-rth | high | high | 0.866667 | mid | 0.375000 | 0.491667 | no | yes |
| 2026-03-03-rth | high | high | 0.983333 | low | 0.250000 | 0.733333 | no | yes |
| 2026-03-04-rth | high | high | 1.000000 | low | 0.281250 | 0.718750 | no | yes |
| 2026-03-05-rth | high | high | 0.933333 | mid | 0.343750 | 0.589583 | no | yes |
| 2026-03-06-rth | high | high | 1.000000 | mid | 0.406250 | 0.593750 | no | yes |
| 2026-03-09-rth | high | high | 1.000000 | mid | 0.625000 | 0.375000 | no | yes |
| 2026-03-10-rth | high | high | 0.983333 | mid | 0.656250 | 0.327083 | no | yes |
| 2026-03-11-rth | high | high | 0.966667 | high | 0.843750 | 0.122917 | no | yes |
| 2026-03-12-rth | high | high | 0.950000 | high | 0.812500 | 0.137500 | no | yes |
| 2026-03-13-rth | high | high | 0.983333 | high | 0.875000 | 0.108333 | no | yes |
| 2026-03-16-rth | high | high | 0.966667 | high | 0.781250 | 0.185417 | no | yes |
| 2026-03-17-rth | high | high | 0.866667 | mid | 0.531250 | 0.335417 | yes | no |
| 2026-03-18-rth | high | high | 0.850000 | mid | 0.500000 | 0.350000 | yes | no |
| 2026-03-19-rth | high | high | 0.933333 | mid | 0.437500 | 0.495833 | yes | no |
| 2026-03-20-rth | high | high | 0.883333 | low | 0.187500 | 0.695833 | yes | no |
| 2026-03-23-rth | high | high | 0.950000 | low | 0.093750 | 0.856250 | no | yes |
| 2026-03-24-rth | high | high | 0.933333 | low | 0.218750 | 0.714583 | no | yes |
| 2026-03-25-rth | high | high | 0.950000 | low | 0.156250 | 0.793750 | no | yes |
| 2026-03-26-rth | high | high | 0.883333 | low | 0.062500 | 0.820833 | no | yes |
| 2026-03-27-rth | high | high | 0.983333 | low | 0.031250 | 0.952083 | no | yes |
| 2026-03-30-rth | high | high | 1.000000 | low | 0.125000 | 0.875000 | no | yes |
| 2026-03-31-rth | high | high | 0.983333 | low | 0.312500 | 0.670833 | no | yes |

## Recommendation

Proceed to QFA-420. The substrate validation reproduces the public-proxy pattern within the ADR-0014 divergence bound, with the secondary basis caveat carried explicitly.
