# REL-01-Short Evidence Note

REL-01-Short is the two-session controlled live-sim pilot packet used before continuing the longer REL-01 sequence. It is not a substitute for the formal 10-session REL-01 gate.

## Current Decision Artifact

The current passing packet is recorded under:

```text
reports/rel/rel01_short_packet_current/
```

Primary decision artifact:

```text
reports/rel/rel01_short_packet_current/rel01_short_aggregate_report.json
```

Final packet guardrail artifact:

```text
reports/rel/rel01_short_packet_current/rel01_short_final_packet_report.json
```

The packet manifest is:

```text
reports/rel/rel01_short_packet_current/rel01_manifest.json
```

## Result

REL-01A aggregate status:

```text
status = pass
sessions = 2/2
source_events = 265437
provenance_spot_checks = 5/5
```

REL-01D feature-surface audit:

```text
status = pass
restricted_uses = 0
blocked_uses = 0
shadow_uses = 0
```

REL-01E MBO shadow lineage:

```text
status = no_shadow_telemetry
```

`no_shadow_telemetry` is expected for this packet. MBO shadow telemetry was not enabled for the comparable two-session run, so REL-01E did not have lineage-rich shadow fields to validate. This is not a failure and does not promote MBO-derived decision features.

## Finalizer

Run the final packet guardrail after REL-01A, REL-01D, and REL-01E reports exist:

```powershell
npm run rel:01:short:final -- `
  --manifest reports/rel/rel01_short_packet_current/rel01_manifest.json `
  --rel01a-report reports/rel/rel01_short_packet_current/rel01_short_aggregate_report.json `
  --rel01d-report reports/rel/rel01_short_packet_current/rel01d_feature_surface_audit_report.json `
  --rel01e-report reports/rel/rel01_short_packet_current/rel01e_mbo_shadow_lineage_report.json `
  --policy-note reports/rel/rel01_short_policy_note.md `
  --out-json reports/rel/rel01_short_packet_current/rel01_short_final_packet_report.json `
  --out-md reports/rel/rel01_short_packet_current/rel01_short_final_packet_report.md
```

The finalizer is read-only with respect to trading/runtime behavior. It fails unless the short packet has exactly two distinct RTH sessions, REL-01A is `pass`, REL-01D is `pass`, REL-01E is `no_shadow_telemetry`, and the accepted feature surface has zero restricted, blocked, invalid, or shadow uses.

## Scope

REL-01-Short confirms that two distinct RTH controlled live-sim sessions can pass the REL-00 and REL-01A packet checks under the current accepted feature surface. It does not approve:

- real-money execution;
- MBO-derived strategy/risk/sizing decision inputs;
- full DATA-01B promotion;
- replacing the formal 10-session REL-01 packet.

Generated evidence remains under `reports/` and should not be committed.
