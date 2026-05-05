import type { DataTier, DatabentoSchema } from '../../contracts/tier-policy.js';
import type { CachedRecordSource } from '../parquet-cache.js';
import { readCachedRecords } from '../parquet-cache.js';
import type { DbnOhlcv1mRecord, DbnRecord } from '../dbn-types.js';
import { BarBuilderInputError } from './bar-builder-input-error.js';
import { assertBarSpecConstructible, type BarSpecConstructibilityOptions } from './capability-gates.js';
import { deriveBarId, deriveBoundaryId } from './identity.js';
import { checkManifestSymbol, parseManifestSymbol, type ManifestSymbolCheck } from './manifest-symbol.js';
import type {
  BarBuilderOutput,
  BarCloseReason,
  BarOpenReason,
  BuiltBar,
  ContractRollBoundary,
} from './output-types.js';
import { parseBarSpec, type ParsedBarSpec, type TimeBarSpec } from './bar-spec.js';
import type { ContractRollPolicy, RollDetectionSource } from './roll-policy.js';
import type { BarConstructionMethod, BarQualityFlag, BarSourceMetadata } from './source-metadata.js';
import { deriveTimeBucket, type TimeBucket } from './time-bucket.js';
import {
  isDefinitionRecord,
  isOhlcvRecord,
  isTradeLikeRecord,
  resolveRecordContract,
  toKnownContractDefinition,
  toTradeLikeRecord,
  type KnownContractDefinition,
  type ResolvedRecordContract,
} from './record-adapter.js';

export interface BuildBarsOptions {
  readonly bar_spec: string;
  readonly manifest_symbol: string;
  readonly roll_policy: ContractRollPolicy;
  readonly input_schemas: readonly DatabentoSchema[];
  readonly corpus_tier: DataTier | null;
}

interface ActiveBarState {
  readonly contract: ResolvedRecordContract;
  readonly manifestSymbolCheck: ManifestSymbolCheck;
  readonly sourceMetadata: BarSourceMetadata;
  readonly openReason: BarOpenReason;
  readonly rollBoundaryId: string | null;
  readonly seq: number;
  readonly bucket: TimeBucket | null;
  readonly firstRecordTsNs: DbnRecord['ts_event'];
  lastRecordTsNs: DbnRecord['ts_event'];
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint;
  tickCount: number;
  dollarTotal: bigint;
}

interface LastClosedTimeBar {
  readonly bucketStartTsNs: TimeBucket['bucket_start_ts_ns'];
  readonly seq: number;
}

interface PendingBoundary {
  readonly boundary: ContractRollBoundary;
  readonly nextOpenReason: 'contract_roll';
}

