"""Canonical RA-093 feature surface.

RA-094's live feature builder should mirror ``FEATURE_NAMES`` exactly. Missing
values are deliberately encoded as zeros plus quality/category one-hots instead
of changing the vector shape.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

AGGRESSOR_WINDOWS_SECONDS = (60, 300, 900, 3600)
AGGRESSOR_SIDES = ("buy", "sell", "unknown")
FLOW_DIRECTIONS = ("bullish", "bearish", "neutral", "unknown")
ZONE_KINDS = (
    "sigma",
    "vwap",
    "vpoc",
    "vah",
    "val",
    "hvn",
    "lvn",
    "ib",
    "globex",
    "rth",
    "other",
    "unknown",
)
REGIMES = ("LOW", "NORMAL", "HIGH", "UNKNOWN")
QUALITIES = ("live", "inferred", "stale_l1", "unavailable", "unknown")

NUMERIC_FEATURES = (
    "cvd_session_cvd",
    "cvd_last_60m_cvd",
    "cvd_last_15m_cvd",
    "cvd_momentum_flip",
    "v_delta",
    "footprint_imbalance",
    "confluence_stack_size",
    "distance_to_zone_ticks",
    "sigma",
    "atr_14",
    "depth_top3_bid_ratio",
    "depth_total_visible_size",
    "microprice_lean_ticks",
)

FEATURE_NAMES = (
    *NUMERIC_FEATURES,
    *(f"aggressor_{seconds}s_net" for seconds in AGGRESSOR_WINDOWS_SECONDS),
    *(f"aggressor_{seconds}s_ratio" for seconds in AGGRESSOR_WINDOWS_SECONDS),
    *(f"last_trade_aggressor_{side}" for side in AGGRESSOR_SIDES),
    *(f"cvd_session_direction_{direction}" for direction in FLOW_DIRECTIONS),
    *(f"cvd_last_15m_direction_{direction}" for direction in FLOW_DIRECTIONS),
    *(f"zone_kind_{kind}" for kind in ZONE_KINDS),
    *(f"regime_{regime}" for regime in REGIMES),
    *(f"orderflow_quality_{quality}" for quality in QUALITIES),
    *(f"depth_quality_{quality}" for quality in QUALITIES),
)


def build_feature_vector(setup_row: Mapping[str, Any], tick_size: float = 0.25) -> dict[str, float]:
    """Build a stable feature dictionary for one setup-firing row."""

    features = _record(setup_row.get("features"))
    orderflow = _record(setup_row.get("orderflow_snapshot"))
    depth = _record(setup_row.get("depth_snapshot"))
    cvd = _record(orderflow.get("cvd"))
    footprint = _record(orderflow.get("footprint"))
    zone = _record(setup_row.get("zone_context"))

    vector = {name: 0.0 for name in FEATURE_NAMES}
    vector["cvd_session_cvd"] = _float(cvd.get("session_cvd"))
    vector["cvd_last_60m_cvd"] = _float(cvd.get("last_60m_cvd"))
    vector["cvd_last_15m_cvd"] = _float(cvd.get("last_15m_cvd"))
    vector["cvd_momentum_flip"] = 1.0 if bool(cvd.get("momentum_flip")) else 0.0
    vector["v_delta"] = _float(_first_present(orderflow, "v_delta", "vdelta", "v_delta_value"))
    vector["footprint_imbalance"] = _float(
        _first_present(footprint, "imbalance", "imbalance_ratio", "stacked_imbalance")
    )
    vector["confluence_stack_size"] = _float(setup_row.get("confluence_stack_size"))
    vector["distance_to_zone_ticks"] = _float(zone.get("distance_pts")) / tick_size
    vector["sigma"] = _float(_first_present(features, "sigma", "sigma_pts"))
    vector["atr_14"] = _float(_first_present(features, "atr_14", "atr"))

    for window in _list(orderflow.get("aggressor_windows")):
        record = _record(window)
        seconds = _window_seconds(record)
        if seconds in AGGRESSOR_WINDOWS_SECONDS:
            vector[f"aggressor_{seconds}s_net"] = _float(
                _first_present(record, "net", "net_volume")
            )
            vector[f"aggressor_{seconds}s_ratio"] = _float(
                _first_present(record, "ratio", "imbalance_ratio")
            )

    last_trade_aggressor = _category(orderflow.get("last_trade_aggressor"), AGGRESSOR_SIDES)
    vector[f"last_trade_aggressor_{last_trade_aggressor}"] = 1.0

    session_direction = _category(cvd.get("session_direction"), FLOW_DIRECTIONS)
    vector[f"cvd_session_direction_{session_direction}"] = 1.0
    last_15m_direction = _category(cvd.get("last_15m_direction"), FLOW_DIRECTIONS)
    vector[f"cvd_last_15m_direction_{last_15m_direction}"] = 1.0

    zone_kind = _zone_kind(zone.get("kind"))
    vector[f"zone_kind_{zone_kind}"] = 1.0
    regime = _category(setup_row.get("regime"), REGIMES, transform=lambda value: str(value).upper())
    vector[f"regime_{regime}"] = 1.0

    orderflow_quality = _category(_first_present(orderflow, "quality"), QUALITIES)
    vector[f"orderflow_quality_{orderflow_quality}"] = 1.0
    depth_quality = _category(_first_present(depth, "quality"), QUALITIES)
    vector[f"depth_quality_{depth_quality}"] = 1.0

    depth_metrics = _depth_metrics(depth, tick_size=tick_size)
    vector["depth_top3_bid_ratio"] = depth_metrics["top3_bid_ratio"]
    vector["depth_total_visible_size"] = depth_metrics["total_visible_size"]
    vector["microprice_lean_ticks"] = _float(
        _first_present(features, "microprice_start_lean_ticks", "microprice_end_lean_ticks")
    )
    if vector["microprice_lean_ticks"] == 0.0:
        vector["microprice_lean_ticks"] = depth_metrics["microprice_lean_ticks"]

    return vector


def feature_vector_values(setup_row: Mapping[str, Any], tick_size: float = 0.25) -> list[float]:
    vector = build_feature_vector(setup_row, tick_size=tick_size)
    return [vector[name] for name in FEATURE_NAMES]


def feature_metadata() -> dict[str, Any]:
    return {
        "feature_schema_version": 1,
        "feature_names": list(FEATURE_NAMES),
        "aggressor_windows_seconds": list(AGGRESSOR_WINDOWS_SECONDS),
        "zone_kind_categories": list(ZONE_KINDS),
        "regime_categories": list(REGIMES),
        "quality_categories": list(QUALITIES),
        "notes": [
            "CVD, v_delta, footprint, aggressor and quality values are inference-derived.",
            "Missing train-time values encode as zeros plus unknown category one-hots.",
            "RA-094 live feature builder must emit this exact ordered feature list.",
        ],
    }


def _record(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _float(value: Any) -> float:
    try:
        if value is None:
            return 0.0
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _first_present(record: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in record and record[key] is not None:
            return record[key]
    return None


def _category(
    value: Any,
    allowed: tuple[str, ...],
    *,
    transform: Callable[[Any], str] | None = None,
) -> str:
    if value is None:
        return "UNKNOWN" if "UNKNOWN" in allowed else "unknown"
    text = transform(value) if transform is not None else str(value).lower()
    if text in allowed:
        return str(text)
    upper = str(text).upper()
    if upper in allowed:
        return upper
    return "UNKNOWN" if "UNKNOWN" in allowed else "unknown"


def _zone_kind(value: Any) -> str:
    text = str(value or "unknown").lower()
    for kind in ZONE_KINDS:
        if kind != "other" and kind != "unknown" and kind in text:
            return kind
    if text in {"", "none", "unknown"}:
        return "unknown"
    return "other"


def _window_seconds(record: Mapping[str, Any]) -> int | None:
    raw = _first_present(record, "window_seconds", "seconds", "window")
    if isinstance(raw, str):
        text = raw.lower()
        if text.endswith("min"):
            return int(_float(text[:-3]) * 60)
        if text.endswith("m"):
            return int(_float(text[:-1]) * 60)
        if text.endswith("s"):
            return int(_float(text[:-1]))
    value = int(_float(raw))
    return value if value > 0 else None


def _depth_metrics(depth: Mapping[str, Any], tick_size: float) -> dict[str, float]:
    bids = [_record(level) for level in _list(depth.get("bid_levels"))]
    asks = [_record(level) for level in _list(depth.get("ask_levels"))]
    top_bid = sum(_float(level.get("size")) for level in bids[:3])
    top_ask = sum(_float(level.get("size")) for level in asks[:3])
    total_bid = sum(_float(level.get("size")) for level in bids)
    total_ask = sum(_float(level.get("size")) for level in asks)
    ratio = top_bid / (top_bid + top_ask) if top_bid + top_ask > 0 else 0.0
    lean = _microprice_lean_ticks(depth, tick_size)
    return {
        "top3_bid_ratio": ratio,
        "total_visible_size": total_bid + total_ask,
        "microprice_lean_ticks": lean,
    }


def _microprice_lean_ticks(depth: Mapping[str, Any], tick_size: float) -> float:
    mid = _float(depth.get("mid"))
    bids = [_record(level) for level in _list(depth.get("bid_levels"))]
    asks = [_record(level) for level in _list(depth.get("ask_levels"))]
    if not bids or not asks or mid <= 0.0 or tick_size <= 0:
        return 0.0
    best_bid = bids[0]
    best_ask = asks[0]
    bid_price = _float(best_bid.get("price"))
    ask_price = _float(best_ask.get("price"))
    bid_size = _float(best_bid.get("size"))
    ask_size = _float(best_ask.get("size"))
    if bid_price <= 0.0 or ask_price <= 0.0 or bid_size + ask_size <= 0.0:
        return 0.0
    microprice = (ask_price * bid_size + bid_price * ask_size) / (bid_size + ask_size)
    return (microprice - mid) / tick_size
