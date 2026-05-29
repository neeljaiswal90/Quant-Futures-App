"""Incremental probe-parity -> OBS-01 normalization.

This CLI is the intraday counterpart to ``rithmic_analytics.cli.normalize``.
It keeps a per-capture byte-offset state file so the dashboard refresh loop
can normalize only newly appended raw probe records every five minutes.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import IO, Any, cast
from zoneinfo import ZoneInfo

from rithmic_analytics.ops.normalize_probe import (
    NormalizeReport,
    UnrecoverableCaptureError,
    _L1QuoteForwardFiller,
    normalize_probe_to_obs01,
    parity_l1quote_record_to_mbp1_dict,
    parity_mbo_record_to_mbo_dicts,
    parity_record_to_obs01_dict,
    session_id_from_path,
)

EXIT_OK: int = 0
EXIT_BAD_INPUT: int = 1
EXIT_USAGE: int = 2
STATE_SCHEMA_VERSION: int = 1

_LOG = logging.getLogger("rithmic_analytics.normalize_incremental")
_PT = ZoneInfo("America/Los_Angeles")


@dataclass(slots=True)
class NormalizeState:
    """Byte-offset state for one raw capture and its normalized siblings."""

    source_file: str
    last_byte_offset: int
    last_record_ts_ns: int | None
    last_normalized_at: str
    schema_version: int
    trades_emitted_total: int
    mbp1_records_emitted_total: int
    mbo_records_emitted_total: int


@dataclass(slots=True)
class _SpanResult:
    report: NormalizeReport
    end_offset: int
    last_record_ts_ns: int | None


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rithmic_analytics.cli.normalize_probe_incremental",
        description=(
            "Incrementally transform probe-parity JSONL records into OBS-01, "
            "MBP1, and MBO siblings using a byte-offset state file."
        ),
    )
    parser.add_argument("--input", type=Path, required=True, help="Raw probe JSONL.")
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Destination OBS-01 JSONL path. Convention: <ROOT>_<session>.obs01.jsonl",
    )
    parser.add_argument(
        "--mbp1-output",
        type=Path,
        default=None,
        help="Destination MBP1 JSONL. Default: derive from --output.",
    )
    parser.add_argument(
        "--mbo-output",
        type=Path,
        default=None,
        help="Destination MBO JSONL. Default: derive from --output.",
    )
    parser.add_argument("--skip-mbp1", action="store_true", help="Disable MBP1 output.")
    parser.add_argument("--skip-mbo", action="store_true", help="Disable MBO output.")
    parser.add_argument("--session-id", type=str, default=None, help="OBS-01 session_id.")
    parser.add_argument("--run-id", type=str, default=None, help="OBS-01 run_id.")
    parser.add_argument(
        "--state-path",
        type=Path,
        default=None,
        help="State JSON path. Default: <input>.obs01.normalize_state.json.",
    )
    parser.add_argument(
        "--audit-path",
        type=Path,
        default=None,
        help="Optional dashboard _audit.json path for full-fallback audit events.",
    )
    parser.add_argument(
        "--force-full",
        action="store_true",
        help="Ignore existing state and rebuild normalized siblings from byte 0.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = _build_parser().parse_args(argv)

    if not args.input.exists():
        _LOG.error(f"normalize input not found: {args.input}")
        return EXIT_BAD_INPUT

    mbp1_out = (
        None
        if args.skip_mbp1
        else (args.mbp1_output or _derive_sibling(args.output, "mbp1"))
    )
    mbo_out = None if args.skip_mbo else (args.mbo_output or _derive_sibling(args.output, "mbo"))
    state_path = args.state_path or args.input.with_name(
        args.input.name[: -len(".jsonl")] + ".obs01.normalize_state.json"
        if args.input.name.endswith(".jsonl")
        else args.input.name + ".obs01.normalize_state.json"
    )

    try:
        state, fallback_reason = _load_valid_state(
            state_path=state_path,
            source_path=args.input,
            raw_size=args.input.stat().st_size,
            obs01_path=args.output,
            mbp1_path=mbp1_out,
            mbo_path=mbo_out,
            force_full=args.force_full,
        )
    except ValueError as exc:
        _LOG.error(str(exc))
        return EXIT_USAGE

    if args.session_id is None:
        session_id = session_id_from_path(args.input)
        if session_id is None:
            _LOG.error(
                f"cannot derive session_id from path {args.input}; pass --session-id "
                "or use data/captures/YYYY-MM-DD/<ROOT>_<session>.jsonl"
            )
            return EXIT_USAGE
    else:
        session_id = args.session_id
    run_id = args.run_id or f"normalize-{session_id}"

    try:
        result, new_state = _run_normalize(
            input_path=args.input,
            obs01_path=args.output,
            mbp1_path=mbp1_out,
            mbo_path=mbo_out,
            state=state,
            state_path=state_path,
            session_id=session_id,
            run_id=run_id,
            fallback_reason=fallback_reason,
            audit_path=args.audit_path,
        )
    except FileNotFoundError as exc:
        _LOG.error(str(exc))
        return EXIT_BAD_INPUT
    except UnrecoverableCaptureError as exc:
        _LOG.error(f"UNRECOVERABLE CAPTURE: {exc}")
        return EXIT_BAD_INPUT
    except ValueError as exc:
        _LOG.error(str(exc))
        return EXIT_USAGE

    sys.stderr.write(json.dumps({
        "mode": "full_fallback" if fallback_reason else "incremental",
        "fallback_reason": fallback_reason,
        "span_report": result.report.to_dict(),
        "state": asdict(new_state),
    }, indent=2) + "\n")
    return EXIT_OK


def _derive_sibling(out_path: Path, suffix: str) -> Path:
    out_str = str(out_path)
    if out_str.endswith(".obs01.jsonl"):
        return Path(out_str[: -len(".obs01.jsonl")] + f".{suffix}.jsonl")
    if out_str.endswith(".jsonl"):
        return Path(out_str[: -len(".jsonl")] + f".{suffix}.jsonl")
    return Path(out_str + f".{suffix}.jsonl")


def _load_valid_state(
    *,
    state_path: Path,
    source_path: Path,
    raw_size: int,
    obs01_path: Path,
    mbp1_path: Path | None,
    mbo_path: Path | None,
    force_full: bool,
) -> tuple[NormalizeState | None, str | None]:
    if force_full:
        return None, "force_full"
    if not state_path.exists():
        return None, "missing_state"
    try:
        raw = json.loads(state_path.read_text(encoding="utf-8"))
        state = NormalizeState(
            source_file=str(raw["source_file"]),
            last_byte_offset=int(raw["last_byte_offset"]),
            last_record_ts_ns=_optional_int(raw.get("last_record_ts_ns")),
            last_normalized_at=str(raw["last_normalized_at"]),
            schema_version=int(raw["schema_version"]),
            trades_emitted_total=int(raw.get("trades_emitted_total", 0)),
            mbp1_records_emitted_total=int(raw.get("mbp1_records_emitted_total", 0)),
            mbo_records_emitted_total=int(raw.get("mbo_records_emitted_total", 0)),
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        _LOG.warning(f"normalize incremental state is corrupt: {state_path} ({exc})")
        return None, "corrupt_state"

    if state.schema_version != STATE_SCHEMA_VERSION:
        return None, "state_schema_mismatch"
    if Path(state.source_file).resolve() != source_path.resolve():
        return None, "source_file_mismatch"
    if state.last_byte_offset < 0 or state.last_byte_offset > raw_size:
        return None, "raw_file_shrunk_or_offset_invalid"
    if not obs01_path.exists():
        return None, "missing_obs01_output"
    if mbp1_path is not None and not mbp1_path.exists():
        return None, "missing_mbp1_output"
    if mbo_path is not None and not mbo_path.exists():
        return None, "missing_mbo_output"
    return state, None


def _run_normalize(
    *,
    input_path: Path,
    obs01_path: Path,
    mbp1_path: Path | None,
    mbo_path: Path | None,
    state: NormalizeState | None,
    state_path: Path,
    session_id: str,
    run_id: str,
    fallback_reason: str | None,
    audit_path: Path | None,
) -> tuple[_SpanResult, NormalizeState]:
    raw_size = input_path.stat().st_size
    if fallback_reason is not None:
        _emit_fallback_audit(
            audit_path=audit_path,
            event_type="normalize_state_missing_fallback_full",
            source_path=input_path,
            session_id=session_id,
            reason=fallback_reason,
            input_size_bytes=raw_size,
        )
        report = normalize_probe_to_obs01(
            input_path,
            obs01_path,
            mbp1_out_path=mbp1_path,
            mbo_out_path=mbo_path,
            session_id=session_id,
            run_id=run_id,
            overwrite=True,
        )
        result = _SpanResult(
            report=report,
            end_offset=raw_size,
            last_record_ts_ns=None,
        )
        new_state = NormalizeState(
            source_file=str(input_path.resolve()),
            last_byte_offset=result.end_offset,
            last_record_ts_ns=result.last_record_ts_ns,
            last_normalized_at=_now_iso(),
            schema_version=STATE_SCHEMA_VERSION,
            trades_emitted_total=result.report.trades_emitted,
            mbp1_records_emitted_total=result.report.mbp1_records_emitted,
            mbo_records_emitted_total=result.report.mbo_records_emitted,
        )
        _write_state_atomic(state_path, new_state)
        _LOG.warning(
            f"normalize incremental fallback_full reason={fallback_reason} "
            f"bytes={raw_size} obs01_trades={result.report.trades_emitted}"
        )
        return result, new_state

    if state is None:
        raise ValueError("internal error: state is required when fallback_reason is None")
    if raw_size == state.last_byte_offset:
        report = NormalizeReport(session_id=session_id, run_id=run_id)
        result = _SpanResult(
            report=report,
            end_offset=state.last_byte_offset,
            last_record_ts_ns=state.last_record_ts_ns,
        )
        state.last_normalized_at = _now_iso()
        _write_state_atomic(state_path, state)
        _LOG.info(f"normalize incremental no-op: {input_path.name} unchanged")
        return result, state

    result = _normalize_span(
        input_path=input_path,
        obs01_path=obs01_path,
        mbp1_path=mbp1_path,
        mbo_path=mbo_path,
        session_id=session_id,
        run_id=run_id,
        start_offset=state.last_byte_offset,
        stop_offset=raw_size,
        append=True,
        counter_start=state.trades_emitted_total + 1,
        l1q_filler=_seed_l1q_filler(mbp1_path),
    )
    new_state = NormalizeState(
        source_file=str(input_path.resolve()),
        last_byte_offset=result.end_offset,
        last_record_ts_ns=result.last_record_ts_ns or state.last_record_ts_ns,
        last_normalized_at=_now_iso(),
        schema_version=STATE_SCHEMA_VERSION,
        trades_emitted_total=state.trades_emitted_total + result.report.trades_emitted,
        mbp1_records_emitted_total=(
            state.mbp1_records_emitted_total + result.report.mbp1_records_emitted
        ),
        mbo_records_emitted_total=state.mbo_records_emitted_total
        + result.report.mbo_records_emitted,
    )
    _write_state_atomic(state_path, new_state)
    _LOG.info(
        f"normalize incremental {input_path.name}: "
        f"bytes {state.last_byte_offset}->{result.end_offset}, "
        f"trades +{result.report.trades_emitted}, "
        f"mbp1 +{result.report.mbp1_records_emitted}, "
        f"mbo +{result.report.mbo_records_emitted}"
    )
    return result, new_state


def _normalize_span(
    *,
    input_path: Path,
    obs01_path: Path,
    mbp1_path: Path | None,
    mbo_path: Path | None,
    session_id: str,
    run_id: str,
    start_offset: int,
    stop_offset: int,
    append: bool,
    counter_start: int,
    l1q_filler: _L1QuoteForwardFiller,
) -> _SpanResult:
    report = NormalizeReport(session_id=session_id, run_id=run_id)
    last_record_ts_ns: int | None = None
    counter = counter_start

    obs01_path.parent.mkdir(parents=True, exist_ok=True)
    obs_mode = "a" if append else "w"
    mbp1_handle: IO[str] | None = None
    mbo_handle: IO[str] | None = None
    if mbp1_path is not None:
        mbp1_path.parent.mkdir(parents=True, exist_ok=True)
        mbp1_handle = cast(IO[str], mbp1_path.open(obs_mode, encoding="utf-8"))
    if mbo_path is not None:
        mbo_path.parent.mkdir(parents=True, exist_ok=True)
        mbo_handle = cast(IO[str], mbo_path.open(obs_mode, encoding="utf-8"))

    end_offset = start_offset
    try:
        with input_path.open("rb") as f_in, obs01_path.open(
            obs_mode, encoding="utf-8"
        ) as raw_obs01_handle:
            obs01_handle = cast(IO[str], raw_obs01_handle)
            f_in.seek(start_offset)
            while end_offset < stop_offset:
                raw_bytes = f_in.readline()
                if raw_bytes == b"":
                    break
                end_offset += len(raw_bytes)
                try:
                    raw = raw_bytes.decode("utf-8")
                except UnicodeDecodeError:
                    report.skipped_decode_error += 1
                    continue
                line = raw.strip()
                if not line:
                    continue
                report.records_read += 1
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    report.skipped_decode_error += 1
                    continue
                ts_ns = _optional_int(rec.get("exchange_event_ts_ns"))
                if ts_ns is not None:
                    last_record_ts_ns = ts_ns
                _route_record(
                    rec=rec,
                    report=report,
                    obs01_handle=obs01_handle,
                    mbp1_handle=mbp1_handle,
                    mbo_handle=mbo_handle,
                    l1q_filler=l1q_filler,
                    session_id=session_id,
                    run_id=run_id,
                    counter=counter,
                )
                if _is_obs_trade_record(rec):
                    # Counter bumps only if the OBS path actually emitted;
                    # _route_record returns that signal via report delta.
                    counter = counter_start + report.trades_emitted
    finally:
        if mbp1_handle is not None:
            mbp1_handle.close()
        if mbo_handle is not None:
            mbo_handle.close()

    report.mbp1_forward_filled = l1q_filler.forward_filled_count
    report.mbp1_first_record_one_sided = l1q_filler.first_record_one_sided_count
    return _SpanResult(report=report, end_offset=end_offset, last_record_ts_ns=last_record_ts_ns)


def _route_record(
    *,
    rec: dict[str, Any],
    report: NormalizeReport,
    obs01_handle: IO[str],
    mbp1_handle: IO[str] | None,
    mbo_handle: IO[str] | None,
    l1q_filler: _L1QuoteForwardFiller,
    session_id: str,
    run_id: str,
    counter: int,
) -> None:
    stream = rec.get("stream")

    if stream == "L1_QUOTE" and mbp1_handle is not None:
        mbp1_result = parity_l1quote_record_to_mbp1_dict(rec)
        if isinstance(mbp1_result, tuple):
            _, mbp1_reason = mbp1_result
            if mbp1_reason == "no_timestamp":
                report.skipped_no_timestamp += 1
            elif mbp1_reason == "missing_quote":
                report.skipped_l1quote_missing_quote += 1
            return
        mbp1_result = l1q_filler.fill(mbp1_result)
        mbp1_handle.write(json.dumps(mbp1_result, separators=(",", ":")) + "\n")
        report.mbp1_records_emitted += 1
        return

    if stream == "MBO" and mbo_handle is not None and rec.get("action") != "T":
        mbo_result = parity_mbo_record_to_mbo_dicts(rec)
        if isinstance(mbo_result, tuple):
            _, mbo_reason = mbo_result
            if mbo_reason == "no_timestamp":
                report.skipped_no_timestamp += 1
            elif mbo_reason == "no_sequence":
                report.skipped_mbo_no_sequence += 1
            elif mbo_reason == "missing_orders":
                report.skipped_mbo_missing_orders += 1
            elif mbo_reason == "unknown_action":
                report.skipped_mbo_unknown_action += 1
            elif mbo_reason == "unknown_side":
                report.skipped_mbo_unknown_side += 1
            return
        for row in mbo_result:
            mbo_handle.write(json.dumps(row, separators=(",", ":")) + "\n")
            report.mbo_records_emitted += 1
        return

    result = parity_record_to_obs01_dict(
        rec, session_id=session_id, run_id=run_id, counter=counter,
    )
    if isinstance(result, tuple):
        _, reason_tag = result
        if reason_tag == "wrong_stream":
            report.skipped_wrong_stream += 1
        elif reason_tag == "no_timestamp":
            report.skipped_no_timestamp += 1
        elif reason_tag == "missing_payload":
            report.skipped_missing_payload += 1
        elif reason_tag == "last_trade_no_payload":
            report.skipped_last_trade_no_payload += 1
        elif reason_tag == "zero_quantity":
            report.skipped_zero_quantity += 1
        elif reason_tag == "mbo_non_trade":
            report.skipped_mbo_non_trade += 1
        return

    obs01_handle.write(json.dumps(result, separators=(",", ":")) + "\n")
    report.trades_emitted += 1


def _is_obs_trade_record(rec: dict[str, Any]) -> bool:
    return rec.get("stream") in {"LAST_TRADE", "MBO"}


def _seed_l1q_filler(mbp1_path: Path | None) -> _L1QuoteForwardFiller:
    filler = _L1QuoteForwardFiller()
    if mbp1_path is None or not mbp1_path.exists():
        return filler
    rec = _read_last_json_line(mbp1_path)
    if rec is None:
        return filler
    bid_px = _optional_float(rec.get("bid_px_00"))
    ask_px = _optional_float(rec.get("ask_px_00"))
    if bid_px is not None and bid_px != 0:
        filler.bid_state = (
            bid_px,
            int(rec.get("bid_sz_00") or 0),
            int(rec.get("bid_ct_00") or 0),
        )
    if ask_px is not None and ask_px != 0:
        filler.ask_state = (
            ask_px,
            int(rec.get("ask_sz_00") or 0),
            int(rec.get("ask_ct_00") or 0),
        )
    return filler


def _read_last_json_line(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            pos = handle.tell()
            if pos == 0:
                return None
            buffer = bytearray()
            while pos > 0:
                pos -= 1
                handle.seek(pos)
                byte = handle.read(1)
                if byte == b"\n" and buffer:
                    break
                if byte != b"\n":
                    buffer.extend(byte)
            line = bytes(reversed(buffer)).decode("utf-8").strip()
        return json.loads(line) if line else None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _write_state_atomic(path: Path, state: NormalizeState) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(asdict(state), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _emit_fallback_audit(
    *,
    audit_path: Path | None,
    event_type: str,
    source_path: Path,
    session_id: str,
    reason: str,
    input_size_bytes: int,
) -> None:
    if audit_path is None:
        return
    try:
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        data: dict[str, Any]
        if audit_path.exists():
            raw = json.loads(audit_path.read_text(encoding="utf-8"))
            data = raw if isinstance(raw, dict) else {"entries": []}
        else:
            data = {"entries": []}
        entries = data.get("entries")
        if not isinstance(entries, list):
            entries = []
        session_count = 1 + sum(
            1
            for entry in entries
            if isinstance(entry, dict)
            and entry.get("event_type") == event_type
            and entry.get("metadata", {}).get("session_id") == session_id
        )
        entries.append({
            "timestamp_pt": _now_pt_label(),
            "event_type": event_type,
            "description": (
                f"Incremental normalize state fallback for {source_path.name}: "
                f"{reason}; full re-normalize over {input_size_bytes:,} bytes "
                f"(session fallback #{session_count})"
            ),
            "related_level_id": "normalize-incremental",
            "metadata": {
                "source_file": str(source_path),
                "session_id": session_id,
                "reason": reason,
                "input_size_bytes": input_size_bytes,
                "session_fallback_count": session_count,
            },
        })
        data["entries"] = entries[-50:]
        tmp = audit_path.with_name(audit_path.name + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        tmp.replace(audit_path)
    except Exception as exc:  # audit is observability, not normalization-critical
        _LOG.warning(f"failed to write normalize fallback audit event: {exc}")


def _optional_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _optional_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _now_iso() -> str:
    return datetime.now(_PT).isoformat()


def _now_pt_label() -> str:
    return datetime.now(_PT).strftime("%Y-%m-%d %H:%M:%S PT")


if __name__ == "__main__":
    sys.exit(main())
