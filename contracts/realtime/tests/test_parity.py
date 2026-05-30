"""TS ⇄ Pydantic parity tripwire (RA-067).

Parses the ``as const`` arrays + the envelope interface out of ``events.ts``
and ``config.ts`` and asserts they match the Pydantic source of truth in
``events.py`` / ``config.py``. A drift on either side reds this test in
every worktree — the integration safety mechanism that lets four agents
build against a frozen contract in parallel.

The test parses the machine-checkable surface (the ``as const`` arrays and
the interface field lists), not arbitrary TS — keeping it robust without a
TypeScript toolchain in the loop.
"""

from __future__ import annotations

import re
from pathlib import Path

from contracts.realtime import config as cfg
from contracts.realtime import events as ev

_REALTIME_DIR = Path(__file__).resolve().parents[1]
_EVENTS_TS = (_REALTIME_DIR / "events.ts").read_text(encoding="utf-8")
_CONFIG_TS = (_REALTIME_DIR / "config.ts").read_text(encoding="utf-8")


def _const_string_array(ts_src: str, name: str) -> list[str]:
    """Extract members of `export const NAME = [ "a", "b", ... ] as const;`."""
    m = re.search(rf"export const {name}\s*=\s*\[(.*?)\]\s*as const;", ts_src, re.DOTALL)
    assert m, f"const array {name} not found in TS source"
    return re.findall(r'"([^"]+)"', m.group(1))


