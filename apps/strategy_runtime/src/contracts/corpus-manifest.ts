/**
 * TypeScript representation of the JSON corpus manifests emitted by
 * `scripts/sim/fetch-databento-sim03-corpus.py`. The Python emitter remains
 * canonical; these types intentionally mirror its field names so backtester
 * consumers can load existing Databento manifests without lossy translation.
 */

/** Dataset-level fetch range for a single Databento schema. */
export interface CorpusManifestDatasetSchemaRange {
  /** Inclusive provider-reported availability start timestamp. */
  readonly start: string;
  /** Exclusive provider-reported availability end timestamp. */
  readonly end: string;
}

/** Provider metadata range returned by Databento during corpus fetch. */
export interface CorpusManifestDatasetRange {
  /** Inclusive provider-reported dataset start timestamp. */
  readonly start: string;
  /** Exclusive provider-reported dataset end timestamp. */
  readonly end: string;
  /** Per-schema availability windows keyed by Databento schema name. */
  readonly schema: Readonly<Record<string, CorpusManifestDatasetSchemaRange>>;
}

/** Aggregate session and byte counts emitted in a corpus manifest. */
export interface CorpusManifestSummary {
  /** Number of sessions requested by the session-list input. */
  readonly requested_sessions: number;
  /** Number of sessions whose required files were fetched or reused. */
  readonly complete_sessions: number;
  /** Number of sessions excluded before fetch, such as short sessions. */
  readonly excluded_sessions: number;
  /** Number of sessions that were attempted but incomplete. */
  readonly partial_sessions: number;
  /** Total compressed DBN bytes across source files recorded by the manifest. */
  readonly total_bytes: number;
  /** Number of complete sessions assigned to calibration. */
  readonly calibration_sessions: number;
  /** Number of complete sessions assigned to validation. */
  readonly validation_sessions: number;
}

/** Retry policy used by the Python fetcher for provider calls. */
export interface CorpusManifestRetryPolicy {
  /** Maximum provider-call attempts per schema fetch. */
  readonly attempts: number;
  /** Backoff strategy label, for example `exponential`. */
  readonly backoff: string;
  /** Base delay in seconds used by the backoff strategy. */
  readonly base_seconds: number;
}

/** Nanosecond timestamp window recorded by the Python manifest emitter. */
export interface CorpusManifestWindow {
  /** Inclusive start timestamp in nanoseconds since Unix epoch, encoded as decimal text. */
  readonly start_ts_ns: string;
  /** Exclusive end timestamp in nanoseconds since Unix epoch, encoded as decimal text. */
  readonly end_ts_ns: string;
}

/** Per-schema DBN file entry recorded for each session. */
export interface CorpusManifestSchemaFile {
  /** Databento schema name for the DBN file. */
  readonly schema: string;
  /** Fetch status for this schema file, for example `available`. */
  readonly status: string;
  /** Path to the compressed DBN file as emitted by the Python fetcher. */
  readonly path: string;
  /** Inclusive source-data start timestamp in nanoseconds since Unix epoch. */
  readonly start_ts_ns: string;
  /** Exclusive source-data end timestamp in nanoseconds since Unix epoch. */
  readonly end_ts_ns: string;
  /** Compressed byte count observed for this DBN file. */
  readonly byte_count: number;
  /** Optional record count when the emitter has one; current Tier A manifests use `null`. */
  readonly record_count: number | null;
  /** Whether the fetcher reused a pre-existing non-empty local file. */
  readonly reused_existing: boolean;
  /** Number of fetch attempts used for this schema file. */
  readonly attempts: number;
  /** Optional lower-case sha256 file hash for future emitter versions or verified fixtures. */
  readonly sha256?: string;
}

/** A fetched or excluded trading session entry inside a corpus manifest. */
export interface CorpusManifestSession {
  /** Stable session identifier, usually `<YYYY-MM-DD>-rth`. */
  readonly session_id: string;
  /** Session fetch status, for example `complete`, `partial`, or `excluded`. */
  readonly status: string;
  /** Calibration split assignment emitted by the Python fetcher. */
  readonly split: string;
  /** Raw Databento symbol used for this session. */
  readonly symbol: string;
  /** Reason the session was excluded, or `null` when it was included. */
  readonly exclusion_reason: string | null;
  /** UTC-midnight-aligned definition snapshot window for this session. */
  readonly definition_snapshot_window: CorpusManifestWindow;
  /** Regular trading hours data window for event schemas. */
  readonly rth_window: CorpusManifestWindow;
  /** Per-schema DBN file entries keyed by Databento schema name. */
  readonly schemas: Readonly<Record<string, CorpusManifestSchemaFile>>;
}

/** Canonical TypeScript contract for Python-emitted Databento corpus manifests. */
export interface CorpusManifest {
  /** Manifest schema version emitted as `manifest_schema_version` by the Python fetcher. */
  readonly manifest_schema_version: number;
  /** Ticket identifier for the Python emitter that produced the manifest. */
  readonly ticket_id: string;
  /** Corpus fetch status, for example `complete` or `partial`. */
  readonly status: string;
  /** Structured blocker reason when the corpus is not ready, otherwise `null`. */
  readonly blocked_reason: string | null;
  /** Whether enough complete sessions were fetched for SIM-03 model fitting. */
  readonly ready_for_sim03_model_fitting: boolean;
  /** Scope note emitted by the Python fetcher describing what the manifest does not do. */
  readonly scope_note: string;
  /** Databento dataset name, for example `GLBX.MDP3`. */
  readonly dataset: string;
  /** Default corpus symbol from the fetch invocation. */
  readonly symbol: string;
  /** Whether the Python process observed `DATABENTO_API_KEY` during fetch. */
  readonly databento_api_key_present: boolean;
  /** Provider dataset range snapshot captured during fetch. */
  readonly dataset_range: CorpusManifestDatasetRange;
  /** Provider dataset range error, or `null` when metadata was available. */
  readonly dataset_range_error: string | null;
  /** Databento schema used for contract definition snapshots. */
  readonly definition_schema: string;
  /** Event schemas fetched over each session RTH window. */
  readonly event_schemas: readonly string[];
  /** Minimum complete-session count requested for the fetch. */
  readonly min_complete_sessions: number;
  /** Output directory passed to the Python fetcher. */
  readonly out_dir: string;
  /** Retry policy active during corpus fetch. */
  readonly retry_policy: CorpusManifestRetryPolicy;
  /** Validation split fraction used by the Python fetcher. */
  readonly validation_fraction: number;
  /** Aggregate corpus counts and byte totals. */
  readonly corpus_summary: CorpusManifestSummary;
  /** Per-session manifest entries in emitter order. */
  readonly sessions: readonly CorpusManifestSession[];
}
