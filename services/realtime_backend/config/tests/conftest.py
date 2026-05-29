"""Test-level conftest.

The sys.path bootstrap lives one level up in ``config/conftest.py`` (loaded
before this package is collected, since collection imports
``realtime_backend.config``). This file is intentionally minimal.
"""
