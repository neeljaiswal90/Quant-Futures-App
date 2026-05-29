"""Tests for the pure toast renderer + zone-price map."""

from __future__ import annotations

from contracts.realtime.events import (
    RealtimeMessage,
    SignalPayload,
    SnapshotPayload,
    ZoneState,
    ZoneUpdatePayload,
    make_message,
)
from notification_daemon.render import ZonePriceMap, render_toast


def _critical(level_id: str | None = "vpoc", families: list[str] | None = None) -> RealtimeMessage:
    return make_message(
        type="event",
        seq=3,
        tier="CRITICAL",
        payload=SignalPayload(
            event_type="confluence_stack",
            level_id=level_id,
            description="CRITICAL: iceberg + absorption + sweep stacked at VPOC",
            intensity=0.95,
            confidence="high",
            metadata={"families": families if families is not None else ["iceberg", "absorption", "sweep"]},
        ),
    )


def test_zone_map_populates_from_snapshot() -> None:
    zm = ZonePriceMap()
    snap = SnapshotPayload(
        zones=[
            ZoneState(id="vpoc", kind="vpoc", price=30075.0, label="VPOC"),
            ZoneState(id="vah", kind="vah", price=30120.0, label="VAH"),
        ]
    )
    zm.update(snap.zones)
    assert zm.price_for("vpoc") == 30075.0
    assert zm.label_for("vpoc") == "VPOC"
    assert len(zm) == 2


def test_zone_map_incremental_update_is_upsert() -> None:
    zm = ZonePriceMap()
    zm.update([ZoneState(id="vpoc", kind="vpoc", price=30075.0, label="VPOC")])
    upd = ZoneUpdatePayload(zones=[ZoneState(id="wvwap", kind="wvwap", price=30088.0, label="W-VWAP")])
    zm.update(upd.zones)
    # Old level untouched (incremental), new level added.
    assert zm.price_for("vpoc") == 30075.0
    assert zm.price_for("wvwap") == 30088.0
    # A later update for an existing id overwrites (level moved).
    zm.update([ZoneState(id="vpoc", kind="vpoc", price=30099.0, label="VPOC")])
    assert zm.price_for("vpoc") == 30099.0


def test_render_uses_mapped_price_and_families() -> None:
    zm = ZonePriceMap()
    zm.update([ZoneState(id="vpoc", kind="vpoc", price=30075.0, label="VPOC")])
    title, body = render_toast(_critical(), zm)
    assert "CRITICAL" in title
    assert "VPOC @ 30075.00" in title
    assert "iceberg + absorption + sweep" in body
    # Posture (the signal description) is present.
    assert "stacked at VPOC" in body


def test_render_falls_back_to_label_when_price_unmapped() -> None:
    zm = ZonePriceMap()  # empty -> no mapped price for vpoc
    title, _ = render_toast(_critical(), zm)
    # No mapped price/label -> falls back to the raw level_id.
    assert "vpoc" in title
    assert "@" not in title


def test_render_handles_missing_level_id() -> None:
    zm = ZonePriceMap()
    title, body = render_toast(_critical(level_id=None), zm)
    assert "CRITICAL" in title
    assert body  # still renders families + posture


def test_render_handles_empty_families() -> None:
    zm = ZonePriceMap()
    zm.update([ZoneState(id="vpoc", kind="vpoc", price=30075.0, label="VPOC")])
    title, body = render_toast(_critical(families=[]), zm)
    assert "VPOC @ 30075.00" in title
    # Body falls back to the posture line.
    assert "stacked at VPOC" in body