export async function* buildBars(
  records: AsyncIterable<DbnRecord>,
  options: BuildBarsOptions,
): AsyncIterableIterator<BarBuilderOutput> {
  const parsedBarSpec = parseBarSpecOrThrow(options.bar_spec);
  const manifestExpectation = parseManifestSymbol(options.manifest_symbol);
  if (manifestExpectation.root !== options.roll_policy.instrument_root) {
    throw new BarBuilderInputError([
      {
        path: '$.manifest_symbol',
        code: 'incompatible_root',
        message: `manifest symbol root ${manifestExpectation.root} is incompatible with roll policy root ${options.roll_policy.instrument_root}`,
      },
    ]);
  }

  const constructionMethod = assertBarSpecConstructible(
    parsedBarSpec,
    options.input_schemas,
    {} satisfies BarSpecConstructibilityOptions,
  );

  const definitions = new Map<number, KnownContractDefinition>();
  let activeBar: ActiveBarState | null = null;
  let lastClosedTimeBar: LastClosedTimeBar | null = null;
  let lastContract: ResolvedRecordContract | null = null;
  let nextOpenReason: BarOpenReason = 'stream_start';
  let nextRollBoundaryId: string | null = null;

  for await (const record of records) {
    if (isDefinitionRecord(record)) {
      definitions.set(record.instrument_id, toKnownContractDefinition(record));
      continue;
    }

    if (constructionMethod === 'trade_aggregation') {
      if (!isTradeLikeRecord(record)) {
        continue;
      }

      const contract = resolveRecordContract(record, options.roll_policy.instrument_root, definitions);
      const boundary = buildBoundaryIfNeeded(lastContract, contract, record.ts_event, options, manifestExpectation);
      if (boundary !== null) {
        if (activeBar !== null) {
          const closeReason: BarCloseReason =
            isTimeBarSpec(parsedBarSpec) &&
            activeBar.bucket !== null &&
            !sameTimeBucket(record.ts_event, parsedBarSpec, activeBar.bucket)
              ? 'bar_boundary'
              : 'contract_roll';
          const closed = closeActiveBar(activeBar, options.bar_spec, closeReason, closeReason === 'bar_boundary');
          if (activeBar.bucket !== null) {
            lastClosedTimeBar = {
              bucketStartTsNs: activeBar.bucket.bucket_start_ts_ns,
              seq: activeBar.seq,
            };
          }
          yield closed;
          yield { ...boundary.boundary, forced_closed_bar_id: closed.bar_id };
          activeBar = null;
        } else {
          yield boundary.boundary;
        }
        nextOpenReason = boundary.nextOpenReason;
        nextRollBoundaryId = boundary.boundary.boundary_id;
      }

      const trade = toTradeLikeRecord(record);
      if (isTimeBarSpec(parsedBarSpec)) {
        const bucket = deriveTimeBucket(trade.ts_ns, parsedBarSpec);
        if (
          activeBar !== null &&
          activeBar.bucket !== null &&
          activeBar.bucket.bucket_start_ts_ns !== bucket.bucket_start_ts_ns
        ) {
          const closed = closeActiveBar(activeBar, options.bar_spec, 'bar_boundary', true);
          lastClosedTimeBar = {
            bucketStartTsNs: activeBar.bucket.bucket_start_ts_ns,
            seq: activeBar.seq,
          };
          yield closed;
          activeBar = null;
          nextOpenReason = 'bar_boundary';
          nextRollBoundaryId = null;
        }

        if (activeBar === null) {
          activeBar = openTradeBar(
            contract,
            trade.ts_ns,
            trade.price,
            trade.size,
            bucket,
            options,
            manifestExpectation,
            constructionMethod,
            nextRollBoundaryId,
            nextOpenReason,
            lastClosedTimeBar,
          );
          nextOpenReason = 'bar_boundary';
          nextRollBoundaryId = null;
        } else {
          accumulateTrade(activeBar, trade.price, trade.size, trade.ts_ns);
        }
      } else {
        if (activeBar === null) {
          activeBar = openTradeBar(
            contract,
            trade.ts_ns,
            trade.price,
            trade.size,
            null,
            options,
            manifestExpectation,
            constructionMethod,
            nextRollBoundaryId,
            nextOpenReason,
            null,
          );
          nextOpenReason = 'bar_boundary';
          nextRollBoundaryId = null;
        } else {
          accumulateTrade(activeBar, trade.price, trade.size, trade.ts_ns);
        }
        if (eventThresholdReached(activeBar, parsedBarSpec)) {
          const closed = closeActiveBar(activeBar, options.bar_spec, 'target_reached', true);
          yield closed;
          activeBar = null;
          nextOpenReason = 'bar_boundary';
          nextRollBoundaryId = null;
        }
      }

      lastContract = contract;
      continue;
    }

    if (!isOhlcvRecord(record)) {
      continue;
    }

    const contract = resolveRecordContract(record, options.roll_policy.instrument_root, definitions);
    const bucket = deriveTimeBucket(record.ts_event, parsedBarSpec as TimeBarSpec);
    const boundary = buildBoundaryIfNeeded(lastContract, contract, record.ts_event, options, manifestExpectation);

    if (constructionMethod === 'ohlcv_passthrough') {
      if (boundary !== null) {
        yield boundary.boundary;
        nextOpenReason = boundary.nextOpenReason;
        nextRollBoundaryId = boundary.boundary.boundary_id;
      }
      const bar = buildOhlcvPassthroughBar(
        record,
        contract,
        bucket,
        options,
        manifestExpectation,
        nextOpenReason,
        nextRollBoundaryId,
      );
      yield bar;
      lastClosedTimeBar = { bucketStartTsNs: bucket.bucket_start_ts_ns, seq: 0 };
      lastContract = contract;
      nextOpenReason = 'bar_boundary';
      nextRollBoundaryId = null;
      continue;
    }

    if (
      activeBar !== null &&
      activeBar.bucket !== null &&
      boundary !== null &&
      activeBar.bucket.bucket_start_ts_ns === bucket.bucket_start_ts_ns
    ) {
      throw new BarBuilderInputError([
        {
          path: '$.records',
          code: 'roll_unsplittable_aggregate',
          message: 'cannot split an aggregated ohlcv bar across a mid-bucket contract roll',
        },
      ]);
    }

    if (boundary !== null) {
      if (activeBar !== null) {
        const closed = closeActiveBar(activeBar, options.bar_spec, 'bar_boundary', true);
        lastClosedTimeBar = {
          bucketStartTsNs: activeBar.bucket!.bucket_start_ts_ns,
          seq: activeBar.seq,
        };
        yield closed;
        activeBar = null;
      }
      yield boundary.boundary;
      nextOpenReason = boundary.nextOpenReason;
      nextRollBoundaryId = boundary.boundary.boundary_id;
    }

    if (
      activeBar !== null &&
      activeBar.bucket !== null &&
      activeBar.bucket.bucket_start_ts_ns !== bucket.bucket_start_ts_ns
    ) {
      const closed = closeActiveBar(activeBar, options.bar_spec, 'bar_boundary', true);
      lastClosedTimeBar = {
        bucketStartTsNs: activeBar.bucket.bucket_start_ts_ns,
        seq: activeBar.seq,
      };
      yield closed;
      activeBar = null;
      nextOpenReason = 'bar_boundary';
      nextRollBoundaryId = null;
    }

    if (activeBar === null) {
      activeBar = openOhlcvAggregateBar(
        record,
        contract,
        bucket,
        options,
        manifestExpectation,
        nextOpenReason,
        lastClosedTimeBar,
        nextRollBoundaryId,
      );
      nextOpenReason = 'bar_boundary';
      nextRollBoundaryId = null;
    } else {
      accumulateOhlcv(activeBar, record);
    }
    lastContract = contract;
  }

  if (activeBar !== null) {
    yield closeActiveBar(activeBar, options.bar_spec, 'stream_end', false);
  }
}

