# QFA-212 archive-native regime substrate validation

## Status

PASS: archive-native validation is within the ADR-0014 20 percentage-point divergence bound. QFA-420 dispatch is unblocked from the substrate-validation perspective.

## Scope discipline

- ADR-0013 methodology applied with ADR-0014 archive-size refinement.
- Primary label is VIX previous trading day close with rolling 60-session percentile.
- Secondary diagnostic is MNQ RTH MBP-1 mid-quote RV, 5-minute bars, 10-session smoother.
- Secondary percentile basis is explicitly `within_window` because the archive has 62 sessions, fewer than the 70 needed for rolling-60 RV10 percentiles.
- No QFA-105, QFA-402, RunSpec, journal, corpus manifest, or determinism-gate changes.

## Source inputs

- VIX/VXN snapshot: `config/research/vix-vxn-daily-2025-09-to-2026-04.json`
- Snapshot vintage: `2026-05-08T18:13:11Z`
- VIX rows: 171
- VXN rows: 167
- Archive sessions: 62 (2026-02-02-rth to 2026-04-30-rth)
- 2026-02 manifest: 05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c
- 2026-03 manifest: cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f
- 2026-04 manifest: e37d01b3a3976f2f2614c2a85171ce4cc8b6b5ad069bf782f55285b0e7721a2c

## Secondary basis

- selected_basis: `within_window`
- smoothed_available_sessions: 53
- rolling_60_available_sessions: 0
- caveat: within-window captures within-archive stratification, not rolling-60 regime drift.

## Archive-native contingency validation

| Matrix | Comparable sessions | Agreement | 95% CI | Reference | Result |
|---|---:|---:|---:|---:|---|
| VIX vs MNQ-RV | 48 | 56.2% | 29.2% - 75.0% | public-proxy RV20 50.0% +/- 20pp | within bound |
| VIX vs VXN | 57 | 93.0% | 86.0% - 100.0% | proxy diagnostic ~97.6% | diagnostic only |

### VIX vs MNQ-RV matrix

| VIX \ Other | low | mid | high |
|---|---:|---:|---:|
| low | 10 | 0 | 0 |
| mid | 4 | 1 | 0 |
| high | 2 | 15 | 16 |

### VIX vs VXN matrix

| VIX \ Other | low | mid | high |
|---|---:|---:|---:|
| low | 9 | 1 | 0 |
| mid | 3 | 3 | 0 |
| high | 0 | 0 | 41 |

## Counts

```json
{
  "confirmed": {
    "low": 11,
    "mid": 4,
    "high": 47,
    "null": 0
  },
  "raw_primary": {
    "low": 10,
    "mid": 7,
    "high": 45,
    "null": 0
  },
  "secondary": {
    "low": 17,
    "mid": 18,
    "high": 18,
    "null": 9
  },
  "vxn": {
    "low": 13,
    "mid": 5,
    "high": 44,
    "null": 0
  },
  "transition_pending": 5,
  "quality_excluded": 5,
  "use_for_calibration": 57,
  "partial_session": 0
}
```

## Distribution diagnostics

```json
{
  "primary_value": {
    "count": 57,
    "mean": 21.55701754386,
    "min": 16.34,
    "p33": 18.87,
    "median": 20.23,
    "p67": 23.75,
    "max": 31.05
  },
  "secondary_value": {
    "count": 48,
    "mean": 0.008455591951,
    "min": 0.005596929278,
    "p33": 0.008131090555,
    "median": 0.008812389926,
    "p67": 0.009501492919,
    "max": 0.011197879994
  },
  "disagreement_score": {
    "count": 48,
    "mean": 0.2221763125,
    "min": 0.015724,
    "p33": 0.08805,
    "median": 0.11761,
    "p67": 0.262893,
    "max": 0.700314
  },
  "mean_primary_minus_secondary_percentile": 0.210606645833
}
```

## Cut value bootstrap CIs

