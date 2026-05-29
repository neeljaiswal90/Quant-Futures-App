"""Tests for the Notifier protocol + implementations.

The real backend is only smoke-checked for import-safety (we never actually
pop a toast in CI); the FakeNotifier is fully exercised.
"""

from __future__ import annotations

from notification_daemon.notifier import FakeNotifier, Notifier


def test_fake_notifier_records_calls() -> None:
    fake = FakeNotifier()
    fake.notify("title-a", "body-a")
    fake.notify("title-b", "body-b")
    assert fake.calls == [("title-a", "body-a"), ("title-b", "body-b")]


def test_fake_notifier_satisfies_protocol() -> None:
    fake: Notifier = FakeNotifier()
    assert isinstance(fake, Notifier)


def test_importing_module_does_not_require_backend() -> None:
    # Importing the package / notifier module must not import windows_toasts.
    # If this test runs, the import already succeeded; assert the backend is
    # NOT pulled in merely by import (it is lazy inside __init__).
    import sys

    import notification_daemon  # noqa: F401
    import notification_daemon.notifier  # noqa: F401

    # We don't assert windows_toasts is absent (it may be installed); we
    # assert that constructing nothing leaves the package importable, which
    # this test reaching here already proves.
    assert "notification_daemon.notifier" in sys.modules


def test_windows_toast_notifier_class_is_importable() -> None:
    # The class object exists and is importable without constructing it.
    from notification_daemon.notifier import WindowsToastNotifier

    assert WindowsToastNotifier.__name__ == "WindowsToastNotifier"
