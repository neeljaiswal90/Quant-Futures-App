"""Join RA-092 setup firings to RA-091 forward-return labels."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from scalp_models.features import build_feature_vector

SetupType = Literal[
    "zone_rejection",
    "sweep_absorption",
    "iceberg_hold",
    "cvd_flip_at_zone",
    "microprice_flip_zone",
]
Direction = Literal["long", "short"]
LabelStatus = Literal[
    "ok",
    "no_trades_in_horizon",
    "no_post_signal_trade",
    "neutral_direction",
    "tape_eof_before_horizon",
    "invalid_signal",
    "missing_label",
]

HORIZONS_SECONDS = (1, 5, 15, 60, 300)
SETUP_TYPES: tuple[SetupType, ...] = (
    "zone_rejection",
    "sweep_absorption",
    "iceberg_hold",
    "cvd_flip_at_zone",
    "microprice_flip_zone",
)


class TrainingExample(BaseModel):
    """One eligible model-training observation for a setup/horizon cell."""

    model_config = ConfigDict(extra="forbid")

    setup_type: SetupType
    horizon_seconds: int
    ts_ns: int
    session_key: str
    direction: Direction
    label: int = Field(ge=0, le=1)
    target_ticks: float
    realized_mfe_ticks: float
    feature_values: dict[str, float]
    setup_row: dict[str, Any]


@dataclass(frozen=True)
class DatasetBuildResult:
    examples: list[TrainingExample]
    exclusion_counts: dict[str, int]
    setup_row_count: int
    label_row_count: int


@dataclass(frozen=True)
class DatasetConfig:
    target_ticks: float = 4.0
    target_ticks_by_setup: Mapping[str, float] | None = None
    tick_size: float = 0.25
    horizons_seconds: tuple[int, ...] = HORIZONS_SECONDS

    def target_for_setup(self, setup_type: str) -> float:
        if self.target_ticks_by_setup and setup_type in self.target_ticks_by_setup:
            return float(self.target_ticks_by_setup[setup_type])
        return self.target_ticks


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        raise FileNotFoundError(path)
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        parsed = json.loads(line)
        if not isinstance(parsed, dict):
            raise ValueError(f"{path}:{line_number} is not a JSON object")
        rows.append(parsed)
    return rows


def build_training_examples(
    *,
    setup_rows: list[dict[str, Any]],
    label_rows: list[dict[str, Any]],
    config: DatasetConfig | None = None,
) -> DatasetBuildResult:
    cfg = config or DatasetConfig()
    labels_by_id = _labels_by_signal_id(label_rows)
    labels_by_key = _labels_by_session_ts(label_rows)
    examples: list[TrainingExample] = []
    exclusions: dict[str, int] = {}

    for setup in setup_rows:
        setup_type = str(setup.get("setup_type"))
        if setup_type not in SETUP_TYPES:
            continue
        target_ticks = cfg.target_for_setup(setup_type)
        label_row = _find_label_row(setup, labels_by_id, labels_by_key)
        if label_row is None:
            for horizon in cfg.horizons_seconds:
                _increment(exclusions, setup_type, horizon, "missing_label")
            continue
        forward_returns = label_row.get("forward_returns")
        if not isinstance(forward_returns, list):
            for horizon in cfg.horizons_seconds:
                _increment(exclusions, setup_type, horizon, "missing_label")
            continue
        by_horizon = {
            _int(item.get("horizon_seconds")): item
            for item in forward_returns
            if isinstance(item, dict)
        }
        for horizon in cfg.horizons_seconds:
            label = by_horizon.get(horizon)
            if label is None:
                _increment(exclusions, setup_type, horizon, "missing_label")
                continue
            status = str(label.get("status"))
            if status != "ok":
                _increment(exclusions, setup_type, horizon, status)
                continue
            mfe_ticks = _float(label.get("mfe_ticks"))
            examples.append(
                TrainingExample(
                    setup_type=setup_type,
                    horizon_seconds=horizon,
                    ts_ns=_int(setup.get("ts_ns")),
                    session_key=_session_key(setup),
                    direction=_direction(setup.get("direction")),
                    label=1 if mfe_ticks >= target_ticks else 0,
                    target_ticks=target_ticks,
                    realized_mfe_ticks=mfe_ticks,
                    feature_values=build_feature_vector(setup, tick_size=cfg.tick_size),
                    setup_row=setup,
                )
            )

    examples.sort(key=lambda row: (row.ts_ns, row.setup_type, row.horizon_seconds))
    return DatasetBuildResult(
        examples=examples,
        exclusion_counts=dict(sorted(exclusions.items())),
        setup_row_count=len(setup_rows),
        label_row_count=len(label_rows),
    )


def load_training_dataset(
    *,
    setup_path: Path,
    labels_path: Path,
    config: DatasetConfig | None = None,
) -> DatasetBuildResult:
    return build_training_examples(
        setup_rows=read_jsonl(setup_path),
        label_rows=read_jsonl(labels_path),
        config=config,
    )


def _labels_by_signal_id(label_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for row in label_rows:
        signal = row.get("signal")
        if not isinstance(signal, dict):
            continue
        output[_signal_id_from_label(signal)] = row
    return output


def _labels_by_session_ts(
    label_rows: list[dict[str, Any]],
) -> dict[tuple[str, int], dict[str, Any]]:
    output: dict[tuple[str, int], dict[str, Any]] = {}
    for row in label_rows:
        signal = row.get("signal")
        if not isinstance(signal, dict):
            continue
        replay = signal.get("replay")
        if not isinstance(replay, dict):
            continue
        key = (_session_key_from_replay(replay), _int(signal.get("ts_ns")))
        output.setdefault(key, row)
    return output


def _find_label_row(
    setup: Mapping[str, Any],
    labels_by_id: Mapping[str, dict[str, Any]],
    labels_by_key: Mapping[tuple[str, int], dict[str, Any]],
) -> dict[str, Any] | None:
    source_signals = setup.get("source_signals")
    if isinstance(source_signals, list):
        for signal in reversed(source_signals):
            if isinstance(signal, dict):
                signal_id = signal.get("signal_id")
                if isinstance(signal_id, str) and signal_id in labels_by_id:
                    return labels_by_id[signal_id]
    return labels_by_key.get((_session_key(setup), _int(setup.get("ts_ns"))))


def _signal_id_from_label(signal: Mapping[str, Any]) -> str:
    replay = signal.get("replay")
    replay_record = replay if isinstance(replay, Mapping) else {}
    price = signal.get("price")
    price_text = f"{float(price):.2f}" if isinstance(price, int | float) else "no-price"
    return "|".join(
        [
            str(replay_record.get("capture_date")),
            str(replay_record.get("session")),
            str(signal.get("ts_ns")),
            str(signal.get("family")),
            str(signal.get("event_type")),
            str(signal.get("level_id") or "no-level"),
            price_text,
        ]
    )


def _session_key(setup: Mapping[str, Any]) -> str:
    replay = setup.get("replay")
    return _session_key_from_replay(replay if isinstance(replay, Mapping) else {})


def _session_key_from_replay(replay: Mapping[str, Any]) -> str:
    return f"{replay.get('capture_date')}_{replay.get('session')}"


def _direction(value: Any) -> Direction:
    return "short" if str(value).lower() == "short" else "long"


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _increment(counts: dict[str, int], setup_type: str, horizon: int, status: str) -> None:
    key = f"{setup_type}|{horizon}|{status}"
    counts[key] = counts.get(key, 0) + 1
