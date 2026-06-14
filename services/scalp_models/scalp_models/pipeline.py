"""RA-093b one-command replay -> labels -> scalp-model training pipeline."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Literal

from scalp_models.canonical import canonical_json, sha256_file, sha256_text
from scalp_models.dataset import DatasetBuildResult, DatasetConfig, load_training_dataset
from scalp_models.trainer import TrainingConfig, TrainingRunResult, train_models

SessionName = Literal["globex", "rth"]

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ANALYTICS_ROOT = REPO_ROOT / "tools" / "rithmic_analytics"
DEFAULT_DASHBOARD_ROOT = REPO_ROOT / "tools" / "rithmic_dashboard"
DEFAULT_OUT_ROOT = REPO_ROOT / "services" / "scalp_models" / "runs" / "pipeline"
LABEL_CLI = REPO_ROOT / "apps" / "backtester" / "src" / "forward-return-labels" / "cli.ts"
LIVE_WRITE_STALE_SECONDS = 120


class PipelineError(RuntimeError):
    """Raised when the one-command pipeline cannot safely produce artifacts."""


@dataclass(frozen=True)
class PipelineSession:
    capture_date: str
    session: SessionName

    @property
    def key(self) -> str:
        return f"{self.capture_date}_{self.session}"


@dataclass(frozen=True)
class PipelineConfig:
    sessions: tuple[PipelineSession, ...]
    analytics_root: Path = DEFAULT_ANALYTICS_ROOT
    dashboard_root: Path = DEFAULT_DASHBOARD_ROOT
    out_root: Path = DEFAULT_OUT_ROOT
    run_id: str | None = None
    step_ms: int = 500
    depth_n_ticks: int = 20
    limit_steps: int | None = None
    target_ticks: float = 4.0
    min_positives: int = 30
    min_negatives: int = 30
    tick_size: float = 0.25
    allow_live_capture_contention: bool = False
    live_write_stale_seconds: int = LIVE_WRITE_STALE_SECONDS
    node_runner: str = "npx.cmd" if os.name == "nt" else "npx"
    # When > 1, the per-session phase (replay + labels) runs concurrently
    # across that many worker processes. Capped at len(sessions). Merge +
    # train remain in the parent. Each session is single-threaded; this only
    # parallelizes across sessions.
    parallel_sessions: int = 1


@dataclass(frozen=True)
class SchemaSeamSummary:
    setup_row_count: int
    label_row_count: int
    joined_example_count: int
    exclusion_counts: dict[str, int]


@dataclass(frozen=True)
class SessionPipelineResult:
    session: PipelineSession
    signals_path: Path
    signals_manifest_path: Path
    setups_path: Path
    setups_manifest_path: Path
    labels_path: Path
    labels_manifest_path: Path
    seam: SchemaSeamSummary


ArtifactSource = Literal["file", "recorded_hash"]


@dataclass(frozen=True)
class ArtifactChainStep:
    name: str
    sha256: str
    source: ArtifactSource
    path: str | None = None


@dataclass(frozen=True)
class PipelineResult:
    run_dir: Path
    manifest_path: Path
    merged_setups_path: Path
    merged_labels_path: Path
    training: TrainingRunResult
    sessions: tuple[SessionPipelineResult, ...]


_MAX_SESSION_HOURS = 26.0  # globex+RTH day ~23h; longer => a multi-day capture blob


def _session_obs01(session: PipelineSession, analytics_root: Path) -> Path:
    return (analytics_root / "data" / "captures" / session.capture_date
            / f"MNQ_{session.session}.obs01.jsonl")


def _content_key(obs01: Path) -> str:
    """size + sha256 of first+last 1 MB — byte-identical multi-GB blobs collide here."""
    import hashlib

    size = obs01.stat().st_size
    h = hashlib.sha256()
    h.update(str(size).encode())
    with obs01.open("rb") as f:
        h.update(f.read(1 << 20))
        if size > (2 << 20):
            f.seek(size - (1 << 20))
            h.update(f.read())
    return f"{size}:{h.hexdigest()[:16]}"


def _span_hours(obs01: Path) -> float | None:
    def _ts(line: bytes) -> int | None:
        try:
            d = json.loads(line)
        except Exception:
            return None
        t = d.get("ts_ns") or (d.get("payload") or {}).get("exchange_event_ts_ns")
        try:
            return int(t)
        except (TypeError, ValueError):
            return None

    try:
        size = obs01.stat().st_size
        with obs01.open("rb") as f:
            first = f.readline()
            f.seek(max(0, size - 65536))
            tail = f.read().splitlines()
        last = tail[-1] if tail else b""
        ft, lt = _ts(first), _ts(last)
        return (lt - ft) / 3.6e12 if (ft and lt) else None
    except OSError:
        return None


def _filter_clean_sessions(
    sessions: tuple[PipelineSession, ...], analytics_root: Path
) -> tuple[list[PipelineSession], list[tuple[PipelineSession, str]]]:
    """Drop byte-identical duplicate session dirs + multi-day blobs so a
    --date-range glob can't double-count or train a 3-day cutover blob as one
    session. Content-based (size->hash) + span-based, NOT junction-based: the
    6/03 and 6/07 cutover artifacts are real duplicate copies (LinkType=none),
    so a reparse-point check would miss them. Sessions whose obs01 is absent are
    kept (the replay surfaces the missing-capture error)."""
    clean: list[PipelineSession] = []
    dropped: list[tuple[PipelineSession, str]] = []
    seen: dict[str, str] = {}
    for s in sessions:
        obs = _session_obs01(s, analytics_root)
        if not obs.exists():
            clean.append(s)
            continue
        label = f"{s.capture_date}_{s.session}"
        key = _content_key(obs)
        if key in seen:
            dropped.append((s, f"duplicate of {seen[key]}"))
            continue
        seen[key] = label
        span = _span_hours(obs)
        if span is not None and span > _MAX_SESSION_HOURS:
            dropped.append((s, f"multi-day blob ({span:.0f}h)"))
            continue
        clean.append(s)
    return clean, dropped


def run_pipeline(config: PipelineConfig) -> PipelineResult:
    """Run replay, forward-return labeling, and RA-093 training in one command."""

    if not config.sessions:
        raise PipelineError("at least one capture date/session pair is required")

    # Integrity guard (defensive): drop byte-identical duplicate session dirs and
    # multi-day blobs so a --date-range glob can't double-count or train a 3-day
    # cutover blob as one session. No-op when the requested sessions are clean.
    sessions, dropped = _filter_clean_sessions(config.sessions, config.analytics_root)
    for s, reason in dropped:
        print(f"[integrity] dropping {s.capture_date}_{s.session}: {reason}", flush=True)
    if not sessions:
        raise PipelineError("all requested sessions were dropped as duplicates/blobs")

    run_id = config.run_id or _derive_run_id(config)
    run_dir = config.out_root / run_id
    if run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True)

    # Run the capture-not-active guard once per session SEQUENTIALLY in the
    # parent, before spawning any worker. The guard introspects sibling
    # processes via PowerShell, and parallel guard checks self-confuse:
    # each worker's PowerShell process has a command line containing
    # `capture-rithmic-probe` (literally, as the regex it's about to run),
    # so a concurrent worker spots it and false-positives. Running the
    # guard in the parent before fan-out is the only correct ordering.
    for session in sessions:
        _assert_capture_not_active(session, config)

    worker_count = max(1, min(config.parallel_sessions, len(sessions)))
    if worker_count > 1:
        from multiprocessing import get_context

        # spawn context picks a clean interpreter per worker — required on
        # Windows and safer everywhere when the parent has imported a lot.
        ctx = get_context("spawn")
        with ctx.Pool(processes=worker_count) as pool:
            session_results = list(
                pool.starmap(
                    _run_session,
                    [(config, run_dir, session) for session in sessions],
                )
            )
    else:
        session_results = []
        for session in sessions:
            session_results.append(_run_session(config, run_dir, session))

    merged_setups = run_dir / "merged_setups.jsonl"
    merged_labels = run_dir / "merged_labels.jsonl"
    _merge_jsonl([item.setups_path for item in session_results], merged_setups)
    _merge_jsonl([item.labels_path for item in session_results], merged_labels)
    merged_seam = validate_schema_seam(merged_setups, merged_labels)

    training = train_models(
        TrainingConfig(
            setup_path=merged_setups,
            labels_path=merged_labels,
            out_root=run_dir / "model_runs",
            run_id="scalp_models",
            target_ticks=config.target_ticks,
            min_positives=config.min_positives,
            min_negatives=config.min_negatives,
            tick_size=config.tick_size,
        )
    )

    manifest_path = run_dir / "pipeline_manifest.json"
    _write_manifest(
        manifest_path,
        config=config,
        run_id=run_id,
        run_dir=run_dir,
        sessions=tuple(session_results),
        merged_setups=merged_setups,
        merged_labels=merged_labels,
        merged_seam=merged_seam,
        training=training,
    )
    return PipelineResult(
        run_dir=run_dir,
        manifest_path=manifest_path,
        merged_setups_path=merged_setups,
        merged_labels_path=merged_labels,
        training=training,
        sessions=tuple(session_results),
    )


def validate_schema_seam(setups_path: Path, labels_path: Path) -> SchemaSeamSummary:
    """Validate that setups and labels actually meet at the trainer seam.

    If both sides have rows but every setup lands in ``missing_label``, the pipeline
    is broken even though the trainer can still emit an insufficient-samples report.
    """

    dataset = load_training_dataset(
        setup_path=setups_path,
        labels_path=labels_path,
        config=DatasetConfig(),
    )
    missing_label_count = sum(
        count for key, count in dataset.exclusion_counts.items() if key.endswith("|missing_label")
    )
    expected_missing_all = dataset.setup_row_count * len(DatasetConfig().horizons_seconds)
    if (
        dataset.setup_row_count > 0
        and dataset.label_row_count > 0
        and not dataset.examples
        and missing_label_count == expected_missing_all
    ):
        raise PipelineError(
            "schema seam produced all missing_label exclusions; setup rows did not join labels"
        )
    return _seam_summary(dataset)


def sessions_from_date_range(
    date_range: str,
    sessions: tuple[SessionName, ...],
) -> tuple[PipelineSession, ...]:
    """Expand ``YYYY-MM-DD..YYYY-MM-DD`` into date/session pairs."""

    if ".." not in date_range:
        raise PipelineError("--date-range must use START..END")
    start_text, end_text = date_range.split("..", 1)
    start = date.fromisoformat(start_text)
    end = date.fromisoformat(end_text)
    if end < start:
        raise PipelineError("--date-range end must be on or after start")

    output: list[PipelineSession] = []
    current = start
    while current <= end:
        for session in sessions:
            output.append(PipelineSession(capture_date=current.isoformat(), session=session))
        current += timedelta(days=1)
    return tuple(output)


def parse_pair(value: str) -> PipelineSession:
    if ":" not in value:
        raise PipelineError("--pair must be formatted as YYYY-MM-DD:globex or YYYY-MM-DD:rth")
    capture_date, session_text = value.split(":", 1)
    date.fromisoformat(capture_date)
    if session_text not in ("globex", "rth"):
        raise PipelineError("--pair session must be globex or rth")
    return PipelineSession(capture_date=capture_date, session=session_text)  # type: ignore[arg-type]


def _run_session(
    config: PipelineConfig,
    run_dir: Path,
    session: PipelineSession,
) -> SessionPipelineResult:
    session_dir = run_dir / "sessions" / session.key
    session_dir.mkdir(parents=True)
    signals = session_dir / "signals.jsonl"
    setups = session_dir / "setups.jsonl"
    labels = session_dir / "labels.jsonl"
    labels_manifest = session_dir / "labels.manifest.json"

    replay_result = _run_replay_for_session(
        config=config,
        session=session,
        signals_path=signals,
        setups_path=setups,
        scratch_dir=session_dir / "scratch",
    )
    _run_label_cli(
        config=config,
        dataset_path=signals,
        labels_path=labels,
        manifest_path=labels_manifest,
    )
    seam = validate_schema_seam(setups, labels)
    setup_result = replay_result.setup_result
    if setup_result is None:
        raise PipelineError("replay did not produce the required setup dataset")
    return SessionPipelineResult(
        session=session,
        signals_path=signals,
        signals_manifest_path=replay_result.manifest_path,
        setups_path=setups,
        setups_manifest_path=setup_result.manifest_path,
        labels_path=labels,
        labels_manifest_path=labels_manifest,
        seam=seam,
    )


def _run_replay_for_session(
    *,
    config: PipelineConfig,
    session: PipelineSession,
    signals_path: Path,
    setups_path: Path,
    scratch_dir: Path,
) -> Any:
    from replay.runner import ReplayConfig, run_replay

    return run_replay(
        ReplayConfig(
            analytics_root=config.analytics_root,
            dashboard_root=config.dashboard_root,
            capture_date=session.capture_date,
            session=session.session,
            out_path=signals_path,
            setup_out_path=setups_path,
            scratch_dir=scratch_dir,
            step_ms=config.step_ms,
            depth_n_ticks=config.depth_n_ticks,
            limit_steps=config.limit_steps,
        )
    )


def _run_label_cli(
    *,
    config: PipelineConfig,
    dataset_path: Path,
    labels_path: Path,
    manifest_path: Path,
) -> None:
    command = [
        config.node_runner,
        "tsx",
        str(LABEL_CLI),
        "--dataset",
        str(dataset_path),
        "--out",
        str(labels_path),
        "--manifest",
        str(manifest_path),
        "--tick-size",
        str(config.tick_size),
    ]
    completed = subprocess.run(command, cwd=REPO_ROOT, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        raise PipelineError(
            "forward-return label CLI failed:\n"
            f"stdout:\n{completed.stdout}\n"
            f"stderr:\n{completed.stderr}"
        )


def _assert_capture_not_active(session: PipelineSession, config: PipelineConfig) -> None:
    if config.allow_live_capture_contention:
        return
    recent_files = _recent_capture_writes(session, config)
    process_lines = _matching_capture_processes(session)
    if recent_files or process_lines:
        details = {
            "recent_files": [str(path) for path in recent_files],
            "matching_processes": process_lines,
        }
        raise PipelineError(
            "target capture appears active; rerun in a quiet window or pass "
            f"--allow-live-capture-contention. details={canonical_json(details)}"
        )


def _recent_capture_writes(session: PipelineSession, config: PipelineConfig) -> list[Path]:
    capture_dir = config.analytics_root / "data" / "captures" / session.capture_date
    candidates = [
        capture_dir / f"MNQ_{session.session}.jsonl",
        capture_dir / f"MNQ_{session.session}.obs01.jsonl",
        capture_dir / f"MNQ_{session.session}.mbo.jsonl",
    ]
    cutoff = time.time() - config.live_write_stale_seconds
    return [
        path
        for path in candidates
        if path.exists() and path.stat().st_size > 0 and path.stat().st_mtime >= cutoff
    ]


def _matching_capture_processes(session: PipelineSession) -> list[str]:
    if os.name != "nt":
        return []
    script = (
        f"$session = '{session.session}'; "
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine "
        "-and $_.CommandLine -match '(start_capture|capture-rithmic-probe)' "
        "-and $_.CommandLine -match $session } | "
        "ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"
    )
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", script],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        return []
    return [line.strip() for line in completed.stdout.splitlines() if line.strip()]


def _merge_jsonl(paths: list[Path], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as output:
        for path in paths:
            if not path.exists():
                raise PipelineError(f"missing JSONL input: {path}")
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    output.write(line)
                    output.write("\n")


def _write_manifest(
    path: Path,
    *,
    config: PipelineConfig,
    run_id: str,
    run_dir: Path,
    sessions: tuple[SessionPipelineResult, ...],
    merged_setups: Path,
    merged_labels: Path,
    merged_seam: SchemaSeamSummary,
    training: TrainingRunResult,
) -> None:
    artifacts = _artifact_chain(
        [
            *[
                step
                for item in sessions
                for step in _capture_input_chain_steps(item)
            ],
            *[
                _file_chain_step("signals_manifest", item.signals_manifest_path)
                for item in sessions
            ],
            *[
                _file_chain_step("signals", item.signals_path)
                for item in sessions
            ],
            *[
                _file_chain_step("setups_manifest", item.setups_manifest_path)
                for item in sessions
            ],
            *[
                _file_chain_step("setups", item.setups_path)
                for item in sessions
            ],
            *[
                _file_chain_step("labels_manifest", item.labels_manifest_path)
                for item in sessions
            ],
            *[
                _file_chain_step("labels", item.labels_path)
                for item in sessions
            ],
            _file_chain_step("merged_setups", merged_setups),
            _file_chain_step("merged_labels", merged_labels),
            _file_chain_step("model_config", training.run_dir / "config.json"),
            *[
                _file_chain_step("model_metadata", path)
                for path in sorted(training.metadata_paths, key=str)
            ],
            *[
                _file_chain_step("model", path)
                for path in sorted(training.model_paths, key=str)
            ],
            _file_chain_step("calibration_report", training.report_path),
        ]
    )
    manifest = {
        "schema_version": 1,
        "generated_by": "ra093b_scalp_pipeline_v1",
        "generated_at_ns": time.time_ns(),
        "run_id": run_id,
        "run_dir": str(run_dir),
        "git": _git_state(),
        "settings": {
            "analytics_root": str(config.analytics_root),
            "dashboard_root": str(config.dashboard_root),
            "step_ms": config.step_ms,
            "depth_n_ticks": config.depth_n_ticks,
            "limit_steps": config.limit_steps,
            "target_ticks": config.target_ticks,
            "min_positives": config.min_positives,
            "min_negatives": config.min_negatives,
            "tick_size": config.tick_size,
            "parallel_sessions": config.parallel_sessions,
        },
        "sessions": [_session_manifest(item) for item in sessions],
        "merged_inputs": {
            "setups_path": str(merged_setups),
            "setups_sha256": sha256_file(merged_setups),
            "labels_path": str(merged_labels),
            "labels_sha256": sha256_file(merged_labels),
            "schema_seam": _seam_manifest(merged_seam),
        },
        "model_run": {
            "run_id": training.run_id,
            "run_dir": str(training.run_dir),
            "report_path": str(training.report_path),
            "report_sha256": sha256_file(training.report_path),
            "model_count": len(training.model_paths),
            "metadata_count": len(training.metadata_paths),
        },
        "artifact_hash_chain": artifacts,
        "artifact_chain_tip": artifacts[-1]["chain_sha256"] if artifacts else None,
    }
    path.write_text(f"{canonical_json(manifest)}\n", encoding="utf-8")


def _capture_input_chain_steps(item: SessionPipelineResult) -> list[ArtifactChainStep]:
    manifest = _read_json_object(item.signals_manifest_path)
    input_hashes = manifest.get("input_hashes")
    if not isinstance(input_hashes, dict):
        raise PipelineError(f"replay manifest missing input_hashes: {item.signals_manifest_path}")

    steps: list[ArtifactChainStep] = []
    for name in _ordered_input_hash_names(input_hashes):
        value = input_hashes.get(name)
        if value is None:
            continue
        if not isinstance(value, str) or not _is_sha256_hex(value):
            raise PipelineError(
                f"replay manifest input_hashes.{name} is not a sha256 hex string: "
                f"{item.signals_manifest_path}"
            )
        steps.append(
            ArtifactChainStep(
                name=f"capture_input:{item.session.capture_date}:{item.session.session}:{name}",
                sha256=value,
                source="recorded_hash",
                path=f"{item.signals_manifest_path}#input_hashes.{name}",
            )
        )
    if not steps:
        raise PipelineError(
            f"replay manifest has no non-null input hashes: {item.signals_manifest_path}"
        )
    return steps


def _ordered_input_hash_names(input_hashes: dict[Any, Any]) -> list[str]:
    preferred = ["raw", "trade", "mbo", "zones"]
    available = {str(key) for key in input_hashes}
    return [name for name in preferred if name in available] + sorted(available - set(preferred))


def _read_json_object(path: Path) -> dict[str, Any]:
    parsed = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        raise PipelineError(f"expected JSON object in {path}")
    return parsed


def _is_sha256_hex(value: str) -> bool:
    return len(value) == 64 and all(char in "0123456789abcdef" for char in value)


def _file_chain_step(name: str, path: Path) -> ArtifactChainStep:
    return ArtifactChainStep(name=name, path=str(path), sha256=sha256_file(path), source="file")


def _artifact_chain(items: list[ArtifactChainStep]) -> list[dict[str, str]]:
    previous = "0" * 64
    output: list[dict[str, str]] = []
    for item in items:
        chain_hash = sha256_text(
            canonical_json([previous, item.source, item.name, item.path, item.sha256])
        )
        row = {
            "name": item.name,
            "sha256": item.sha256,
            "source": item.source,
            "chain_sha256": chain_hash,
        }
        if item.path is not None:
            row["path"] = item.path
        output.append(row)
        previous = chain_hash
    return output


def _session_manifest(item: SessionPipelineResult) -> dict[str, Any]:
    return {
        "capture_date": item.session.capture_date,
        "session": item.session.session,
        "signals_path": str(item.signals_path),
        "signals_sha256": sha256_file(item.signals_path),
        "signals_manifest_path": str(item.signals_manifest_path),
        "signals_manifest_sha256": sha256_file(item.signals_manifest_path),
        "setups_path": str(item.setups_path),
        "setups_sha256": sha256_file(item.setups_path),
        "setups_manifest_path": str(item.setups_manifest_path),
        "setups_manifest_sha256": sha256_file(item.setups_manifest_path),
        "labels_path": str(item.labels_path),
        "labels_sha256": sha256_file(item.labels_path),
        "labels_manifest_path": str(item.labels_manifest_path),
        "labels_manifest_sha256": sha256_file(item.labels_manifest_path),
        "schema_seam": _seam_manifest(item.seam),
    }


def _seam_summary(dataset: DatasetBuildResult) -> SchemaSeamSummary:
    return SchemaSeamSummary(
        setup_row_count=dataset.setup_row_count,
        label_row_count=dataset.label_row_count,
        joined_example_count=len(dataset.examples),
        exclusion_counts=dataset.exclusion_counts,
    )


def _seam_manifest(seam: SchemaSeamSummary) -> dict[str, Any]:
    return {
        "setup_row_count": seam.setup_row_count,
        "label_row_count": seam.label_row_count,
        "joined_example_count": seam.joined_example_count,
        "exclusion_counts": seam.exclusion_counts,
    }


def _derive_run_id(config: PipelineConfig) -> str:
    payload = {
        "sessions": [session.__dict__ for session in config.sessions],
        "step_ms": config.step_ms,
        "depth_n_ticks": config.depth_n_ticks,
        "limit_steps": config.limit_steps,
        "target_ticks": config.target_ticks,
        "min_positives": config.min_positives,
        "min_negatives": config.min_negatives,
        "tick_size": config.tick_size,
    }
    return f"ra093b_{sha256_text(canonical_json(payload))[:12]}"


def _git_state() -> dict[str, Any]:
    commit = _git(["rev-parse", "HEAD"])
    status = _git(["status", "--short"])
    return {
        "commit": commit.strip() or None,
        "dirty": bool(status.strip()),
        "status_short": status.splitlines(),
        "note": "dirty status is recorded for audit only; unrelated files are not hashed",
    }


def _git(args: list[str]) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    return completed.stdout if completed.returncode == 0 else ""
