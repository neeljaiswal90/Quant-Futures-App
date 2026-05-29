"""Make both the daemon package and the repo contract importable.

This conftest lives at the package root (``services/notification_daemon/``)
so it is picked up no matter which directory pytest is invoked from. It puts
two roots on ``sys.path``:

- ``services/`` so ``import notification_daemon`` resolves (the package is
  ``services/notification_daemon/``).
- the repo root so ``import contracts.realtime.events`` resolves (mirrors
  ``contracts/realtime/tests/conftest.py``).
"""

from __future__ import annotations

import sys
from pathlib import Path

_PACKAGE_ROOT = Path(__file__).resolve().parent  # services/notification_daemon
_SERVICES_ROOT = _PACKAGE_ROOT.parent  # services/
_REPO_ROOT = _SERVICES_ROOT.parent  # repo root

for _p in (_SERVICES_ROOT, _REPO_ROOT):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))
