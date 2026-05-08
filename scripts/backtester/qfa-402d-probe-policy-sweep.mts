import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareQueueFidelityProbe,
  DEFAULT_QUEUE_FIDELITY_POLICY_V1,
  summarizeQueueFidelityRegime,
} from '../../apps/backtester/src/fidelity/queue/index.js';
import type {
  QueueFidelityPolicy,
  QueueFidelityProbe,
  QueueFidelityProbeResult,
} from '../../apps/backtester/src/fidelity/queue/index.js';
import { loadDbnFile } from '../../apps/strategy_runtime/src/data/dbn-loader.js';
import type { DbnMboRecord, DbnMbp1Record, DbnRecord } from '../../apps/strategy_runtime/src/data/dbn-types.js';
import { synthesizeQueue } from '../../apps/strategy_runtime/src/data/queue-synthesis/queue-synthesizer.js';
import type {
  PassiveFillEstimate,
  PassiveOrderProbe,
  QueueSynthesisOptions,
} from '../../apps/strategy_runtime/src/data/queue-synthesis/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const ARCHIVE_ROOT = 'D:/qfa-cache/databento/tier-a-feb-mar-2026';
const OUTPUT_PATH = join(REPO_ROOT, '.tmp', 'qfa-402d-probe-policy-sweep.json');
const SCRATCH_ROOT = join(REPO_ROOT, 'scratch', 'qfa-402d');

const ONE_SECOND_NS = 1_000_000_000n;
const THIRTY_MINUTES_NS = 1_800_000_000_000n;
const MNQ_TICK_SIZE_PRICE_UNITS = 250_000_000n;
const PPM_DENOMINATOR = 1_000_000n;

const LOCKED_MANIFEST_HASHES = Object.freeze({
  feb: '05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c',
  mar: 'cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f',
});

const PROBABILITY_BUCKET_ORDER = Object.freeze([
  '0',
  '1_100k',
  '100k_300k',
  '300k_700k',
  '700k_900k',
  '900k_1000k',
]);
const SIDE_BUCKET_ORDER = Object.freeze(['buy', 'sell']);
const SPREAD_BUCKET_ORDER = Object.freeze(['1_tick', '2_ticks', '3_plus_ticks', 'unknown']);
const QUEUE_BUCKET_ORDER = Object.freeze(['0', '1_5', '6_20', '21_plus', 'unknown']);
const TIME_BUCKET_ORDER = Object.freeze(['first_30m', 'mid_session', 'last_30m', 'bounded_prefix']);
const FILL_HORIZON_GRID_NS = Object.freeze([
  2_500_000_000n,
  5_000_000_000n,
  10_000_000_000n,
  15_000_000_000n,
]);
const DEPLETION_LOOKBACK_GRID_NS = Object.freeze([
  15_000_000_000n,
  30_000_000_000n,
  60_000_000_000n,
]);

interface ManifestSessionSchema {
  readonly path: string;
  readonly byte_count: number;
}

interface ManifestSession {
  readonly session_id: string;
  readonly symbol: string;
  readonly instrument_id?: number;
  readonly schemas: Record<string, ManifestSessionSchema>;
}

interface CorpusManifest {
  readonly sessions: readonly ManifestSession[];
}

interface SessionConfig {
  readonly label: string;
  readonly regime: string;
  readonly month: 'feb' | 'mar';
  readonly session_id: string;
  readonly scope: 'full_rth' | 'first_1800s_prefix';
  readonly prefix_duration_ns: bigint | null;
  readonly fill_horizon_ns: bigint;
  readonly depletion_lookback_ns: bigint;
  readonly rationale: string;
}

interface ProbeContext {
  readonly probe_id: string;
  readonly spread_ticks: number | null;
  readonly spread_bucket: string;
  readonly queue_ahead_proxy: bigint | null;
  readonly queue_ahead_bucket: string;
  readonly time_bucket: string;
}

interface MutableTopOfBook {
  bid_px: bigint | null;
  bid_sz: bigint | null;
  ask_px: bigint | null;
  ask_sz: bigint | null;
}

interface GeneratedProbes {
  readonly probes: readonly QueueFidelityProbe[];
  readonly contexts: ReadonlyMap<string, ProbeContext>;
  readonly first_sample_ts_ns: bigint;
  readonly last_sample_ts_ns: bigint;
  readonly probe_window_end_ts_ns: bigint | null;
  readonly probe_source_mbp1_records: number;
}

interface RecordCounter {
  count: number;
}

interface ActiveMboOrder {
  order_id: bigint;
  side: 'B' | 'A';
  price: bigint;
  size: bigint;
  ahead_of_virtual_order: boolean;
}

interface ActiveReferenceProbe {
  probe: QueueFidelityProbe;
  queue_ahead: bigint;
  filled: bigint;
  expires_at_ns: bigint;
}

interface AnalysisProbeRow {
  readonly probe_id: string;
  readonly ts_ns: string;
  readonly side: string;
  readonly reference_fill_probability_ppm: number;
  readonly synthesized_fill_probability_ppm: number;
  readonly signed_error_ppm: number;
  readonly absolute_error_ppm: number;
  readonly within_tolerance: boolean;
  readonly spread_bucket: string;
  readonly spread_ticks: number | null;
  readonly queue_ahead_bucket: string;
  readonly queue_ahead_proxy: string | null;
  readonly time_bucket: string;
  readonly synthesized_probability_bucket: string;
  readonly reference_probability_bucket: string;
}

