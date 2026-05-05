/**
 * TypeScript contract for the manually curated QFA-111 economic calendar.
 *
 * The source artifact is `config/research/economic-calendar.yaml`, committed to
 * git for deterministic alpha-validation research. It covers the source-backed
 * event universe used by downstream Phase 4/5 work: FOMC decisions, CPI
 * releases, NFP/Employment Situation releases, and major OPEC/OPEC+ policy
 * decision events.
 */

/** Supported economic-event categories in the curated calendar. */
export type Category = 'FOMC' | 'CPI' | 'NFP' | 'OPEC';

/** Coarse market-impact class assigned during manual curation. */
export type MarketImpactClass = 'high' | 'medium' | 'low';

/** One source-backed manually curated economic-calendar event. */
export interface EconomicCalendarEvent {
  /** Stable event identifier in `<category-lowercase>-<YYYY-MM-DD>` form. */
  readonly event_id: string;
  /** Event category. */
  readonly category: Category;
  /** Event date in `YYYY-MM-DD` format. */
  readonly event_date: string;
  /**
   * Announcement or release time in UTC `HH:MM:SS` format, or `null` when the
   * authoritative source does not publish a canonical timestamp.
   */
  readonly event_time_utc: string | null;
  /** Human-readable event description. */
  readonly description: string;
  /** Official source URL used to curate this event. */
  readonly authoritative_source: string;
  /** Optional coarse impact classification. */
  readonly market_impact_class?: MarketImpactClass;
  /** Optional ex-post numeric surprise measure, when curated in a later phase. */
  readonly surprise_factor?: number;
}

/** Versioned manually curated economic-calendar artifact. */
export interface EconomicCalendar {
  /** Calendar config format version. */
  readonly version: number;
  /** Calendar schema version. */
  readonly schema_version: number;
  /** Source policy for the calendar artifact. */
  readonly source: 'manual_curation';
  /** Human-readable methodology and inclusion-policy notes. */
  readonly editorial_notes: string;
  /** Date-sorted event list. */
  readonly events: readonly EconomicCalendarEvent[];
}

/** Loaded economic calendar plus deterministic config-lineage metadata. */
export interface LoadedEconomicCalendar extends EconomicCalendar {
  /** Sha256 hash of the canonicalized parsed calendar contents. */
  readonly config_hash: string;
  /** Hash algorithm used for `config_hash`. */
  readonly config_hash_algorithm: 'sha256';
  /** Canonical JSON used as the input to `config_hash`. */
  readonly canonical_config_json: string;
}
