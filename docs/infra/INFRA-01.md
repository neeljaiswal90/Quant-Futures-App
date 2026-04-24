# INFRA-01 Revised Timestamp Verification Gate

INFRA-01 is now the verification gate that consumes the primary `INFRA-01B` exchange-time architecture evidence before `DATA-01` proceeds.
It does not implement a live Rithmic data path or order routing.

See [ADR-0001](../adr/ADR-0001-canonical-event-time.md): for sim-first V1, `exchange_event_ts_ns` is canonical event time and `sidecar_recv_ts_ns` is telemetry only.

## Canonical Timestamp Fields

Runtime and journal-facing code must preserve the APP-02 timestamp contract:

- `exchange_event_ts_ns`: exchange-matched or source event timestamp.
- `rithmic_publish_ts_ns`: optional Rithmic gateway publish/send timestamp when available and semantically understood.
- `sidecar_recv_ts_ns`: sidecar host receive timestamp, preserved as telemetry.
- `runtime_consume_ts_ns`: TypeScript runtime consume timestamp.
- `ts_ns`: canonical emitted event timestamp used by runtime events and JSONL journals; for market-data events this is derived from `exchange_event_ts_ns`.

In-memory timestamps are branded `bigint` nanoseconds. JSONL transport serializes nanoseconds as unsigned decimal strings.

## DATA-01 Gate

DATA-01 remains blocked until `reports/infra/infra01_revised_timestamp_gate.json` says:

- `data01_eligible = true`
- `route_to = DATA-01`

The revised gate confirms:

- `exchange_event_ts_ns` is populated for at least 99.9% of market-data records, excluding documented startup/control records.
- `exchange_event_ts_ns` is non-decreasing per stream.
- `sidecar_recv_ts_ns - exchange_event_ts_ns` telemetry has non-negative p50 and p99 below 500 ms.
- Databento overlap parity report exists and confirms exchange-time-aligned live capture and historical data reconstruct comparable market state.

## INFRA-01B Primary Evidence

`INFRA-01B` is the primary timestamp architecture path. It captures Linux/chrony or equivalent host-time evidence and a 30-minute RTH re-probe with all four streams:

- `L1_QUOTE`
- `LAST_TRADE`
- `MBP10`
- `MBO`

Host-time evidence target:

- chrony tracking RMS offset below 10 ms;
- root dispersion below 50 ms;
- sustained across a 1-hour observation window.

This host-time target is a telemetry/clock-health guardrail for V1. It is not the canonical event-time source for replay, labels, or feature alignment.

## Receive-Time Telemetry

`sidecar_recv_ts_ns` is used for receive-latency diagnostics, runtime health, feed delay monitoring, and operational troubleshooting.

`sidecar_recv_ts_ns` must not be used as the canonical event timestamp for V1 replay, first-passage labels, feature alignment, candidate lineage, or gap detection when `exchange_event_ts_ns` is populated.

## Failure Routing

`canonical_event_time_failure` means exchange-time evidence is unsafe: coverage is below threshold, per-stream exchange time is not non-decreasing, or Databento overlap parity fails. DATA-01 remains blocked.

`telemetry_clock_health_issue` means `sidecar_recv_ts_ns - exchange_event_ts_ns` telemetry p50 is negative or p99 is at least 500 ms while exchange-time evidence remains safe. This does not invalidate canonical event time, but the INFRA-01B report remains `status: "fail"` and routes back to `INFRA-01B` until the telemetry evidence is accepted or remediated by the revised INFRA-01 verification gate.

`invalid` means the evidence is not usable yet, usually because the probe was shorter than 30 minutes, no valid timestamp records were provided, the clock file is missing/invalid, JSONL is malformed, or a required timestamp field is absent. Missing Databento parity is recorded as `pending`, not invalid, because full overlap parity is finalized by the later INFRA-01 verification gate.

## Code Surface

`apps/strategy_runtime/src/infra/timestamp-validation.ts` exposes:

- `evaluateCanonicalExchangeTimeGate` for the primary INFRA-01B exchange-time path.
- `evaluateTimestampReprobe` for the superseded receive-latency threshold model retained only for historical tests/traceability.

Both functions are pure and deterministic: callers provide all timestamps, samples, and clock-discipline evidence explicitly.

