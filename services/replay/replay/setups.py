"""RA-092 scalping setup taxonomy derived from detector-firing rows.

The setup dataset is intentionally derived from the Python detector-firing
dataset, not TypeScript logic. That keeps the detector stack single-source of
truth for live and replay. The one exception-like primitive is microprice:
RA-092 computes a replay-local approximation from each row's bounded
``depth_snapshot``. Live ``LiveSignals`` does not yet expose microprice; wiring
that into live emission is a follow-up ticket, not part of this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from replay.canonical import canonical_json, sha256_file, sha256_text
from replay.dataset import ReplayContext, SignalDatasetRow, ZoneContext

ScalpSetupType = Literal[
    "zone_rejection",
    "sweep_absorption",
    "iceberg_hold",
    "cvd_flip_at_zone",
    "microprice_flip_zone",
]
SetupDirection = Literal["long", "short"]


@dataclass(frozen=True)
class SetupDerivationConfig:
    """Thresholds for deriving setup firings from raw detector firings."""

    min_zone_confluence: int = 2
    sweep_absorption_window_seconds: float = 10.0
    price_match_tolerance_pts: float = 2.0
    microprice_epsilon_ticks: float = 0.5
    microprice_persistence_seconds: float = 2.0
    tick_size: float = 0.25


class SetupSignalRef(BaseModel):
    """One source detector row used to derive a setup row."""

    model_config = ConfigDict(extra="forbid")

    signal_id: str
    ts_ns: int
    family: str
    event_type: str
    price: float | None = None
    level_id: str | None = None
    tier: str | None = None


class SetupDatasetRow(BaseModel):
    """One derived setup firing for RA-093+ model training."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = 1
    ts_ns: int
    setup_type: ScalpSetupType
    direction: SetupDirection
    price: float | None = None
    level_id: str | None = None
    zone_context: ZoneContext | None = None
    regime: str | None = None
    confluence_stack_size: int = Field(ge=1)
    source_signals: list[SetupSignalRef]
    features: dict[str, Any]
    replay: ReplayContext


