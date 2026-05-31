"""Pydantic schema for RA-090a detector-firing datasets."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DatasetFamily = Literal[
    "sweep",
    "iceberg",
    "absorption",
    "dislocation",
    "aggressor_flow",
    "vol_regime",
    "institutional_flow",
]


class ZoneContext(BaseModel):
    """Nearest structural zone/reference context at the firing price."""

    id: str
    kind: str
    tier: str | None = None
    price: float
    distance_pts: float


class ReplayContext(BaseModel):
    """Replay provenance carried on every row."""

    capture_date: str
    session: str
    step_ns: int
    source_obs01: str | None = None
    source_mbo: str | None = None
    schema_version: int = 1


class SignalDatasetRow(BaseModel):
    """One detector firing as seen by the live Python detector stack.

    ``ts_ns`` is the detector domain event exchange timestamp whenever the
    detector exposes one; only regime transitions fall back to the replay step
    timestamp because the live volatility event is session-level.
    """

    model_config = ConfigDict(extra="forbid")

    ts_ns: int
    family: DatasetFamily
    event_type: str
    tier: Literal["CRITICAL", "HIGH", "MEDIUM"] | None = None
    price: float | None = None
    level_id: str | None = None
    side: str | None = None
    direction: str | None = None
    zone_context: ZoneContext | None = None
    regime: str | None = None
    orderflow_snapshot: dict[str, Any] | None = None
    depth_snapshot: dict[str, Any] | None = None
    confluence_stack_size: int = Field(ge=1)
    payload: dict[str, Any]
    replay: ReplayContext


class DatasetManifest(BaseModel):
    """Sidecar manifest for deterministic replay artifacts."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = 1
    capture_date: str
    session: str
    row_count: int
    dataset_sha256: str
    settings: dict[str, Any]
    input_hashes: dict[str, str | None]
    seeded_files: dict[str, str | None] = Field(default_factory=dict)
