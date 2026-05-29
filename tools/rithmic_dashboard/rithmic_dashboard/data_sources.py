"""Readers for local analytics artifacts and capture tail price."""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from rithmic_dashboard.models import DataWarning, PriceSnapshot
from rithmic_dashboard.session_state import PT

_TAIL_STEPS = (20_000, 100_000, 500_000, 1_000_000)
_STATISTICAL_SOURCE_MARKERS = ("vwap", "sigma", "band")


def load_envelope(
    zones_path: Path,
    *,
    analytics_root: Path,
    symbol: str = "MNQ",
) -> tuple[dict[str, Any] | None, Path | None, list[DataWarning]]:
    """Load the requested zone envelope and overlay same-date statistical lines.

    The dashboard's primary structural source is the selected volume-profile
    envelope. Same-date RTH envelopes can carry VWAP/sigma reference lines that
    combined envelopes omit, so those statistical lines are overlaid when
    available.
    """

    warnings: list[DataWarning] = []
    primary_path = zones_path if zones_path.exists() else None
    mode = "primary"

    if primary_path is None:
        overlay_only = _same_date_rth_path(zones_path)
        if overlay_only.exists():
            primary_path = overlay_only
            mode = "overlay_only"

    zones_dir = analytics_root / "data" / "zones"
    if primary_path is None:
        candidates = sorted(
            zones_dir.glob(f"*_{symbol}_*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not candidates:
            warnings.append(
                DataWarning("fail", f"No zones JSON available for requested session: {zones_path}")
            )
            return None, None, warnings
        primary_path = candidates[0]
        mode = "fallback"

    primary = _read_json_object(primary_path)
    if primary is None:
        return None, primary_path, warnings

    overlay_path = _same_date_rth_path(primary_path)
    overlay = None
    if overlay_path != primary_path and overlay_path.exists():
        overlay = _read_json_object(overlay_path)
        if overlay is None:
            warnings.append(
                DataWarning("warn", f"Could not parse statistical overlay: {overlay_path}")
            )
    elif overlay_path != primary_path:
        # Combined/session envelopes may legitimately be the only finalized
        # source available during an active capture. The source path is still
        # exposed via dashboard_sources; this is not a trader-facing warning.
        pass

    merged = _merge_statistical_reference_lines(
        primary,
        overlay,
        primary_path=primary_path,
        overlay_path=overlay_path if overlay is not None else None,
        mode=mode,
    )
    return merged, primary_path, warnings


def _read_json_object(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _same_date_rth_path(path: Path) -> Path:
    name = path.name
    if "_MNQ_" not in name:
        return path
    date_part = name.split("_MNQ_", 1)[0]
    return path.with_name(f"{date_part}_MNQ_rth.json")


def _merge_statistical_reference_lines(
    primary: dict[str, Any],
    overlay: dict[str, Any] | None,
    *,
    primary_path: Path,
    overlay_path: Path | None,
    mode: str,
) -> dict[str, Any]:
    merged = dict(primary)
    primary_lines = _reference_lines(primary)
    overlay_lines = _reference_lines(overlay or {})
    non_statistical = [line for line in primary_lines if not _is_statistical_line(line)]
    statistical: dict[str, dict[str, Any]] = {
        _line_key(line): line for line in primary_lines if _is_statistical_line(line)
    }
    for line in overlay_lines:
        if _is_statistical_line(line):
            statistical[_line_key(line)] = line

    reference_lines = [*non_statistical, *statistical.values()]
    reference_lines = _ensure_two_sigma_lines(reference_lines)
    merged["reference_lines"] = reference_lines
    merged["dashboard_sources"] = {
        "mode": "merged" if overlay_path is not None else mode,
        "primary_path": str(primary_path),
        "overlay_path": str(overlay_path) if overlay_path is not None else None,
        "statistical_reference_count": len(
            [line for line in reference_lines if _is_statistical_line(line)]
        ),
    }
    return merged


def _reference_lines(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    raw = envelope.get("reference_lines", [])
    if not isinstance(raw, list):
        return []
    return [line for line in raw if isinstance(line, dict)]


def _is_statistical_line(line: dict[str, Any]) -> bool:
    source = str(line.get("source", "")).lower()
    return any(marker in source for marker in _STATISTICAL_SOURCE_MARKERS)


def _line_key(line: dict[str, Any]) -> str:
    return str(line.get("source", "reference"))


def _ensure_two_sigma_lines(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    vwap = _line_price(lines, "vwap_rth")
    plus1 = _line_price(lines, "vwap_rth_band_p1sd")
    minus1 = _line_price(lines, "vwap_rth_band_m1sd")
    if vwap is None:
        return lines
    sigmas = [abs(value - vwap) for value in (plus1, minus1) if value is not None]
    if not sigmas:
        return lines
    sigma = sum(sigmas) / len(sigmas)
    if not math.isfinite(sigma) or sigma <= 0:
        return lines

    existing_sources = {str(line.get("source", "")) for line in lines}
    next_lines = list(lines)
    if "vwap_rth_band_p2sd" not in existing_sources:
        price = vwap + 2.0 * sigma
        next_lines.append(
            {
                "price": price,
                "text": f"VWAP RTH +2σ {price:.2f}",
                "source": "vwap_rth_band_p2sd",
                "derived": True,
            }
        )
    if "vwap_rth_band_m2sd" not in existing_sources:
        price = vwap - 2.0 * sigma
        next_lines.append(
            {
                "price": price,
                "text": f"VWAP RTH -2σ {price:.2f}",
                "source": "vwap_rth_band_m2sd",
                "derived": True,
            }
        )
    return next_lines


def _line_price(lines: list[dict[str, Any]], source: str) -> float | None:
    for line in lines:
        if str(line.get("source", "")) == source:
            try:
                return float(line["price"])
            except (KeyError, TypeError, ValueError):
                return None
    return None


def get_current_price(
    capture_file: Path,
    *,
    fallback_capture_root: Path | None = None,
    last_known_price: float | None = None,
) -> PriceSnapshot:
    """Read the latest trade price from raw capture or normalized trade siblings."""

    warnings: list[DataWarning] = []
    candidates = _price_candidate_files(capture_file)
    if not capture_file.exists():
        warnings.append(DataWarning("warn", f"Capture file missing: {capture_file}"))
        if fallback_capture_root is not None:
            candidates.extend(_latest_capture_candidates(fallback_capture_root))

    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen or not candidate.exists():
            continue
        seen.add(candidate)
        found = _scan_tail_for_price(candidate)
        if found is None:
            continue
        price, ts = found
        return PriceSnapshot(
            price=price,
            source_path=candidate,
            event_time_pt=_event_time_from_ns(ts),
            source=_source_label(candidate),
            warnings=tuple(warnings),
        )

    if last_known_price is not None:
        warnings.append(DataWarning("warn", "No trade print found; using last known price."))
        return PriceSnapshot(
            price=last_known_price,
            source_path=None,
            event_time_pt=None,
            source="state:last_known_price",
            warnings=tuple(warnings),
        )

    warnings.append(DataWarning("fail", "No trade print available; price unavailable."))
    return PriceSnapshot(
        price=None,
        source_path=None,
        event_time_pt=None,
        source="unavailable",
        warnings=tuple(warnings),
    )


def _price_candidate_files(capture_file: Path) -> list[Path]:
    stem = capture_file.name.removesuffix(".jsonl")
    parent = capture_file.parent
    return [
        parent / f"{stem}.obs01.jsonl",
        parent / f"{stem}.mbp1.jsonl",
        capture_file,
    ]


def _latest_capture_candidates(captures_root: Path) -> list[Path]:
    if not captures_root.exists():
        return []
    files = [
        p
        for p in captures_root.glob("*/MNQ_*.jsonl")
        if p.is_file() and ".mbo." not in p.name and ".mbp1." not in p.name
    ]
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)[:8]


def _scan_tail_for_price(path: Path) -> tuple[float, int | None] | None:
    file_size = path.stat().st_size
    for tail_bytes in _TAIL_STEPS:
        chunk = _read_tail_text(path, min(file_size, tail_bytes))
        found = _latest_trade_from_text(chunk)
        if found is not None:
            return found
    return None


def _read_tail_text(path: Path, tail_bytes: int) -> str:
    with path.open("rb") as f:
        f.seek(max(0, path.stat().st_size - tail_bytes))
        return f.read().decode("utf-8", errors="ignore")


def _latest_trade_from_text(text: str) -> tuple[float, int | None] | None:
    last_price: float | None = None
    last_ts: int | None = None
    for raw in text.splitlines():
        if not raw.strip():
            continue
        try:
            rec = json.loads(raw)
        except json.JSONDecodeError:
            continue
        extracted = _extract_trade_price(rec)
        if extracted is None:
            continue
        last_price, last_ts = extracted
    if last_price is None:
        return None
    return last_price, last_ts


def _extract_trade_price(rec: dict[str, Any]) -> tuple[float, int | None] | None:
    stream = rec.get("stream")
    event_type = rec.get("type")
    raw_payload = rec.get("payload")
    payload: dict[str, Any] = raw_payload if isinstance(raw_payload, dict) else {}

    if (
        stream not in {"LAST_TRADE", "TRADE"}
        and event_type != "TRADE"
        and "price" not in rec
        and "price" not in payload
        and ("bid_px_00" not in rec or "ask_px_00" not in rec)
    ):
        return None

    raw_price = rec.get("price", payload.get("price"))
    if raw_price is None:
        bid = rec.get("bid_px_00")
        ask = rec.get("ask_px_00")
        if isinstance(bid, (int, float)) and isinstance(ask, (int, float)):
            raw_price = (float(bid) + float(ask)) / 2.0
        else:
            return None

    raw_ts = (
        rec.get("exchange_event_ts_ns")
        or rec.get("ts_event_ns")
        or rec.get("ts_ns")
        or payload.get("exchange_event_ts_ns")
    )
    try:
        ts = int(raw_ts) if raw_ts is not None else None
        return float(raw_price), ts
    except (TypeError, ValueError):
        return None


def _event_time_from_ns(ts_ns: int | None) -> datetime | None:
    if ts_ns is None:
        return None
    return datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=UTC).astimezone(PT)


def _source_label(path: Path) -> str:
    if path.name.endswith(".obs01.jsonl"):
        return "normalized OBS-01 trade tail"
    if path.name.endswith(".mbp1.jsonl"):
        return "MBP1 midquote tail"
    return "raw capture tail"