export async function* buildCachedBars(
  source: CachedRecordSource,
  options: BuildBarsOptions,
): AsyncIterableIterator<BarBuilderOutput> {
  yield* buildBars(readCachedRecords(source.parquetPath, source.schema), options);
}

function parseBarSpecOrThrow(barSpec: string): ParsedBarSpec {
  try {
    return parseBarSpec(barSpec);
  } catch (error) {
    throw new BarBuilderInputError([
      {
        path: '$.bar_spec',
        code: 'unsupported_bar_spec',
        message: error instanceof Error ? error.message : `unsupported bar_spec: ${barSpec}`,
      },
    ]);
  }
}

function buildBoundaryIfNeeded(
  previousContract: ResolvedRecordContract | null,
  nextContract: ResolvedRecordContract,
  boundaryTsNs: DbnRecord['ts_event'],
  options: BuildBarsOptions,
  manifestExpectation: ReturnType<typeof parseManifestSymbol>,
): PendingBoundary | null {
  if (previousContract === null || previousContract.instrument_id === nextContract.instrument_id) {
    return null;
  }

  const manifestSymbolCheck = checkManifestSymbol(
    manifestExpectation,
    {
      instrument_id: nextContract.instrument_id,
      raw_symbol: nextContract.raw_symbol,
      root: nextContract.root,
    },
    options.roll_policy,
  );
  const detectionSource = deriveDetectionSource(previousContract, nextContract, options.roll_policy);
  return {
    nextOpenReason: 'contract_roll',
    boundary: {
      type: 'contract_roll_boundary',
      boundary_id: deriveBoundaryId({
        instrument_root: options.roll_policy.instrument_root,
        boundary_ts_ns: boundaryTsNs,
        previous_contract: previousContract,
        next_contract: nextContract,
      }),
      instrument_root: options.roll_policy.instrument_root,
      roll_policy: options.roll_policy,
      detection_source: detectionSource,
      boundary_ts_ns: boundaryTsNs,
      previous_contract: previousContract,
      next_contract: nextContract,
      forced_closed_bar_id: null,
      manifest_symbol_check: manifestSymbolCheck,
    },
  };
}

function deriveDetectionSource(
  previousContract: ResolvedRecordContract,
  nextContract: ResolvedRecordContract,
  policy: ContractRollPolicy,
): RollDetectionSource {
  if (
    policy.prefer_definition_validation &&
    previousContract.has_definition &&
    nextContract.has_definition &&
    previousContract.raw_symbol !== null &&
    nextContract.raw_symbol !== null
  ) {
    return 'definition_validated';
  }
  return 'instrument_id_change';
}

