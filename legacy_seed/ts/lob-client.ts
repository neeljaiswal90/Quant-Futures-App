/**
 * lob-client.ts — HTTP client for the Python market-data sidecar.
 *
 * Fetches BBO + full feature snapshots and manages trade/signal context
 * for the Bookmap/Rithmic LOB bridge.
 */

export interface LobHealthResult {
  status: string;
  source_connected: boolean;
  bbo_fresh: boolean;
  bbo_age_ms: number;
  update_count: number;
  trade_count: number;
  depth_levels_bid: number;
  depth_levels_ask: number;
  // MBO capability + freshness (from sidecar health endpoint)
  mbo_events_buffered: number;       // rolling 60s window count
  mbo_total_count?: number;          // lifetime event count (optional for old sidecars)
  mbo_status?: string;               // "idle" | "active" | "stale" (optional for old sidecars)
  mbo_age_ms?: number;               // ms since last MBO event (optional for old sidecars)
  mbo_adv_event_count?: number;      // advanced analyzer window count (optional for old sidecars)
  // Context
  active_trade_id: string | null;
  active_signal_id: string | null;
  recording_context: string;
  uptime_sec: number;
  source_alias?: string | null;
  source_symbol_root?: string | null;
  feed_provider?: string | null;

  // ── DATA-04 /lob/health v2 fields (v3.1 §1.3) ─────────────────────────────
  //
  // All OPTIONAL on the wire contract so pre-DATA-04 sidecars continue
  // to be readable. Bookmap-mode sidecars emit what they can derive
  // (provider_kind, source_alias-derived raw_symbol, reconnect_count)
  // and leave Databento-specific fields (dataset, schema, instrument_id,
  // ns timestamps, snapshot_synced, gap_detected_count, last_clear_book_ts,
  // DATA-13 lag / slow-reader / replay boundary)
  // as null until DATA-09..13.
  //
  // Consumers SHOULD treat every field as nullable and not assume
  // population on any specific provider.

  /** 'bookmap' | 'databento' — canonical provider kind at this moment. */
  provider_kind?: 'bookmap' | 'databento' | null;
  /** Databento dataset code (e.g. "GLBX.MDP3"). Null in Bookmap mode. */
  dataset?: string | null;
  /** Databento schema (e.g. "mbo", "mbp-1"). Null in Bookmap mode. */
  schema?: string | null;
  /** CME / Databento numeric instrument id. Null in Bookmap mode until
   * the addon can surface it. */
  instrument_id?: number | null;
  /** Pinned raw_symbol for this session (e.g. "MNQM6"). Mirrors the
   * session-contract-manifest resolved_raw_symbol when available. */
  raw_symbol?: string | null;
  /** Lifetime reconnect counter on the provider's wire connection. */
  reconnect_count?: number | null;
  /** Databento last receive-time in ns (mirrors the /lob/bbo ns field).
   * Null until DATA-09 live ingest populates. */
  last_ts_recv_ns?: number | null;
  /** Age in ms since the last symbol-mapping record was applied. Null
   * until DATA-10 symbol mapping lands. */
  symbol_mapping_age_ms?: number | null;
  /** True once the sidecar's order book has completed its initial
   * snapshot-sync (v3.1 §1.3: authority is not claimed pre-sync). */
  snapshot_synced?: boolean | null;
  /** Lifetime count of detected gaps in the MBO/MBP sequence. */
  gap_detected_count?: number | null;
  /** Epoch-ms of the last F_LAST clear-book event. Null if none seen. */
  last_clear_book_ts?: number | null;
  /** DATA-13: count of slow-reader warnings (wall clock vs ts_recv skew). */
  slow_reader_warning_count?: number | null;
  /** DATA-13: p50 wire lag (ts_recv − ts_event) in ms over a rolling window. */
  lag_ms_p50?: number | null;
  /** DATA-13: p95 wire lag in ms over the same window. */
  lag_ms_p95?: number | null;
  /** DATA-13: nanoseconds — ts_recv_ns of first record after reconnect_count increased. */
  last_replay_completed_ts?: number | null;

