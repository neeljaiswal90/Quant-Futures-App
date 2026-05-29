"""Shared pytest fixtures and paths.

Real-data fixtures live outside the package at ``D:\\Quant-futures-app\\data\\
probes\\infra01\\full\\``. Tests that depend on them mark themselves with
``@pytest.mark.skipif(not REAL_*.exists(), ...)`` so the suite still passes on
a machine where the captures aren't available (e.g. CI).
"""

from __future__ import annotations

from pathlib import Path

FIXTURE_ROOT: Path = Path(r"D:\Quant-futures-app\data\probes\infra01\full")

REAL_OBS01: Path = FIXTURE_ROOT / "l1-trade-post04d.obs01.jsonl"
REAL_MBP1: Path = FIXTURE_ROOT / "databento" / "MNQM6_mbp1_post04d.normalized.jsonl"
REAL_MBO: Path = FIXTURE_ROOT / "databento" / "MNQM6_mbo_post04d.normalized.jsonl"
