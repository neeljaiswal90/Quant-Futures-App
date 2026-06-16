# QFA-612-LIVE-CAPTURE-FULL-SESSION-MINUTE-BAR-SEED-01

STATE: PENDING-REVIEW

## Determination

```text
LIVE_CAPTURE_FULL_SESSION_MINUTE_BAR_SEED_READY_FOR_PAPER_OBSERVATION_START
```

## Summary

The QFA-612 live/local capture bridge now supports a compact full-session minute-bar seed built from the current OBS01 capture before paper-start preflight. The runtime loads this seed to initialize session-to-source-offset bar state, then tails OBS01 for new trades and MBP1 for quotes.

This removes the previous bounded-tail VWAP caveat for paper-observation start while preserving broker safety boundaries.

## Evidence

```text
npm run build = pass
npm run lint --if-present = pass
python -m pytest services\broker_session_sidecar\tests -q = pass, 19 passed
```

Guarded paper-start evidence:

```text
determination = PAPER_TRADING_START_RTH_2026_06_15_STARTED_AND_STOPPED_BOUNDED
preflight_passed = true
blocked_gates = []
live_capture_minute_bar_seed_has_warmup = true
live_capture_minute_bar_seed_starts_at_rth_open = true
full_session_vwap_authority = true
full_session_vwap_authority_scope = through_minute_bar_seed_source_offset_plus_live_tail
QUOTE = 1
FEATURES = 1
STRAT_EVAL = 1
ORDER_INTENT = 0
```

Output hashes:

```text
bounded_jsonl_lf_sha256 = 82e2f368e20c162f342d79638ff6eb742e01cbbf3e76db03618cd997b5fb696a
report_json_lf_sha256 = 9d08455645ac935c7e4e053c425de9384d8e0a11d7c34462e2bc12f53c74f19e
report_md_lf_sha256 = 75e1a63154a7acf168f76df11e95b8a76333500d81edc39d426cd6cf84a8f791
memo_lf_sha256 = 1870f0edad1f6c86a9146ac0dc53ef9490e86f36041263e04bb77e02324dff3d
```

## Boundary

```text
Rithmic Test only
capture credentials are not broker fallback
paper_observation_stop_after_candidate = true
observation_day_authority = false
order_translation_authority = false
production_account_used = false
live_trading_authority_created = false
phase_6_authority_created = false
roster_mutated = false
automatic_shutdown_flattening = false
```

## Next gate

Paper observation can now begin in candidate-stopped mode. The next autonomous gate is live candidate watch:

```text
QFA-612-LIVE-CAPTURE-CANDIDATE-WATCH-01
```

That gate should keep `paper_observation_stop_after_candidate=true` and prove whether live capture produces `CANDIDATE > 0` before any order-translation authority is considered.
