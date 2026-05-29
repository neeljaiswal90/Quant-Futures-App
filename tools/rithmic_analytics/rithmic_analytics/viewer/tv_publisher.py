"""TV chart-sync publisher — RA-034.

Generates a plan-file describing how to bring a TradingView (Desktop or
Tradesea) chart's shapes in sync with the canonical zones JSON. Python
emits the plan; an executor agent loop (Claude Code session with TV-MCP
or Chrome-MCP tools) reads the plan and performs the actual shape
add/remove operations.

Design (RA-034 sweep, all decisions locked in pre-build):

**State-file driven safety contract.** We only touch shapes ``tv_sync``
previously created. The state file at
``data/tv_sync_state/<backend>_<chart_id>.json`` maps
``source_id → shape_id``. Manual user drawings (fibs, trend lines,
etc.) are invisible to the planner and survive forever. This is the
load-bearing safety invariant.

**Plan-emit only.** ``--apply`` writes a plan file; it does NOT execute
MCP calls. The executor agent reads the plan, invokes MCP tools, writes
back the updated state file. Survives mid-execution crashes — the plan
is a permanent artifact, resumable from state + plan + the actual
chart's current shapes.

**Source ID convention.**

- Reference lines: ``ref:<source>:<price formatted to 2 decimals>`` —
  e.g. ``ref:vpoc:27381.25``. Both singleton (VPOC) and plural (LVN)
  sources work — price disambiguates.
- Zones: ``zone:<zone.id>`` — e.g. ``zone:hvn-27380``. ``Zone.id`` is
  already deterministic in the schema.

**Style policy** (per-source defaults, tune via ``STYLE_BY_SOURCE`` /
``STYLE_BY_CONVICTION`` dicts at module top). VWAP-RTH is teal
(#14B8A6) and VWAP-Globex is purple (#A855F7) to avoid visual
collision with Neel's existing always-on Weekly-AVWAP indicator (also
orange).

**Time anchor for new shapes.** The executor uses
``Math.floor(Date.now() / 1000)`` rounded to bar resolution, **not**
``getVisibleRange().to`` (2026-05-20 incident: ``vr.to`` placed
labels 8 weeks into future-space, off-screen). This is documented in
the executor agent's prompt template, not in this module — but the
plan file's ``meta`` block carries the convention as a reminder.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from rithmic_analytics.core.schema import ReferenceLine, Zone

_LOG = logging.getLogger("rithmic_analytics.tv_publisher")

_PLAN_VERSION: int = 1
_STATE_VERSION: int = 1


# ---------------------------------------------------------------------------
# Style policy (locked per RA-034 sweep with Neel's teal/purple tweak)
# ---------------------------------------------------------------------------

STYLE_BY_SOURCE: dict[str, dict[str, Any]] = {
    # Value-area + POC
    "vpoc": {"color": "#84CC16", "style": "solid", "width": 2},   # lime
    "vah":  {"color": "#EF4444", "style": "dashed", "width": 1},  # red
    "val":  {"color": "#10B981", "style": "dashed", "width": 1},  # green
    # LVNs — cyan dotted regardless of timeframe
    "lvn_rth":    {"color": "#06B6D4", "style": "dotted", "width": 1},
    "lvn_globex": {"color": "#06B6D4", "style": "dotted", "width": 1},
    "lvn_multi":  {"color": "#06B6D4", "style": "dotted", "width": 1},
    # VWAP RTH — teal (not orange — avoid collision with Neel's W-AVWAP indicator)
    "vwap_rth":           {"color": "#14B8A6", "style": "solid", "width": 2},
    "vwap_rth_band_p1sd": {"color": "#14B8A6", "style": "dashed", "width": 1},
    "vwap_rth_band_m1sd": {"color": "#14B8A6", "style": "dashed", "width": 1},
    # VWAP Globex — purple
    "vwap_globex":           {"color": "#A855F7", "style": "solid", "width": 2},
    "vwap_globex_band_p1sd": {"color": "#A855F7", "style": "dashed", "width": 1},
    "vwap_globex_band_m1sd": {"color": "#A855F7", "style": "dashed", "width": 1},
    # VWAP Weekly — blue
    "vwap_weekly": {"color": "#3B82F6", "style": "solid", "width": 2},
}

# Fallback for unknown reference-line sources — neutral gray
_DEFAULT_REF_STYLE: dict[str, Any] = {"color": "#9CA3AF", "style": "solid", "width": 1}

STYLE_BY_CONVICTION: dict[str, dict[str, Any]] = {
    "SUPER": {"color": "#FACC15", "opacity": 0.40, "border_width": 2},  # bold yellow
    "HIGH":  {"color": "#FACC15", "opacity": 0.30, "border_width": 1},
    "MED":   {"color": "#FACC15", "opacity": 0.20, "border_width": 1},
    "LOW":   {"color": "#9CA3AF", "opacity": 0.15, "border_width": 1},  # gray
}


# ---------------------------------------------------------------------------
# Source-ID derivation
# ---------------------------------------------------------------------------


def reference_line_source_id(ref: ReferenceLine) -> str:
    """``ReferenceLine`` → canonical source ID. Stable across runs as long as
    ``source`` + ``price`` are unchanged.

    Price is formatted to 2 decimals (MNQ ticks finer than that don't
    exist — 0.25 is the tick). This stabilises IDs against fp noise.
    """
    return f"ref:{ref.source}:{ref.price:.2f}"


def zone_source_id(zone: Zone) -> str:
    """``Zone`` → canonical source ID. ``Zone.id`` is already deterministic
    in the schema (e.g. ``"hvn-27380"``)."""
    return f"zone:{zone.id}"


# ---------------------------------------------------------------------------
# Operation dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AddOperation:
    """Add a new shape. Executor must record the returned ``shape_id`` in
    the state file keyed by ``source_id``."""

    source_id: str
    kind: Literal["reference_line", "rectangle"]
    label: str
    style: dict[str, Any]
    price: float | None = None   # reference_line
    top: float | None = None     # rectangle
    bot: float | None = None     # rectangle
    op: Literal["add"] = "add"

    def to_dict(self) -> dict[str, Any]:
        return {
            "op": "add", "source_id": self.source_id, "kind": self.kind,
            "label": self.label, "price": self.price, "top": self.top,
            "bot": self.bot, "style": dict(self.style),
        }


@dataclass(frozen=True, slots=True)
class RemoveOperation:
    """Remove a previously-created shape. Executor clears the state-file
    entry for ``source_id`` once the remove succeeds (or the shape was
    already missing — idempotent)."""

    source_id: str
    shape_id: str
    reason: str
    op: Literal["remove"] = "remove"

    def to_dict(self) -> dict[str, Any]:
        return {
            "op": "remove", "source_id": self.source_id,
            "shape_id": self.shape_id, "reason": self.reason,
        }


@dataclass(frozen=True, slots=True)
class NoChangeOperation:
    """Source is in both target state and state file — no operation needed.
    Surfaced in the plan for transparency / debugging diff."""

    source_id: str
    reason: str
    op: Literal["noop"] = "noop"

    def to_dict(self) -> dict[str, Any]:
        return {"op": "noop", "source_id": self.source_id, "reason": self.reason}


Operation = AddOperation | RemoveOperation | NoChangeOperation


@dataclass(frozen=True, slots=True)
class TVSyncPlan:
    """Plan emitted by ``TVPublisher.plan(...)``. Serialised to a plan-file
    by ``--apply``; the executor agent consumes it."""

    plan_version: int
    generated_at: str
    backend: str
    chart_id: str
    zones_json_path: str
    state_path: str
    operations: list[Operation]
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "plan_version": self.plan_version,
            "generated_at": self.generated_at,
            "backend": self.backend,
            "chart_id": self.chart_id,
            "zones_json_path": self.zones_json_path,
            "state_path": self.state_path,
            "operations": [o.to_dict() for o in self.operations],
            "meta": dict(self.meta),
        }

    @property
    def n_add(self) -> int:
        return sum(1 for o in self.operations if isinstance(o, AddOperation))

    @property
    def n_remove(self) -> int:
        return sum(1 for o in self.operations if isinstance(o, RemoveOperation))

    @property
    def n_noop(self) -> int:
        return sum(1 for o in self.operations if isinstance(o, NoChangeOperation))

    def summary_line(self) -> str:
        return (
            f"{self.backend}/{self.chart_id}: "
            f"{self.n_add} add, {self.n_remove} remove, {self.n_noop} noop"
        )


# ---------------------------------------------------------------------------
# State file
# ---------------------------------------------------------------------------


def load_state(path: Path) -> dict[str, str]:
    """Load ``source_id → shape_id`` mapping from the state file.

    Missing file → empty dict (bootstrap case). Malformed file → log
    warning, return empty (treat as bootstrap; safer than crashing).
    """
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        _LOG.warning(
            f"tv_sync state file malformed at {path}: {exc}; treating as empty"
        )
        return {}

    if not isinstance(payload, dict):
        _LOG.warning(f"tv_sync state file not a dict at {path}; treating as empty")
        return {}

    mappings = payload.get("mappings", {})
    if not isinstance(mappings, dict):
        return {}
    # Flatten: support both {source_id: "shape_id"} and {source_id: {"shape_id": ...}}
    out: dict[str, str] = {}
    for k, v in mappings.items():
        if isinstance(v, str):
            out[str(k)] = v
        elif isinstance(v, dict) and "shape_id" in v:
            out[str(k)] = str(v["shape_id"])
    return out


def write_state(
    path: Path,
    *,
    backend: str,
    chart_id: str,
    mappings: dict[str, str],
) -> None:
    """Atomic write via ``.tmp`` + rename. The executor agent uses this
    after performing the plan's operations."""
    payload = {
        "version": _STATE_VERSION,
        "backend": backend,
        "chart_id": chart_id,
        "last_applied_at": datetime.now(UTC).isoformat(),
        "mappings": {
            sid: {"shape_id": shape, "added_at": datetime.now(UTC).isoformat()}
            for sid, shape in mappings.items()
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# Style resolution
# ---------------------------------------------------------------------------


def _style_for_reference_line(ref: ReferenceLine) -> dict[str, Any]:
    return dict(STYLE_BY_SOURCE.get(ref.source, _DEFAULT_REF_STYLE))


def _style_for_zone(zone: Zone) -> dict[str, Any]:
    return dict(STYLE_BY_CONVICTION.get(zone.conviction, STYLE_BY_CONVICTION["LOW"]))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Target:
    """Internal shape: target Add operation spec (pre-classification)."""

    source_id: str
    add_op: AddOperation


def _zones_envelope_to_targets(envelope: dict[str, Any]) -> dict[str, _Target]:
    """Walk a zone-envelope dict; produce {source_id: target_spec}."""
    targets: dict[str, _Target] = {}

    for raw_ref in envelope.get("reference_lines") or []:
        ref = ReferenceLine(
            price=float(raw_ref["price"]),
            text=str(raw_ref["text"]),
            source=str(raw_ref["source"]),
        )
        sid = reference_line_source_id(ref)
        targets[sid] = _Target(
            source_id=sid,
            add_op=AddOperation(
                source_id=sid,
                kind="reference_line",
                label=ref.text,
                price=ref.price,
                style=_style_for_reference_line(ref),
            ),
        )

    for raw_zone in envelope.get("zones") or []:
        zone = Zone(
            id=str(raw_zone["id"]),
            top=float(raw_zone["top"]),
            bot=float(raw_zone["bot"]),
            type=str(raw_zone["type"]),
            conviction=str(raw_zone["conviction"]),
            text=str(raw_zone["text"]),
            sources=list(raw_zone.get("sources") or []),
            volume_pct=raw_zone.get("volume_pct"),
            multi_tf_count=raw_zone.get("multi_tf_count"),
            multi_session_count=raw_zone.get("multi_session_count"),
        )
        sid = zone_source_id(zone)
        targets[sid] = _Target(
            source_id=sid,
            add_op=AddOperation(
                source_id=sid,
                kind="rectangle",
                label=zone.text,
                top=zone.top,
                bot=zone.bot,
                style=_style_for_zone(zone),
            ),
        )

    return targets


def plan_sync(
    *,
    envelope: dict[str, Any],
    state: dict[str, str],
    backend: str,
    chart_id: str,
    zones_json_path: Path,
    state_path: Path,
) -> TVSyncPlan:
    """Compute a sync plan from a zone envelope + current state.

    Args:
        envelope: Parsed zone-envelope dict (validated upstream).
        state: ``source_id → shape_id`` mapping from the state file.
        backend: ``"tv_desktop"`` or ``"tradesea"`` — stamped into plan.
        chart_id: Chart identifier. Stamped into plan + state file.
        zones_json_path: Source path for audit.
        state_path: Destination state-file path the executor will write.

    Returns:
        :class:`TVSyncPlan` containing Add / Remove / NoChange operations.
        Idempotent: same envelope + same state → identical plan.

    Stale-detection: anything in ``state`` whose source_id is NOT in the
    envelope becomes a Remove op. Anything in the envelope whose
    source_id is NOT in ``state`` becomes an Add op. Source IDs present
    in both become NoChange.

    The planner does **not** query the chart — by design. Manual
    user-drawn shapes are invisible to it. The safety contract is that
    ``state`` only contains shapes ``tv_sync`` itself created.
    """
    targets = _zones_envelope_to_targets(envelope)
    target_ids = set(targets.keys())
    state_ids = set(state.keys())

    operations: list[Operation] = []

    # Removes — in state but not in target
    for source_id in sorted(state_ids - target_ids):
        operations.append(
            RemoveOperation(
                source_id=source_id,
                shape_id=state[source_id],
                reason="not present in zones JSON",
            )
        )

    # Adds — in target but not in state
    for source_id in sorted(target_ids - state_ids):
        operations.append(targets[source_id].add_op)

    # NoChange — in both
    for source_id in sorted(target_ids & state_ids):
        operations.append(
            NoChangeOperation(source_id=source_id, reason="already present")
        )

    return TVSyncPlan(
        plan_version=_PLAN_VERSION,
        generated_at=datetime.now(UTC).isoformat(),
        backend=backend,
        chart_id=chart_id,
        zones_json_path=str(zones_json_path),
        state_path=str(state_path),
        operations=operations,
        meta={
            # 2026-05-20 incident reference: ``vr.to`` placed Tradesea
            # labels 8 weeks in future-space (off-screen). Executor must
            # anchor at ``Math.floor(Date.now() / 1000)`` rounded to bar
            # resolution, NOT ``getVisibleRange().to``.
            "time_anchor_hint": "Math.floor(Date.now() / 1000)",
            "createMultipointShape_hint": (
                "Tradesea iframe: use createMultipointShape (no underscore). "
                "_createMultipointShape only persists the first point — "
                "2026-05-20 incident."
            ),
            "iframe_remount_hint": (
                "Tradesea iframe ID changes on chart-state remount. "
                "Re-query iframe[id^='tradingview_'] every operation; "
                "never cache the ID."
            ),
        },
    )


# ---------------------------------------------------------------------------
# Plan file I/O
# ---------------------------------------------------------------------------


def write_plan(plan: TVSyncPlan, plan_path: Path) -> None:
    """Write a plan file. Parent dir created on demand."""
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    plan_path.write_text(json.dumps(plan.to_dict(), indent=2), encoding="utf-8")


def write_latest_pointer(plans_dir: Path, plan_path: Path, backend: str) -> Path:
    """Write ``_latest.json`` in the plans dir pointing at the most recent
    plan. The Claude Code executor session reads this to find the plan
    without globbing — avoids the "which plan file should I execute?"
    ambiguity when multiple targets fire in a single morning.

    Returns the latest-pointer path.
    """
    latest_path = plans_dir / "_latest.json"
    latest_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "backend": backend,
        "plan_path": str(plan_path),
        "generated_at": datetime.now(UTC).isoformat(),
    }
    latest_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return latest_path
