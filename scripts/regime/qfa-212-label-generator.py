#!/usr/bin/env python
"""QFA-212 label generator wrapper.

The archive-native validator owns the shared implementation and emits both
regime-labels.json and the validation report. This wrapper exists as the
label-generator entry point required by the QFA-212 dispatch packet.
"""

from __future__ import annotations

import runpy
from pathlib import Path

SCRIPT = Path(__file__).with_name("qfa-212-archive-native-validator.py")
runpy.run_path(str(SCRIPT), run_name="__main__")
