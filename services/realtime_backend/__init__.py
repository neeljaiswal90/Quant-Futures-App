"""RA-060 realtime WebSocket backend for the MNQ futures dashboard.

Greenfield FastAPI + uvicorn service. It imports the RA-046–RA-059 detectors
from :mod:`rithmic_dashboard.features` *as a library* (in-process — never
re-shelling out), tails the live capture siblings with watchdog, classifies
confluence into CRITICAL / HIGH / MEDIUM tiers, and pushes
:mod:`contracts.realtime` envelopes over a WebSocket plus a REST ``/snapshot``.

The package self-bootstraps the repo root onto ``sys.path`` on import so that
``import contracts.realtime...`` resolves regardless of the directory the
process was launched from (mirrors ``contracts/realtime/tests/conftest.py``).
``rithmic_dashboard`` is installed editable, so it imports without help.
"""

from __future__ import annotations

import sys
from pathlib import Path

# services/realtime_backend/__init__.py -> repo root is parents[2].
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

REPO_ROOT = _REPO_ROOT

__all__ = ["REPO_ROOT"]
