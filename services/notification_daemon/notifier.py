"""Toast backends behind a small :class:`Notifier` protocol.

Two implementations:

- :class:`WindowsToastNotifier` — the real backend. It **lazy-imports**
  ``windows_toasts`` only inside ``__init__``, so merely *importing* this
  module (and therefore the whole daemon package) never fails on a box
  without the backend installed. Constructing one on such a box raises a
  clear :class:`NotifierUnavailable`.
- :class:`FakeNotifier` — records ``(title, body)`` calls in memory.
  Injected by tests so the full pipeline runs with zero toast backend
  (CI-safe).

The daemon depends only on the :class:`Notifier` protocol, never on a
concrete class, so swapping the fake in is a one-line injection.
"""

from __future__ import annotations

import logging
from typing import Protocol, runtime_checkable

logger = logging.getLogger("notification_daemon.notifier")


class NotifierUnavailable(RuntimeError):
    """Raised when a real toast backend cannot be constructed."""


@runtime_checkable
class Notifier(Protocol):
    """Anything that can show a title/body toast."""

    def notify(self, title: str, body: str) -> None:
        """Display a toast. Implementations must not raise on display errors
        that are merely cosmetic — log and continue (the daemon keeps running
        through a flaky toast subsystem)."""
        ...


class WindowsToastNotifier:
    """Real Windows toast backend (``windows-toasts``).

    The backend is imported and the toaster constructed lazily in
    ``__init__``; if the import fails (backend not installed, or not on
    Windows) we raise :class:`NotifierUnavailable` so the daemon can fall
    back to a logging-only mode rather than crash at import time.
    """

    def __init__(self, app_id: str = "MNQ Futures Dashboard") -> None:
        try:
            # Lazy import — keeps `import notification_daemon` safe everywhere.
            from windows_toasts import Toast, WindowsToaster
        except Exception as exc:  # pragma: no cover - depends on host
            raise NotifierUnavailable(
                "windows-toasts is not importable on this host; "
                "construct a FakeNotifier or run with --no-toast"
            ) from exc
        self._Toast = Toast
        self._toaster = WindowsToaster(app_id)

    def notify(self, title: str, body: str) -> None:
        try:
            toast = self._Toast()
            # windows-toasts renders one line per text fragment; split the
            # body so multi-line bodies show as multiple lines.
            toast.text_fields = [title, *body.split("\n")]
            self._toaster.show_toast(toast)
        except Exception:  # pragma: no cover - cosmetic display failure
            logger.exception("failed to show Windows toast (continuing)")


class FakeNotifier:
    """In-memory notifier that records calls. Test/CI substitute."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def notify(self, title: str, body: str) -> None:
        self.calls.append((title, body))


__all__ = [
    "Notifier",
    "NotifierUnavailable",
    "WindowsToastNotifier",
    "FakeNotifier",
]
