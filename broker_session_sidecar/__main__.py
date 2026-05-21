"""Allow `python -m broker_session_sidecar` from the repository root."""

from services.broker_session_sidecar.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
