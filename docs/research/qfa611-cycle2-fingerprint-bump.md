# QFA-611-Cycle2 fingerprint bump

This document records the strategy fingerprint changes between Cycle1 (T-8,
merged 84df378, 2026-05-11) and Cycle2 (QFA-611-Cycle2 Stage A).

## Schema-derived fingerprint changes (per QFA-7xx-A)

QFA-7xx-A (PR #182, merged 241b67c) extended `StrategyFeatureSnapshot` with
the `context` block. This deterministically bumps every strategy fingerprint
because the snapshot schema is part of the fingerprinted replay surface.

| strategy_id | Cycle1 fingerprint (snapshot pre-QFA-7xx-A) | Cycle2 fingerprint (snapshot post-QFA-7xx-A) |
|---|---|---|
| trend_pullback_long | 910e6cc7bb91ee82a6dff649e2164c547621576c090d4453711e6d4a0b60d549 | 8662261d0b4f8c4aeca040526eb203f403f64429ea0f925f2816ce9a0656872e |
| trend_pullback_short | b129c321588bda0ce91a14afdad7e24099038d122b6cfd7fa7a1169049388c66 | e70f6c67265b6e6c72c8956945d9b25e8829479e05f05c3dc3a75ad06aa157fa |
| breakout_retest_long | 24260bfedcca496002ebd51e89126617df47a623825f679f572f61c5003f5763 | 68db2cac0ac22b1ee5e27727c18987040e7d3cddbb51b47ee10ff0a7c2865e9a |
| breakdown_retest_short | 5cd6116850454717d10773cbbdee9255703a087a6d87e134d56e045c32b48a25 | ac35b627faa7ee80dfdb7fb215d965f41a72264a8aab1e0a9a5b04fca3a1fcd1 |

## New strategy fingerprints (Cycle2-introduced)

| strategy_id | parameter_lock_hash | first-time fingerprint_sha256 |
|---|---|---|
| regime_mean_reversion_long | c32b46d7b0ca6258c7dc45509cac273a6584e9d63d0000e5115745f12ee15bf4 | 8df668aaeb6fcbb927e7c00822d6a79e10b7b2acabf908ada8674f9bf22d3093 |
| regime_mean_reversion_short | bbeb4c0776e1982779899fc713b60832a96f096431047e76451468f8f1720821 | c50caabc9dd2d5042835250b56394b966f51c483222b02da2bd1568cbda29b5d |
| liquidity_sweep_reversal_long | f4b9ad9d3c8105bd603fe9cae1943a8d03ea1189f7adde9910377e91c2caee1c | ac1f7ad53648ccbc71428a28b70f76a9f527858a7d2254819e963d6ad3066b6f |
| liquidity_sweep_reversal_short | 95b0222ca6b58e31bf4b329cf753798b92739b33c1267f0202b3d634c44f7d55 | 5fc2117a0e21bb12aeec32d121818dd799cdc79506531f52355dd537355d63d8 |

## Cycle1 parameter-lock continuity

The four Cycle1 strategy parameter hashes remain byte-identical between the
Cycle1 manifest and the runtime YAML hash recomputation:

| strategy_id | parameter_lock_hash |
|---|---|
| trend_pullback_long | 7f5400cd40dfe811f5101bec829ca17897e841b0810287346ec6a3b062282293 |
| trend_pullback_short | 0e483163640ed3132c4e42841ac3a1862f9fc231cc77732fc8678cbfbb50fd2a |
| breakout_retest_long | 15c0aa4d624a99cdc7150bee903f7563c9ea3b377380074ef55f64cba9fbc664 |
| breakdown_retest_short | 973fc5a795bfcb9f5bc2270aa152faa83947238a9a4e1a1e91bda4bf7cc2da35 |

## Validation

The QFA-301 replay sanity tooling was rerun for all 8 strategies against the
QFA-7xx-A-extended snapshot. The QFA-7xx-A regression gate is frozen to the
original 4 strategies and re-confirms no candidate, entry, exit, sizing, or
PnL behavior changes. The 4 new strategies' behavior is locked by their own
regression baselines from QFA-7xx-S3 and QFA-7xx-S2.

## Trial accounting

`effective_trial_count = 8` (was 4 in Cycle1).

DSR penalty applies at the new trial count for all 8 strategies, including
the Cycle1 4-strategy subset. This is the CF-29 count-agnostic methodology:
Cycle1 strategies are not grandfathered into a 4-trial DSR; they face the
same 8-trial penalty as the new candidates.
