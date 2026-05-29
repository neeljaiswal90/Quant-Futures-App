"""Path bootstrap for the RA-063 config package tests.

Lives at the package root (above ``tests/``) so pytest loads it *before*
collecting any test module — which is important because importing the test
package walks through ``realtime_backend.config.__init__`` (which does
``import realtime_backend``). Putting both ``services/`` (for
``import realtime_backend``) and the repo root (for ``import contracts.realtime``)
on ``sys.path`` here guarantees those imports resolve regardless of the cwd
pytest is invoked from. Mirrors ``services/realtime_backend/tests/conftest.py``.
"""

from __future__ import annotations

import sys
from pathlib import Path

# config/conftest.py -> services/ is parents[2]; repo root is parents[3].
_SERVICES_DIR = Path(__file__).resolve().parents[2]
_REPO_ROOT = _SERVICES_DIR.parent
for _p in (str(_SERVICES_DIR), str(_REPO_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)