`scripts/infra/evaluate-infra-01-probe.ts` evaluates captured JSONL evidence and writes `reports/infra/infra01b_canonical_exchange_time_report.json` by default:

```powershell
npm run infra:01:evaluate -- --probe data/probes/infra01/smoke/probe.jsonl --clock data/probes/infra01/smoke/clock_sync.json
```

Use `--out <report.json>` to choose a different path. Use `--databento-parity <report.json>` when an overlap parity report exists; otherwise the report records parity as `pending`.

The evaluator separates input validation from gate evaluation:

- invalid or incomplete evidence writes `status: "invalid"` and exits `3`;
- complete evidence that fails a canonical, telemetry, clock-evidence, or provided parity gate writes `status: "fail"` and exits `2`;
- complete evidence that passes the INFRA-01B checks writes `status: "pass"`, exits `0`, and routes to `INFRA-01` verification.

The INFRA-01B report includes:

- `canonical_event_time`;
- `exchange_timestamp_coverage`;
- `per_stream_monotonicity`;
- `receive_latency_telemetry`;
- `clock_evidence`;
- `databento_overlap_parity`;
- `data01_conceptually_unblocked`.

`data01_eligible` remains `false` in INFRA-01B output. DATA-01 remains blocked until the later INFRA-01 verification report says `data01_eligible = true` and `route_to = DATA-01`.

`scripts/infra/capture-rithmic-probe.py` is a standalone Rithmic RProtocol probe collector. It connects only to `TICKER_PLANT`; it is not the runtime sidecar and never connects to `ORDER_PLANT`.

## RProtocol SDK Setup

Do not commit the RProtocol SDK, extracted vendor files, generated protobuf files, credentials, or raw full captures.

Point `RITHMIC_RPROTOCOL_HOME` at the extracted SDK version directory or its parent:

```powershell
$env:RITHMIC_RPROTOCOL_HOME="C:\Users\Neel\Desktop\RProtocolAPI_extracted\0.89.0.0"
```

The collector expects:

```text
RITHMIC_RPROTOCOL_HOME/
  samples/samples.py/SampleMD.py
  samples/samples.py/*_pb2.py
  proto/*.proto
  etc/rithmic_ssl_cert_auth_params
```

Missing generated market-data protobufs for `order_book`, `depth_by_order`, `request_depth_by_order_updates`, and `response_depth_by_order_updates` are generated into `.cache/rprotocol_pb2/` on demand. The cache is ignored by git.

RProtocolAPI 0.89 sample `*_pb2.py` files are old descriptor-style protobuf outputs. The collector sets `PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python` by default for compatibility. If `base_pb2` still fails with `Descriptors cannot be created directly`, set it explicitly before running the probe:

```powershell
$env:PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION="python"
```

## Confirmed RProtocol Template IDs

The collector uses these SDK Reference Guide defaults and keeps CLI flags available as overrides:

| Purpose | Template ID | CLI override |
| --- | ---: | --- |
| `OrderBook` / MBP10 payload | `156` | `--order-book-template-id` |
| `RequestDepthByOrderUpdates` subscription request | `117` | `--request-depth-by-order-template-id` |
| `ResponseDepthByOrderUpdates` subscription response | `118` | `--response-depth-by-order-template-id` |
| `DepthByOrder` / MBO payload | `160` | `--depth-by-order-template-id` |
| `DepthByOrderEndEvent` | `161` | `--depth-by-order-end-event-template-id` |

Template `118` is logged to stderr with `rp_code` and `user_msg` when present. Template `161` is parsed when `depth_by_order_end_event_pb2.py` can be generated or imported; otherwise it is counted separately by template ID without failing the probe.

## Credentials

Use environment variables so secrets do not enter shell history:

```powershell
$env:RITHMIC_CONNECT_POINT="wss://your-rithmic-ticker-plant-host:443"
$env:RITHMIC_SYSTEM_NAME="Rithmic Paper Trading"
$env:RITHMIC_USER="your-user"
$env:RITHMIC_PASSWORD="your-password"
```

You can confirm available systems without credentials:

```powershell
python scripts/infra/capture-rithmic-probe.py --list-systems --connect-point $env:RITHMIC_CONNECT_POINT --rprotocol-home $env:RITHMIC_RPROTOCOL_HOME
```