def _interface_fields(ts_src: str, name: str) -> list[str]:
    """Extract top-level field names from `export interface NAME { ... }`."""
    m = re.search(rf"export interface {name}\s*\{{(.*?)\n\}}", ts_src, re.DOTALL)
    assert m, f"interface {name} not found in TS source"
    body = m.group(1)
    # Match `  fieldName: ...` / `  fieldName?: ...` at line starts.
    return re.findall(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:", body, re.MULTILINE)


# --------------------------------------------------------------------------
# events.py ⇄ events.ts
# --------------------------------------------------------------------------


def test_schema_version_matches() -> None:
    m = re.search(r"export const SCHEMA_VERSION\s*=\s*(\d+);", _EVENTS_TS)
    assert m
    assert int(m.group(1)) == ev.SCHEMA_VERSION


def test_message_types_match() -> None:
    assert _const_string_array(_EVENTS_TS, "MESSAGE_TYPES") == list(ev.MESSAGE_TYPES)


def test_tiers_match() -> None:
    assert _const_string_array(_EVENTS_TS, "TIERS") == list(ev.TIERS)


def test_known_families_match() -> None:
    assert _const_string_array(_EVENTS_TS, "KNOWN_FAMILIES") == list(ev.KNOWN_FAMILIES)


def test_envelope_fields_match() -> None:
    ts_const = _const_string_array(_EVENTS_TS, "ENVELOPE_FIELDS")
    assert ts_const == list(ev.ENVELOPE_FIELDS)
    # The const list and the TS interface must agree...
    ts_iface = _interface_fields(_EVENTS_TS, "RealtimeMessage")
    assert ts_iface == list(ev.ENVELOPE_FIELDS)
    # ...and both must equal the Pydantic model's field order.
    py_fields = list(ev.RealtimeMessage.model_fields.keys())
    assert py_fields == list(ev.ENVELOPE_FIELDS)


def test_known_families_have_ts_interface_and_py_model() -> None:
    # Every known family resolves to a registered Pydantic model...
    for family in ev.KNOWN_FAMILIES:
        assert family in ev._PAYLOAD_REGISTRY, f"{family} missing from Python registry"
    # ...and the TS union references a payload interface for each family
    # (lightweight presence check on the discriminant literal).
    for family in ev.KNOWN_FAMILIES:
        assert f'family: "{family}"' in _EVENTS_TS, f'{family} missing from events.ts'


def test_confidence_and_regime_literals_match() -> None:
    assert _const_string_array(_EVENTS_TS, "CONFIDENCE_LEVELS") == ["high", "medium", "low"]
    assert _const_string_array(_EVENTS_TS, "REGIMES") == ["LOW", "NORMAL", "HIGH"]


def test_orderflow_literals_match() -> None:
    assert _const_string_array(_EVENTS_TS, "FLOW_DIRECTIONS") == list(ev.FLOW_DIRECTIONS)
    assert _const_string_array(_EVENTS_TS, "TRADE_AGGRESSORS") == list(ev.TRADE_AGGRESSORS)
    assert _const_string_array(_EVENTS_TS, "INFERRED_DIRECTIONS") == list(ev.INFERRED_DIRECTIONS)
    assert _const_string_array(_EVENTS_TS, "FOOTPRINT_SIDES") == list(ev.FOOTPRINT_SIDES)
    assert _const_string_array(_EVENTS_TS, "ORDERFLOW_QUALITIES") == list(
        ev.ORDERFLOW_QUALITIES
    )
    assert _const_string_array(_EVENTS_TS, "DEPTH_QUALITIES") == list(ev.DEPTH_QUALITIES)


def test_signal_payload_fields_match() -> None:
    ts_fields = _interface_fields(_EVENTS_TS, "SignalPayload")
    py_fields = list(ev.SignalPayload.model_fields.keys())
    assert ts_fields == py_fields


def test_all_known_payload_fields_match() -> None:
    """Field-level TS<->Pydantic parity for EVERY known payload family.

    RA-069 MEDIUM fix: previously only SignalPayload was field-checked, so a
    Python-only field add/rename on any of the other nine families passed the
    tripwire silently while the TS mirror diverged.
    """
    for family, model in ev._PAYLOAD_REGISTRY.items():
        ts_fields = _interface_fields(_EVENTS_TS, model.__name__)
        py_fields = list(model.model_fields.keys())
        assert ts_fields == py_fields, (
            f"{family} ({model.__name__}) TS<->Py field drift: ts={ts_fields} py={py_fields}"
        )


def test_nested_state_fields_match() -> None:
    """Nested payload models are field-checked too.

    ZoneState / ScenarioState are nested inside zone_update + snapshot payloads;
    the orderflow models are nested inside price_tick.
    """
    for model in (
        ev.ZoneState,
        ev.ScenarioState,
        ev.CvdStats,
        ev.AggressorWindowStats,
        ev.VDeltaStats,
        ev.FootprintStats,
        ev.OrderflowStats,
        ev.DepthLevel,
    ):
        ts_fields = _interface_fields(_EVENTS_TS, model.__name__)
        py_fields = list(model.model_fields.keys())
        assert ts_fields == py_fields, (
            f"{model.__name__} TS<->Py field drift: ts={ts_fields} py={py_fields}"
        )


# --------------------------------------------------------------------------
# config.py ⇄ config.ts
# --------------------------------------------------------------------------


def test_config_schema_version_matches() -> None:
    m = re.search(r"export const CONFIG_SCHEMA_VERSION\s*=\s*(\d+);", _CONFIG_TS)
    assert m
    assert int(m.group(1)) == cfg.CONFIG_SCHEMA_VERSION


def test_config_alert_tiers_match() -> None:
    assert _const_string_array(_CONFIG_TS, "ALERT_TIERS") == list(cfg.ALERT_TIERS)


def test_config_tier_fields_match() -> None:
    ts_const = _const_string_array(_CONFIG_TS, "ALERT_TIER_FIELDS")
    assert ts_const == list(cfg.ALERT_TIER_FIELDS)
    ts_iface = _interface_fields(_CONFIG_TS, "TierAlertConfig")
    assert ts_iface == list(cfg.TierAlertConfig.model_fields.keys())
    assert ts_iface == list(cfg.ALERT_TIER_FIELDS)


def test_config_alert_config_fields_match() -> None:
    ts_fields = _interface_fields(_CONFIG_TS, "AlertConfig")
    py_fields = list(cfg.AlertConfig.model_fields.keys())
    assert ts_fields == py_fields


def test_config_nested_fields_match() -> None:
    """ProximityConfig / QuietHoursConfig are nested inside AlertConfig and were
    previously unchecked by the tripwire (RA-069 MEDIUM fix)."""
    for model in (cfg.ProximityConfig, cfg.QuietHoursConfig):
        ts_fields = _interface_fields(_CONFIG_TS, model.__name__)
        py_fields = list(model.model_fields.keys())
        assert ts_fields == py_fields, (
            f"{model.__name__} TS<->Py field drift: ts={ts_fields} py={py_fields}"
        )
