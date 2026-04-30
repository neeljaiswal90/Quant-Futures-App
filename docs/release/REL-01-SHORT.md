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

## Scope

REL-01-Short confirms that two distinct RTH controlled live-sim sessions can pass the REL-00 and REL-01A packet checks under the current accepted feature surface. It does not approve:

- real-money execution;
- MBO-derived strategy/risk/sizing decision inputs;
- full DATA-01B promotion;
- replacing the formal 10-session REL-01 packet.

Generated evidence remains under `reports/` and should not be committed.