const SESSION_BASES = Object.freeze([
  {
    label_prefix: 'feb25_full_rth',
    regime: 'feb_baseline_1',
    month: 'feb',
    session_id: '2026-02-25-rth',
    scope: 'full_rth',
    prefix_duration_ns: null,
    rationale: 'Direct full-RTH delta point from QFA-402b.',
  },
  {
    label_prefix: 'feb24_full_rth',
    regime: 'feb_baseline_2',
    month: 'feb',
    session_id: '2026-02-24-rth',
    scope: 'full_rth',
    prefix_duration_ns: null,
    rationale: 'First preferred second clean Feb session with complete mbo, mbp-1, and trades schemas.',
  },
] satisfies readonly Omit<SessionConfig, 'label' | 'fill_horizon_ns' | 'depletion_lookback_ns'>[] & readonly { readonly label_prefix: string }[]);

const SESSION_CONFIGS: readonly SessionConfig[] = Object.freeze(SESSION_BASES.flatMap((base) =>
  FILL_HORIZON_GRID_NS.flatMap((fillHorizon) =>
    DEPLETION_LOOKBACK_GRID_NS.map((lookback) => Object.freeze({
      label: `${base.label_prefix}_h${fillHorizon.toString()}_l${lookback.toString()}`,
      regime: base.regime,
      month: base.month,
      session_id: base.session_id,
      scope: base.scope,
      prefix_duration_ns: base.prefix_duration_ns,
      fill_horizon_ns: fillHorizon,
      depletion_lookback_ns: lookback,
      rationale: base.rationale,
    })),
  ),
));

function nowMs(): number {
  return performance.now();
}