function createSourceMetadata(
  options: BuildBarsOptions,
  constructionMethod: BarConstructionMethod,
  contract: ResolvedRecordContract,
  manifestSymbolCheck: ManifestSymbolCheck,
  extraFlags: readonly BarQualityFlag[] = [],
): BarSourceMetadata {
  const flags = new Set<BarQualityFlag>(extraFlags);
  if (!contract.has_definition) flags.add('definition_missing');
  if (manifestSymbolCheck.status === 'unverified') flags.add('manifest_unverified');
  if (constructionMethod === 'ohlcv_passthrough' || constructionMethod === 'ohlcv_aggregation') {
    flags.add('ohlcv_source');
  }
  return Object.freeze({
    corpus_tier: options.corpus_tier,
    input_schemas: options.input_schemas,
    construction_method: constructionMethod,
    contract_identity_source: contract.identity_source,
    quality_flags: Object.freeze([...flags]),
  });
}

function openTradeBar(
  contract: ResolvedRecordContract,
  tsNs: DbnRecord['ts_event'],
  price: bigint,
  size: bigint,
  bucket: TimeBucket | null,
  options: BuildBarsOptions,
  manifestExpectation: ReturnType<typeof parseManifestSymbol>,
  constructionMethod: BarConstructionMethod,
  rollBoundaryId: string | null,
  openReason: BarOpenReason,
  lastClosedTimeBar: LastClosedTimeBar | null,
): ActiveBarState {
  const manifestSymbolCheck = checkManifestSymbol(
    manifestExpectation,
    {
      instrument_id: contract.instrument_id,
      raw_symbol: contract.raw_symbol,
      root: contract.root,
    },
    options.roll_policy,
  );
  const seq =
    bucket !== null &&
    openReason === 'contract_roll' &&
    lastClosedTimeBar !== null &&
    lastClosedTimeBar.bucketStartTsNs === bucket.bucket_start_ts_ns
      ? lastClosedTimeBar.seq + 1
      : 0;
  return {
    contract,
    manifestSymbolCheck,
    sourceMetadata: createSourceMetadata(options, constructionMethod, contract, manifestSymbolCheck),
    openReason,
    rollBoundaryId,
    seq,
    bucket,
    firstRecordTsNs: tsNs,
    lastRecordTsNs: tsNs,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: size,
    tickCount: 1,
    dollarTotal: price * size,
  };
}

function openOhlcvAggregateBar(
  record: DbnOhlcv1mRecord,
  contract: ResolvedRecordContract,
  bucket: TimeBucket,
  options: BuildBarsOptions,
  manifestExpectation: ReturnType<typeof parseManifestSymbol>,
  openReason: BarOpenReason,
  lastClosedTimeBar: LastClosedTimeBar | null,
  rollBoundaryId: string | null,
): ActiveBarState {
  const manifestSymbolCheck = checkManifestSymbol(
    manifestExpectation,
    {
      instrument_id: contract.instrument_id,
      raw_symbol: contract.raw_symbol,
      root: contract.root,
    },
    options.roll_policy,
  );
  const seq =
    openReason === 'contract_roll' &&
    lastClosedTimeBar !== null &&
    lastClosedTimeBar.bucketStartTsNs === bucket.bucket_start_ts_ns
      ? lastClosedTimeBar.seq + 1
      : 0;
  return {
    contract,
    manifestSymbolCheck,
    sourceMetadata: createSourceMetadata(options, 'ohlcv_aggregation', contract, manifestSymbolCheck),
    openReason,
    rollBoundaryId,
    seq,
    bucket,
    firstRecordTsNs: record.ts_event,
    lastRecordTsNs: record.ts_event,
    open: record.open,
    high: record.high,
    low: record.low,
    close: record.close,
    volume: record.volume,
    tickCount: 1,
    dollarTotal: record.close * record.volume,
  };
}

function buildOhlcvPassthroughBar(
  record: DbnOhlcv1mRecord,
  contract: ResolvedRecordContract,
  bucket: TimeBucket,
  options: BuildBarsOptions,
  manifestExpectation: ReturnType<typeof parseManifestSymbol>,
  openReason: BarOpenReason,
  rollBoundaryId: string | null,
): BuiltBar {
  const manifestSymbolCheck = checkManifestSymbol(
    manifestExpectation,
    {
      instrument_id: contract.instrument_id,
      raw_symbol: contract.raw_symbol,
      root: contract.root,
    },
    options.roll_policy,
  );
  return {
    type: 'bar',
    bar_id: deriveBarId({
      instrument_root: options.roll_policy.instrument_root,
      raw_symbol: contract.raw_symbol,
      instrument_id: contract.instrument_id,
      bar_spec_token: parseBarSpec(options.bar_spec).token,
      bucket_start_ts_ns: bucket.bucket_start_ts_ns,
      first_record_ts_ns: record.ts_event,
      seq: 0,
    }),
    instrument_root: options.roll_policy.instrument_root,
    instrument_id: contract.instrument_id,
    raw_symbol: contract.raw_symbol,
    bar_spec: options.bar_spec,
    open_reason: openReason,
    close_reason: 'bar_boundary',
    is_complete: true,
    roll_boundary_id: rollBoundaryId,
    manifest_symbol_check: manifestSymbolCheck,
    source_metadata: createSourceMetadata(options, 'ohlcv_passthrough', contract, manifestSymbolCheck),
    bucket_start_ts_ns: bucket.bucket_start_ts_ns,
    bucket_end_ts_ns: bucket.bucket_end_ts_ns,
    first_record_ts_ns: record.ts_event,
    last_record_ts_ns: record.ts_event,
    open: record.open,
    high: record.high,
    low: record.low,
    close: record.close,
    volume: record.volume,
  };
}

