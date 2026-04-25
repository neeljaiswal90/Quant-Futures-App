# CFG-01 - Risk and Management YAML Lineage

Status: implemented

## Scope

CFG-01 moves the remaining RISK and MGMT runtime defaults into typed YAML config and threads deterministic lineage hashes into ORCH-02 events. It does not add live execution, sockets, DATA-01 sidecar dependencies, or strategy math changes.

## Config Files

Risk policy:

```text
config/risk/risk-policy.yaml
```

Management profiles:

```text
config/management/profiles.yaml
```

Both files use the same strict project YAML subset as STRAT-07: two-space indentation, nested mappings, scalar values only, no arbitrary YAML tags, and no executable parsing behavior.

## Risk Lineage

`loadRiskPolicyConfig()` validates `config/risk/risk-policy.yaml`, canonicalizes the typed policy with sorted JSON keys, and emits:

- `risk_config_hash`
- `risk_config_version`
- `risk_config_hash_algorithm`
- `canonical_risk_config_json`

The YAML includes account/risk limits, session circuit-breaker controls, sizing mode, typed `default_regime`, and Phase-1 sizing parameters.

## Management Lineage

`loadManagementProfilesConfig()` validates `config/management/profiles.yaml`, computes one deterministic `profile_hash` per profile, then computes a whole-file `management_config_hash`.

The YAML includes all four V1 profiles plus the explicit fallback profile:

- `trend_pullback_long`
- `trend_pullback_short`
- `breakout_retest_long`
- `breakdown_retest_short`
- `fallback_profile`

## ORCH-02 Event Lineage

ORCH-02 consumes the loaded risk policy and management profiles from `loadAppConfig()`.

Runner-created envelopes still carry APP-03 `config_hash` in `event.config`.

Payloads additionally carry:

- `SIZING`: `strategy_config_hash`, `risk_config_hash`, `risk_manager_version`
- `RISK_GATE`: `strategy_config_hash`, `risk_config_hash`, `risk_manager_version`, `session_risk`
- `POSITION`: `strategy_config_hash`, `management_profile_hash`, `management_profile_id`, `management_profile_version`
- `MGMT_TICK`: `strategy_config_hash`, `management_profile_hash`, `management_profile_id`, `management_profile_version`, `position_manager_version`
- `MGMT_ACTION`: `strategy_config_hash`, `management_profile_hash`, `management_profile_id`, `management_profile_version`, `position_manager_version`

## Determinism Rule

CFG-01 does not change EVT-01 causation. The runner does not generate timestamps for these hashes or config decisions. Every derived event still inherits `ts_ns` from the causation chain.

## Future Notes

Risk and management config hashes are now present for REL-01 traceability. Future tuning tickets should update YAML and rely on lineage hash changes rather than embedding new constants in runtime code.
