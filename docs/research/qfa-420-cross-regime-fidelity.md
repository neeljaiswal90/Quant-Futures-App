# QFA-420 cross-regime queue-fidelity stratification

## Status

Primary verdict: **A**.

QFA-420 v1 applies ADR-0015 exactly: high-vs-low is the only
load-bearing contrast, mid is descriptive-only, and the TOST
SESOI is +/-50,000 ppm.

## Scope discipline

- ADR-0011 threshold/tolerance preserved: 800,000 ppm / +/-100,000 ppm.
- ADR-0012 probe policy preserved: 15s fill horizon, 60s depletion lookback, mbp_trades_proxy.
- ADR-0013 / ADR-0014 regime substrate consumed as-is from `artifacts/regime/regime-labels.json`.
- No QFA-105, QFA-402 formula, RunSpec, journal, or determinism-gate changes.
- `regime-labels.json` remains research-tier; LD-420-7 promotion is a follow-up path only.

## Source inputs

- Regime substrate hash: `f49c2ac2c94b77fede4dbffa2c785d04c11c5d974901621c97f43f5d2f82e5c9`
- 2026-02 manifest: `05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c`
- 2026-03 manifest: `cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f`
- 2026-04 manifest: `e37d01b3a3976f2f2614c2a85171ce4cc8b6b5ad069bf782f55285b0e7721a2c`

## Calibration-eligible session counts

| Regime | Sessions |
|---|---:|
| high | 43 |
| mid | 3 |
| low | 11 |

## Per-regime equal-weight summary

| Regime | n | Mean ppm | Median ppm | Min ppm | Max ppm |
|---|---:|---:|---:|---:|---:|
| high | 43 | 905,083 | 908,478 | 838,653 | 936,877 |
| mid | 3 | 884,610 | 885,187 | 881,682 | 886,960 |
| low | 11 | 878,009 | 878,798 | 863,306 | 890,315 |

## Per-regime probe-weighted sensitivity

| Regime | Pooled share ppm | Comparable probes | Within-tolerance probes |
|---|---:|---:|---:|
| high | 905,083 | 2,012,336 | 1,821,333 |
| mid | 884,610 | 140,394 | 124,194 |
| low | 878,009 | 514,778 | 451,980 |

## High-vs-low TOST bootstrap

Equal-weight delta(high - low): `27,074` ppm.

| Block length | 90% CI lower | 90% CI upper | 95% CI lower | 95% CI upper | Verdict |
|---:|---:|---:|---:|---:|---|
| 3 | 21,541 | 34,580 | 20,241 | 35,769 | A |
| 5 | 21,521 | 32,883 | 20,280 | 33,773 | A |
| 7 | 22,757 | 32,394 | 21,587 | 33,099 | A |

Block-length stability flag: `true`.

## Mid-regime descriptive statistics

- mid_regime_status: `screening_floor`
- mid_regime_inference: `descriptive_only`
- mid_anomaly_flag: `false`

| Session | Share ppm |
|---|---:|
| 2026-04-13-rth | 881,682 |
| 2026-04-14-rth | 885,187 |
| 2026-04-15-rth | 886,960 |

| Statistic | Value ppm |
|---|---:|
| mean | 884,610 |
| median | 885,187 |
| min | 881,682 |
| max | 886,960 |

Leave-one-out pair means:

| Excluded session | Pair mean ppm | Pair sessions |
|---|---:|---|
| 2026-04-13-rth | 886,074 | 2026-04-14-rth, 2026-04-15-rth |
| 2026-04-14-rth | 884,321 | 2026-04-13-rth, 2026-04-15-rth |
| 2026-04-15-rth | 883,434 | 2026-04-13-rth, 2026-04-14-rth |

## 21+ visible-queue-ahead diagnostic

Warning flag: `false`.

| Regime | 21+ pooled share ppm | 21+ comparable probes | Overall pooled share ppm | Warning |
|---|---:|---:|---:|---|
| high | 489,769 | 2,297 | 905,083 | false |
| mid | 510,791 | 556 | 884,610 | false |
| low | 519,891 | 1,106 | 878,009 | false |

## Per-session results