function accumulateTrade(activeBar: ActiveBarState, price: bigint, size: bigint, tsNs: DbnRecord['ts_event']): void {
  activeBar.lastRecordTsNs = tsNs;
  activeBar.high = activeBar.high > price ? activeBar.high : price;
  activeBar.low = activeBar.low < price ? activeBar.low : price;
  activeBar.close = price;
  activeBar.volume += size;
  activeBar.tickCount += 1;
  activeBar.dollarTotal += price * size;
}

function accumulateOhlcv(activeBar: ActiveBarState, record: DbnOhlcv1mRecord): void {
  activeBar.lastRecordTsNs = record.ts_event;
  activeBar.high = activeBar.high > record.high ? activeBar.high : record.high;
  activeBar.low = activeBar.low < record.low ? activeBar.low : record.low;
  activeBar.close = record.close;
  activeBar.volume += record.volume;
  activeBar.tickCount += 1;
  activeBar.dollarTotal += record.close * record.volume;
}

function closeActiveBar(
  activeBar: ActiveBarState,
  barSpec: string,
  closeReason: BarCloseReason,
  isComplete: boolean,
): BuiltBar {
  return {
    type: 'bar',
    bar_id: deriveBarId({
      instrument_root: activeBar.contract.root,
      raw_symbol: activeBar.contract.raw_symbol,
      instrument_id: activeBar.contract.instrument_id,
      bar_spec_token: parseBarSpec(barSpec).token,
      bucket_start_ts_ns: activeBar.bucket?.bucket_start_ts_ns ?? null,
      first_record_ts_ns: activeBar.firstRecordTsNs,
      seq: activeBar.seq,
    }),
    instrument_root: activeBar.contract.root,
    instrument_id: activeBar.contract.instrument_id,
    raw_symbol: activeBar.contract.raw_symbol,
    bar_spec: barSpec,
    open_reason: activeBar.openReason,
    close_reason: closeReason,
    is_complete: isComplete,
    roll_boundary_id: activeBar.rollBoundaryId,
    manifest_symbol_check: activeBar.manifestSymbolCheck,
    source_metadata: activeBar.sourceMetadata,
    bucket_start_ts_ns: activeBar.bucket?.bucket_start_ts_ns ?? null,
    bucket_end_ts_ns: activeBar.bucket?.bucket_end_ts_ns ?? null,
    first_record_ts_ns: activeBar.firstRecordTsNs,
    last_record_ts_ns: activeBar.lastRecordTsNs,
    open: activeBar.open,
    high: activeBar.high,
    low: activeBar.low,
    close: activeBar.close,
    volume: activeBar.volume,
  };
}

function isTimeBarSpec(barSpec: ParsedBarSpec): barSpec is TimeBarSpec {
  return barSpec.kind === 'time';
}

function sameTimeBucket(
  tsNs: DbnRecord['ts_event'],
  barSpec: TimeBarSpec,
  bucket: TimeBucket,
): boolean {
  return deriveTimeBucket(tsNs, barSpec).bucket_start_ts_ns === bucket.bucket_start_ts_ns;
}

function eventThresholdReached(activeBar: ActiveBarState, parsedBarSpec: ParsedBarSpec): boolean {
  if (parsedBarSpec.kind !== 'tick') {
    return false;
  }
  switch (parsedBarSpec.subkind) {
    case 'ticks':
      return activeBar.tickCount >= parsedBarSpec.count;
    case 'volume':
      return activeBar.volume >= BigInt(parsedBarSpec.count);
    case 'dollar':
      return activeBar.dollarTotal >= BigInt(parsedBarSpec.count);
  }
}
