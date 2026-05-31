"""Read Rithmic capture siblings as deterministic exchange-time row streams."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from heapq import heappop, heappush
from pathlib import Path
from typing import Any, Literal

SourceKind = Literal["trade", "mbo"]


@dataclass(frozen=True)
class CaptureSources:
    """Resolved source files for one Rithmic capture session."""

    raw_path: Path
    trade_path: Path | None
    mbo_path: Path | None


@dataclass(frozen=True)
class SourceRow:
    """One raw JSONL row plus its exchange timestamp and target sibling."""

    ts_ns: int
    kind: SourceKind
    raw_line: str
    record: dict[str, Any]
    source_path: Path
    ordinal: int


def resolve_capture_sources(
    analytics_root: Path,
    *,
    capture_date: str,
    session: str,
) -> CaptureSources:
    capture_dir = analytics_root / "data" / "captures" / capture_date
    raw_path = capture_dir / f"MNQ_{session}.jsonl"
    obs_path = capture_dir / f"MNQ_{session}.obs01.jsonl"
    mbo_path = capture_dir / f"MNQ_{session}.mbo.jsonl"
    trade_path = obs_path if obs_path.exists() and obs_path.stat().st_size > 0 else raw_path
    return CaptureSources(
        raw_path=raw_path,
        trade_path=trade_path if trade_path.exists() else None,
        mbo_path=mbo_path if mbo_path.exists() and mbo_path.stat().st_size > 0 else None,
    )


def iter_source_rows(sources: CaptureSources) -> Iterator[SourceRow]:
    """Yield trade and MBO rows in exchange-time order.

    Normalized siblings are already exchange-time sorted. We merge them with a
    small heap instead of materializing the full session, so real multi-GB
    captures keep bounded memory while preserving deterministic tie-breaking.
    """

    streams: list[Iterator[SourceRow]] = []
    if sources.trade_path is not None:
        streams.append(_iter_jsonl_rows(sources.trade_path, kind="trade", start_ordinal=0))
    if sources.mbo_path is not None:
        streams.append(_iter_jsonl_rows(sources.mbo_path, kind="mbo", start_ordinal=0))

    heap: list[tuple[int, int, int, int, SourceRow]] = []
    for stream_id, stream in enumerate(streams):
        row = next(stream, None)
        if row is not None:
            heappush(heap, _heap_item(row, stream_id))

    while heap:
        _, _, _, stream_id, row = heappop(heap)
        yield row
        next_row = next(streams[stream_id], None)
        if next_row is not None:
            heappush(heap, _heap_item(next_row, stream_id))


def _iter_jsonl_rows(path: Path, *, kind: SourceKind, start_ordinal: int) -> Iterator[SourceRow]:
    ordinal = start_ordinal
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        for raw in handle:
            line = raw.rstrip("\r\n")
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict):
                continue
            ts_ns = _row_ts_ns(record, kind=kind)
            if ts_ns is None:
                continue
            yield SourceRow(
                ts_ns=ts_ns,
                kind=kind,
                raw_line=line,
                record=record,
                source_path=path,
                ordinal=ordinal,
            )
            ordinal += 1


def _heap_item(row: SourceRow, stream_id: int) -> tuple[int, int, int, int, SourceRow]:
    kind_priority = 0 if row.kind == "trade" else 1
    return (row.ts_ns, kind_priority, row.ordinal, stream_id, row)


def _row_ts_ns(record: dict[str, Any], *, kind: SourceKind) -> int | None:
    payload = record.get("payload")
    payload_dict = payload if isinstance(payload, dict) else {}
    if kind == "mbo":
        return _int(
            _first_present(
                record,
                payload_dict,
                "event_ts_ns",
                "exchange_event_ts_ns",
                "ts_event_ns",
                "ts_ns",
            )
        )
    return _int(
        _first_present(
            record,
            payload_dict,
            "exchange_event_ts_ns",
            "ts_event_ns",
            "ts_ns",
            "sidecar_recv_ts_ns",
        )
    )


def _first_present(record: dict[str, Any], payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if record.get(key) is not None:
            return record.get(key)
        if payload.get(key) is not None:
            return payload.get(key)
    return None


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