| Session | Regime | Share ppm | Comparable probes | Within-tolerance probes | 21+ comparable | 21+ share ppm |
|---|---|---:|---:|---:|---:|---:|
| 2026-02-02-rth | high | 914,996 | 46,798 | 42,820 | 64 | 640,625 |
| 2026-02-03-rth | high | 936,877 | 46,798 | 43,844 | 27 | 444,444 |
| 2026-02-04-rth | high | 917,539 | 46,798 | 42,939 | 15 | 533,333 |
| 2026-02-05-rth | high | 905,166 | 46,798 | 42,360 | 22 | 500,000 |
| 2026-02-06-rth | high | 900,786 | 46,798 | 42,155 | 45 | 533,333 |
| 2026-02-09-rth | high | 897,175 | 46,798 | 41,986 | 113 | 433,628 |
| 2026-02-10-rth | high | 906,363 | 46,798 | 42,416 | 67 | 462,686 |
| 2026-02-11-rth | high | 904,974 | 46,798 | 42,351 | 71 | 521,126 |
| 2026-02-12-rth | high | 919,718 | 46,798 | 43,041 | 40 | 550,000 |
| 2026-02-13-rth | high | 910,679 | 46,798 | 42,618 | 40 | 575,000 |
| 2026-02-17-rth | high | 908,867 | 46,800 | 42,535 | 43 | 488,372 |
| 2026-02-18-rth | high | 911,021 | 46,798 | 42,634 | 53 | 528,301 |
| 2026-02-19-rth | high | 908,478 | 46,798 | 42,515 | 49 | 653,061 |
| 2026-02-20-rth | high | 911,705 | 46,798 | 42,666 | 37 | 459,459 |
| 2026-02-23-rth | high | 907,517 | 46,798 | 42,470 | 66 | 454,545 |
| 2026-02-24-rth | high | 902,218 | 46,798 | 42,222 | 95 | 505,263 |
| 2026-02-25-rth | high | 889,636 | 46,800 | 41,635 | 267 | 471,910 |
| 2026-02-26-rth | high | 918,949 | 46,798 | 43,005 | 72 | 541,666 |
| 2026-02-27-rth | high | 908,072 | 46,798 | 42,496 | 79 | 544,303 |
| 2026-03-02-rth | high | 906,730 | 46,800 | 42,435 | 44 | 431,818 |
| 2026-03-03-rth | high | 914,162 | 46,798 | 42,781 | 22 | 272,727 |
| 2026-03-04-rth | high | 902,367 | 46,798 | 42,229 | 55 | 563,636 |
| 2026-03-05-rth | high | 920,747 | 46,800 | 43,091 | 19 | 631,578 |
| 2026-03-06-rth | high | 915,320 | 46,800 | 42,837 | 15 | 200,000 |
| 2026-03-09-rth | high | 920,897 | 46,800 | 43,098 | 32 | 375,000 |
| 2026-03-10-rth | high | 922,029 | 46,800 | 43,151 | 44 | 454,545 |
| 2026-03-11-rth | high | 912,410 | 46,798 | 42,699 | 34 | 382,352 |
| 2026-03-12-rth | high | 907,303 | 46,798 | 42,460 | 28 | 500,000 |
| 2026-03-13-rth | high | 916,089 | 46,800 | 42,873 | 51 | 490,196 |
| 2026-03-16-rth | high | 838,653 | 46,800 | 39,249 | 40 | 500,000 |
| 2026-03-23-rth | high | 910,876 | 46,800 | 42,629 | 23 | 347,826 |
| 2026-03-24-rth | high | 906,901 | 46,800 | 42,443 | 30 | 666,666 |
| 2026-03-25-rth | high | 907,474 | 46,798 | 42,468 | 27 | 333,333 |
| 2026-03-26-rth | high | 914,333 | 46,798 | 42,789 | 58 | 568,965 |
| 2026-03-27-rth | high | 912,752 | 46,798 | 42,715 | 31 | 483,870 |
| 2026-03-30-rth | high | 914,718 | 46,798 | 42,807 | 58 | 465,517 |
| 2026-03-31-rth | high | 918,479 | 46,798 | 42,983 | 25 | 760,000 |
| 2026-04-01-rth | high | 875,400 | 46,798 | 40,967 | 51 | 470,588 |
| 2026-04-02-rth | high | 878,926 | 46,798 | 41,132 | 53 | 415,094 |
| 2026-04-06-rth | high | 861,233 | 46,798 | 40,304 | 41 | 365,853 |
| 2026-04-07-rth | high | 894,290 | 46,798 | 41,851 | 41 | 585,365 |
| 2026-04-08-rth | high | 885,037 | 46,798 | 41,418 | 113 | 460,176 |
| 2026-04-09-rth | high | 880,721 | 46,798 | 41,216 | 97 | 412,371 |
| 2026-04-13-rth | mid | 881,682 | 46,798 | 41,261 | 148 | 445,945 |
| 2026-04-14-rth | mid | 885,187 | 46,798 | 41,425 | 225 | 533,333 |
| 2026-04-15-rth | mid | 886,960 | 46,798 | 41,508 | 183 | 535,519 |
| 2026-04-16-rth | low | 881,341 | 46,798 | 41,245 | 128 | 570,312 |
| 2026-04-17-rth | low | 874,503 | 46,798 | 40,925 | 95 | 557,894 |
| 2026-04-20-rth | low | 863,947 | 46,798 | 40,431 | 115 | 504,347 |
| 2026-04-21-rth | low | 890,315 | 46,798 | 41,665 | 48 | 541,666 |
| 2026-04-22-rth | low | 878,798 | 46,798 | 41,126 | 158 | 575,949 |
| 2026-04-23-rth | low | 888,862 | 46,798 | 41,597 | 62 | 580,645 |
| 2026-04-24-rth | low | 875,144 | 46,798 | 40,955 | 83 | 566,265 |
| 2026-04-27-rth | low | 863,306 | 46,798 | 40,401 | 178 | 410,112 |
| 2026-04-28-rth | low | 873,968 | 46,798 | 40,900 | 116 | 474,137 |
| 2026-04-29-rth | low | 879,781 | 46,798 | 41,172 | 61 | 524,590 |
| 2026-04-30-rth | low | 888,136 | 46,798 | 41,563 | 62 | 500,000 |

## Downstream implication

Outcome A: QFA-510 readiness review and QFA-420-h1 determinism promotion are the next coordinator actions per ADR-0015 LD-420-7.
