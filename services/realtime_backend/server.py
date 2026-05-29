"""CLI entrypoint — parse args, build the app, run uvicorn.

Boot with::

    python -m realtime_backend --host 127.0.0.1 --port 8765

(run from ``D:\\Quant-futures-app\\services`` so ``realtime_backend`` and the
bootstrapped repo-root imports resolve). ``--host`` / ``--port`` override the
GREEN-LIT defaults (127.0.0.1:8765); ``--session`` / ``--trading-date`` pin the
session instead of resolving it from the wall clock.
"""

from __future__ import annotations

import argparse
from collections.abc import Sequence

import uvicorn

from realtime_backend.app import create_app
from realtime_backend.settings import settings_from_env


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="realtime_backend",
        description="RA-060 realtime WebSocket backend for the MNQ dashboard.",
    )
    parser.add_argument("--host", default=None, help="Bind host (default 127.0.0.1).")
    parser.add_argument("--port", type=int, default=None, help="Bind port (default 8765).")
    parser.add_argument(
        "--analytics-root",
        default=None,
        help="Override the rithmic_analytics root path.",
    )
    parser.add_argument(
        "--session",
        default=None,
        choices=["rth", "globex", "between"],
        help="Pin the session instead of resolving from the wall clock.",
    )
    parser.add_argument(
        "--trading-date",
        default=None,
        help="Pin the trading date (YYYY-MM-DD).",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        help="uvicorn log level (default info).",
    )
    return parser.parse_args(argv)


def build_settings_from_args(args: argparse.Namespace) -> object:
    """Layer CLI args over env + defaults into a Settings instance."""
    from pathlib import Path

    overrides: dict[str, object] = {
        "host": args.host,
        "port": args.port,
        "session_override": args.session,
        "trading_date_override": args.trading_date,
    }
    if args.analytics_root is not None:
        overrides["analytics_root"] = Path(args.analytics_root)
    return settings_from_env(**overrides)


def main(argv: Sequence[str] | None = None) -> None:
    args = _parse_args(argv)
    settings = build_settings_from_args(args)
    app = create_app(settings)  # type: ignore[arg-type]
    uvicorn.run(
        app,
        host=settings.host,  # type: ignore[attr-defined]
        port=settings.port,  # type: ignore[attr-defined]
        log_level=args.log_level,
    )


if __name__ == "__main__":
    main()
