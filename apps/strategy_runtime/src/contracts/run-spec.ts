/**
 * QFA-115 Backtest Run Specification — pure type definitions and role-order
 * constants. The contract for what a backtest run is and how its inputs are
 * declared.
 *
 * Module decomposition:
 *   run-spec.ts             — types + role-order constants (this file)
 *   run-spec-validate.ts    — invariant validation
 *   run-spec-hash.ts        — RunSpec-specific JCS canonicalization + sha256
 *   run-id.ts               — deterministic run-id derivation
 *   backtest-run-meta.ts    — event payload (extends RunSpec)
 *
 * This file is types-only. It contains no logic, validation, hashing, or
 * derivation. See sibling modules.
 *
 * See `docs/adr/ADR-0007-backtest-lineage-block.md` (authored in QFA-115
 * Session 2b) for the binding design rationale.
 */

import type { ConfigLineageRef } from './lineage.js';
import type { StrategyId } from './strategy-ids.js';

/**
 * Operational role of a config artifact relative to a backtest run.
 * Used to disambiguate identically-shaped {@link ConfigLineageRef}s when
 * multiple configs participate in a single run (e.g., one config per
 * strategy plus a shared strategies config plus risk and management).
 */
export type ConfigInputRole =
  | 'strategy'
  | 'strategy_shared'
  | 'risk'
  | 'management'
  | 'venue_cost'
  | 'session'
  | 'roll_policy'
  | 'walk_forward'
  | 'tier_policy'
  | 'economic_calendar_policy'
  | 'fill_model_config'
  | 'cost_model_config'
  | 'other';

/**
 * Operational role of a corpus relative to a backtest run.
 *
 * - `primary` — the corpus the backtest reads from.
 * - `calibration` — calibration corpus for fill / cost / model fits.
 * - `validation` — held-out corpus used for validation gating.
 * - `held_out` — corpus reserved for final OOS evaluation.
 * - `stress` — stress-regime corpus used for robustness checks.
 * - `other` — escape hatch for ad-hoc roles; must be justified in
 *    `tier_classification.classification_reason`.
 */
export type CorpusInputRole =
  | 'primary'
  | 'calibration'
  | 'validation'
  | 'held_out'
  | 'stress'
  | 'other';

/**
 * Provenance of how a corpus's data tier was decided.
 *
 * - `runner_code` — tier is hard-coded by the runner (e.g., the runner ran
 *    `classifyCorpusTier` from `tier-policy.ts`).
 * - `config` — tier is asserted by an external config artifact whose lineage
 *    is referenced via {@link CorpusTierClassificationRef.policy_ref}.
 */
export type CorpusTierPolicySource = 'runner_code' | 'config';

/**
 * Whether a corpus's verified-report has been run and passed at the time of
 * this backtest. `not_run` is allowed but disables the
 * {@link CorpusInputRef.verification_report_hash} field; `passed` requires it.
 */
export type CorpusVerificationStatus = 'not_run' | 'passed';

/**
 * The three-tier data taxonomy literal type. Self-defined here to keep
 * `run-spec.ts` independent of `tier-policy.ts`'s implementation. The string
 * values must match `tier-policy.ts`'s `DataTier` union; consumers that need
 * the policy-side type should import from `tier-policy.ts` directly.
 */
export type CorpusDataTier = 'A' | 'B' | 'C';

/**
 * A {@link ConfigLineageRef} annotated with its operational role and source
 * path. Used to disambiguate same-shape lineage refs in `RunSpec.config_inputs`.
 */
export interface NamedConfigLineageRef {
  /** Role of this config relative to the backtest. */
  readonly role: ConfigInputRole;
  /**
   * Repo-relative POSIX-normalized path to the config artifact. Validation
   * rejects backslashes, absolute paths, drive-letter prefixes, and `..`
   * traversal segments. See `validateConfigPath` in `run-spec-validate.ts`.
   */
  readonly config_path: string;
  /** The hash + version pair already in lineage.ts. */
  readonly lineage: ConfigLineageRef;
}

/**
 * Tier classification provenance for a corpus input. Encodes both the
 * decided tier (in {@link CorpusInputRef.tier}) and how the decision was
 * reached.
 *
 * Invariant enforced by `validateRunSpec`:
 *  - `policy_source === 'config'` IFF `policy_ref !== null`.
 *  - `policy_source === 'runner_code'` IFF `policy_ref === null`.
 */
export interface CorpusTierClassificationRef {
  /**
   * Human-readable explanation of which schemas drove the classification.
   * Mirror of `classifyCorpusTier`'s `classification_reason` field; copied
   * here so the BacktestRunMeta event is self-contained without needing to
   * re-classify at read time.
   */
  readonly classification_reason: string;
  /** Provenance of the tier decision. */
  readonly policy_source: CorpusTierPolicySource;
  /**
   * Lineage of the config that asserted the tier, when `policy_source === 'config'`.
   * Null when `policy_source === 'runner_code'` (the runner classified itself).
   */
  readonly policy_ref: ConfigLineageRef | null;
}

/**
 * A single corpus input declared by a backtest run. Pairs the corpus's
 * manifest hash with its declared tier and verification state.
 *
 * Invariants enforced by `validateRunSpec`:
 *  - `verification_status === 'passed'` IFF `verification_report_hash !== null`.
 *  - `verification_status === 'not_run'` IFF `verification_report_hash === null`.
 *  - `tier_classification.policy_ref` correctness (see
 *    {@link CorpusTierClassificationRef}).
 */