## Clock Sync Evidence

Create `clock_sync.json` next to each probe. On Windows, capture source/status before the probe:

```powershell
w32tm /query /source
w32tm /query /status /verbose
w32tm /stripchart /computer:time.windows.com /period:10 /samples:180 /dataonly
```

Then write:

```json
{
  "source": "chrony",
  "captured_at_ts_ns": "REPLACE_WITH_TIME_TIME_NS",
  "synchronized": true,
  "rms_offset_ms": 1.0,
  "root_dispersion_ms": 10.0,
  "observation_window_minutes": 60
}
```

For Windows/w32tm evidence, `source: "ntp"` with `mean_offset_ms` and `dispersion_ms` is still accepted as valid input, but poor values are reported as host clock-health telemetry and do not by themselves prove canonical exchange-time failure.

## 60-Second Smoke

Start with LAST_TRADE/L1_QUOTE only. This validates SDK bootstrapping, websocket connectivity, login, timestamp capture, JSONL shape, and the evaluator path before debugging MBP10/MBO response template IDs:

```powershell
New-Item -ItemType Directory -Force data/probes/infra01/smoke | Out-Null
python scripts/infra/capture-rithmic-probe.py --duration-sec 60 --streams LAST_TRADE,L1_QUOTE --symbol MNQM6 --exchange CME --out data/probes/infra01/smoke/probe-l1.jsonl
npm run infra:01:evaluate -- --probe data/probes/infra01/smoke/probe-l1.jsonl --clock data/probes/infra01/smoke/clock_sync.json --out data/probes/infra01/smoke/report-l1.json
```

Then run all streams. This validates ORDER_BOOK subscription request, depth-by-order request setup, confirmed MBP10/MBO template parsing, and the generated protobuf cache path:

```powershell
python scripts/infra/capture-rithmic-probe.py --duration-sec 60 --streams LAST_TRADE,L1_QUOTE,MBP10,MBO --symbol MNQM6 --exchange CME --out data/probes/infra01/smoke/probe-all.jsonl
npm run infra:01:evaluate -- --probe data/probes/infra01/smoke/probe-all.jsonl --clock data/probes/infra01/smoke/clock_sync.json --out data/probes/infra01/smoke/report-all.json
```

The `--streams` flag accepts any comma-separated subset of:

```text
LAST_TRADE,L1_QUOTE,MBP10,MBO
```

The evaluator command below still works with any probe JSONL path:

```powershell
npm run infra:01:evaluate -- --probe data/probes/infra01/smoke/probe.jsonl --clock data/probes/infra01/smoke/clock_sync.json --out data/probes/infra01/smoke/report.json
```

The confirmed template IDs are used by default. Override only if the SDK/reference guide version differs:

```powershell
--order-book-template-id <ORDER_BOOK_TEMPLATE_ID> --depth-by-order-template-id <DEPTH_BY_ORDER_TEMPLATE_ID> --request-depth-by-order-template-id <REQUEST_DEPTH_BY_ORDER_UPDATES_TEMPLATE_ID> --response-depth-by-order-template-id <RESPONSE_DEPTH_BY_ORDER_UPDATES_TEMPLATE_ID> --depth-by-order-end-event-template-id <DEPTH_BY_ORDER_END_EVENT_TEMPLATE_ID>
```

## 35-Minute INFRA-01 Probe

Run the full post-sync probe for 2100 seconds:

```powershell
New-Item -ItemType Directory -Force data/probes/infra01/full | Out-Null
python scripts/infra/capture-rithmic-probe.py --duration-sec 2100 --streams LAST_TRADE,L1_QUOTE,MBP10,MBO --symbol MNQM6 --exchange CME --out data/probes/infra01/full/probe.jsonl
npm run infra:01:evaluate -- --probe data/probes/infra01/full/probe.jsonl --clock data/probes/infra01/full/clock_sync.json --out reports/infra/infra01b_canonical_exchange_time_report.json
```

The INFRA-01B evaluator exits `0` only when the exchange-time evidence is ready to route to INFRA-01 verification. DATA-01 remains blocked until the subsequent INFRA-01 report exits `0` and says `data01_eligible = true`.