function durationMs(startMs: number, endMs = nowMs()): number {
  return Math.round(endMs - startMs);
}

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readManifest(month: 'feb' | 'mar'): CorpusManifest {
  const manifestPath = join(ARCHIVE_ROOT, `manifest-${month}-2026.json`);
  const expectedHash = LOCKED_MANIFEST_HASHES[month];
  const actualHash = sha256File(manifestPath);
  if (actualHash !== expectedHash) {
    throw new Error(`Manifest hash mismatch for ${month}: expected ${expectedHash}, actual ${actualHash}`);
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as CorpusManifest;
}

function findSession(manifest: CorpusManifest, sessionId: string): ManifestSession {
  const session = manifest.sessions.find((entry) => entry.session_id === sessionId);
  if (session === undefined) {
    throw new Error(`Session ${sessionId} not found in manifest`);
  }
  for (const schema of ['mbo', 'mbp-1', 'trades']) {
    if (session.schemas[schema] === undefined) {
      throw new Error(`Session ${sessionId} missing required schema ${schema}`);
    }
  }
  return session;
}

function fullSchemaPath(schema: ManifestSessionSchema): string {
  if (isAbsolute(schema.path)) {
    return schema.path;
  }
  return join(ARCHIVE_ROOT, schema.path);
}

function floorToSecond(tsNs: bigint): bigint {
  return (tsNs / ONE_SECOND_NS) * ONE_SECOND_NS;
}

function isMbp1Record(record: DbnRecord): record is Extract<DbnRecord, { readonly schema: 'mbp-1' }> {
  return record.schema === 'mbp-1';
}

function isTradesRecord(record: DbnRecord): record is Extract<DbnRecord, { readonly schema: 'trades' }> {
  return record.schema === 'trades';
}

function topLevel(record: DbnMbp1Record): DbnMbp1Record['levels'][number] | null {
  return record.levels.length > 0 ? record.levels[0] : null;
}

function ensureTopOfBook(map: Map<number, MutableTopOfBook>, instrumentId: number): MutableTopOfBook {
  const existing = map.get(instrumentId);
  if (existing !== undefined) {
    return existing;
  }
  const created: MutableTopOfBook = {
    bid_px: null,
    bid_sz: null,
    ask_px: null,
    ask_sz: null,
  };
  map.set(instrumentId, created);
  return created;
}

function applyMbp1TopOfBook(map: Map<number, MutableTopOfBook>, record: Extract<DbnRecord, { readonly schema: 'mbp-1' }>): void {
  const level = topLevel(record);
  if (level === null) {
    return;
  }
  const state = ensureTopOfBook(map, record.instrument_id);
  state.bid_px = BigInt(level.bid_px);
  state.bid_sz = BigInt(level.bid_sz);
  state.ask_px = BigInt(level.ask_px);
  state.ask_sz = BigInt(level.ask_sz);
}

function spreadBucket(spreadTicks: number | null): string {
  if (spreadTicks === null || !Number.isFinite(spreadTicks) || spreadTicks < 1) {
    return 'unknown';
  }
  if (spreadTicks === 1) {
    return '1_tick';
  }
  if (spreadTicks === 2) {
    return '2_ticks';
  }
  return '3_plus_ticks';
}

function queueAheadBucket(queueAhead: bigint | null): string {
  if (queueAhead === null || queueAhead < 0n) {
    return 'unknown';
  }
  if (queueAhead === 0n) {
    return '0';
  }
  if (queueAhead <= 5n) {
    return '1_5';
  }
  if (queueAhead <= 20n) {
    return '6_20';
  }
  return '21_plus';
}

function probabilityBucket(value: number): string {
  if (value === 0) {
    return '0';
  }
  if (value <= 100_000) {
    return '1_100k';
  }
  if (value <= 300_000) {
    return '100k_300k';
  }
  if (value <= 700_000) {
    return '300k_700k';
  }
  if (value <= 900_000) {
    return '700k_900k';
  }
  return '900k_1000k';
}

function computeSpreadTicks(state: MutableTopOfBook): number | null {
  if (state.bid_px === null || state.ask_px === null || state.ask_px <= state.bid_px) {
    return null;
  }
  const spread = state.ask_px - state.bid_px;
  const ticks = spread / MNQ_TICK_SIZE_PRICE_UNITS;
  if (ticks <= 0n || ticks > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(ticks);
}

function emitSample(
  sampleTs: bigint,
  rawSymbol: string,
  topOfBookByInstrument: Map<number, MutableTopOfBook>,
  probes: QueueFidelityProbe[],
  pendingContexts: Omit<ProbeContext, 'time_bucket'>[],
  fillHorizonNs: bigint,
  depletionLookbackNs: bigint,
): void {
  const instrumentIds = Array.from(topOfBookByInstrument.keys()).sort((left, right) => left - right);
  for (const instrumentId of instrumentIds) {
    const state = topOfBookByInstrument.get(instrumentId);
    if (state === undefined) {
      continue;
    }
    const spreadTicks = computeSpreadTicks(state);
    const candidates = [
      { side: 'buy' as const, price: state.bid_px, visibleSize: state.bid_sz },
      { side: 'sell' as const, price: state.ask_px, visibleSize: state.ask_sz },
    ];
    for (const candidate of candidates) {
      if (candidate.price === null || candidate.visibleSize === null || candidate.price <= 0n || candidate.visibleSize <= 0n) {
        continue;
      }
      const sequence = probes.length + 1;
      const probeId = `qfa-402:${sampleTs.toString()}:${instrumentId}:${candidate.side}:${candidate.price.toString()}:${sequence}`;
      probes.push(Object.freeze({
        probe_id: probeId,
        ts_ns: sampleTs,
        instrument_id: instrumentId,
        raw_symbol: rawSymbol,
        side: candidate.side,
        limit_price: candidate.price,
        quantity: DEFAULT_QUEUE_FIDELITY_POLICY_V1.order_quantity,
        fill_horizon_ns: fillHorizonNs,
        depletion_lookback_ns: depletionLookbackNs,
      }));
      pendingContexts.push(Object.freeze({
        probe_id: probeId,
        spread_ticks: spreadTicks,
        spread_bucket: spreadBucket(spreadTicks),
        queue_ahead_proxy: candidate.visibleSize,
        queue_ahead_bucket: queueAheadBucket(candidate.visibleSize),
      }));
    }
  }
}

function timeBucketForFullSession(tsNs: bigint, firstSample: bigint, lastSample: bigint): string {
  if (tsNs - firstSample < THIRTY_MINUTES_NS) {
    return 'first_30m';
  }
  if (lastSample - tsNs < THIRTY_MINUTES_NS) {
    return 'last_30m';
  }
  return 'mid_session';
}

async function generateStreamingProbes(
  mbp1Path: string,
  rawSymbol: string,
  config: SessionConfig,
): Promise<GeneratedProbes> {
  const probes: QueueFidelityProbe[] = [];
  const pendingContexts: Omit<ProbeContext, 'time_bucket'>[] = [];
  const topOfBookByInstrument = new Map<number, MutableTopOfBook>();
  let firstSample: bigint | null = null;
  let nextSample: bigint | null = null;
  let lastRecordTs: bigint | null = null;
  let probeWindowEnd: bigint | null = null;
  let probeSourceRecords = 0;

  for await (const record of loadDbnFile(mbp1Path, 'mbp-1')) {
    if (!isMbp1Record(record)) {
      continue;
    }
    if (firstSample === null || nextSample === null) {
      firstSample = floorToSecond(record.ts_event);
      nextSample = firstSample;
      probeWindowEnd = config.prefix_duration_ns === null ? null : firstSample + config.prefix_duration_ns;
    }
    if (probeWindowEnd !== null && record.ts_event >= probeWindowEnd) {
      while (nextSample < probeWindowEnd) {
        emitSample(nextSample, rawSymbol, topOfBookByInstrument, probes, pendingContexts, config.fill_horizon_ns, config.depletion_lookback_ns);
        nextSample += ONE_SECOND_NS;
      }
      break;
    }
    while (nextSample < record.ts_event && (probeWindowEnd === null || nextSample < probeWindowEnd)) {
      emitSample(nextSample, rawSymbol, topOfBookByInstrument, probes, pendingContexts, config.fill_horizon_ns, config.depletion_lookback_ns);
      nextSample += ONE_SECOND_NS;
    }
    applyMbp1TopOfBook(topOfBookByInstrument, record);
    lastRecordTs = record.ts_event;
    probeSourceRecords += 1;
  }

  if (firstSample === null || nextSample === null) {
    throw new Error(`No mbp-1 records found for ${config.session_id}`);
  }

  const finalExclusive = probeWindowEnd ?? ((lastRecordTs === null ? firstSample : floorToSecond(lastRecordTs)) + ONE_SECOND_NS);
  while (nextSample < finalExclusive) {
    emitSample(nextSample, rawSymbol, topOfBookByInstrument, probes, pendingContexts, config.fill_horizon_ns, config.depletion_lookback_ns);
    nextSample += ONE_SECOND_NS;
  }

  const lastSample = probes.length === 0 ? firstSample : probes[probes.length - 1]!.ts_ns;
  const probeById = new Map(probes.map((probe) => [probe.probe_id, probe] as const));
  const contexts = new Map<string, ProbeContext>();
  for (const context of pendingContexts) {
    const probe = probeById.get(context.probe_id);
    if (probe === undefined) {
      throw new Error(`Missing probe for context ${context.probe_id}`);
    }
    contexts.set(context.probe_id, Object.freeze({
      ...context,
      time_bucket: config.scope === 'first_1800s_prefix'
        ? 'bounded_prefix'
        : timeBucketForFullSession(probe.ts_ns, firstSample, lastSample),
    }));
  }

  return Object.freeze({
    probes: Object.freeze(probes),
    contexts,
    first_sample_ts_ns: firstSample,
    last_sample_ts_ns: lastSample,
    probe_window_end_ts_ns: probeWindowEnd,
    probe_source_mbp1_records: probeSourceRecords,
  });
}

async function* boundedDbnRecords(
  path: string,
  schema: 'mbp-1' | 'trades',
  lowerInclusive: bigint | null,
  upperInclusive: bigint | null,
  counter: RecordCounter,
): AsyncIterable<DbnRecord> {
  for await (const record of loadDbnFile(path, schema)) {
    if (lowerInclusive !== null && record.ts_event < lowerInclusive) {
      continue;
    }
    if (upperInclusive !== null && record.ts_event > upperInclusive) {
      break;
    }
    if (schema === 'mbp-1' && !isMbp1Record(record)) {
      continue;
    }
    if (schema === 'trades' && !isTradesRecord(record)) {
      continue;
    }
    counter.count += 1;
    yield record;
  }
}

function toPassiveOrderProbe(probe: QueueFidelityProbe): PassiveOrderProbe {
  return Object.freeze({
    ts_ns: probe.ts_ns,
    instrument_id: probe.instrument_id,
    raw_symbol: probe.raw_symbol,
    side: probe.side,
    limit_price: probe.limit_price,
    order_quantity: probe.quantity,
    latency_ns: 0n,
  });
}

async function* asyncPassiveProbes(probes: readonly QueueFidelityProbe[]): AsyncIterable<PassiveOrderProbe> {
  for (const probe of probes) {
    yield toPassiveOrderProbe(probe);
  }
}

function synthesizedResultFromEstimate(probe: QueueFidelityProbe, estimate: PassiveFillEstimate | undefined): QueueFidelityProbeResult {
  if (estimate === undefined || estimate.estimated_fill_probability_ppm === null || estimate.source_metadata.quality_flags.includes('queue_state_unavailable')) {
    return Object.freeze({
      probe_id: probe.probe_id,
      ts_ns: probe.ts_ns,
      side: probe.side,
      limit_price: probe.limit_price,
      quantity: probe.quantity,
      reference_fill_probability_ppm: null,
      synthesized_fill_probability_ppm: null,
      absolute_error_ppm: null,
      within_tolerance: null,
      status: 'synthesized_unavailable',
    });
  }
  return Object.freeze({
    probe_id: probe.probe_id,
    ts_ns: probe.ts_ns,
    side: probe.side,
    limit_price: probe.limit_price,
    quantity: probe.quantity,
    reference_fill_probability_ppm: null,
    synthesized_fill_probability_ppm: estimate.estimated_fill_probability_ppm,
    absolute_error_ppm: null,
    within_tolerance: null,
    status: 'compared',
  });
}

async function computeSynthesizedResults(
  probes: readonly QueueFidelityProbe[],
  mbp1Path: string,
  tradesPath: string,
  windowStart: bigint | null,
  windowEnd: bigint | null,
  symbol: string,
  fillHorizonNs: bigint,
  depletionLookbackNs: bigint,
): Promise<{ readonly results: readonly QueueFidelityProbeResult[]; readonly mbp1_records: number; readonly trades_records: number }> {
  const mbp1Counter: RecordCounter = { count: 0 };
  const tradesCounter: RecordCounter = { count: 0 };
  const options: QueueSynthesisOptions = Object.freeze({
    instrument_root: inferInstrumentRoot(symbol) ?? 'MNQ',
    manifest_symbol: symbol,
    mode: 'mbp_trades_proxy',
    input_schemas: Object.freeze(['mbp-1', 'trades']),
    corpus_tier: null,
    passive_order_quantity: DEFAULT_QUEUE_FIDELITY_POLICY_V1.order_quantity,
    fill_horizon_ns: fillHorizonNs,
    depletion_lookback_ns: depletionLookbackNs,
    allow_unverified_identity: true,
  });
  const probeIdsByKey = new Map(probes.map((probe) => [probeKey(probe), probe.probe_id] as const));
  const estimatesByProbe = new Map<string, PassiveFillEstimate>();
  for await (const output of synthesizeQueue(
    [
      boundedDbnRecords(mbp1Path, 'mbp-1', windowStart, windowEnd, mbp1Counter),
      boundedDbnRecords(tradesPath, 'trades', windowStart, windowEnd, tradesCounter),
    ],
    options,
    asyncPassiveProbes(probes),
  )) {
    if (output.type !== 'passive_fill_estimate') {
      continue;
    }
    const estimate = output as PassiveFillEstimate;
    const estimateKey = passiveEstimateKey(estimate);
    estimatesByProbe.set(probeIdsByKey.get(estimateKey) ?? estimateKey, estimate);
  }
  return Object.freeze({
    results: Object.freeze(probes.map((probe) => synthesizedResultFromEstimate(probe, estimatesByProbe.get(probe.probe_id)))),
    mbp1_records: mbp1Counter.count,
    trades_records: tradesCounter.count,
  });
}

function probeKey(probe: QueueFidelityProbe): string {
  return [
    probe.ts_ns.toString(),
    probe.instrument_id.toString(),
    probe.side,
    probe.limit_price.toString(),
    probe.quantity.toString(),
  ].join('|');
}

function passiveEstimateKey(estimate: PassiveFillEstimate): string {
  return [
    estimate.ts_ns.toString(),
    estimate.instrument_id.toString(),
    estimate.side,
    estimate.limit_price.toString(),
    estimate.order_quantity.toString(),
  ].join('|');
}

function inferInstrumentRoot(symbol: string): string | null {
  const match = /^[A-Z]+/.exec(symbol);
  return match?.[0] ?? null;
}

function policyForConfig(config: SessionConfig): QueueFidelityPolicy {
  return Object.freeze({
    ...DEFAULT_QUEUE_FIDELITY_POLICY_V1,
    fill_horizon_ns: config.fill_horizon_ns,
    depletion_lookback_ns: config.depletion_lookback_ns,
  });
}

function orderKey(record: DbnMboRecord): string {
  return `${record.instrument_id}:${record.order_id.toString()}`;
}

function matchesProbeSide(order: ActiveMboOrder, probe: QueueFidelityProbe): boolean {
  return (probe.side === 'buy' && order.side === 'B') || (probe.side === 'sell' && order.side === 'A');
}

function isTradeAction(record: DbnMboRecord): boolean {
  return record.action === 'T' || record.action === 'F';
}

function consumeProbe(active: ActiveReferenceProbe, size: bigint): void {
  if (size <= 0n) {
    return;
  }
  const remaining = active.probe.quantity - active.filled;
  if (remaining <= 0n) {
    return;
  }
  active.filled += size < remaining ? size : remaining;
}

function reduceAhead(active: ActiveReferenceProbe, size: bigint): bigint {
  if (size <= 0n || active.queue_ahead <= 0n) {
    return size;
  }
  if (size <= active.queue_ahead) {
    active.queue_ahead -= size;
    return 0n;
  }
  const remaining = size - active.queue_ahead;
  active.queue_ahead = 0n;
  return remaining;
}

function fillFractionPpm(filled: bigint, quantity: bigint): number {
  if (quantity <= 0n) {
    return 0;
  }
  const boundedFilled = filled > quantity ? quantity : filled;
  return Number((boundedFilled * PPM_DENOMINATOR) / quantity);
}

function resultFromReference(probe: QueueFidelityProbe, fillPpm: number): QueueFidelityProbeResult {
  return Object.freeze({
    probe_id: probe.probe_id,
    ts_ns: probe.ts_ns,
    side: probe.side,
    limit_price: probe.limit_price,
    quantity: probe.quantity,
    reference_fill_probability_ppm: fillPpm,
    synthesized_fill_probability_ppm: null,
    absolute_error_ppm: null,
    within_tolerance: null,
    status: 'compared',
  });
}

function unavailableReference(probe: QueueFidelityProbe): QueueFidelityProbeResult {
  return Object.freeze({
    probe_id: probe.probe_id,
    ts_ns: probe.ts_ns,
    side: probe.side,
    limit_price: probe.limit_price,
    quantity: probe.quantity,
    reference_fill_probability_ppm: null,
    synthesized_fill_probability_ppm: null,
    absolute_error_ppm: null,
    within_tolerance: null,
    status: 'reference_unavailable',
  });
}

async function computeReferenceResults(
  probes: readonly QueueFidelityProbe[],
  mboPath: string,
): Promise<{ readonly results: readonly QueueFidelityProbeResult[]; readonly mbo_records: number }> {
  type OrderState = {
    readonly side: 'B' | 'A' | 'N';
    readonly price: bigint;
    readonly size: bigint;
  };
  type ReplayProbe = {
    readonly probe: QueueFidelityProbe;
    readonly resultIndex: number;
    readonly horizonEnd: bigint;
    readonly aheadOrderIds: Set<string>;
    queueAhead: bigint;
    filled: bigint;
  };

  const sortedProbes = [...probes].sort(compareProbesForReplay);
  const results = new Array<QueueFidelityProbeResult>(sortedProbes.length);
  const activeOrders = new Map<string, OrderState>();
  const activeProbes: ReplayProbe[] = [];
  let probeIndex = 0;
  let mboRecords = 0;

  const activateProbe = (probe: QueueFidelityProbe, resultIndex: number): void => {
      let queueAhead = 0n;
    const aheadOrderIds = new Set<string>();
    for (const [orderId, order] of activeOrders.entries()) {
      if (orderMatchesProbe(order, probe)) {
          queueAhead += order.size;
        aheadOrderIds.add(orderId);
        }
      }
      activeProbes.push({
        probe,
      resultIndex,
      horizonEnd: probe.ts_ns + probe.fill_horizon_ns,
      aheadOrderIds,
      queueAhead,
        filled: 0n,
      });
  };

  const retireExpired = (tsNs: bigint): void => {
    let index = 0;
    while (index < activeProbes.length) {
      const active = activeProbes[index]!;
      if (active.horizonEnd < tsNs) {
        results[active.resultIndex] = referenceResult(active);
        activeProbes.splice(index, 1);
        continue;
      }
      index += 1;
    }
  };

  const retireAll = (): void => {
    for (const active of activeProbes.splice(0)) {
      results[active.resultIndex] = referenceResult(active);
    }
  };

  const referenceResult = (active: ReplayProbe): QueueFidelityProbeResult => Object.freeze({
    probe_id: active.probe.probe_id,
    ts_ns: active.probe.ts_ns,
    side: active.probe.side,
    limit_price: active.probe.limit_price,
    quantity: active.probe.quantity,
    reference_fill_probability_ppm: fillFractionPpm(active.filled, active.probe.quantity),
    synthesized_fill_probability_ppm: null,
    absolute_error_ppm: null,
    within_tolerance: null,
    status: 'compared',
  });

  const minBigint = (left: bigint, right: bigint): bigint => left < right ? left : right;
  const maxBigint = (left: bigint, right: bigint): bigint => left > right ? left : right;
  const probeSideToMboSide = (side: QueueFidelityProbe['side']): 'B' | 'A' => side === 'buy' ? 'B' : 'A';
  const orderMatchesProbe = (
    order: { readonly side: 'B' | 'A' | 'N'; readonly price: bigint },
    probe: { readonly side: QueueFidelityProbe['side']; readonly limit_price: bigint },
  ): boolean => order.side === probeSideToMboSide(probe.side) && order.price === probe.limit_price;

  const applyReductionAtProbePrice = (active: ReplayProbe, reduction: bigint, execution: boolean): void => {
    const consumedAhead = minBigint(active.queueAhead, reduction);
    active.queueAhead -= consumedAhead;
    const remainingReduction = reduction - consumedAhead;
    if (!execution || remainingReduction <= 0n) {
      return;
    }
    active.filled += minBigint(active.probe.quantity - active.filled, remainingReduction);
  };

  const applyRecordToActiveReferenceProbes = (record: DbnMboRecord, previous: OrderState | undefined): void => {
    if (record.side === 'N') {
      return;
    }
    const recordOrderKey = record.order_id.toString();
    const size = BigInt(record.size);
    for (const active of activeProbes) {
      if (record.action === 'A') {
        continue;
      }
      if (record.action === 'M') {
        if (previous !== undefined && active.aheadOrderIds.has(recordOrderKey) && orderMatchesProbe(previous, active.probe)) {
          active.queueAhead = maxBigint(0n, active.queueAhead - previous.size);
          active.aheadOrderIds.delete(recordOrderKey);
        }
        continue;
      }
      const recordState = previous ?? {
        side: record.side,
        price: record.price,
        size,
      };
      if (!orderMatchesProbe(recordState, active.probe)) {
        continue;
      }
      const reduction = previous === undefined ? size : minBigint(size, previous.size);
      applyReductionAtProbePrice(active, reduction, record.action === 'T' || record.action === 'F');
    }
  };

  const applyRecordToOrderState = (record: DbnMboRecord, previous: OrderState | undefined): void => {
    if (record.side === 'N') {
      return;
    }
    const recordOrderKey = record.order_id.toString();
    const size = BigInt(record.size);
    if (record.action === 'A' || record.action === 'M') {
      activeOrders.set(recordOrderKey, {
        side: record.side,
        price: record.price,
        size,
      });
      return;
    }
    if (previous === undefined) {
      return;
    }
    const remaining = previous.size - minBigint(size, previous.size);
    if (remaining > 0n) {
      activeOrders.set(recordOrderKey, { ...previous, size: remaining });
    } else {
      activeOrders.delete(recordOrderKey);
    }
  };

  for await (const record of loadDbnFile(mboPath, 'mbo')) {
    const mbo = record as DbnMboRecord;
    mboRecords += 1;
    while (probeIndex < sortedProbes.length && sortedProbes[probeIndex]!.ts_ns < mbo.ts_event) {
      retireExpired(sortedProbes[probeIndex]!.ts_ns);
      activateProbe(sortedProbes[probeIndex]!, probeIndex);
      probeIndex += 1;
    }
    retireExpired(mbo.ts_event);
    const previous = activeOrders.get(mbo.order_id.toString());
    applyRecordToActiveReferenceProbes(mbo, previous);
    applyRecordToOrderState(mbo, previous);
    while (probeIndex < sortedProbes.length && sortedProbes[probeIndex]!.ts_ns === mbo.ts_event) {
      activateProbe(sortedProbes[probeIndex]!, probeIndex);
      probeIndex += 1;
    }
    if (probeIndex >= sortedProbes.length && activeProbes.length === 0) {
      break;
    }
  }

  while (probeIndex < sortedProbes.length) {
    retireExpired(sortedProbes[probeIndex]!.ts_ns);
    activateProbe(sortedProbes[probeIndex]!, probeIndex);
    probeIndex += 1;
  }
  retireAll();
  const byProbeId = new Map(sortedProbes.map((probe, index) => [probe.probe_id, results[index] ?? unavailableReference(probe)] as const));

  return Object.freeze({
    results: Object.freeze(probes.map((probe) => byProbeId.get(probe.probe_id) ?? unavailableReference(probe))),
    mbo_records: mboRecords,
  });
}

function compareProbesForReplay(left: QueueFidelityProbe, right: QueueFidelityProbe): number {
  if (left.ts_ns < right.ts_ns) {
    return -1;
  }
  if (left.ts_ns > right.ts_ns) {
    return 1;
  }
  if (left.instrument_id !== right.instrument_id) {
    return left.instrument_id - right.instrument_id;
  }
  return left.side.localeCompare(right.side);
}

function comparableRows(
  comparedResults: readonly QueueFidelityProbeResult[],
  contexts: ReadonlyMap<string, ProbeContext>,
): readonly AnalysisProbeRow[] {
  return Object.freeze(comparedResults.flatMap((result) => {
    if (
      result.status !== 'compared' ||
      result.reference_fill_probability_ppm === null ||
      result.synthesized_fill_probability_ppm === null ||
      result.absolute_error_ppm === null ||
      result.within_tolerance === null
    ) {
      return [];
    }
    const context = contexts.get(result.probe_id);
    if (context === undefined) {
      throw new Error(`Missing probe context for ${result.probe_id}`);
    }
    const signedError = result.synthesized_fill_probability_ppm - result.reference_fill_probability_ppm;
    return [Object.freeze({
      probe_id: result.probe_id,
      ts_ns: result.ts_ns.toString(),
      side: result.side,
      reference_fill_probability_ppm: result.reference_fill_probability_ppm,
      synthesized_fill_probability_ppm: result.synthesized_fill_probability_ppm,
      signed_error_ppm: signedError,
      absolute_error_ppm: result.absolute_error_ppm,
      within_tolerance: result.within_tolerance,
      spread_bucket: context.spread_bucket,
      spread_ticks: context.spread_ticks,
      queue_ahead_bucket: context.queue_ahead_bucket,
      queue_ahead_proxy: context.queue_ahead_proxy === null ? null : context.queue_ahead_proxy.toString(),
      time_bucket: context.time_bucket,
      synthesized_probability_bucket: probabilityBucket(result.synthesized_fill_probability_ppm),
      reference_probability_bucket: probabilityBucket(result.reference_fill_probability_ppm),
    })];
  }));
}

function percentile(sortedValues: readonly number[], q: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * q) - 1));
  return sortedValues[index]!;
}