  // ── v3.2.1 §5.2 L2 authoritative-book FSM fields on /lob/health ──────────
  //
  // All OPTIONAL on the wire. Populated in Databento L2-primary mode
  // from the pinned-instrument FSM; null in legacy Bookmap mode and
  // under DATABENTO_SCHEMAS rollback. The TS hard-risk consumer
  // (RISK-10A) reads `quote_authoritative` to gate new-entry
  // publication.

  /** True when the FSM verdict says all 5 reconvergence rules hold. */
  quote_authoritative?: boolean | null;
  /** ms-epoch of the most recent reset/gap boundary. */
  reconvergence_epoch_ts_ms?: number | null;
  /** Consecutive A/M/C/T updates since reconvergence_epoch_ts_ms. */
  reconvergence_updates_without_gap?: number | null;
  /** ms-epoch of the most recent detected sequence-gap. */
  last_gap_ts_ms?: number | null;
  /** ms-epoch of the most recent provider ErrorMsg observation. */
  last_provider_error_ts_ms?: number | null;
  /** ms-epoch of the most recent post-reset bid update. */
  last_bid_update_ts_ms?: number | null;
  /** ms-epoch of the most recent post-reset ask update. */
  last_ask_update_ts_ms?: number | null;
  /** "cold" | "reconverging" | "ready" */
  warmup_state?: string | null;
  /** Diagnostic string: which rule is currently blocking authority. */
  not_authoritative_reason?: string | null;
}

/**
 * Wire-shape mirror of python-market-data-service/lob_features/schema.py::ScalpState.
 *
 * All fields are optional/nullable — several microstructure signals (afi_*,
 * hazard_*, abs_*, refill_*) are deferred to a later sidecar extension and
 * intentionally remain None during Phase 1–3. Every consumer MUST tolerate
 * a missing nested block and null-valued subfields.
 *
 * The camelCase domain object is `ScalperStateVector` in
 * src/autotrade/features/scalper-state.ts — this wire contract stays in
 * snake_case and never escapes the client boundary.
 */
export interface ScalpState {
  // Multi-level book snapshot (k=5)
  bid_px: number[] | null;
  ask_px: number[] | null;
  bid_sz: number[] | null;
  ask_sz: number[] | null;
  // Microprice + edge
  microprice: number | null;
  microprice_edge_ticks: number | null;
  // Multi-level weighted queue imbalance
  qi_1: number | null;
  qi_3: number | null;
  qi_5: number | null;
  // Cont-style event-level OFI (raw + z-scored)
  ofi_250ms: number | null;
  ofi_1s: number | null;
  ofi_3s: number | null;
  z_ofi_250ms: number | null;
  z_ofi_1s: number | null;
  z_ofi_3s: number | null;
  // Aggressive flow imbalance (deferred — Phase 1 microstructure.py remainder)
  afi_250ms: number | null;
  afi_1s: number | null;
  afi_3s: number | null;
  // Queue hazard per side (deferred)
  hazard_bid_1s: number | null;
  hazard_ask_1s: number | null;
  // Absorption per side (deferred)
  abs_bid_1s: number | null;
  abs_ask_1s: number | null;
  // Refill / iceberg proxy per side (deferred)
  refill_bid_1s: number | null;
  refill_ask_1s: number | null;
  // Micro-volatility (1s EWMA std of mid-tick differences)
  sigma_1s_ticks: number | null;
  // Spread in ticks (from top-of-book)
  spread_ticks: number | null;
}

