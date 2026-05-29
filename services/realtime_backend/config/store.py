"""Persistence layer for the alert configuration (RA-063).

:class:`AlertConfigStore` is a thin, dependency-light wrapper around a single
JSON document on disk (``data/dashboard/alert_config.json`` by default):

- **load-or-seed-defaults** on construction: if the file is missing the
  shipped :func:`default_alert_config` is used (and persisted lazily on the
  first :meth:`replace`); a present file is parsed and validated against the
  contract :class:`AlertConfig`.
- **atomic write**: writes to a uniquely-named temp file in the *same*
  directory then :func:`os.replace` swaps it in, so a reader never observes a
  half-written file and a crash mid-write cannot corrupt the live document.
- **in-memory cache + write-through**: :meth:`get` returns the cached
  object; :meth:`replace` swaps the cache *and* persists. The cached object is
  the single source of truth the gating path reads on every event — that is
  the hot-reload mechanism (no mtime poller). :meth:`reload_from_disk` exists
  for out-of-band edits.

The path is injectable so tests can point at a ``tmp_path``.
"""

from __future__ import annotations

import os
import tempfile
import threading
from pathlib import Path

from contracts.realtime.config import AlertConfig, default_alert_config

from realtime_backend import REPO_ROOT

# Repo-root-relative default. ``data/dashboard/`` does not exist yet; the first
# write creates it (``mkdir(parents=True)``).
DEFAULT_CONFIG_PATH: Path = REPO_ROOT / "data" / "dashboard" / "alert_config.json"


class AlertConfigStore:
    """Load-or-seed, cache, and atomically persist a single :class:`AlertConfig`.

    Construction never writes to disk: a missing file seeds the in-memory
    cache from :func:`default_alert_config` and the file is materialized on the
    first :meth:`replace`. This keeps a read-only GET from creating files as a
    side effect.
    """

    def __init__(self, path: Path | str | None = None) -> None:
        self._path = Path(path) if path is not None else DEFAULT_CONFIG_PATH
        # Re-entrant so a future caller could compose replace() inside a held
        # lock without self-deadlock; writes here are short and uncontended.
        self._lock = threading.RLock()
        self._cache: AlertConfig = self._load_or_default()

    # ----- properties ----------------------------------------------------

    @property
    def path(self) -> Path:
        """The JSON document path this store reads/writes."""
        return self._path

    # ----- reads ---------------------------------------------------------

    def get(self) -> AlertConfig:
        """Return the cached config (the object gating reads each event).

        Returns the live cached instance, not a copy: callers must treat it as
        read-only. :meth:`replace` swaps the reference under the lock, so a
        concurrent reader either sees the whole old or the whole new object.
        """
        with self._lock:
            return self._cache

    # ----- writes --------------------------------------------------------

    def replace(self, config: AlertConfig) -> AlertConfig:
        """Persist ``config`` atomically and swap it into the cache.

        Write-through: disk and cache move together under the lock. Returns the
        persisted (now-cached) document so a PUT handler can echo it back.
        """
        with self._lock:
            self._atomic_write(config)
            self._cache = config
            return self._cache

    def reload_from_disk(self) -> AlertConfig:
        """Re-read the document from disk into the cache (out-of-band edits).

        A missing file falls back to defaults (without writing). Use this for
        manual edits made while the process is running; the normal hot-reload
        path is :meth:`replace`, which the PUT handler drives.
        """
        with self._lock:
            self._cache = self._load_or_default()
            return self._cache

    # ----- internals -----------------------------------------------------

    def _load_or_default(self) -> AlertConfig:
        if not self._path.exists():
            return default_alert_config()
        raw = self._path.read_text(encoding="utf-8")
        # ``model_validate_json`` enforces ``extra="forbid"`` from the contract,
        # so a hand-edited file with stray keys fails loudly rather than
        # silently dropping them.
        return AlertConfig.model_validate_json(raw)

    def _atomic_write(self, config: AlertConfig) -> None:
        """Write ``config`` to a temp file in the target dir, then os.replace."""
        directory = self._path.parent
        directory.mkdir(parents=True, exist_ok=True)
        payload = config.model_dump_json(indent=2) + "\n"
        # NamedTemporaryFile in the *same* directory guarantees os.replace is an
        # atomic same-filesystem rename (cross-device renames are not atomic).
        fd, tmp_name = tempfile.mkstemp(
            prefix=self._path.name + ".",
            suffix=".tmp",
            dir=directory,
        )
        tmp_path = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_path, self._path)
        except BaseException:
            # Never leave a stray temp file behind on failure.
            tmp_path.unlink(missing_ok=True)
            raise


__all__ = ["AlertConfigStore", "DEFAULT_CONFIG_PATH"]
