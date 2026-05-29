"""RA-062 — native Windows notification daemon.

A headless second WebSocket client on the RA-067 mock / RA-060 realtime
stream that fires native Windows toasts on CRITICAL alerts. Solves the
"browser was backgrounded, missed the alert" problem.

Public surface (import-safe on any box — the toast backend is lazy-imported
only when :class:`WindowsToastNotifier` is *constructed*):

- :func:`should_notify` / :func:`render_toast` — pure, unit-testable gate +
  renderer.
- :class:`Notifier` protocol, :class:`WindowsToastNotifier` (real),
  :class:`FakeNotifier` (records calls; CI-safe).
- :class:`RealtimeClient` — reconnecting WS client.
- :class:`ZonePriceMap` — in-memory ``{zone_id: price}`` tracker.
"""

from __future__ import annotations


def _bootstrap_sys_path() -> None:
    """Make ``contracts.realtime`` (repo root) and ``notification_daemon``
    (``services/``) importable when the package is loaded as a script from an
    arbitrary working directory.

    Runs *before* the submodule imports below — those pull in the realtime
    contract, so the repo root must already be on the path. Idempotent and a
    no-op under pytest (the conftest / ``pythonpath`` already set the roots).
    """
    import sys
    from pathlib import Path

    pkg_root = Path(__file__).resolve().parent  # services/notification_daemon
    for root in (pkg_root.parent, pkg_root.parent.parent):  # services/, repo root
        sp = str(root)
        if sp not in sys.path:
            sys.path.insert(0, sp)


_bootstrap_sys_path()

from notification_daemon.gate import should_notify  # noqa: E402
from notification_daemon.notifier import (  # noqa: E402
    FakeNotifier,
    Notifier,
    WindowsToastNotifier,
)
from notification_daemon.render import ZonePriceMap, render_toast  # noqa: E402

__all__ = [
    "should_notify",
    "render_toast",
    "ZonePriceMap",
    "Notifier",
    "WindowsToastNotifier",
    "FakeNotifier",
    "RealtimeClient",
]


def __getattr__(name: str) -> object:
    # Lazy re-export of RealtimeClient so importing the package never pulls
    # in asyncio websockets machinery unless the client is actually used.
    if name == "RealtimeClient":
        from notification_daemon.ws_client import RealtimeClient

        return RealtimeClient
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