export interface LobSnapshot {
  timestamp_ms: number;
  bbo_age_ms: number;
  data_quality: 'full_depth' | 'bbo_only' | 'stale' | 'unavailable';
  recording_context: string;
  // BBO
  bid: number | null;
  ask: number | null;
  mid: number | null;
  bid_size: number | null;
  ask_size: number | null;
  spread_pts: number | null;
  spread_ticks: number | null;
  // Depth
  depth_imbalance_5: number | null;
  depth_imbalance_10: number | null;
  total_bid_depth_10lvl: number | null;
  total_ask_depth_10lvl: number | null;
  large_bid_within_5pts: boolean | null;
  large_ask_within_5pts: boolean | null;
  // Trade flow
  cumulative_delta_10s: number | null;
  cumulative_delta_30s: number | null;
  cumulative_delta_60s: number | null;
  trade_flow_imbalance_10s: number | null;
  trade_flow_imbalance_30s: number | null;
  // MBO aggregates
  cancel_add_ratio_10s: number | null;
  replenishment_rate_10s: number | null;
  absorption_rate_10s: number | null;
  mean_order_lifetime_top_book: number | null;
  aggressor_penetration_10s: number | null;
  sweep_count_10s: number | null;
  // Advanced MBO (populated when AdvancedMboAnalyzer is active)
  adv_cancel_replace_ratio_10s: number | null;
  adv_modify_rate_10s: number | null;
  adv_iceberg_suspicion_30s: number | null;
  adv_queue_deterioration_bid_10s: number | null;
  adv_queue_deterioration_ask_10s: number | null;
  adv_pull_cascade_count_10s: number | null;
  adv_lifetime_p50_ms: number | null;
  // Microstructure: Absorption
  absorption_score_10s: number | null;
  absorption_bid_score_10s: number | null;
  absorption_ask_score_10s: number | null;
  strongest_absorption_price: number | null;
  // Microstructure: Sweeps
  sweep_volume_10s: number | null;
  max_sweep_levels_10s: number | null;
  last_sweep_side: string | null;
  // Microstructure: Footprint
  footprint_delta_30s: number | null;
  footprint_delta_5s: number | null;
  footprint_imbalance_ratio_30s: number | null;
  footprint_stacked_imbalance_count_30s: number | null;
  dominant_aggressor_side: string | null;
  // Microstructure: Large Trades
  large_trade_count_10s: number | null;
  large_trade_volume_10s: number | null;
  largest_trade_size_30s: number | null;
  large_trade_buy_sell_imbalance_30s: number | null;
  // Microstructure: Volume Profile
  session_vpoc: number | null;
  session_vah: number | null;
  session_val: number | null;
  distance_to_vpoc: number | null;
  inside_value_area: boolean | null;
  // Correlation
  trade_id: string | null;
  signal_id: string | null;
  // Scalper microstructure state (lob_mbo_scalp family only).
  // Null when the sidecar has not requested scalp_state inclusion or when
  // the depth book is empty at compute time. Consumers MUST tolerate null.
  scalp_state?: ScalpState | null;
}

/**
 * Lightweight BBO-only response from /lob/bbo — no feature computation.
 *
 * DATA-03 (v3.1 §1.3): v2 wire schema for honest BBO timestamps.
 *
 * Legacy fields (bid/ask/mid/spread_pts/bbo_age_ms/timestamp_ms/
 * source_connected/update_count/is_fresh/last_bbo_ts_ms) are retained
 * verbatim so pre-DATA-03 sidecars and pre-DATA-03 callers keep working
 * during the migration-warm period.
 *
 * `timestamp_ms` — DEPRECATED but not removed. Pre-DATA-03 this carried
 * ambiguous semantics: sometimes the sidecar's wall clock at response
 * time, sometimes the event-recv time. v2 splits these into three
 * explicit fields (`source_event_ts_ms`, `source_recv_ts_ms`,
 * `engine_response_ts_ms`). Consumers SHOULD prefer the new fields and
 * treat `timestamp_ms` as a compatibility-only hint.
 *
 * All v2 timestamp fields are OPTIONAL on the wire contract now (null
 * or omitted from a pre-DATA-03 sidecar payload). Real population
 * begins with DATA-09 Databento live ingest and DATA-11..13 wiring.
 * Callers that need a source timestamp today coalesce:
 *   source_event_ts_ms ?? source_recv_ts_ms ?? timestamp_ms.
 *
 * The ns-resolution fields are Databento-native; Bookmap does not
 * surface ns timestamps so they stay null until DATA-09.
 */
export interface LobBbo {
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread_pts: number | null;
  bbo_age_ms: number;
  /** @deprecated DATA-03: prefer source_event_ts_ms / source_recv_ts_ms / engine_response_ts_ms. */
  timestamp_ms: number;
  source_connected: boolean;
  update_count: number;
  is_fresh: boolean;
  last_bbo_ts_ms: number;

  // ── DATA-03 v2 honest-BBO timestamp fields (v3.1 §1.3) ────────────────────
  // All nullable. Bookmap-mode sidecars return null or omit.
  // Databento-mode population begins with DATA-09..13.

