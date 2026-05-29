"""Canonical zone JSON envelope schema.

This module defines the **wire format** that all downstream tooling consumes —
chart-drawing pipelines, the future RA-020 retrofit of Neel's ``vp_*.py``
scripts, and the daily HTML reports. The on-disk JSON Schema spec is
``zone_schema.json`` (same directory); ``validate_envelope()`` is the callable
counterpart.

Schema versioning discipline:
    - Bump ``schema_version`` on any incompatible change (renamed key,
      removed key, type change).
    - Adding a new optional field with a default → no bump.
    - Migration code for older versions belongs in a future ``_migrations.py``
      module — do not write speculative migration shims before a real v2 exists.

Phase 1 zone construction:
    - HVNs from a ``VolumeProfile`` become ``Zone`` objects, typed ``support``
      by default (HVN levels act as support on retest from above and resistance
      on retest from below; downstream tooling can refine).
    - VPOC, VAH, VAL each become reference lines.
    - LVNs become reference lines tagged ``lvn_<timeframe>``.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from importlib import resources
from typing import Any

import jsonschema

from rithmic_analytics.features.volume_profile import VolumeProfile

SCHEMA_VERSION: int = 1

_VALID_TIMEFRAMES_FOR_HVN: frozenset[str] = frozenset(
    {
        # Bar-based timeframes
        "1m", "3m", "5m", "10m", "15m", "30m",
        "1h", "2h", "4h", "1d", "1w",
        # Session-based "timeframes" (used by Phase 1 builder + RA-010)
        "rth", "globex",
        # Multi-session aggregation (RA-021)
        "multi",
    }
)


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Zone:
    """A horizontal zone (price band) with conviction grading.

    Attributes:
        id: Deterministic identifier (e.g. ``"hvn-27380"``).
        top: Upper price edge of the band.
        bot: Lower price edge of the band.
        type: ``"support"`` or ``"resistance"``. **Phase-1 builders emit
            ``"support"`` regardless of price location** because the single-TF
            VP builder has no current-price context to disambiguate. Consumers
            with live-price context (chart rendering, real-time alerts)
            should reassign based on ``current_price ≷ zone.top``. See
            ``docs/feature_reference.md`` → "Phase-1 zone type resolution".
        conviction: ``"SUPER"`` / ``"HIGH"`` / ``"MED"`` / ``"LOW"`` — see
            :func:`grade_zone` for the rules.
        text: Short label for chart rendering.
        sources: Provenance tags (e.g. ``["hvn_5m", "weekly_avwap_band"]``).
        volume_pct: Fraction of session volume (HVN only); ``None`` for non-VP
            zones.
        multi_tf_count: Number of distinct timeframes where this zone appears
            (populated by RA-021 multi-session aggregator); ``None`` in Phase 1.
    """

    id: str
    top: float
    bot: float
    type: str
    conviction: str
    text: str
    sources: list[str]
    volume_pct: float | None = None
    multi_tf_count: int | None = None
    multi_session_count: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "top": self.top,
            "bot": self.bot,
            "type": self.type,
            "conviction": self.conviction,
            "text": self.text,
            "sources": list(self.sources),
            "volume_pct": self.volume_pct,
            "multi_tf_count": self.multi_tf_count,
            "multi_session_count": self.multi_session_count,
        }


@dataclass(frozen=True, slots=True)
class ReferenceLine:
    """A horizontal reference line at a single price level.

    Attributes:
        price: Y-axis location.
        text: Short label.
        source: Provenance tag (e.g. ``"vpoc"``, ``"lvn_5m"``).
    """

    price: float
    text: str
    source: str

    def to_dict(self) -> dict[str, Any]:
        return {"price": self.price, "text": self.text, "source": self.source}


@dataclass(frozen=True, slots=True)
class ZoneEnvelope:
    """Top-level zone JSON envelope. Maps 1:1 to ``zone_schema.json``.

    See module docstring for the schema-versioning discipline.

    Attributes:
        schema_version: Bump on incompatible change.
        symbol: Root symbol (NOT the front-month contract).
        timeframe: Free-form label: ``"rth"``, ``"globex"``, ``"5m"``, etc.
        bars_used: Source-bar count that fed the computation.
        computed_at: ISO-8601 UTC timestamp.
        data_source: ``"rithmic"`` or ``"tradingview"``.
        vpoc / vah / val / atr_14: May be NaN if input was empty; NaN serializes
            to JSON ``null``. Specifically, ``atr_14`` is NaN whenever the
            input has fewer than 14 complete bars at the chosen
            ``bar_size_ns`` — a real wire-format value, not a test edge case.
            Downstream consumers must check ``envelope.atr_14 is None``
            before using it for stop-distance or zone-width scaling.
        bin_size_ticks: Bin width in ticks.
        zones: Conviction-graded support/resistance bands.
        reference_lines: Single-price markers (VPOC, VAH, VAL, LVNs, etc.).
    """

    schema_version: int
    symbol: str
    timeframe: str
    bars_used: int
    computed_at: str
    data_source: str
    vpoc: float
    vah: float
    val: float
    atr_14: float
    bin_size_ticks: int
    zones: list[Zone] = field(default_factory=list)
    reference_lines: list[ReferenceLine] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "bars_used": self.bars_used,
            "computed_at": self.computed_at,
            "data_source": self.data_source,
            "vpoc": _nan_to_none(self.vpoc),
            "vah": _nan_to_none(self.vah),
            "val": _nan_to_none(self.val),
            "atr_14": _nan_to_none(self.atr_14),
            "bin_size_ticks": self.bin_size_ticks,
            "zones": [z.to_dict() for z in self.zones],
            "reference_lines": [r.to_dict() for r in self.reference_lines],
        }

    def to_json(self, *, indent: int | None = 2) -> str:
        """Serialize to JSON string. NaN → ``null`` (strict JSON, no NaN tokens)."""
        return json.dumps(self.to_dict(), indent=indent, allow_nan=False, sort_keys=False)

    def summary_line(self) -> str:
        """Single-line human-readable digest. Used by RA-006 CLI for stdout."""
        n_hvn = sum(1 for z in self.zones if any(s.startswith("hvn") for s in z.sources))
        n_lvn = sum(1 for r in self.reference_lines if r.source.startswith("lvn"))
        return (
            f"{self.symbol} {self.timeframe} · {self.computed_at} · "
            f"VPOC={self.vpoc:.2f} VAH={self.vah:.2f} VAL={self.val:.2f} · "
            f"{n_hvn} HVNs, {n_lvn} LVNs · ATR14={self.atr_14:.1f}"
        )

    @classmethod
    def from_volume_profile(
        cls,
        vp: VolumeProfile,
        *,
        symbol: str,
        timeframe: str,
        atr_14: float,
        data_source: str,
        bin_size_ticks: int,
        bars_used: int = 0,
        computed_at: str | None = None,
    ) -> ZoneEnvelope:
        """Build a Phase 1 envelope from a ``VolumeProfile``.

        Args:
            vp: Output of :func:`compute_vp`.
            symbol: Root symbol (e.g. ``"MNQ"``).
            timeframe: Label used as the HVN source-tag suffix (e.g. ``"5m"``
                → HVN sources become ``"hvn_5m"``).
            atr_14: Average True Range over 14 periods. NaN OK.
            data_source: ``"rithmic"`` or ``"tradingview"``.
            bin_size_ticks: Bin width in ticks (mirror the value passed to
                ``compute_vp`` — avoids re-deriving from ``vp.bin_size``).
            bars_used: Optional source-bar count.
            computed_at: Optional override of the ISO timestamp; defaults to
                ``datetime.now(UTC).isoformat()``.

        Returns:
            ``ZoneEnvelope`` populated with HVN→zone and VPOC/VAH/VAL/LVN→
            reference_line mappings.
        """
        if computed_at is None:
            computed_at = datetime.now(UTC).isoformat()

        zones: list[Zone] = []
        for h in vp.hvn_list:
            sources = [f"hvn_{timeframe}"]
            zones.append(
                Zone(
                    id=f"hvn-{_format_bin_id(h.price_low)}",
                    top=h.price_high,
                    bot=h.price_low,
                    type="support",
                    conviction=grade_zone(sources),
                    text=f"HVN {h.volume_pct:.1%}",
                    sources=sources,
                    volume_pct=h.volume_pct,
                )
            )

        refs: list[ReferenceLine] = []
        if not math.isnan(vp.vpoc):
            refs.append(ReferenceLine(price=vp.vpoc, text=f"VPOC {vp.vpoc:g}", source="vpoc"))
        if not math.isnan(vp.vah):
            refs.append(ReferenceLine(price=vp.vah, text=f"VAH {vp.vah:g}", source="vah"))
        if not math.isnan(vp.val):
            refs.append(ReferenceLine(price=vp.val, text=f"VAL {vp.val:g}", source="val"))
        for lvn in vp.lvn_list:
            refs.append(
                ReferenceLine(
                    price=lvn.price_low,
                    text=f"LVN {lvn.volume}",
                    source=f"lvn_{timeframe}",
                )
            )

        return cls(
            schema_version=SCHEMA_VERSION,
            symbol=symbol,
            timeframe=timeframe,
            bars_used=bars_used,
            computed_at=computed_at,
            data_source=data_source,
            vpoc=vp.vpoc,
            vah=vp.vah,
            val=vp.val,
            atr_14=atr_14,
            bin_size_ticks=bin_size_ticks,
            zones=zones,
            reference_lines=refs,
        )


# ---------------------------------------------------------------------------
# Helpers (module-private)
# ---------------------------------------------------------------------------


def _nan_to_none(x: float) -> float | None:
    """NaN → None for JSON. Anything else passes through."""
    return None if math.isnan(x) else x


def _format_bin_id(bin_low: float) -> str:
    """Format a bin lower edge as a clean string for use in zone IDs.

    Integers drop the trailing ``.0``; non-integers keep their precision but
    strip trailing zeros.

    >>> _format_bin_id(27380.0)
    '27380'
    >>> _format_bin_id(27380.25)
    '27380.25'
    >>> _format_bin_id(27380.50)
    '27380.5'
    """
    if bin_low.is_integer():
        return str(int(bin_low))
    return f"{bin_low}".rstrip("0").rstrip(".")


# ---------------------------------------------------------------------------
# Conviction grader
# ---------------------------------------------------------------------------


def grade_zone(sources: list[str]) -> str:
    """Grade a zone's conviction based on its source tags.

    Rules (in priority order):
        - **SUPER**: ≥4 *distinct* HVN timeframes. The check is on the set of
          TF suffixes, not the list length — four ``hvn_5m`` entries grade MED.
        - **HIGH**: ≥1 HVN + ≥1 statistical band (any ``*avwap*`` or ``*_band``)
          + ≥1 structural (``ema*`` or ``swing_*``).
        - **MED**: any single HVN, OR statistical band alone, OR ``vah``/``val``.
        - **LOW**: only EMA / round-number / swing sources without HVN or band,
          and empty source lists.

    Malformed source strings (e.g. ``"hvn_"`` with no TF) are silently skipped —
    they don't contribute to any category.

    Args:
        sources: Provenance tags attached to a zone.

    Returns:
        One of ``"SUPER"``, ``"HIGH"``, ``"MED"``, ``"LOW"``.

    Example:
        >>> grade_zone(["hvn_1m", "hvn_5m", "hvn_15m", "hvn_1h"])
        'SUPER'
        >>> grade_zone(["hvn_5m", "weekly_avwap_band", "ema50"])
        'HIGH'
        >>> grade_zone(["weekly_avwap_band"])
        'MED'
        >>> grade_zone(["ema50", "round_27500"])
        'LOW'
    """
    hvn_tfs: set[str] = set()
    has_band = False
    has_structural = False
    has_va = False

    for s in sources:
        if s.startswith("hvn_"):
            tf = s.removeprefix("hvn_")
            if tf in _VALID_TIMEFRAMES_FOR_HVN:
                hvn_tfs.add(tf)
            # Malformed (e.g. "hvn_" or "hvn_garbage") is silently ignored.
        elif "avwap" in s or "_band" in s:
            # RA-031 extension: VWAP σ-bands carry ``_band`` as a middle
            # segment (e.g. ``vwap_rth_band_p1sd``), so substring match
            # rather than endswith. AVWAP / *_band suffix sources keep
            # matching too.
            has_band = True
        elif s.startswith(("ema", "swing_")):
            has_structural = True
        elif s in ("vah", "val"):
            has_va = True
        # Anything else (e.g. round_27500, foobar) doesn't move the needle on
        # MED/HIGH/SUPER. It only blocks LOW if HVN/band/VA are also absent —
        # see fall-through below.

    has_hvn = len(hvn_tfs) > 0

    if len(hvn_tfs) >= 4:
        return "SUPER"
    if has_hvn and has_band and has_structural:
        return "HIGH"
    if has_hvn or has_band or has_va:
        return "MED"
    return "LOW"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def _load_schema() -> dict[str, Any]:
    """Load and cache the on-disk JSON Schema spec."""
    schema_text = (
        resources.files("rithmic_analytics.core").joinpath("zone_schema.json").read_text()
    )
    schema: dict[str, Any] = json.loads(schema_text)
    return schema


def validate_envelope(payload: dict[str, Any]) -> None:
    """Validate a zone-envelope dict against the on-disk JSON Schema.

    Used by RA-006 (CLI) to verify output before write, by RA-020 (retrofit) to
    verify Neel's scripts' new JSON output, and in tests for round-trip checks.

    Args:
        payload: Dict-shaped envelope (typically ``ZoneEnvelope.to_dict()`` or
            the result of ``json.loads(...)`` on a zone JSON file).

    Raises:
        jsonschema.ValidationError: If ``payload`` violates ``zone_schema.json``.
    """
    schema = _load_schema()
    jsonschema.validate(instance=payload, schema=schema)
