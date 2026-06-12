"""Golden byte-exactness gate for the replay incremental-parse rewrite.

The rewrite (parse-once + persist detector state across steps) MUST keep every
detector output byte-identical or it silently shifts training setups/labels.
This harness runs the real replay on a fixed fixture + step budget, hashes all
outputs, and either records the golden baseline (--capture) or asserts the
current run matches it (--check).

Usage (from repo root, with the QFA PYTHONPATH set by this script):
    python services/replay/golden_gate.py --capture   # record baseline (pre-rewrite)
    python services/replay/golden_gate.py --check      # assert unchanged (after each rewrite step)

Fixture: 2026-05-25 / rth (smallest real session, exercises sweeps+absorption+
iceberg+dislocation). Bounded by STEP_LIMIT for a fast, deterministic baseline.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
for _p in (
    _REPO,
    _REPO / "services",
    _REPO / "contracts",
    _REPO / "services" / "scalp_models",
    _REPO / "services" / "replay",
    _REPO / "tools" / "rithmic_dashboard",
    _REPO / "tools" / "rithmic_analytics",
):
    s = str(_p)
    if s not in sys.path:
        sys.path.insert(0, s)

from replay.runner import ReplayConfig, run_replay  # noqa: E402

ANALYTICS_ROOT = _REPO / "tools" / "rithmic_analytics"
DASHBOARD_ROOT = _REPO / "tools" / "rithmic_dashboard"
CAPTURE_DATE = "2026-05-25"
SESSION = "rth"
STEP_LIMIT = 800  # bounded baseline: exercises detectors without a full-session run
# A larger budget so the scratch MBO file exceeds DEFAULT_TAIL_BYTES (20MB) and
# the bounded tail actually SLIDES — required to guard the incremental-tracker
# rewrite (Phase 4), whose window-back behavior the 800-step baseline (12.9MB,
# never slides) cannot exercise. NOTE: 2026-05-25 is a quiet session (20MB spans
# ~620s >> the 120s order TTL), so even this only exercises reader/parse slide,
# NOT window-back-binding eviction — that needs a busy-session fixture (see
# docs/perf/replay-incremental-tracker-design.md).
SLIDE_STEP_LIMIT = 1600
GOLDEN_PATH = Path(__file__).resolve().parent / "golden_gate_baseline.json"


def _baseline_path(steps: int) -> Path:
    here = Path(__file__).resolve().parent
    if steps == STEP_LIMIT:
        return here / "golden_gate_baseline.json"
    return here / f"golden_gate_baseline_{steps}.json"


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run_and_hash(work: Path, *, steps: int = STEP_LIMIT) -> dict[str, str]:
    """Run the replay into a fresh scratch dir; return {relpath: sha256} for all outputs."""
    out_path = work / "signals.jsonl"
    setup_path = work / "setups.jsonl"
    scratch = work / "scratch"
    run_replay(
        ReplayConfig(
            analytics_root=ANALYTICS_ROOT,
            dashboard_root=DASHBOARD_ROOT,
            capture_date=CAPTURE_DATE,
            session=SESSION,
            out_path=out_path,
            setup_out_path=setup_path,
            scratch_dir=scratch,
            limit_steps=steps,
        )
    )
    hashes: dict[str, str] = {}
    # Datasets (the real golden) — deterministic content, no wall-clock.
    for p in (out_path, setup_path):
        if p.exists():
            hashes[p.name] = _sha256_file(p)
    # Detector live-analysis outputs (intermediate but order-sensitive).
    live = scratch / "detector" / "live_analysis"
    if live.exists():
        for p in sorted(live.rglob("*.jsonl")):
            hashes[f"live/{p.name}"] = _sha256_file(p)
        for p in sorted(live.rglob("*_state.json")):
            hashes[f"live/{p.name}"] = _sha256_file(p)
    return hashes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--capture", action="store_true", help="record the golden baseline")
    ap.add_argument("--check", action="store_true", help="assert current run matches golden")
    ap.add_argument(
        "--steps",
        type=int,
        default=STEP_LIMIT,
        help=f"step budget (default {STEP_LIMIT}; {SLIDE_STEP_LIMIT} exercises tail-slide)",
    )
    args = ap.parse_args()
    if not (args.capture or args.check):
        ap.error("pass --capture or --check")

    baseline_path = _baseline_path(args.steps)
    import tempfile

    with tempfile.TemporaryDirectory(prefix="golden-gate-") as td:
        hashes = run_and_hash(Path(td), steps=args.steps)

    print(f"hashed {len(hashes)} output files from {CAPTURE_DATE}/{SESSION} @ {args.steps} steps")
    for name, digest in sorted(hashes.items()):
        print(f"  {digest[:12]}  {name}")

    if args.capture:
        baseline_path.write_text(json.dumps(hashes, indent=2, sort_keys=True), encoding="utf-8")
        print(f"\nbaseline written: {baseline_path}")
        return 0

    # --check
    if not baseline_path.exists():
        print(f"\nNO BASELINE at {baseline_path} — run --capture --steps {args.steps} first", file=sys.stderr)
        return 2
    golden = json.loads(baseline_path.read_text(encoding="utf-8"))
    mismatches = []
    for name, digest in hashes.items():
        if golden.get(name) != digest:
            mismatches.append((name, golden.get(name), digest))
    missing = [n for n in golden if n not in hashes]
    if mismatches or missing:
        print("\n=== GOLDEN MISMATCH (byte-exactness regression) ===", file=sys.stderr)
        for name, g, c in mismatches:
            print(f"  {name}: golden {str(g)[:12]} -> current {c[:12]}", file=sys.stderr)
        for n in missing:
            print(f"  MISSING output: {n}", file=sys.stderr)
        return 1
    print("\nGOLDEN OK — all outputs byte-identical")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
