"""RA-062 daemon entry point — wiring + lifecycle.

Composes the pieces (config → zone map → gate → renderer → notifier) into a
single ``on_message`` handler, hands it to the reconnecting
:class:`RealtimeClient`, and manages process lifecycle (signals, graceful
shutdown, structured logging).

Run::

    python -m notification_daemon.run                 # default ws://127.0.0.1:8765/ws
    python -m notification_daemon.run --url ws://host:port/ws
    python -m notification_daemon.run --no-toast      # log-only (no backend)
    python -m notification_daemon.run --tray          # DEFERRED (see note)

The ``--tray`` flag is accepted but tray support is deferred (pystray is not
installed). Passing it logs a notice and runs the core daemon unchanged.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import signal
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

# Importing the package runs notification_daemon/__init__._bootstrap_sys_path,
# which puts the repo root on sys.path so the contract import below resolves
# even when launched as `python -m notification_daemon.run` from services/.
from contracts.realtime.config import AlertConfig
from contracts.realtime.events import (
    PT,
    RealtimeMessage,
    SnapshotPayload,
    ZoneUpdatePayload,
)
from notification_daemon.config_loader import load_alert_config
from notification_daemon.gate import should_notify
from notification_daemon.notifier import (
    FakeNotifier,
    Notifier,
    NotifierUnavailable,
    WindowsToastNotifier,
)
from notification_daemon.render import ZonePriceMap, render_toast
from notification_daemon.ws_client import RealtimeClient

logger = logging.getLogger("notification_daemon")

DEFAULT_URL = "ws://127.0.0.1:8765/ws"


def _now_pt() -> datetime:
    """Current wall-clock in the trader timezone (America/Los_Angeles)."""
    return datetime.now(PT)


@dataclass
class NotificationDaemon:
    """Stateful message handler: zone map + gate + render + notify.

    Construction takes the injected collaborators (notifier + config) so the
    end-to-end test wires a :class:`FakeNotifier` and a chosen config with no
    toast backend and no real clock dependency beyond ``now_pt``.
    """

    notifier: Notifier
    config: AlertConfig
    zones: ZonePriceMap = field(default_factory=ZonePriceMap)
    notified: int = 0
    seen: int = 0

    def _ingest_zones(self, msg: RealtimeMessage) -> None:
        """Feed snapshot / zone-update frames into the zone-price map."""
        payload = msg.payload
        if isinstance(payload, (SnapshotPayload, ZoneUpdatePayload)):
            self.zones.update(payload.zones)
            logger.debug("zone map now has %d levels", len(self.zones))

    async def on_message(self, msg: RealtimeMessage) -> None:
        """Handle one inbound frame: maybe update zones, maybe fire a toast."""
        self.seen += 1
        self._ingest_zones(msg)

        now_pt = _now_pt()
        if not should_notify(msg, self.config, now_pt):
            return

        title, body = render_toast(msg, self.zones)
        logger.info("CRITICAL toast: %s | %s", title, body.replace("\n", " / "))
        try:
            self.notifier.notify(title, body)
            self.notified += 1
        except Exception:
            logger.exception("notifier raised while showing toast")


def _build_notifier(no_toast: bool) -> Notifier:
    """Pick a notifier: real toast backend, or a log-only fake on failure."""
    if no_toast:
        logger.info("--no-toast: running with a log-only FakeNotifier")
        return FakeNotifier()
    try:
        notifier = WindowsToastNotifier()
        logger.info("using WindowsToastNotifier")
        return notifier
    except NotifierUnavailable as exc:
        logger.warning("toast backend unavailable (%s); falling back to log-only", exc)
        return FakeNotifier()


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="notification_daemon.run",
        description="RA-062 native Windows notification daemon.",
    )
    parser.add_argument("--url", default=DEFAULT_URL, help=f"WS stream URL (default {DEFAULT_URL})")
    parser.add_argument(
        "--config", default=None, help="Path to alert_config.json (default: data/dashboard/...)"
    )
    parser.add_argument(
        "--no-toast", action="store_true", help="Do not use a real toast backend (log only)."
    )
    parser.add_argument(
        "--tray", action="store_true", help="DEFERRED: tray icon (pystray not installed)."
    )
    parser.add_argument("--log-level", default="INFO", help="Logging level (default INFO).")
    return parser.parse_args(argv)


async def _run_async(args: argparse.Namespace) -> None:
    config = load_alert_config(Path(args.config) if args.config else None)
    notifier = _build_notifier(args.no_toast)

    if args.tray:
        logger.info("--tray requested but tray support is DEFERRED (pystray not installed)")

    daemon = NotificationDaemon(notifier=notifier, config=config)
    stop_event = asyncio.Event()
    client = RealtimeClient(args.url, daemon.on_message, stop_event=stop_event)

    # Graceful shutdown on SIGINT/SIGTERM where supported.
    loop = asyncio.get_event_loop()
    for sig_name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, sig_name, None)
        if sig is None:
            continue
        # add_signal_handler is unavailable on Windows event loops; the
        # KeyboardInterrupt path in main() handles Ctrl-C there.
        with contextlib.suppress(NotImplementedError, RuntimeError):
            loop.add_signal_handler(sig, stop_event.set)

    logger.info("daemon up; streaming %s", args.url)
    try:
        await client.run()
    finally:
        logger.info("daemon shutting down (seen=%d, notified=%d)", daemon.seen, daemon.notified)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    _configure_logging(args.log_level)
    try:
        asyncio.run(_run_async(args))
    except KeyboardInterrupt:
        logger.info("interrupted; exiting")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
