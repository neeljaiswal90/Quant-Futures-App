"""RA-050 schema-extensibility contract test (RA-067).

An unknown payload family must round-trip through the envelope: parse into
:class:`GenericPayload`, serialize back with every original field intact,
and reach the feed without raising. This is what lets a future detector
family flow to the UI without a renderer change.
"""

from __future__ import annotations

import json

from contracts.realtime.events import (
    GenericPayload,
    RealtimeMessage,
    SignalPayload,
    make_message,
    parse_payload,
)


def test_unknown_family_parses_to_generic() -> None:
    payload = parse_payload(
        {"family": "quantum_flux_2027", "magnitude": 7, "note": "from the future"}
    )
    assert isinstance(payload, GenericPayload)
    assert payload.family == "quantum_flux_2027"


def test_unknown_family_round_trips_losslessly() -> None:
    raw = {
        "type": "event",
        "seq": 42,
        "ts_ns": 1_777_000_000_000_000_000,
        "ts_pt": "2026-05-28T11:30:00-07:00",
        "tier": "HIGH",
        "schema_version": 1,
        "payload": {
            "family": "never_seen_before",
            "custom_int": 5,
            "custom_str": "hello",
            "nested": {"a": 1, "b": [2, 3]},
        },
    }
    msg = RealtimeMessage.model_validate(raw)
    assert isinstance(msg.payload, GenericPayload)

    dumped = json.loads(msg.model_dump_json())
    # Envelope intact.
    assert dumped["type"] == "event"
    assert dumped["seq"] == 42
    assert dumped["tier"] == "HIGH"
    # Every unknown payload field preserved (SerializeAsAny + extra=allow).
    assert dumped["payload"]["family"] == "never_seen_before"
    assert dumped["payload"]["custom_int"] == 5
    assert dumped["payload"]["custom_str"] == "hello"
    assert dumped["payload"]["nested"] == {"a": 1, "b": [2, 3]}


def test_unknown_family_does_not_crash_envelope_construction() -> None:
    # The renderer-equivalent path: build a message with an unknown family
    # via the public constructor — must not raise.
    msg = make_message(
        type="event",
        seq=1,
        payload={"family": "exotic_microstructure", "x": 1.23},
        tier=None,
    )
    assert msg.payload.family == "exotic_microstructure"


def test_known_family_still_typed() -> None:
    # Extensibility must not regress strong typing for known families.
    msg = make_message(
        type="event",
        seq=2,
        payload={
            "family": "signal",
            "event_type": "cvd_breakdown",
            "description": "x",
            "intensity": 0.5,
            "confidence": "high",
        },
        tier="MEDIUM",
    )
    assert isinstance(msg.payload, SignalPayload)
    assert msg.payload.event_type == "cvd_breakdown"


def test_missing_family_is_rejected() -> None:
    import pytest

    with pytest.raises(ValueError, match="family"):
        parse_payload({"no_family_here": True})