function meanRounded(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function errorDistribution(rows: readonly AnalysisProbeRow[]): object {
  const abs = rows.map((row) => row.absolute_error_ppm).sort((left, right) => left - right);
  const signed = rows.map((row) => row.signed_error_ppm).sort((left, right) => left - right);
  let squaredSum = 0n;
  for (const row of rows) {
    const error = BigInt(row.signed_error_ppm);
    squaredSum += error * error;
  }
  return Object.freeze({
    comparable_count: rows.length,
    mean_absolute_error_ppm: meanRounded(abs),
    median_absolute_error_ppm: percentile(abs, 0.5),
    p90_absolute_error_ppm: percentile(abs, 0.9),
    p95_absolute_error_ppm: percentile(abs, 0.95),
    max_absolute_error_ppm: abs.length === 0 ? null : abs[abs.length - 1],
    mean_signed_error_ppm: meanRounded(signed),
    median_signed_error_ppm: percentile(signed, 0.5),
    mean_squared_error_ppm2: rows.length === 0 ? null : Number(squaredSum / BigInt(rows.length)),
  });
}

function distributionByBucket(rows: readonly AnalysisProbeRow[], field: 'reference_probability_bucket' | 'synthesized_probability_bucket'): readonly object[] {
  return Object.freeze(PROBABILITY_BUCKET_ORDER.map((bucket) => Object.freeze({
    bucket,
    count: rows.filter((row) => row[field] === bucket).length,
  })));
}

function withinShare(count: number, total: number): number | null {
  if (total === 0) {
    return null;
  }
  return Number((BigInt(count) * PPM_DENOMINATOR) / BigInt(total));
}

function groupRows(rows: readonly AnalysisProbeRow[], key: (row: AnalysisProbeRow) => string, order: readonly string[]): readonly object[] {
  return Object.freeze(order.map((bucket) => {
    const bucketRows = rows.filter((row) => key(row) === bucket);
    const within = bucketRows.filter((row) => row.within_tolerance).length;
    return Object.freeze({
      bucket,
      comparable_probes: bucketRows.length,
      within_tolerance_probes: within,
      within_tolerance_share_ppm: withinShare(within, bucketRows.length),
      error_distribution: errorDistribution(bucketRows),
    });
  }));
}

function calibrationTable(rows: readonly AnalysisProbeRow[]): readonly object[] {
  return Object.freeze(PROBABILITY_BUCKET_ORDER.map((bucket) => {
    const bucketRows = rows.filter((row) => row.synthesized_probability_bucket === bucket);
    const within = bucketRows.filter((row) => row.within_tolerance).length;
    return Object.freeze({
      synthesized_probability_bucket: bucket,
      count: bucketRows.length,
      mean_synthesized_ppm: meanRounded(bucketRows.map((row) => row.synthesized_fill_probability_ppm)),
      mean_reference_ppm: meanRounded(bucketRows.map((row) => row.reference_fill_probability_ppm)),
      mean_signed_error_ppm: meanRounded(bucketRows.map((row) => row.signed_error_ppm)),
      within_tolerance_share_ppm: withinShare(within, bucketRows.length),
    });
  }));
}

function analyzeSessionResults(
  label: string,
  comparedResults: readonly QueueFidelityProbeResult[],
  contexts: ReadonlyMap<string, ProbeContext>,
): object {
  const rows = comparableRows(comparedResults, contexts);
  return Object.freeze({
    label,
    error_distribution: errorDistribution(rows),
    reference_probability_distribution: distributionByBucket(rows, 'reference_probability_bucket'),
    synthesized_probability_distribution: distributionByBucket(rows, 'synthesized_probability_bucket'),
    stratifications: Object.freeze({
      side: groupRows(rows, (row) => row.side, SIDE_BUCKET_ORDER),
      spread: groupRows(rows, (row) => row.spread_bucket, SPREAD_BUCKET_ORDER),
      queue_ahead: groupRows(rows, (row) => row.queue_ahead_bucket, QUEUE_BUCKET_ORDER),
      synthesized_probability: groupRows(rows, (row) => row.synthesized_probability_bucket, PROBABILITY_BUCKET_ORDER),
      reference_probability: groupRows(rows, (row) => row.reference_probability_bucket, PROBABILITY_BUCKET_ORDER),
      time_of_day: groupRows(rows, (row) => row.time_bucket, TIME_BUCKET_ORDER),
    }),
    calibration_table: calibrationTable(rows),
  });
}

async function runSession(config: SessionConfig, manifest: CorpusManifest): Promise<object> {
  const sessionStartMs = nowMs();
  const cellPolicy = policyForConfig(config);
  const session = findSession(manifest, config.session_id);
  const mboPath = fullSchemaPath(session.schemas.mbo!);
  const mbp1Path = fullSchemaPath(session.schemas['mbp-1']!);
  const tradesPath = fullSchemaPath(session.schemas.trades!);
  const stageTimings: Record<string, number> = {};
  let peakRssMb = rssMb();

  console.log(`[qfa-402d] ${config.label}: generating probes`);
  const probeStart = nowMs();
  const generated = await generateStreamingProbes(mbp1Path, session.symbol, config);
  stageTimings.generate_probes_ms = durationMs(probeStart);
  peakRssMb = Math.max(peakRssMb, rssMb());

  const synthWindowStart = config.scope === 'first_1800s_prefix' ? generated.first_sample_ts_ns : null;
  const synthWindowEnd = config.scope === 'first_1800s_prefix'
    ? generated.first_sample_ts_ns + config.prefix_duration_ns! + config.fill_horizon_ns
    : null;

  console.log(`[qfa-402d] ${config.label}: synthesized mbp_trades_proxy for ${generated.probes.length} probes`);
  const synthStart = nowMs();
  const synthesized = await computeSynthesizedResults(
    generated.probes,
    mbp1Path,
    tradesPath,
    synthWindowStart,
    synthWindowEnd,
    session.symbol,
    config.fill_horizon_ns,
    config.depletion_lookback_ns,
  );
  stageTimings.synthesize_ms = durationMs(synthStart);
  peakRssMb = Math.max(peakRssMb, rssMb());

  console.log(`[qfa-402d] ${config.label}: MBO reference replay`);
  const refStart = nowMs();
  const reference = await computeReferenceResults(generated.probes, mboPath);
  stageTimings.mbo_reference_ms = durationMs(refStart);
  peakRssMb = Math.max(peakRssMb, rssMb());

  console.log(`[qfa-402d] ${config.label}: compare and analyze`);
  const compareStart = nowMs();
  const referenceByProbe = new Map(reference.results.map((result) => [result.probe_id, result] as const));
  const compared = synthesized.results.map((synthResult) => {
    const refResult = referenceByProbe.get(synthResult.probe_id);
    if (refResult === undefined) {
      throw new Error(`Missing reference result for ${synthResult.probe_id}`);
    }
    return compareQueueFidelityProbe(refResult, synthResult, cellPolicy);
  });
  const summary = summarizeQueueFidelityRegime(config.regime, compared, cellPolicy);
  const analysis = analyzeSessionResults(config.label, compared, generated.contexts);
  stageTimings.compare_analyze_ms = durationMs(compareStart);
  stageTimings.total_ms = durationMs(sessionStartMs);
  peakRssMb = Math.max(peakRssMb, rssMb());

  const result = Object.freeze({
    label: config.label,
    session_id: config.session_id,
    regime: config.regime,
    scope: config.scope,
    rationale: config.rationale,
    policy_cell: Object.freeze({
      fill_horizon_ns: config.fill_horizon_ns.toString(),
      depletion_lookback_ns: config.depletion_lookback_ns.toString(),
      tolerance_ppm: cellPolicy.tolerance_ppm,
      threshold_ppm: cellPolicy.min_within_tolerance_share_ppm,
    }),
    raw_symbol: session.symbol,
    instrument_id: session.instrument_id ?? null,
    schema_byte_counts: Object.freeze({
      mbo: session.schemas.mbo!.byte_count,
      mbp1: session.schemas['mbp-1']!.byte_count,
      trades: session.schemas.trades!.byte_count,
    }),
    file_sizes: Object.freeze({
      mbo: statSync(mboPath).size,
      mbp1: statSync(mbp1Path).size,
      trades: statSync(tradesPath).size,
    }),
    first_sample_ts_ns: generated.first_sample_ts_ns.toString(),
    last_sample_ts_ns: generated.last_sample_ts_ns.toString(),
    probe_window_end_ts_ns: generated.probe_window_end_ts_ns?.toString() ?? null,
    total_probes: generated.probes.length,
    summary,
    records_consumed: Object.freeze({
      probe_source_mbp1_records: generated.probe_source_mbp1_records,
      synthesis_mbp1_records: synthesized.mbp1_records,
      synthesis_trades_records: synthesized.trades_records,
      mbo_records: reference.mbo_records,
    }),
    runtime_ms: stageTimings,
    peak_rss_mb: peakRssMb,
    analysis,
  });
  writeCellScratch(config, result);
  return result;
}

function writeCellScratch(config: SessionConfig, result: object): void {
  const dir = join(SCRATCH_ROOT, config.session_id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${config.fill_horizon_ns.toString()}-${config.depletion_lookback_ns.toString()}.json`);
  writeFileSync(path, `${JSON.stringify(result, jsonReplacer, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  const runStart = nowMs();
  const manifests = Object.freeze({
    feb: readManifest('feb'),
    mar: readManifest('mar'),
  });
  const sessions = [];
  for (const config of SESSION_CONFIGS) {
    sessions.push(await runSession(config, manifests[config.month]));
  }

  const result = Object.freeze({
    ticket: 'QFA-402d',
    generated_at_note: 'Deterministic archive analysis script; no wall-clock timestamp emitted.',
    repo_head_expected: 'c0d709ad205afa6e95f234c15eb09cd939556eb8',
    archive_root: ARCHIVE_ROOT,
    manifest_hashes: LOCKED_MANIFEST_HASHES,
    policy: Object.freeze({
      mode: 'mbp_trades_proxy',
      sample_interval: DEFAULT_QUEUE_FIDELITY_POLICY_V1.sample_interval,
      fill_horizon_grid_ns: FILL_HORIZON_GRID_NS.map((value) => value.toString()),
      depletion_lookback_grid_ns: DEPLETION_LOOKBACK_GRID_NS.map((value) => value.toString()),
      order_quantity: DEFAULT_QUEUE_FIDELITY_POLICY_V1.order_quantity.toString(),
      tolerance_ppm: DEFAULT_QUEUE_FIDELITY_POLICY_V1.tolerance_ppm,
      threshold_ppm: DEFAULT_QUEUE_FIDELITY_POLICY_V1.min_within_tolerance_share_ppm,
    }),
    sessions: Object.freeze(sessions),
    total_runtime_ms: durationMs(runStart),
    peak_rss_mb_at_end: rssMb(),
    squared_error_note: 'mean_squared_error_ppm2 uses realized fractional fill ppm targets, not binary fill/no-fill conversion.',
  });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(result, jsonReplacer, 2)}\n`, 'utf8');
  console.log(`[qfa-402d] wrote ${OUTPUT_PATH}`);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

await main();