  /** Source's own event-time wall clock (ms since epoch) — when the quote
   * was stamped by the exchange / provider. null if the source does not
   * expose it. */
  source_event_ts_ms?: number | null;
  /** Source's receive-time wall clock (ms since epoch) — when the sidecar
   * first observed the quote on the wire. null if unknown. */
  source_recv_ts_ms?: number | null;
  /** Sidecar wall clock (ms since epoch) at the moment the response was
   * assembled. Non-null on all DATA-03+ sidecars. */
  engine_response_ts_ms?: number | null;
  /** Databento ns resolution — source event time. null in Bookmap mode. */
  ts_event_ns?: number | null;
  /** Databento ns resolution — source receive time. null in Bookmap mode. */
  ts_recv_ns?: number | null;
  /** Databento ns resolution — feed in-delta (recv − event). null in Bookmap mode. */
  ts_in_delta_ns?: number | null;
}

/**
 * Resolve the "best available" source timestamp (ms since epoch) from a
 * BBO response. Prefers the explicit DATA-03 source_event → source_recv
 * path; falls back to the deprecated timestamp_ms only when both v2
 * fields are absent. Returns null only when nothing usable is present
 * (which should not happen on any DATA-03+ response).
 */
export function resolveBboSourceTimestampMs(bbo: LobBbo): number | null {
  if (bbo.source_event_ts_ms != null && Number.isFinite(bbo.source_event_ts_ms)) {
    return bbo.source_event_ts_ms;
  }
  if (bbo.source_recv_ts_ms != null && Number.isFinite(bbo.source_recv_ts_ms)) {
    return bbo.source_recv_ts_ms;
  }
  if (Number.isFinite(bbo.timestamp_ms) && bbo.timestamp_ms > 0) {
    return bbo.timestamp_ms;
  }
  return null;
}

/**
 * Compute quote-age in milliseconds using the honest source timestamp
 * when available. Falls back to the sidecar-provided `bbo_age_ms` only
 * when no source timestamp is resolvable. Used by QuoteService and the
 * freshness FSM so the "age" operators see reflects source-event time,
 * not sidecar wall-clock.
 */
export function computeQuoteAgeMs(bbo: LobBbo, nowMs: number = Date.now()): number {
  const srcMs = resolveBboSourceTimestampMs(bbo);
  if (srcMs != null && srcMs > 0 && nowMs >= srcMs) {
    return nowMs - srcMs;
  }
  return Number.isFinite(bbo.bbo_age_ms) && bbo.bbo_age_ms >= 0 ? bbo.bbo_age_ms : 0;
}

export class LobClient {
  private contextErrorCount_ = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 1000,
  ) {}

  /** Number of failed context management calls (trade/signal start/end). */
  get contextErrors(): number { return this.contextErrorCount_; }

  async getHealth(): Promise<LobHealthResult> {
    const res = await fetch(`${this.baseUrl}/lob/health`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`LOB health returned ${res.status}`);
    return await res.json() as LobHealthResult;
  }

  /** Lightweight BBO fetch — no full feature computation on sidecar. */
  async getBbo(): Promise<LobBbo> {
    const res = await fetch(`${this.baseUrl}/lob/bbo`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`LOB bbo returned ${res.status}`);
    return await res.json() as LobBbo;
  }

  async getSnapshot(): Promise<LobSnapshot> {
    const res = await fetch(`${this.baseUrl}/lob/snapshot`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`LOB snapshot returned ${res.status}`);
    return await res.json() as LobSnapshot;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const h = await this.getHealth();
      return h.status === 'ok' && h.source_connected && h.bbo_fresh;
    } catch {
      return false;
    }
  }

  // ── Context management ─────────────────────────────────────────────────

  async startTradeContext(tradeId: string, side?: string, entryPrice?: number): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/trade_context/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade_id: tradeId, side, entry_price: entryPrice }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      this.contextErrorCount_++;
    }
  }

  async endTradeContext(tradeId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/trade_context/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade_id: tradeId }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      this.contextErrorCount_++;
    }
  }

  async startSignalContext(signalId: string, direction?: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/signal_context/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signal_id: signalId, direction }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      this.contextErrorCount_++;
    }
  }

  async endSignalContext(signalId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/signal_context/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signal_id: signalId }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      this.contextErrorCount_++;
    }
  }
}