export interface CorpusInputRef {
  /** Operational role of this corpus relative to the backtest. */
  readonly role: CorpusInputRole;
  /** Lower-case 64-char hex sha256 of the corpus manifest content. */
  readonly manifest_hash: string;
  /** Schema version of the manifest at hash time. Must be a positive integer. */
  readonly manifest_schema_version: number;
  /**
   * Lower-case 64-char hex sha256 of the verified report file bytes when
   * `verification_status === 'passed'`. Null otherwise.
   */
  readonly verification_report_hash: string | null;
  /** Whether the corpus has been verified at the time of this backtest. */
  readonly verification_status: CorpusVerificationStatus;
  /** The three-tier classification of the corpus's microstructure schemas. */
  readonly tier: CorpusDataTier;
  /** Provenance and reasoning for the tier classification. */
  readonly tier_classification: CorpusTierClassificationRef;
}

/**
 * Backtest replay window. ISO-8601 string boundaries; mode determines whether
 * boundaries are interpreted as session ends ('session') or instants ('instant').
 *
 * Invariants enforced by `validateRunSpec`:
 *  - `start <= end` (lexicographic on ISO-8601).
 *  - `mode === 'session'` requires YYYY-MM-DD or expanded calendar-date format.
 *  - `mode === 'instant'` requires UTC ISO-8601 with explicit Z suffix.
 *  - `inclusive_end` semantic: when true, end-instant or end-session is included.
 */
export interface BacktestWindow {
  /** Inclusive start. ISO-8601 calendar date (session mode) or UTC instant (instant mode). */
  readonly start: string;
  /**
   * End boundary. ISO-8601 calendar date (session mode) or UTC instant
   * (instant mode). Inclusive iff {@link BacktestWindow.inclusive_end}.
   */
  readonly end: string;
  /** Boundary semantics. */
  readonly mode: 'instant' | 'session';
  /** Whether `end` is included in the window. */
  readonly inclusive_end: boolean;
  /** Trading calendar used to interpret session boundaries. */
  readonly calendar: 'CME_US_INDEX_FUTURES';
}

/**
 * The complete specification of a single backtest run. Hashed via
 * `computeRunSpecHash` to produce a deterministic `run_spec_hash`, and
 * embedded in the `BACKTEST_RUN_META` journal event for self-contained
 * lineage.
 *
 * Field-shape invariants are enforced by `validateRunSpec` in
 * `run-spec-validate.ts`. Hashing and ID derivation are in `run-spec-hash.ts`
 * and `run-id.ts` respectively.
 */
export interface RunSpec {
  /** Schema version of the RunSpec format. Pinned to 1 in QFA-115. */
  readonly run_spec_schema_version: 1;
  /** Instrument family. MNQ-only in V1. */
  readonly instrument_root: 'MNQ';
  /**
   * Bar specification. Time bars: `1m`, `5m`, `1h`, `1d`, `30s` etc. Tick-derived
   * bars: `tick:ticks:N`, `tick:volume:N`, `tick:dollar:N`. Validated by
   * `validateBarSpecGrammar` and tokenized by `deriveBarToken`.
   */
  readonly bar_spec: string;
  /** Replay window. */
  readonly backtest_window: BacktestWindow;
  /**
   * Deterministic seed for any seeded-PRNG path (e.g., `FixedSeedRandomSource`).
   * Must be a non-negative safe integer ≤ 2^32 - 1.
   */
  readonly determinism_seed: number;
  /**
   * Strategies active in this run. Order is semantic (preserved by JCS;
   * NOT sorted) — different orderings produce different run_spec_hashes.
   * No duplicates allowed; each must be a known StrategyId.
   */
  readonly strategy_ids: readonly StrategyId[];
  /**
   * Corpus inputs. Ordered by `CORPUS_INPUT_ROLE_ORDER`, then `manifest_hash`
   * ASC, then `manifest_schema_version` ASC. Validation rejects out-of-order;
   * does NOT silently sort.
   */
  readonly corpus_inputs: readonly CorpusInputRef[];
  /**
   * Config inputs. Ordered by `CONFIG_INPUT_ROLE_ORDER`, then `config_path` ASC,
   * then `lineage.config_hash` ASC, then `lineage.config_version` ASC.
   * Validation rejects out-of-order.
   */
  readonly config_inputs: readonly NamedConfigLineageRef[];
  /** Lower-case 40-char hex git SHA-1 of the runner code at run time. */
  readonly runner_code_commit_sha: string;
  /** Whether the runner's working tree had uncommitted changes at run time. */
  readonly runner_code_dirty: boolean;
}

/**
 * Required ordering of corpus inputs by role. Validation enforces that
 * `RunSpec.corpus_inputs` appears in this role-order (with same-role ties
 * broken by `manifest_hash` then `manifest_schema_version`).
 *
 * Determinism guarantee: identical RunSpec content produces identical
 * `run_spec_hash` independent of caller construction order, because
 * validation rejects out-of-order arrays before hashing.
 */
export const CORPUS_INPUT_ROLE_ORDER = [
  'primary',
  'calibration',
  'validation',
  'held_out',
  'stress',
  'other',
] as const satisfies readonly CorpusInputRole[];

/**
 * Required ordering of config inputs by role. Validation enforces that
 * `RunSpec.config_inputs` appears in this role-order (with same-role ties
 * broken by `config_path` then `lineage.config_hash` then `lineage.config_version`).
 *
 * The role list mirrors `ConfigInputRole`. Adding a new role requires updating
 * BOTH this constant AND the union; tests assert that every union member
 * appears here.
 */
export const CONFIG_INPUT_ROLE_ORDER = [
  'strategy',
  'strategy_shared',
  'risk',
  'management',
  'venue_cost',
  'session',
  'roll_policy',
  'walk_forward',
  'tier_policy',
  'economic_calendar_policy',
  'fill_model_config',
  'cost_model_config',
  'other',
] as const satisfies readonly ConfigInputRole[];
