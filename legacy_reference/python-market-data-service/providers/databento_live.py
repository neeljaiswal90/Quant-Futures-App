"""
Databento live ingest module (v3.1 Phase 2, DATA-09).

Connects to Databento, subscribes to MBO + definitions + statistics +
status, dispatches each record via the provider-neutral handler, and
maintains connection-state metrics that /lob/health v2 surfaces.

Scope boundaries:
  - This module does NOT reconstruct the order book. DATA-11 ports the
    MBO kernel; DATA-09 only delivers records.
  - This module does NOT become authoritative quote source. DATA-05
    startup selector still fails closed on MARKET_DATA_PROVIDER=databento
    until the Phase 2 ticket chain (09..16) is fully merged AND the
    selector is updated in a later ticket to flip from
    fail_databento_not_wired to use_databento.
  - Raw DBN bytes to disk (DATA-14) is optional: when
    ``DATABENTO_RECORD_RAW_DBN`` is true and ``DATABENTO_DBN_ARCHIVE_PATH``
    points at a directory, ``Live.add_stream`` writes exclusive ``.dbn``
    segments plus JSON sidecar manifests. Segments roll on **UTC calendar
    day change** (from wire ``ts_recv`` when present) even if the TCP
    session stays up, on **each reconnect** (new ``_run_once``), and once
    on the first **DATA-10** session pin (pre-pin vs post-pin traffic).

Reconnect policy:
  Exponential backoff with full jitter on every disconnect. Start at
  1s, double each retry up to a cap of 30s. Reconnect attempts are
  counted on ProviderHealth.reconnect_count. An unrecoverable error
  (bad credentials, subscription rejected) stops the loop and surfaces
  via health.last_error.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import replace
from typing import Callable, Iterable, Optional

import json
import os
from pathlib import Path
from typing import Optional as _Optional

from .base import (
    MarketDataProvider,
    ProviderHealth,
    ProviderRecord,
    RecordHandler,
)
from .symbol_resolver import (
    PinnedMapping,
    SymbolResolver,
    SymbolResolverError,
)

# Semver of the session contract manifest shape. Must stay in lockstep
# with src/autotrade/session-contract-manifest.ts::SESSION_CONTRACT_MANIFEST_VERSION.
SESSION_CONTRACT_MANIFEST_VERSION = "1.0.0"

# CME month codes → month number. Used to derive expiry from raw_symbol.
_CME_MONTH_CODES = {
    "F": 1, "G": 2, "H": 3, "J": 4, "K": 5, "M": 6,
    "N": 7, "Q": 8, "U": 9, "V": 10, "X": 11, "Z": 12,
}

# Tick size per supported root. Must stay consistent with the TS-side
# contracts.ts registry; hardcoded here so the sidecar doesn't need a
# cross-language import.
_TICK_SIZE_BY_ROOT = {"NQ": 0.25, "MNQ": 0.25, "ES": 0.25, "MES": 0.25}


def _env_flag_truthy(value: _Optional[str]) -> bool:
    if value is None:
        return False
    return value.strip().lower() in ("1", "true", "yes", "on")


def _raw_dbn_settings_from_env(
    *,
    record_raw_dbn: _Optional[bool] = None,
    dbn_archive_path: _Optional[str] = None,
    dbn_use_zstd_wire: _Optional[bool] = None,
) -> tuple[bool, _Optional[str], bool]:
    """
    DATA-14: mirror DATA-01 / ``env.ts`` knobs for raw DBN archival.

    When ``record_raw_dbn`` is None, read ``DATABENTO_RECORD_RAW_DBN``.
    When ``dbn_use_zstd_wire`` is None, read ``DATABENTO_DBN_ZSTD_WIRE``.
    """
    if record_raw_dbn is None:
        record_raw_dbn = _env_flag_truthy(os.environ.get("DATABENTO_RECORD_RAW_DBN"))
    if dbn_archive_path is not None:
        path = (dbn_archive_path or "").strip() or None
    else:
        path = (os.environ.get("DATABENTO_DBN_ARCHIVE_PATH") or "").strip() or None
    if dbn_use_zstd_wire is None:
        dbn_use_zstd_wire = _env_flag_truthy(os.environ.get("DATABENTO_DBN_ZSTD_WIRE"))
    return record_raw_dbn, path, dbn_use_zstd_wire


def _utc_archive_date_yyyy_mm_dd(ts_recv_ns: _Optional[int]) -> str:
    """
    DATA-14: calendar UTC date for archive rotation (YYYY-MM-DD).

    Prefers wire ``ts_recv_ns`` when present so a long-lived TCP session
    still rolls the DBN file at the true exchange-day boundary carried
    on the records; falls back to wall-clock UTC when absent.
    """
    from datetime import datetime, timezone

    if isinstance(ts_recv_ns, int) and ts_recv_ns > 0:
        sec = ts_recv_ns / 1_000_000_000.0
        return datetime.fromtimestamp(sec, tz=timezone.utc).date().isoformat()
    return datetime.now(timezone.utc).date().isoformat()


# ─── Backoff policy ─────────────────────────────────────────────────────────

INITIAL_BACKOFF_SEC = 1.0
MAX_BACKOFF_SEC = 30.0
BACKOFF_MULTIPLIER = 2.0


def next_backoff(current: float) -> float:
    """
    Exponential backoff with full jitter. Pure function so tests can
    assert the schedule deterministically.

    Returns a delay in [0, min(MAX, current * MULTIPLIER)]. The full-
    jitter form avoids the thundering-herd behavior of a naive
    exponential schedule when multiple sidecars reconnect in sync.
    """
    capped = min(MAX_BACKOFF_SEC, max(INITIAL_BACKOFF_SEC, current) * BACKOFF_MULTIPLIER)
    return random.uniform(0.0, capped)


def _kind_from_record(rec: object) -> str:
    """
    Map a native Databento record class to a ProviderRecord.kind string.
    The mapping is deliberately narrow — unknown kinds pass through as
    'other' and the dispatcher logs them.
    """
    cls = type(rec).__name__
    mapping = {
        "MboMsg": "mbo",
        "Mbp1Msg": "mbp1",
        "MBP1Msg": "mbp1",
        # DATA-11 (v3.2.1 §2.1): MBP-10 is the L2-canonical schema.
        # Map both the pep8 and all-caps class names databento-python
        # has shipped at various versions.
        "Mbp10Msg": "mbp10",
        "MBP10Msg": "mbp10",
        "TradeMsg": "trade",
        "InstrumentDefMsg": "definition",
        "StatisticsMsg": "statistic",
        "StatusMsg": "status",
        "SystemMsg": "status",
        "SymbolMappingMsg": "symbol_mapping",
        "ErrorMsg": "error",
    }
    return mapping.get(cls, f"other:{cls}")


class DatabentoLiveProvider(MarketDataProvider):
    """
    Databento live-client adapter. Wraps `databento.Live` behind the
    provider-neutral interface so the sidecar can swap providers at
    startup without touching the dispatch layer.

    The `client_factory` argument is injected in tests so the reconnect /
    backoff / dispatch logic can be exercised without the real SDK.
    """

    kind = "databento"

    def __init__(
        self,
        *,
        api_key: str,
        dataset: str,
        stype_in: str,
        parent_symbols: Iterable[str],
        # DATA-09 retrofit (v3.2.1 §2.1): Databento path is now L2 canonical.
        # Default subscription is MBP-10 (top-10 book levels) + trades +
        # definition + statistics + status. MBO is no longer the primary
        # schema — any remaining MBO-dependent code is slated for removal
        # in DATA-11 (new mbp10_book_state.py) and may only be retained
        # behind a Bookmap-L3-only adapter.
        #
        # Rollback: set DATABENTO_SCHEMAS in the environment to the
        # legacy "mbo,definition,statistics,status" string, or pass an
        # explicit `schemas=` kwarg. The env override is consumed in
        # app._construct_databento_provider_from_env.
        schemas: Iterable[str] = (
            "mbp-10", "trades", "definition", "statistics", "status",
        ),
        client_factory=None,
        sleeper=None,
        session_id: _Optional[str] = None,
        manifest_path: _Optional[str] = None,
        logger: _Optional[Callable[[str], None]] = None,
        record_raw_dbn: _Optional[bool] = None,
        dbn_archive_path: _Optional[str] = None,
        dbn_use_zstd_wire: _Optional[bool] = None,
    ) -> None:
        if not api_key:
            raise ValueError("databento_live: api_key is required")
        if not dataset:
            raise ValueError("databento_live: dataset is required")
        if not stype_in:
            raise ValueError("databento_live: stype_in is required")
        parents = [s.strip() for s in parent_symbols if s and s.strip()]
        if not parents:
            raise ValueError("databento_live: parent_symbols must be non-empty")

        self._api_key = api_key
        self._dataset = dataset
        self._stype_in = stype_in
        self._parent_symbols = parents
        self._schemas = list(schemas)
        # Dependency-injected so tests don't need the real SDK.
        self._client_factory = client_factory or _default_client_factory
        self._sleeper = sleeper or asyncio.sleep

        self._stop_requested = False
        self._active_client = None
        self._health = ProviderHealth(
            provider_kind="databento",
            dataset=dataset,
            parent_symbols=list(parents),
        )

        # DATA-10: one-shot symbol resolver for the session. v3.1 §1.2
        # requires the live session pin to a single raw_symbol + a
        # matching discovery root; the resolver enforces both (rejects
        # mid-session re-pins AND rejects pinning to an unexpected
        # root) and exposes symbol_mapping_age_ms via health(). The
        # resolver is seeded with the FIRST configured parent symbol —
        # the common live-path is single-parent. Multi-parent
        # discovery is supported in the subscription but the session
        # still pins to a single concrete contract and the first pin
        # must belong to the first parent's root.
        self._session_id = session_id or os.environ.get("SIDE_CAR_SESSION_ID") or _default_session_id()
        self._manifest_path = manifest_path or os.environ.get(
            "DATABENTO_SESSION_MANIFEST_PATH",
            str(Path(os.environ.get("LOG_DIR", "logs")) / "session_contract_manifest.json"),
        )
        self._logger = logger or (lambda line: print(line, flush=True))
        self._symbol_resolver = SymbolResolver(
            parent_symbol=parents[0],
            on_pin=self._on_session_pin,
        )

        rr, apath, zwire = _raw_dbn_settings_from_env(
            record_raw_dbn=record_raw_dbn,
            dbn_archive_path=dbn_archive_path,
            dbn_use_zstd_wire=dbn_use_zstd_wire,
        )
        if rr and not apath:
            raise ValueError(
                "databento_live: DATABENTO_RECORD_RAW_DBN requires "
                "DATABENTO_DBN_ARCHIVE_PATH (directory for segment .dbn files)"
            )
        self._record_raw_dbn = rr
        self._dbn_archive_root: _Optional[Path] = (
            Path(apath).expanduser() if apath else None
        )
        if rr and self._dbn_archive_root is not None and self._dbn_archive_root.exists():
            if self._dbn_archive_root.is_file():
                raise ValueError(
                    "databento_live: DATABENTO_DBN_ARCHIVE_PATH must be a directory, "
                    f"not a file ({self._dbn_archive_root})"
                )
        self._dbn_use_zstd_wire = zwire
        self._dbn_segment_seq = 0
        self._active_dbn_segment_path: _Optional[Path] = None
        # DATA-14: UTC calendar day of the active DBN segment (from ts_recv or wall).
        self._dbn_active_utc_date: _Optional[str] = None
        # Live client handle while _run_once is active — used for mid-connection rotation.
        self._dbn_client_for_archive: _Optional[object] = None
        # One-time segment roll on first DATA-10 pin (trading-session boundary for archives).
        self._dbn_rotated_for_pin: bool = False

    # ─── Lifecycle ──────────────────────────────────────────────────────────

    async def start(self, handler: RecordHandler) -> None:
        self._stop_requested = False
        backoff = INITIAL_BACKOFF_SEC
        while not self._stop_requested:
            try:
                await self._run_once(handler)
                # Clean exit from _run_once means the server closed the
                # stream cleanly; treat that like a disconnect and reconnect.
                if self._stop_requested:
                    break
                await self._on_disconnect("clean_close")
                delay = next_backoff(backoff)
                backoff = min(MAX_BACKOFF_SEC, backoff * BACKOFF_MULTIPLIER)
                await self._sleeper(delay)
            except _UnrecoverableError as exc:
                # Don't retry on auth failures / bad subscriptions —
                # surface and stop the loop so the operator sees it.
                self._note_error(str(exc), unrecoverable=True)
                return
            except Exception as exc:  # noqa: BLE001 — network churn, log+retry
                await self._on_disconnect(f"exception: {type(exc).__name__}: {exc}")
                delay = next_backoff(backoff)
                backoff = min(MAX_BACKOFF_SEC, backoff * BACKOFF_MULTIPLIER)
                await self._sleeper(delay)

    async def stop(self) -> None:
        self._stop_requested = True
        client = self._active_client
        if client is not None:
            try:
                _close = getattr(client, "stop", None) or getattr(client, "close", None)
                if _close is not None:
                    result = _close()
                    if asyncio.iscoroutine(result):
                        await result
            except Exception:
                pass
            self._active_client = None
        self._health.connected = False
        self._health.subscribed = False

    def health(self) -> ProviderHealth:
        # Return a defensive copy so callers cannot mutate our state.
        # DATA-10: overlay the resolver's pinned identity so /lob/health
        # reports the pinned raw_symbol/instrument_id from the symbol-
        # mapping record, not just the last-seen record fields. Falls
        # back to whatever the dispatcher has observed.
        h = replace(self._health, parent_symbols=list(self._health.parent_symbols))
        pinned = self._symbol_resolver.pinned_mapping()
        if pinned is not None:
            h.raw_symbol = pinned.raw_symbol
            h.instrument_id = pinned.instrument_id
        return h

    def symbol_mapping_age_ms(self):
        """DATA-10: current age of the pinned symbol mapping, for /lob/health v2."""
        return self._symbol_resolver.mapping_age_ms()

    def pinned_mapping(self):
        """DATA-10: expose resolver's pin for callers that need the full record."""
        return self._symbol_resolver.pinned_mapping()

    # ─── DATA-10: session-pin hook (log + manifest write) ───────────────────

    def _on_session_pin(self, pinned: PinnedMapping) -> None:
        """
        Fires exactly once — on the first successful, root-verified pin.
        Emits the v3.1 DATA-10 acceptance log line AND writes the
        session contract manifest to disk so BAR-06's TS-side writer
        (and any replay/audit tooling) can read it directly.

        If writing the manifest fails, the log still fires and the
        ingest loop continues — we prefer a visible warning over
        halting live ingest on a disk-write hiccup.
        """
        # 1. Startup log line (handoff acceptance: "logs show the
        #    resolved raw symbol and instrument ID at startup")
        self._logger(
            f"[SYMBOL-RESOLVE] session pinned "
            f"parent_symbol={pinned.parent_symbol} "
            f"raw_symbol={pinned.raw_symbol} "
            f"instrument_id={pinned.instrument_id} "
            f"session_id={self._session_id}"
        )

        # 2. Build + write the session contract manifest. Shape
        #    matches src/autotrade/session-contract-manifest.ts's
        #    SessionContractManifest interface exactly — BAR-06's
        #    TS-side writer reads the same keys.
        manifest = self._build_session_manifest(pinned)
        try:
            path = Path(self._manifest_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            # Atomic write: tmp + rename so concurrent readers never
            # see a partial manifest.
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
            tmp.replace(path)
            self._logger(f"[SYMBOL-RESOLVE] wrote session manifest -> {path}")
        except Exception as exc:  # noqa: BLE001
            self._logger(
                f"[SYMBOL-RESOLVE] WARNING failed to write session manifest "
                f"at {self._manifest_path}: {exc}"
            )
        self._dbn_rotate_on_first_session_pin(pinned)
        self._dbn_merge_pin_into_sidecar_manifest(pinned)

    def _build_session_manifest(self, pinned: PinnedMapping) -> dict:
        """
        Build the session contract manifest dict. Keys match
        src/autotrade/session-contract-manifest.ts SessionContractManifest.
        Pure — safe to call from tests.
        """
        # Derive root from raw_symbol. The resolver already verified
        # this matches parent_symbol, so pinned.parent_symbol is the
        # canonical root.
        root = pinned.parent_symbol
        tick_size = _TICK_SIZE_BY_ROOT.get(root)
        expiry = _expiry_from_raw_symbol(pinned.raw_symbol)
        return {
            "session_id": self._session_id,
            "symbol_root": root,
            "parent_symbol": pinned.parent_symbol,
            "resolved_raw_symbol": pinned.raw_symbol,
            "instrument_id": pinned.instrument_id,
            "expiry": expiry,
            "tick_size": tick_size if tick_size is not None else 0.25,
            "display_factor": 1,
            # Per session-contract-manifest.ts ResolutionReason enum.
            "resolution_reason": "parent_symbol_discovery_first_match",
            "manifest_version": SESSION_CONTRACT_MANIFEST_VERSION,
        }

    def _dbn_stream_error(self, exc: BaseException) -> None:
        """Exception callback for Live.add_stream DBN file writes."""
        self._logger(f"[DBN-ARCHIVE] WARNING raw DBN stream write error: {exc}")

    def _next_dbn_segment_path(self, *, archive_utc_date: str) -> Path:
        """Allocate a new exclusive ``.dbn`` path under the archive root."""
        assert self._dbn_archive_root is not None
        root = self._dbn_archive_root
        root.mkdir(parents=True, exist_ok=True)
        self._dbn_segment_seq += 1
        from datetime import datetime, timezone

        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%f")
        safe_date = archive_utc_date.replace("-", "")
        safe_sess = "".join(
            ch if ch.isalnum() or ch in "-._" else "_" for ch in self._session_id
        )[:96]
        safe_ds = "".join(
            ch if ch.isalnum() or ch in "-._" else "_" for ch in self._dataset
        )[:48]
        fname = (
            f"{safe_ds}__{safe_sess}__day{safe_date}__{ts}__seg{self._dbn_segment_seq:04d}.dbn"
        )
        path = root / fname
        if path.exists():
            raise OSError(f"dbn archive path already exists (collision): {path}")
        return path

    def _detach_closed_dbn_streams(self, client: object, archived_path: Path) -> None:
        """
        Remove a finished segment from the Live session's user-stream list so
        subsequent gateway records are not duplicated into a closed file.

        Uses ``client._session._user_streams`` (SDK-internal) in a defensive
        way: if the layout changes, rotation becomes a no-op for detach only.
        """
        session = getattr(client, "_session", None)
        streams = getattr(session, "_user_streams", None) if session is not None else None
        if not isinstance(streams, list):
            return
        want = str(archived_path.resolve())
        kept: list[object] = []
        for cs in streams:
            name = str(getattr(cs, "stream_name", ""))
            norm_name = name.replace("\\", "/")
            norm_want = want.replace("\\", "/")
            if norm_name == norm_want or norm_name.endswith(archived_path.name):
                try:
                    close = getattr(cs, "close", None)
                    if callable(close):
                        close()
                except Exception:
                    pass
                continue
            kept.append(cs)
        streams[:] = kept

    def _dbn_begin_new_segment(self, client: object, ts_recv_ns: _Optional[int]) -> None:
        """Open a new DBN file + sidecar for the current Live client."""
        day = _utc_archive_date_yyyy_mm_dd(ts_recv_ns)
        seg_path = self._next_dbn_segment_path(archive_utc_date=day)
        self._active_dbn_segment_path = seg_path
        self._write_dbn_sidecar_manifest(seg_path, archive_utc_date=day)
        client.add_stream(str(seg_path), exception_callback=self._dbn_stream_error)

    def _dbn_maybe_rotate_for_archive_calendar(
        self,
        client: object,
        ts_recv_ns: _Optional[int],
    ) -> None:
        """
        DATA-14: roll DBN segments on UTC calendar day change (session in the
        sense of archive bookkeeping), even when the TCP live session stays up.
        """
        day = _utc_archive_date_yyyy_mm_dd(ts_recv_ns)
        if self._dbn_active_utc_date is None:
            self._dbn_active_utc_date = day
            return
        if day == self._dbn_active_utc_date:
            return
        old = self._active_dbn_segment_path
        self._logger(
            f"[DBN-ARCHIVE] rotating DBN segment (UTC day {self._dbn_active_utc_date} -> {day})"
        )
        if old is not None:
            self._detach_closed_dbn_streams(client, old)
        self._dbn_active_utc_date = day
        self._dbn_begin_new_segment(client, ts_recv_ns)

    def _dbn_rotate_on_first_session_pin(self, pinned: PinnedMapping) -> None:
        """
        DATA-14: after DATA-10 pins the contract, roll to a fresh DBN segment so
        the authoritative session does not share a file with pre-pin discovery
        traffic (session boundary in the handoff sense).
        """
        if not self._record_raw_dbn or self._dbn_client_for_archive is None:
            return
        if self._dbn_rotated_for_pin:
            return
        self._dbn_rotated_for_pin = True
        old = self._active_dbn_segment_path
        self._logger(
            "[DBN-ARCHIVE] rotating DBN segment for DATA-10 session pin "
            f"(raw_symbol={pinned.raw_symbol} instrument_id={pinned.instrument_id})"
        )
        if old is not None:
            self._detach_closed_dbn_streams(self._dbn_client_for_archive, old)
        self._dbn_begin_new_segment(self._dbn_client_for_archive, None)
        self._dbn_active_utc_date = None

    def _write_dbn_sidecar_manifest(self, dbn_path: Path, *, archive_utc_date: str) -> None:
        """JSON sidecar next to the segment file for offline replay metadata."""
        # DATA-09 retrofit (v3.2.1 §2.1, kickoff tightening): the
        # manifest/provider retrofit is atomic — bumping archive_kind
        # from v1 to v2 signals the L2-canonical schema era so a
        # consumer can never read a mixed-state archive (runtime L2
        # but manifest still implies MBO).
        #
        # Feed provenance contract (v2):
        #   archive_kind                 — schema version stamp (v2)
        #   archive_schema_version       — integer bump (2) for
        #                                  consumers that prefer int
        #                                  comparisons
        #   provider_mode                — "L2_MBP10" in this binary era
        #   schema_era                   — "v3_2_1_l2_canonical"
        #   feed_schemas_subscribed      — explicit copy of the schema
        #                                  list actually subscribed for
        #                                  this segment; richer than a
        #                                  bare `schemas` field
        #   book_state_source            — which module the sidecar
        #                                  reads top-of-book from.
        #                                  "mbp10" means MBP-10 L2
        #                                  snapshots (v3.2.1 path).
        #                                  "mbo_kernel" is the legacy
        #                                  per-order kernel; any future
        #                                  rollback build would stamp
        #                                  that string so consumers can
        #                                  tell downstream.
        #   trade_source                 — "databento_trades" is the
        #                                  v3.2.1 authoritative source;
        #                                  CVD is derived here.
        #
        # Until DATA-11 lands, runtime still reads book state from the
        # legacy MBO kernel even though subscription is L2. We stamp
        # that honestly — the manifest never lies — so any rollback
        # replay run can distinguish genuine L2-native archives from
        # transitional "L2 subscription / MBO kernel" archives.
        schemas = list(self._schemas)
        book_state_source = "mbp10" if "mbp-10" in schemas else "mbo_kernel"
        trade_source = "databento_trades" if "trades" in schemas else "databento_mbo_trades"
        manifest = {
            "archive_kind": "databento_live_dbn_segment_v2",
            "archive_schema_version": 2,
            "provider_mode": "L2_MBP10",
            "schema_era": "v3_2_1_l2_canonical",
            "book_state_source": book_state_source,
            "trade_source": trade_source,
            "feed_schemas_subscribed": schemas,
            "dbn_file": dbn_path.name,
            "archive_utc_date": archive_utc_date,
            "session_id": self._session_id,
            "dataset": self._dataset,
            "stype_in": self._stype_in,
            "parent_symbols": list(self._parent_symbols),
            "schemas": schemas,  # retained for back-compat with v1 readers
            "wire_zstd_requested": bool(self._dbn_use_zstd_wire),
            "reconnect_count_at_segment_open": int(self._health.reconnect_count),
            "session_contract_manifest_version": SESSION_CONTRACT_MANIFEST_VERSION,
            "pinned": None,
        }
        side = dbn_path.parent / (dbn_path.name + ".manifest.json")
        tmp = side.parent / (side.name + ".tmp")
        tmp.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(side)

    def _dbn_merge_pin_into_sidecar_manifest(self, pinned: PinnedMapping) -> None:
        if self._active_dbn_segment_path is None:
            return
        side = self._active_dbn_segment_path.parent / (
            self._active_dbn_segment_path.name + ".manifest.json"
        )
        if not side.is_file():
            return
        try:
            cur = json.loads(side.read_text(encoding="utf-8"))
        except Exception:
            cur = {}
        cur["pinned"] = {
            "parent_symbol": pinned.parent_symbol,
            "raw_symbol": pinned.raw_symbol,
            "instrument_id": pinned.instrument_id,
        }
        tmp = side.parent / (side.name + ".tmp")
        tmp.write_text(json.dumps(cur, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(side)

    # ─── Internal one-connection run loop ───────────────────────────────────

    async def _run_once(self, handler: RecordHandler) -> None:
        self._active_dbn_segment_path = None
        self._dbn_rotated_for_pin = False
        import databento as db  # type: ignore

        use_zstd = bool(self._record_raw_dbn and self._dbn_use_zstd_wire)
        compression = db.Compression.ZSTD if use_zstd else db.Compression.NONE
        try:
            client = self._client_factory(self._api_key, compression=compression)
        except TypeError:
            client = self._client_factory(self._api_key)
        self._active_client = client
        try:
            if self._record_raw_dbn:
                self._dbn_client_for_archive = client
                self._dbn_begin_new_segment(client, None)
                # Anchor `_dbn_active_utc_date` from the first record's ts_recv in
                # `_dbn_maybe_rotate_for_archive_calendar` — not wall clock here —
                # so tiny fixture timestamps do not force an immediate day roll.
                self._dbn_active_utc_date = None
            _classify_subscription_errors(
                lambda: self._subscribe_all(client),
            )()
            self._health.connected = True
            self._health.subscribed = True
            # `client` is expected to be async-iterable yielding records.
            # Explicitly close the iterator on early-exit paths so
            # Python's async-generator finalization does not emit a
            # RuntimeWarning about an un-awaited aclose.
            iterator = _aiter(client)
            try:
                async for rec in iterator:
                    if self._stop_requested:
                        break
                    await self._dispatch(rec, handler)
            finally:
                aclose = getattr(iterator, "aclose", None)
                if aclose is not None:
                    try:
                        await aclose()
                    except Exception:
                        pass
        finally:
            self._health.connected = False
            self._health.subscribed = False
            self._active_client = None
            self._dbn_client_for_archive = None

    def _subscribe_all(self, client) -> None:
        """Subscribe to every configured schema on a single client."""
        for schema in self._schemas:
            client.subscribe(
                dataset=self._dataset,
                schema=schema,
                stype_in=self._stype_in,
                symbols=list(self._parent_symbols),
            )

    async def _dispatch(self, rec: object, handler: RecordHandler) -> None:
        kind = _kind_from_record(rec)
        ts_event_ns = _getattr_optional_int(rec, "ts_event")
        ts_recv_ns = _getattr_optional_int(rec, "ts_recv")
        raw_symbol = _getattr_optional_str(rec, "raw_symbol")
        instrument_id = _getattr_optional_int(rec, "instrument_id")

        if self._record_raw_dbn and self._dbn_client_for_archive is not None:
            self._dbn_maybe_rotate_for_archive_calendar(
                self._dbn_client_for_archive,
                ts_recv_ns,
            )

        # Update health metrics before the handler so /lob/health reflects
        # at-least-once-reached state even if the handler throws.
        if ts_recv_ns is not None:
            self._health.last_ts_recv_ns = ts_recv_ns
        if raw_symbol is not None:
            self._health.raw_symbol = raw_symbol
        if instrument_id is not None:
            self._health.instrument_id = instrument_id
        self._health.message_count += 1

        if kind == "error":
            self._note_error(_error_message(rec), unrecoverable=False)
            # Fall through — let the handler see error records too.
        elif kind == "heartbeat" or kind == "status":
            self._health.heartbeat_count += 1

        provider_rec = ProviderRecord(
            kind=kind,
            ts_event_ns=ts_event_ns,
            ts_recv_ns=ts_recv_ns,
            payload=rec,
            raw_symbol=raw_symbol,
            instrument_id=instrument_id,
        )

        # DATA-10: feed the symbol resolver BEFORE the handler so
        # health() reflects the latest pin state when the handler
        # observes the record, and so a mid-session re-pin (v3.1 §1.2
        # violation) halts the loop before the handler runs on
        # inconsistent identity.
        try:
            self._symbol_resolver.observe(provider_rec)
        except SymbolResolverError as exc:
            self._note_error(str(exc), unrecoverable=True)
            raise _UnrecoverableError(str(exc)) from exc
        try:
            await handler(provider_rec)
        except Exception as exc:  # noqa: BLE001 — one bad handler shouldn't kill ingest
            self._note_error(f"handler_error: {exc}", unrecoverable=False)

    async def _on_disconnect(self, reason: str) -> None:
        self._health.connected = False
        self._health.subscribed = False
        self._health.reconnect_count += 1
        self._note_error(f"disconnect: {reason}", unrecoverable=False)

    def _note_error(self, msg: str, *, unrecoverable: bool) -> None:
        self._health.error_count += 1
        self._health.last_error = msg
        self._health.last_error_ts_ns = None
        if unrecoverable:
            self._health.connected = False
            self._health.subscribed = False


# ─── Internals ──────────────────────────────────────────────────────────────

class _UnrecoverableError(Exception):
    """Raised on auth / config / bad-subscription errors so run() stops retrying."""


def _classify_subscription_errors(thunk):
    """
    Wrap the subscription call so certain SDK errors escalate to
    _UnrecoverableError. Kept as a wrapper so the rules are greppable
    and testable independently of the provider class.
    """

    def _inner():
        try:
            return thunk()
        except Exception as exc:  # noqa: BLE001
            msg = str(exc).lower()
            if any(
                key in msg for key in ("unauthor", "api key", "forbidden", "invalid symbol")
            ):
                raise _UnrecoverableError(str(exc)) from exc
            raise

    return _inner


def _aiter(client):
    """
    Return an async iterator over a Databento Live client. The real
    client is both iterable and async-iterable depending on SDK version;
    we normalize here so _run_once doesn't branch.
    """
    if hasattr(client, "__aiter__"):
        return client.__aiter__()

    async def _gen():
        # Fallback for sync-iterable mocks.
        for rec in client:
            yield rec

    return _gen()


def _getattr_optional_int(rec: object, name: str) -> Optional[int]:
    v = getattr(rec, name, None)
    if isinstance(v, int):
        return v
    return None


def _getattr_optional_str(rec: object, name: str) -> Optional[str]:
    v = getattr(rec, name, None)
    if isinstance(v, str) and v:
        return v
    return None


def _error_message(rec: object) -> str:
    return str(getattr(rec, "err", None) or getattr(rec, "message", None) or repr(rec))


def _default_client_factory(api_key: str, *, compression=None):
    """Default client factory. Lazy-import databento so tests don't need the SDK."""
    import databento as db  # type: ignore

    if compression is None:
        compression = db.Compression.NONE
    return db.Live(key=api_key, compression=compression)


def _default_session_id() -> str:
    """Deterministic-ish session id for a sidecar process. BAR-06 may
    override this at session manifest write time if the TS runner
    supplies its own session_id via a sidecar context call."""
    from datetime import datetime, timezone
    return (
        "DATABENTO_SIDE_"
        + datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    )


def _expiry_from_raw_symbol(raw_symbol: str) -> Optional[str]:
    """
    Derive ISO-8601 expiry date (YYYY-MM-DD) from a CME-format raw
    symbol (e.g. "MNQM6" -> 2026-06-19 third Friday, approximate).

    Returns None when the raw_symbol cannot be parsed. The date is the
    THIRD FRIDAY of the contract month, which is the CME equity-index
    futures expiration convention. Year digit is resolved by matching
    the closest future year to the current wall clock.

    Approximate — the TS-side session-contract-manifest module treats
    expiry as informational (non-null if known, null otherwise); the
    sidecar does not enforce expiry in execution logic.
    """
    from datetime import date, timedelta
    if not raw_symbol or not isinstance(raw_symbol, str):
        return None
    # Parse <root><month><year-digits> with the same shape rules used
    # elsewhere. We duplicate a small regex here rather than import
    # symbol_resolver to avoid a circular import.
    import re
    m = re.match(r"^([A-Z]{2,4})([FGHJKMNQUVXZ])(\d{1,2})$", raw_symbol)
    if m is None:
        return None
    month_letter = m.group(2)
    year_digits = m.group(3)
    month_num = _CME_MONTH_CODES.get(month_letter)
    if month_num is None:
        return None
    # Resolve year: match the digits against nearby years so "6" -> 2026
    # when running in 2026. Pick the year >= current year with matching
    # last-N digits.
    today = date.today()
    current_year = today.year
    n = len(year_digits)
    target_suffix = int(year_digits)
    # Candidate years: from current_year to current_year + 10.
    expiry_year = None
    for y in range(current_year, current_year + 11):
        if y % (10 ** n) == target_suffix:
            expiry_year = y
            break
    if expiry_year is None:
        return None
    # Third Friday of the contract month: find first Friday, add 14 days.
    first = date(expiry_year, month_num, 1)
    # weekday(): Mon=0 .. Fri=4 .. Sun=6
    days_until_friday = (4 - first.weekday()) % 7
    third_friday = first + timedelta(days=days_until_friday + 14)
    return third_friday.isoformat()