class SetupDatasetManifest(BaseModel):
    """Sidecar manifest for setup-firing datasets."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = 1
    setup_schema_version: int = 1
    capture_date: str
    session: str
    source_dataset_path: str
    source_dataset_sha256: str | None
    source_row_count: int
    row_count: int
    setup_dataset_sha256: str
    settings: dict[str, Any]


@dataclass(frozen=True)
class SetupDatasetResult:
    """Resolved setup dataset output paths and hash metadata."""

    out_path: Path
    manifest_path: Path
    row_count: int
    dataset_sha256: str


def derive_setup_rows(
    signal_rows: list[SignalDatasetRow],
    config: SetupDerivationConfig | None = None,
) -> list[SetupDatasetRow]:
    """Derive the five RA-092 setup types from detector-firing rows."""

    cfg = config or SetupDerivationConfig()
    rows = sorted(signal_rows, key=lambda row: (row.ts_ns, row.family, row.event_type))
    setup_rows: list[SetupDatasetRow] = []
    setup_rows.extend(_zone_rejections(rows, cfg))
    setup_rows.extend(_sweep_absorptions(rows, cfg))
    setup_rows.extend(_iceberg_holds(rows, cfg))
    setup_rows.extend(_cvd_flips(rows, cfg))
    setup_rows.extend(_microprice_flips(rows, cfg))
    setup_rows.sort(
        key=lambda row: (
            row.ts_ns,
            row.setup_type,
            row.level_id or "",
            row.price if row.price is not None else -1.0,
        )
    )
    return _dedupe(setup_rows)


def setup_dataset_text(setup_rows: list[SetupDatasetRow]) -> str:
    """Return canonical JSONL for setup rows."""

    return "".join(canonical_json(row.model_dump(mode="json")) + "\n" for row in setup_rows)


def write_setup_dataset(
    *,
    signal_rows: list[SignalDatasetRow],
    out_path: Path,
    source_dataset_path: Path,
    config: SetupDerivationConfig | None = None,
) -> SetupDatasetResult:
    """Write setup-firing JSONL plus deterministic manifest."""

    cfg = config or SetupDerivationConfig()
    setup_rows = derive_setup_rows(signal_rows, cfg)
    text = setup_dataset_text(setup_rows)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8")
    dataset_hash = sha256_text(text)
    manifest = _manifest(
        signal_rows=signal_rows,
        out_hash=dataset_hash,
        out_row_count=len(setup_rows),
        source_dataset_path=source_dataset_path,
        config=cfg,
    )
    manifest_path = out_path.with_suffix(out_path.suffix + ".manifest.json")
    manifest_path.write_text(
        canonical_json(manifest.model_dump(mode="json")) + "\n",
        encoding="utf-8",
    )
    return SetupDatasetResult(
        out_path=out_path,
        manifest_path=manifest_path,
        row_count=len(setup_rows),
        dataset_sha256=dataset_hash,
    )


def read_signal_dataset(path: Path) -> list[SignalDatasetRow]:
    """Load a detector-firing dataset emitted by RA-090a."""

    rows: list[SignalDatasetRow] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rows.append(SignalDatasetRow.model_validate_json(line))
    return rows


def write_setup_dataset_from_signal_dataset(
    *,
    signal_dataset_path: Path,
    out_path: Path,
    config: SetupDerivationConfig | None = None,
) -> SetupDatasetResult:
    """Load an RA-090a dataset and write the RA-092 derived setup dataset."""

    return write_setup_dataset(
        signal_rows=read_signal_dataset(signal_dataset_path),
        out_path=out_path,
        source_dataset_path=signal_dataset_path,
        config=config,
    )


def _zone_rejections(
    rows: list[SignalDatasetRow],
    cfg: SetupDerivationConfig,
) -> list[SetupDatasetRow]:
    output: list[SetupDatasetRow] = []
    for row in rows:
        direction = _direction(row)
        if direction is None or not _is_high_confluence_zone_signal(row, cfg):
            continue
        footprint_side = _nested_str(row.orderflow_snapshot, "footprint", "stacked_side")
        if not _footprint_opposes(direction, footprint_side):
            continue
        output.append(
            _setup_row(
                setup_type="zone_rejection",
                direction=direction,
                rows=[row],
                features={
                    "footprint_stacked_side": footprint_side,
                    "rule": "HIGH/CRITICAL high-confluence zone signal with opposite footprint",
                },
            )
        )
    return output


def _sweep_absorptions(
    rows: list[SignalDatasetRow],
    cfg: SetupDerivationConfig,
) -> list[SetupDatasetRow]:
    sweeps = [row for row in rows if row.family == "sweep"]
    absorptions = [row for row in rows if row.family == "absorption"]
    output: list[SetupDatasetRow] = []
    window_ns = int(cfg.sweep_absorption_window_seconds * 1_000_000_000)
    for sweep in sweeps:
        for absorption in absorptions:
            if absorption.ts_ns <= sweep.ts_ns:
                continue
            delta_ns = absorption.ts_ns - sweep.ts_ns
            if delta_ns > window_ns:
                break
            if not _same_level_or_price(sweep, absorption, cfg.price_match_tolerance_pts):
                continue
            direction = _direction(absorption) or _direction(sweep)
            if direction is None:
                continue
            output.append(
                _setup_row(
                    setup_type="sweep_absorption",
                    direction=direction,
                    rows=[sweep, absorption],
                    features={
                        "sweep_to_absorption_seconds": round(delta_ns / 1_000_000_000, 3),
                        "rule": "sweep immediately followed by absorption at the cleared level",
                    },
                )
            )
            break
    return output


def _iceberg_holds(
    rows: list[SignalDatasetRow],
    cfg: SetupDerivationConfig,
) -> list[SetupDatasetRow]:
    output: list[SetupDatasetRow] = []
    for row in rows:
        if row.family != "iceberg" or not _has_zone_confluence(row, cfg):
            continue
        direction = _direction(row)
        if direction is None:
            continue
        output.append(
            _setup_row(
                setup_type="iceberg_hold",
                direction=direction,
                rows=[row],
                features={"rule": "iceberg detected at a high-confluence zone"},
            )
        )
    return output


def _cvd_flips(
    rows: list[SignalDatasetRow],
    cfg: SetupDerivationConfig,
) -> list[SetupDatasetRow]:
    output: list[SetupDatasetRow] = []
    for row in rows:
        if row.zone_context is None:
            continue
        cvd = _nested_dict(row.orderflow_snapshot, "cvd")
        if not bool(cvd.get("momentum_flip")):
            continue
        direction = _flow_direction(cvd.get("last_15m_direction"))
        if direction is None:
            continue
        output.append(
            _setup_row(
                setup_type="cvd_flip_at_zone",
                direction=direction,
                rows=[row],
                features={
                    "session_direction": cvd.get("session_direction"),
                    "last_15m_direction": cvd.get("last_15m_direction"),
                    "session_cvd": cvd.get("session_cvd"),
                    "last_15m_cvd": cvd.get("last_15m_cvd"),
                    "rule": "CVD momentum flip while price is near a zone",
                },
            )
        )
    return output


def _microprice_flips(
    rows: list[SignalDatasetRow],
    cfg: SetupDerivationConfig,
) -> list[SetupDatasetRow]:
    output: list[SetupDatasetRow] = []
    starts: dict[tuple[str, str], tuple[int, SignalDatasetRow, float]] = {}
    required_ns = int(cfg.microprice_persistence_seconds * 1_000_000_000)
    for row in rows:
        if row.zone_context is None:
            continue
        lean = _microprice_lean_ticks(row.depth_snapshot, cfg.tick_size)
        direction: SetupDirection | None = None
        if lean >= cfg.microprice_epsilon_ticks:
            direction = "long"
        elif lean <= -cfg.microprice_epsilon_ticks:
            direction = "short"
        if direction is None:
            _clear_microprice_streaks(starts, row)
            continue

        zone_id = row.zone_context.id
        key = (zone_id, direction)
        start = starts.get(key)
        if start is None:
            starts[key] = (row.ts_ns, row, lean)
            continue
        start_ts, start_row, start_lean = start
        if row.ts_ns - start_ts < required_ns:
            continue
        output.append(
            _setup_row(
                setup_type="microprice_flip_zone",
                direction=direction,
                rows=[start_row, row],
                features={
                    "microprice_start_lean_ticks": round(start_lean, 4),
                    "microprice_end_lean_ticks": round(lean, 4),
                    "persistence_seconds": round((row.ts_ns - start_ts) / 1_000_000_000, 3),
                    "epsilon_ticks": cfg.microprice_epsilon_ticks,
                    "rule": "replay-local microprice lean persisted at a zone",
                    "live_microprice_followup_required": True,
                },
            )
        )
        starts[key] = (row.ts_ns, row, lean)
    return output


def _clear_microprice_streaks(
    starts: dict[tuple[str, str], tuple[int, SignalDatasetRow, float]],
    row: SignalDatasetRow,
) -> None:
    if row.zone_context is None:
        return
    starts.pop((row.zone_context.id, "long"), None)
    starts.pop((row.zone_context.id, "short"), None)


def _setup_row(
    *,
    setup_type: ScalpSetupType,
    direction: SetupDirection,
    rows: list[SignalDatasetRow],
    features: dict[str, Any],
) -> SetupDatasetRow:
    source_rows = sorted(rows, key=lambda row: (row.ts_ns, row.family, row.event_type))
    anchor = source_rows[-1]
    zone = next((row.zone_context for row in reversed(source_rows) if row.zone_context), None)
    price = next((row.price for row in reversed(source_rows) if row.price is not None), None)
    level_id = next((row.level_id for row in reversed(source_rows) if row.level_id), None)
    confluence = max(row.confluence_stack_size for row in source_rows)
    try:
        return SetupDatasetRow(
            ts_ns=anchor.ts_ns,
            setup_type=setup_type,
            direction=direction,
            price=price,
            level_id=level_id,
            zone_context=zone,
            regime=anchor.regime,
            confluence_stack_size=confluence,
            source_signals=[
                SetupSignalRef(
                    signal_id=_signal_id(row),
                    ts_ns=row.ts_ns,
                    family=row.family,
                    event_type=row.event_type,
                    price=row.price,
                    level_id=row.level_id,
                    tier=row.tier,
                )
                for row in source_rows
            ],
            features=features,
            replay=anchor.replay,
        )
    except ValidationError as exc:
        raise ValueError(f"Invalid setup dataset row for {setup_type}") from exc


def _is_high_confluence_zone_signal(
    row: SignalDatasetRow,
    cfg: SetupDerivationConfig,
) -> bool:
    return (
        row.tier in {"HIGH", "CRITICAL"}
        and row.zone_context is not None
        and row.confluence_stack_size >= cfg.min_zone_confluence
    )


def _has_zone_confluence(row: SignalDatasetRow, cfg: SetupDerivationConfig) -> bool:
    return row.zone_context is not None and row.confluence_stack_size >= cfg.min_zone_confluence


def _same_level_or_price(
    left: SignalDatasetRow,
    right: SignalDatasetRow,
    tolerance_pts: float,
) -> bool:
    if left.level_id is not None and right.level_id is not None and left.level_id == right.level_id:
        return True
    if left.price is None or right.price is None:
        return False
    return abs(left.price - right.price) <= tolerance_pts


def _direction(row: SignalDatasetRow) -> SetupDirection | None:
    text = " ".join(part for part in (row.direction, row.side) if part).lower()
    if "neutral" in text or "mixed" in text:
        return None
    if "buy_absorbed" in text:
        return "short"
    if "sell_absorbed" in text:
        return "long"
    if any(token in text for token in ("long", "bull", "up", "buy", "bid")):
        return "long"
    if any(token in text for token in ("short", "bear", "down", "sell", "ask")):
        return "short"
    return None


def _flow_direction(value: Any) -> SetupDirection | None:
    text = str(value or "").lower()
    if text == "bullish":
        return "long"
    if text == "bearish":
        return "short"
    return None


def _footprint_opposes(direction: SetupDirection, footprint_side: str | None) -> bool:
    if direction == "long":
        return footprint_side == "sell"
    return footprint_side == "buy"


def _nested_dict(value: Any, *keys: str) -> dict[str, Any]:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return {}
        current = current.get(key)
    return current if isinstance(current, dict) else {}


def _nested_str(value: Any, *keys: str) -> str | None:
    current: Any = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return str(current).lower() if current is not None else None


def _microprice_lean_ticks(depth_snapshot: Any, tick_size: float) -> float:
    if not isinstance(depth_snapshot, dict):
        return 0.0
    mid = _float(depth_snapshot.get("mid"))
    bids = depth_snapshot.get("bid_levels")
    asks = depth_snapshot.get("ask_levels")
    if mid is None or not isinstance(bids, list) or not isinstance(asks, list):
        return 0.0
    best_bid = bids[0] if bids and isinstance(bids[0], dict) else None
    best_ask = asks[0] if asks and isinstance(asks[0], dict) else None
    if best_bid is None or best_ask is None:
        return 0.0
    bid_price = _float(best_bid.get("price"))
    ask_price = _float(best_ask.get("price"))
    bid_size = _float(best_bid.get("size"))
    ask_size = _float(best_ask.get("size"))
    if (
        bid_price is None
        or ask_price is None
        or bid_size is None
        or ask_size is None
        or bid_size + ask_size <= 0
        or tick_size <= 0
    ):
        return 0.0
    microprice = (ask_price * bid_size + bid_price * ask_size) / (bid_size + ask_size)
    return (microprice - mid) / tick_size


def _float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _signal_id(row: SignalDatasetRow) -> str:
    return "|".join(
        [
            row.replay.capture_date,
            row.replay.session,
            str(row.ts_ns),
            row.family,
            row.event_type,
            row.level_id or "no-level",
            f"{row.price:.2f}" if row.price is not None else "no-price",
        ]
    )


def _dedupe(rows: list[SetupDatasetRow]) -> list[SetupDatasetRow]:
    seen: set[tuple[Any, ...]] = set()
    output: list[SetupDatasetRow] = []
    for row in rows:
        key = (
            row.setup_type,
            row.ts_ns,
            row.direction,
            row.level_id,
            round(row.price, 2) if row.price is not None else None,
            tuple(signal.signal_id for signal in row.source_signals),
        )
        if key in seen:
            continue
        seen.add(key)
        output.append(row)
    return output


def _manifest(
    *,
    signal_rows: list[SignalDatasetRow],
    out_hash: str,
    out_row_count: int,
    source_dataset_path: Path,
    config: SetupDerivationConfig,
) -> SetupDatasetManifest:
    capture_date = signal_rows[0].replay.capture_date if signal_rows else "unknown"
    session = signal_rows[0].replay.session if signal_rows else "unknown"
    return SetupDatasetManifest(
        capture_date=capture_date,
        session=session,
        source_dataset_path=str(source_dataset_path),
        source_dataset_sha256=sha256_file(source_dataset_path),
        source_row_count=len(signal_rows),
        row_count=out_row_count,
        setup_dataset_sha256=out_hash,
        settings={
            "min_zone_confluence": config.min_zone_confluence,
            "sweep_absorption_window_seconds": config.sweep_absorption_window_seconds,
            "price_match_tolerance_pts": config.price_match_tolerance_pts,
            "microprice_epsilon_ticks": config.microprice_epsilon_ticks,
            "microprice_persistence_seconds": config.microprice_persistence_seconds,
            "tick_size": config.tick_size,
            "live_microprice_followup_required": True,
        },
    )


__all__ = [
    "ScalpSetupType",
    "SetupDatasetManifest",
    "SetupDatasetResult",
    "SetupDatasetRow",
    "SetupDerivationConfig",
    "SetupDirection",
    "SetupSignalRef",
    "derive_setup_rows",
    "read_signal_dataset",
    "setup_dataset_text",
    "write_setup_dataset",
    "write_setup_dataset_from_signal_dataset",
]
