# QFA-402-housekeeping-3: Policy lock validation

Ticket: QFA-402-housekeeping-3 - Apply locked probe policy + mode switch

Status: PASS

Base HEAD: `456884bbc0dff09212b06c9f2aae435d11712067`

Archive path: `D:/qfa-cache/databento/tier-a-feb-mar-2026/`

## Scope

QFA-402-housekeeping-3 applies the ADR-0012 probe-policy lock and validates
the three required queue-fidelity windows. This ticket changes only the locked
QFA-402 defaults and adapter wiring; it does not change QFA-105, queue-fidelity
formulas, thresholds, tolerance, RunSpec contracts, journal events, or CI
archive dependencies.

## ADR references

- ADR-0011: QFA-402 queue-fidelity threshold posture
- ADR-0012: QFA-402 probe policy lock at 15s fill horizon and 60s depletion
  lookback

ADR-0011 threshold/tolerance posture is preserved:

```text
tolerance_ppm                  = 100_000
min_within_tolerance_share_ppm = 800_000
```

ADR-0012 policy values are applied:

```text
fill_horizon_ns       = 15_000_000_000
depletion_lookback_ns = 60_000_000_000
mode                  = mbp_trades_proxy
```

## Manifest verification

```text
Feb manifest: 05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c
Mar manifest: cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f
```

Required schemas were present for all validation windows:

```text
2026-02-24-rth: mbo, mbp-1, trades
2026-02-25-rth: mbo, mbp-1, trades
2026-03-02-rth: mbo, mbp-1, trades
```

## Source change summary

```text
apps/backtester/src/fidelity/queue/types.ts
  - DEFAULT_QUEUE_FIDELITY_POLICY_V1.fill_horizon_ns:
      5_000_000_000n -> 15_000_000_000n
  - DEFAULT_QUEUE_FIDELITY_POLICY_V1.depletion_lookback_ns:
      30_000_000_000n -> 60_000_000_000n
  - synthesized_mode marker:
      qfa105_mbp_proxy_mbp1_only -> qfa105_mbp_trades_proxy_mbp1_trades
  - tolerance_ppm unchanged at 100_000
  - min_within_tolerance_share_ppm unchanged at 800_000

apps/backtester/src/fidelity/queue/synthesized-queue.ts
  - QFA-402 synthesized path now passes MBP-1 plus trades records into
    QFA-105.
  - QFA-105 options now use input_schemas ['mbp-1', 'trades'].
  - QFA-105 options now use mode 'mbp_trades_proxy'.
  - PassiveFillEstimate output shape is unchanged.
```

## Test fixture changes

```text
apps/backtester/tests/unit/fidelity/queue/queue-fidelity.test.ts
  - Mode assertions updated from mbp_proxy to mbp_trades_proxy.
  - Source-inspection test updated for ['mbp-1', 'trades'].
  - Synthetic adapter test now includes a deterministic trades record and
    expects the QFA-105 mbp_trades_proxy probability output.
```

No broader fixture refresh was required.

## Smoke validation

Smoke used the existing QFA-402c streaming helper:

```text
scripts/backtester/qfa-402c-queue-residual-analysis.mts
```

The helper reads `DEFAULT_QUEUE_FIDELITY_POLICY_V1`, so this run exercised the
new locked policy values without modifying or adding a smoke helper.

Heap:

```text
NODE_OPTIONS=--max-old-space-size=8192
```

Runtime:

```text
total_runtime_ms: 614061
peak_rss_mb:      616
```

| Session | Scope | Total probes | Comparable probes | Within-tolerance probes | within_tolerance_share_ppm | Threshold | Margin | Result |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 2026-02-24-rth | full RTH | 46,798 | 46,798 | 42,222 | 902,218 | 800,000 | +102,218 | PASS |
| 2026-02-25-rth | full RTH | 46,800 | 46,800 | 41,635 | 889,636 | 800,000 | +89,636 | PASS |
| 2026-03-02-rth | first 1800s prefix | 3,598 | 3,598 | 3,403 | 945,803 | 800,000 | +145,803 | PASS |

## Runtime breakdown

| Session | Generate probes | Synthesize | MBO reference | Compare/analyze | Total | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|
| 2026-02-25-rth | 20,778 ms | 132,792 ms | 67,939 ms | 247 ms | 221,759 ms | 616 MB |
| 2026-02-24-rth | 37,948 ms | 200,403 ms | 101,586 ms | 263 ms | 340,202 ms | 616 MB |
| 2026-03-02-rth | 6,419 ms | 30,246 ms | 15,406 ms | 22 ms | 52,097 ms | 597 MB |

## Comparison to QFA-402d

QFA-402d identified `15s / 60s` as the best sweep cell:

```text
2026-02-25-rth: 889,636 ppm
2026-02-24-rth: 902,218 ppm
```

This validation run reproduces those exact full-RTH Feb values with the policy
now applied as the default, confirming that QFA-402's default path is aligned
with the sweep evidence.

## Mar pre-lock confirmation

ADR-0012 required a bounded Mar 2026-03-02 1800s smoke at the new policy before
queue fidelity could unblock. The Mar validation window passed:

```text
2026-03-02-rth first 1800s prefix: 945,803 ppm
margin above threshold:            +145,803 ppm
```

This satisfies Q-WT2-3.

## Source and contract confirmation

Confirmed unchanged:

```text
QFA-105 model/formulas
QFA-402 threshold/tolerance
QFA-402 comparison formula
RunSpec contracts
Journal event contracts
Validation policy
CI determinism configuration
CI archive dependency
```

## Verdict

All three ADR-0012 validation windows are greater than or equal to
`800,000 ppm`.

```text
Phase 3 queue fidelity status: PASS pending PR merge
Phase 3 exit-gate implication: QFA-402 queue fidelity unblocks on merge
```
