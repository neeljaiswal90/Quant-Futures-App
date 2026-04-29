# SIM-03J Databento MBO DBN Decode

SIM-03J is the decode bridge between the real SIM-03A Databento corpus (`mbo.dbn.zst`) and SIM-03I's targeted `limit_queue:front` observation exporter. It does not fit models, change thresholds, patch reports, or unblock REL gates by itself.

## Contract

The decoder emits compact JSONL rows with exactly the fields SIM-03I consumes:

```json
{ "ts_event": 1000000000, "order_id": 1, "action": "A", "price": 100000000000, "size": 1, "side": "B" }
```

It reuses the same Databento reader convention as the SIM-03 calibrator:

```python
db.DBNStore.from_file(path).to_ndarray(schema="mbo", count=100_000)
```

SIM-03I still owns split tagging and bucket extraction. It reads the SIM-03 source manifest first, selects the MBO files for the requested split, then invokes this decoder per selected file. That keeps calibration and validation labels attached at the file boundary rather than inferred post-hoc.

## Run Standalone

```powershell
npm run sim:03j:decode-mbo-dbn -- `
  --input A:\Quant-futures-app-data\databento\sim03_corpus\2026-04-27-rth\mbo.dbn.zst `
  --out C:\Quant-futures-app\reports\sim\decoded_mbo_2026-04-27-rth.jsonl
```

The standalone output is an intermediate artifact. Do not commit decoded MBO JSONL; Databento corpus data remains operational evidence only.

## Run Through SIM-03I

```powershell
npm run sim:03i:export-front-observations -- `
  --calibration-report C:\Quant-futures-app\reports\sim\fill_slippage_calibration.json `
  --diagnosis-report C:\Quant-futures-app\reports\sim\limit_queue_front_diagnosis.json `
  --corpus-root A:\Quant-futures-app-data\databento\sim03_corpus `
  --out C:\Quant-futures-app\reports\sim\limit_queue_front_observations.jsonl `
  --manifest-out C:\Quant-futures-app\reports\sim\limit_queue_front_observations_manifest.json `
  --generated-at-ts-ns 1777399200000000000
```

`status: "exported"` means SIM-03H can consume the observation file. REL-01 remains blocked until SIM-03H produces a refit report and SIM-03D validates that report as `pass`.

## Failure Modes

- `requires_decoded_observation_source`: DBN decoding failed, usually because the local Python environment does not have `databento` installed.
- `split_leakage_detected`: at least one session ID emitted observations in both calibration and validation splits. Treat this as a manifest/split bug; do not feed the output to SIM-03H.
- `no_matching_observations`: the selected corpus sources decoded successfully but produced no `limit_queue:front` observations.
