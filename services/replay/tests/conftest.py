from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

for path in (
    REPO_ROOT,
    REPO_ROOT / "services",
    REPO_ROOT / "services" / "replay",
    REPO_ROOT / "services" / "realtime_backend" / "tests",
    REPO_ROOT / "tools" / "rithmic_dashboard",
    REPO_ROOT / "tools" / "rithmic_analytics",
):
    text = str(path)
    if text not in sys.path:
        sys.path.insert(0, text)
