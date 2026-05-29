"""Retired V1 static dashboard CLI."""

from __future__ import annotations

import sys

RETIREMENT_MESSAGE = (
    "The V1 static HTML dashboard generator is retired. "
    "Use the v2 realtime dashboard stack instead: "
    "D:\\Quant-futures-app\\run_realtime_stack.ps1"
)


def main(argv: list[str] | None = None) -> int:
    """Fail loudly for direct callers of the retired V1 generator."""

    _ = argv
    print(RETIREMENT_MESSAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