```json
{
  "primary_vix_33": [
    17.93,
    21.15
  ],
  "primary_vix_67": [
    19.31,
    26.15
  ],
  "secondary_rv10_33": [
    0.005882509237,
    0.009255889295
  ],
  "secondary_rv10_67": [
    0.008297055584,
    0.010263273297
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
| 2026-02-13-rth | high | high | 0.933333 | high | 0.962264 | 0.028931 | no | yes |
| 2026-02-17-rth | high | high | 0.966667 | high | 1.000000 | 0.033333 | no | yes |
| 2026-02-18-rth | high | high | 0.916667 | high | 0.981132 | 0.064465 | no | yes |
| 2026-02-19-rth | high | high | 0.900000 | high | 0.943396 | 0.043396 | no | yes |
| 2026-02-20-rth | high | high | 0.916667 | high | 0.830189 | 0.086478 | no | yes |
| 2026-02-23-rth | high | high | 0.866667 | high | 0.811321 | 0.055346 | no | yes |
| 2026-02-24-rth | high | high | 0.966667 | high | 0.849057 | 0.117610 | no | yes |
| 2026-02-25-rth | high | high | 0.850000 | high | 0.754717 | 0.095283 | no | yes |
| 2026-02-26-rth | high | high | 0.766667 | high | 0.735849 | 0.030818 | no | yes |
| 2026-02-27-rth | high | high | 0.783333 | high | 0.679245 | 0.104088 | no | yes |
| 2026-03-02-rth | high | high | 0.866667 | mid | 0.603774 | 0.262893 | no | yes |
| 2026-03-03-rth | high | high | 0.983333 | mid | 0.509434 | 0.473899 | no | yes |
| 2026-03-04-rth | high | high | 1.000000 | mid | 0.528302 | 0.471698 | no | yes |
| 2026-03-05-rth | high | high | 0.933333 | mid | 0.566038 | 0.367295 | no | yes |
| 2026-03-06-rth | high | high | 1.000000 | mid | 0.622642 | 0.377358 | no | yes |
| 2026-03-09-rth | high | high | 1.000000 | high | 0.773585 | 0.226415 | no | yes |
| 2026-03-10-rth | high | high | 0.983333 | high | 0.792453 | 0.190880 | no | yes |
| 2026-03-11-rth | high | high | 0.966667 | high | 0.905660 | 0.061007 | no | yes |
| 2026-03-12-rth | high | high | 0.950000 | high | 0.886792 | 0.063208 | no | yes |
| 2026-03-13-rth | high | high | 0.983333 | high | 0.924528 | 0.058805 | no | yes |
| 2026-03-16-rth | high | high | 0.966667 | high | 0.867925 | 0.098742 | no | yes |
| 2026-03-17-rth | high | high | 0.866667 | high | 0.716981 | 0.149686 | yes | no |
| 2026-03-18-rth | high | high | 0.850000 | high | 0.698113 | 0.151887 | yes | no |
| 2026-03-19-rth | high | high | 0.933333 | mid | 0.660377 | 0.272956 | yes | no |
| 2026-03-20-rth | high | high | 0.883333 | mid | 0.396226 | 0.487107 | yes | no |
| 2026-03-23-rth | high | high | 0.950000 | mid | 0.339623 | 0.610377 | no | yes |
| 2026-03-24-rth | high | high | 0.933333 | mid | 0.415094 | 0.518239 | no | yes |
| 2026-03-25-rth | high | high | 0.950000 | mid | 0.377358 | 0.572642 | no | yes |
| 2026-03-26-rth | high | high | 0.883333 | low | 0.301887 | 0.581446 | no | yes |
| 2026-03-27-rth | high | high | 0.983333 | low | 0.283019 | 0.700314 | no | yes |
| 2026-03-30-rth | high | high | 1.000000 | mid | 0.358491 | 0.641509 | no | yes |
| 2026-03-31-rth | high | high | 0.983333 | mid | 0.547170 | 0.436163 | no | yes |
| 2026-04-01-rth | high | high | 0.816667 | mid | 0.452830 | 0.363837 | no | yes |
| 2026-04-02-rth | high | high | 0.766667 | mid | 0.490566 | 0.276101 | no | yes |
| 2026-04-06-rth | high | high | 0.716667 | mid | 0.641509 | 0.075158 | no | yes |
| 2026-04-07-rth | high | high | 0.733333 | mid | 0.584906 | 0.148427 | no | yes |
| 2026-04-08-rth | high | high | 0.850000 | mid | 0.471698 | 0.378302 | no | yes |
| 2026-04-09-rth | high | mid | 0.533333 | mid | 0.433962 | 0.099371 | no | yes |
| 2026-04-10-rth | mid | mid | 0.366667 | low | 0.320755 | 0.045912 | yes | no |
| 2026-04-13-rth | mid | mid | 0.350000 | low | 0.264151 | 0.085849 | no | yes |
| 2026-04-14-rth | mid | mid | 0.333333 | low | 0.245283 | 0.088050 | no | yes |
| 2026-04-15-rth | mid | low | 0.266667 | low | 0.169811 | 0.096856 | no | yes |
| 2026-04-16-rth | low | low | 0.266667 | low | 0.188679 | 0.077988 | no | yes |
| 2026-04-17-rth | low | low | 0.233333 | low | 0.094340 | 0.138993 | no | yes |
| 2026-04-20-rth | low | low | 0.150000 | low | 0.037736 | 0.112264 | no | yes |
| 2026-04-21-rth | low | low | 0.316667 | low | 0.075472 | 0.241195 | no | yes |
| 2026-04-22-rth | low | mid | 0.383333 | low | 0.018868 | 0.364465 | no | yes |
| 2026-04-23-rth | low | low | 0.300000 | low | 0.113208 | 0.186792 | no | yes |
| 2026-04-24-rth | low | mid | 0.350000 | low | 0.132075 | 0.217925 | no | yes |
| 2026-04-27-rth | low | low | 0.250000 | low | 0.056604 | 0.193396 | no | yes |
| 2026-04-28-rth | low | low | 0.166667 | low | 0.150943 | 0.015724 | no | yes |
| 2026-04-29-rth | low | low | 0.100000 | low | 0.207547 | 0.107547 | no | yes |
| 2026-04-30-rth | low | low | 0.250000 | low | 0.226415 | 0.023585 | no | yes |

## Recommendation

Proceed to QFA-420. The substrate validation reproduces the public-proxy pattern within the ADR-0014 divergence bound, with the secondary basis caveat carried explicitly.
