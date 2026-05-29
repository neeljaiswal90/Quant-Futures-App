"""Tests for RA-020 retrofits of ``D:\\MNQ-Futures\\tools\\vp_*.py``.

Three scripts retrofitted with ``--source rithmic`` / ``--emit-json`` flags:
    - vp_15m_compute.py
    - vp_htf_globex_prep.py
    - vp_multi_tf_full.py

Each script uses a different VP algorithm. This is BY DESIGN — Neel has
tuned them for distinct use cases. The tests verify each script's algorithm
produces consistent results across data sources, NOT that the three scripts
produce identical output.

Algorithm differences (do not "fix"):
    - vp_multi_tf_full.py: volume-distributed across price range, single-bin VAH/VAL
    - vp_15m_compute.py:   typical-price single-bin, two-bin Market Profile expansion
    - vp_htf_globex_prep.py: typical-price single-bin, +600pt distance filter

Test layers:
    1. Backward-compat byte-for-byte: invoking each script with no new flags
       must reproduce the captured baseline exactly.
    2. ``--emit-json``: when present, the written file validates against
       ``zone_schema.json``.
    3. ``--source rithmic``: invocation against the real OBS-01 fixture
       succeeds. The HTF script's known single-session limitation is exercised
       as a clean exit-2 error.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from rithmic_analytics.core.schema import validate_envelope

from .conftest import REAL_OBS01

_MNQ_TOOLS = Path(r"D:\MNQ-Futures\tools")
_VP_15M = _MNQ_TOOLS / "vp_15m_compute.py"
_VP_HTF = _MNQ_TOOLS / "vp_htf_globex_prep.py"
_VP_MULTI_TF = _MNQ_TOOLS / "vp_multi_tf_full.py"

_BASELINE_DIR = Path(__file__).resolve().parent / "fixtures" / "vp_baselines"
_BASELINE_15M = _BASELINE_DIR / "vp_15m_compute.baseline.txt"
_BASELINE_HTF = _BASELINE_DIR / "vp_htf_globex_prep.baseline.txt"
_BASELINE_MULTI_TF = _BASELINE_DIR / "vp_multi_tf_full.baseline.txt"


def _run(script: Path, args: list[str], timeout: int = 60) -> subprocess.CompletedProcess[bytes]:
    """Invoke a script with the given args; capture stdout/stderr bytes."""
    return subprocess.run(
        [sys.executable, str(script), *args],
        capture_output=True,
        timeout=timeout,
    )


# ===========================================================================
# Layer 1: backward-compat byte-for-byte
# ===========================================================================


@pytest.mark.skipif(not _VP_15M.exists(), reason="vp_15m_compute.py not present")
@pytest.mark.skipif(not _BASELINE_15M.exists(), reason="baseline file missing")
def test_vp_15m_backward_compat_byte_for_byte() -> None:
    result = _run(_VP_15M, [])
    assert result.returncode == 0, f"script exited {result.returncode}: {result.stderr!r}"
    baseline = _BASELINE_15M.read_bytes()
    assert result.stdout == baseline, "vp_15m_compute output diverged from baseline"


@pytest.mark.skipif(not _VP_HTF.exists(), reason="vp_htf_globex_prep.py not present")
@pytest.mark.skipif(not _BASELINE_HTF.exists(), reason="baseline file missing")
def test_vp_htf_backward_compat_byte_for_byte() -> None:
    result = _run(_VP_HTF, [])
    assert result.returncode == 0, f"script exited {result.returncode}: {result.stderr!r}"
    baseline = _BASELINE_HTF.read_bytes()
    assert result.stdout == baseline, "vp_htf_globex_prep output diverged from baseline"


@pytest.mark.skipif(not _VP_MULTI_TF.exists(), reason="vp_multi_tf_full.py not present")
@pytest.mark.skipif(not _BASELINE_MULTI_TF.exists(), reason="baseline file missing")
def test_vp_multi_tf_backward_compat_byte_for_byte() -> None:
    result = _run(_VP_MULTI_TF, [])
    assert result.returncode == 0, f"script exited {result.returncode}: {result.stderr!r}"
    baseline = _BASELINE_MULTI_TF.read_bytes()
    assert result.stdout == baseline, "vp_multi_tf_full output diverged from baseline"


# ===========================================================================
# Layer 2: --emit-json validates against the canonical schema
# ===========================================================================


@pytest.mark.skipif(not _VP_15M.exists(), reason="vp_15m_compute.py not present")
def test_vp_15m_emit_json_validates_against_schema(tmp_path: Path) -> None:
    out = tmp_path / "zones.json"
    result = _run(_VP_15M, ["--emit-json", str(out)])
    assert result.returncode == 0, f"stderr: {result.stderr!r}"
    payload = json.loads(out.read_text(encoding="utf-8"))
    validate_envelope(payload)
    assert payload["symbol"] == "MNQ"
    assert payload["timeframe"] == "15m"
    assert payload["data_source"] == "tradingview"


@pytest.mark.skipif(not _VP_HTF.exists(), reason="vp_htf_globex_prep.py not present")
def test_vp_htf_emit_json_validates_against_schema(tmp_path: Path) -> None:
    out = tmp_path / "zones.json"
    result = _run(_VP_HTF, ["--emit-json", str(out)])
    assert result.returncode == 0, f"stderr: {result.stderr!r}"
    payload = json.loads(out.read_text(encoding="utf-8"))
    validate_envelope(payload)
    assert payload["symbol"] == "MNQ"
    assert payload["timeframe"] == "htf"


@pytest.mark.skipif(not _VP_MULTI_TF.exists(), reason="vp_multi_tf_full.py not present")
def test_vp_multi_tf_emit_json_validates_against_schema(tmp_path: Path) -> None:
    out = tmp_path / "zones.json"
    result = _run(_VP_MULTI_TF, ["--emit-json", str(out)])
    assert result.returncode == 0, f"stderr: {result.stderr!r}"
    payload = json.loads(out.read_text(encoding="utf-8"))
    validate_envelope(payload)
    assert payload["symbol"] == "MNQ"
    assert payload["timeframe"] == "multi"
    # Multi-TF zones should include some confluence clusters (TV cache has plenty
    # of HVNs across 7 TFs → at least 1 zone with multi_tf_count >= 2).
    multi_tf_zones = [z for z in payload["zones"] if (z.get("multi_tf_count") or 0) >= 2]
    assert len(multi_tf_zones) > 0


# ===========================================================================
# Layer 3: --source rithmic
# ===========================================================================


@pytest.mark.skipif(not _VP_15M.exists(), reason="vp_15m_compute.py not present")
@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real OBS-01 fixture not present")
def test_vp_15m_source_rithmic_runs(tmp_path: Path) -> None:
    out = tmp_path / "zones.json"
    result = _run(
        _VP_15M,
        [
            "--source", "rithmic",
            "--rithmic-jsonl", str(REAL_OBS01),
            "--emit-json", str(out),
        ],
    )
    assert result.returncode == 0, f"stderr: {result.stderr!r}"
    payload = json.loads(out.read_text(encoding="utf-8"))
    validate_envelope(payload)
    assert payload["data_source"] == "rithmic"
    # 37-minute fixture aggregated to 15m bars → 3-4 bars
    assert 1 <= payload["bars_used"] <= 5


@pytest.mark.skipif(not _VP_HTF.exists(), reason="vp_htf_globex_prep.py not present")
@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real OBS-01 fixture not present")
def test_vp_htf_source_rithmic_exits_cleanly_with_single_session_input() -> None:
    """HTF script's documented limitation: single-session Rithmic input has
    insufficient Daily bars. The script must fail-fast with a clear message
    and exit 2 (bad config), not crash with IndexError."""
    result = _run(
        _VP_HTF,
        ["--source", "rithmic", "--rithmic-jsonl", str(REAL_OBS01)],
    )
    assert result.returncode == 2, (
        f"expected exit 2 (bad config), got {result.returncode}: {result.stderr!r}"
    )
    assert b"requires >= 2 daily bars" in result.stderr


@pytest.mark.skipif(not _VP_MULTI_TF.exists(), reason="vp_multi_tf_full.py not present")
@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real OBS-01 fixture not present")
def test_vp_multi_tf_source_rithmic_runs(tmp_path: Path) -> None:
    """Multi-TF script tolerates single-session input (each TF gets >= 1 bar)
    even though long-TF output is degraded."""
    out = tmp_path / "zones.json"
    result = _run(
        _VP_MULTI_TF,
        [
            "--source", "rithmic",
            "--rithmic-jsonl", str(REAL_OBS01),
            "--emit-json", str(out),
        ],
    )
    assert result.returncode == 0, f"stderr: {result.stderr!r}"
    payload = json.loads(out.read_text(encoding="utf-8"))
    validate_envelope(payload)
    assert payload["data_source"] == "rithmic"


# ===========================================================================
# Pre-flight error handling
# ===========================================================================


@pytest.mark.skipif(not _VP_15M.exists(), reason="vp_15m_compute.py not present")
def test_vp_15m_source_rithmic_without_jsonl_arg_exits_2() -> None:
    result = _run(_VP_15M, ["--source", "rithmic"])
    assert result.returncode == 2
    assert b"--rithmic-jsonl" in result.stderr


@pytest.mark.skipif(not _VP_HTF.exists(), reason="vp_htf_globex_prep.py not present")
def test_vp_htf_source_rithmic_without_jsonl_arg_exits_2() -> None:
    result = _run(_VP_HTF, ["--source", "rithmic"])
    assert result.returncode == 2
    assert b"--rithmic-jsonl" in result.stderr


@pytest.mark.skipif(not _VP_MULTI_TF.exists(), reason="vp_multi_tf_full.py not present")
def test_vp_multi_tf_source_rithmic_without_jsonl_arg_exits_2() -> None:
    result = _run(_VP_MULTI_TF, ["--source", "rithmic"])
    assert result.returncode == 2
    assert b"--rithmic-jsonl" in result.stderr


# ===========================================================================
# Multi-dim tolerance comparison (deferred to a matched-fixture build)
# ===========================================================================


@pytest.mark.skip(
    reason=(
        "Multi-dim TV-vs-Rithmic tolerance comparison requires fixtures covering "
        "the same time window in BOTH formats. The validated OBS-01 fixture is 37 "
        "minutes; TV cached JSON files cover many days. Deferred until matched "
        "fixtures exist — see docs/future_work.md."
    )
)
def test_multi_dimensional_tolerance_tv_vs_rithmic() -> None:
    # Placeholder for the eventual multi-dimensional comparison:
    #   - VPOC within 1 bin (5pt)
    #   - VAH within 1 bin
    #   - VAL within 1 bin
    #   - Top-3 HVN set overlap >= 2 of 3
    #   - ATR(14) within 5%
    #   - Total volume within 10%
    pass


# Reference: silence ruff unused-import — shutil is here for future test additions
# that may need to copy files around (e.g., synthetic TV cache fixture)
_ = shutil
