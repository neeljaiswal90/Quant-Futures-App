import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import {
  compareQueueFidelityProbe,
  DEFAULT_QUEUE_FIDELITY_POLICY_V1,
  generateQueueFidelityProbes,
  summarizeQueueFidelityRegime,
  type QueueFidelityProbe,
  type QueueFidelityProbeResult,
  type QueueFidelitySide,
} from '../../apps/backtester/src/fidelity/queue/index.js';
import {
  computeManifestHash,
  type CorpusManifest,
  ns,
  type UnixNs,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import { loadDbnFile } from '../../apps/strategy_runtime/src/data/dbn-loader.js';
import type {
  DbnMboRecord,
  DbnMbp1Record,
  DbnTradesRecord,
  DbnRecord,
  DbnSide,
} from '../../apps/strategy_runtime/src/data/dbn-types.js';
import { synthesizeQueue } from '../../apps/strategy_runtime/src/data/queue-synthesis/queue-synthesizer.js';
import type {
  PassiveFillEstimate,
  PassiveOrderProbe,
  QueueSynthesisOptions,
} from '../../apps/strategy_runtime/src/data/queue-synthesis/types.js';

const ARCHIVE_ROOT = 'D:/qfa-cache/databento/tier-a-feb-mar-2026';
const SELECTED_SESSIONS = [
  {
    month: 'feb',
    regime: 'baseline',
    sessionId: '2026-02-25-rth',
    scope: 'full_session',
    prefix_duration_ns: null,
  },
  {
    month: 'mar',
    regime: 'clean_alternate_month',
    sessionId: '2026-03-02-rth',
    scope: 'first_360s_prefix',
    prefix_duration_ns: ns(360_000_000_000n),
  },
] as const;

const SYNTHESIS_HORIZON_PAD_NS = DEFAULT_QUEUE_FIDELITY_POLICY_V1.fill_horizon_ns;

const LOCKED_HASHES = {
  feb: {
    manifestPath: `${ARCHIVE_ROOT}/manifest-feb-2026.json`,
    verifiedPath: `${ARCHIVE_ROOT}/verified-feb-2026.json`,
    manifestContentHash: '0ac2e673aee2acee8949b9d4b73dad62a3c12e4eda0676a1b74351bdbf802409',
    manifestFileSha256: '05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c',
    verifiedFileSha256: '9ca2b49b423303f115ed3ae39d86cfbad7f8231b89de6db91c9cb75856168af6',
  },
  mar: {
    manifestPath: `${ARCHIVE_ROOT}/manifest-mar-2026.json`,
    verifiedPath: `${ARCHIVE_ROOT}/verified-mar-2026.json`,
    manifestContentHash: 'dd873dc9ea3556b1c6cbd399fac465cd1168c9b6501f72d947cc7d71810aa6bd',
    manifestFileSha256: 'cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f',
    verifiedFileSha256: 'a72e662519cf7cfa30db251675b2f609b8b3e4ee081813a06637c1723b52c701',
  },
} as const;

interface OrderState {
  readonly side: DbnSide;
  readonly price: bigint;
  readonly size: bigint;
}

interface ActiveReferenceProbe {
  readonly probe: QueueFidelityProbe;
  readonly resultIndex: number;
  readonly horizonEnd: UnixNs;
  readonly aheadOrderIds: Set<string>;
  queueAhead: bigint;
  filled: bigint;
}

interface SessionSmokeResult {
  readonly session_id: string;
  readonly month: 'feb' | 'mar';
  readonly regime: string;
  readonly scope: string;
  readonly prefix_duration_ns: string | null;
  readonly synthesis_horizon_pad_ns: string | null;
  readonly prefix_start_ts_ns: string | null;
  readonly probe_window_end_ts_ns: string | null;
  readonly data_window_end_ts_ns: string | null;
  readonly symbol: string;
  readonly mbo_path: string;
  readonly mbp1_path: string;
  readonly trades_path: string;
  readonly mbo_bytes_manifest: number;
  readonly mbo_bytes_observed: number;
  readonly mbp1_bytes_manifest: number;
  readonly mbp1_bytes_observed: number;
  readonly trades_bytes_manifest: number;
  readonly trades_bytes_observed: number;
  readonly mbp1_records: number;
  readonly probe_source_mbp1_records: number;
  readonly trades_records: number;
  readonly total_probes: number;
  readonly comparable_probes: number;
  readonly within_tolerance_probes: number;
  readonly within_tolerance_share_ppm: number | null;
  readonly threshold_ppm: number;
  readonly status: string;
  readonly synthesized_source_modes: Readonly<Record<string, number>>;
  readonly unavailable_synthesized_probes: number;
  readonly timings_ms: Readonly<Record<string, number>>;
}

let peakRssMb = 0;

function sampleRssMb(): number {
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  peakRssMb = Math.max(peakRssMb, rssMb);
  return rssMb;
}

function elapsedMs(start: number): number {
  sampleRssMb();
  return Math.round(performance.now() - start);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function loadManifest(month: keyof typeof LOCKED_HASHES): Promise<{
  readonly manifest: CorpusManifest;
  readonly check: Readonly<Record<string, unknown>>;
}> {
  const locked = LOCKED_HASHES[month];
  const manifest = JSON.parse(await BunlessFile.readText(locked.manifestPath)) as CorpusManifest;
  const contentHash = computeManifestHash(manifest);
  const manifestFileSha256 = await sha256File(locked.manifestPath);
  const verifiedFileSha256 = await sha256File(locked.verifiedPath);

  return {
    manifest,
    check: Object.freeze({
      month,
      manifest_path: locked.manifestPath,
      manifest_content_hash: contentHash,
      manifest_content_hash_expected: locked.manifestContentHash,
      manifest_content_hash_match: contentHash === locked.manifestContentHash,
      manifest_file_sha256: manifestFileSha256,
      manifest_file_sha256_expected: locked.manifestFileSha256,
      manifest_file_sha256_match: manifestFileSha256 === locked.manifestFileSha256,
      verified_path: locked.verifiedPath,
      verified_file_sha256: verifiedFileSha256,
      verified_file_sha256_expected: locked.verifiedFileSha256,
      verified_file_sha256_match: verifiedFileSha256 === locked.verifiedFileSha256,
    }),
  };
}

class BunlessFile {
  static async readText(path: string): Promise<string> {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path);
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

interface WindowedRecords<T> {
  readonly records: T[];
  readonly prefix_start_ts_ns: UnixNs | null;
  readonly probe_window_end_ts_ns: UnixNs | null;
  readonly data_window_end_ts_ns: UnixNs | null;
}

async function collectMbp1Records(
  path: string,
  prefixDurationNs: UnixNs | null,
): Promise<WindowedRecords<DbnMbp1Record>> {
  const records: DbnMbp1Record[] = [];
  let prefixStartTsNs: UnixNs | null = null;
  let probeWindowEndTsNs: UnixNs | null = null;
  let dataWindowEndTsNs: UnixNs | null = null;

  for await (const record of loadDbnFile(path, 'mbp-1')) {
    const mbp1 = record as DbnMbp1Record;
    if (prefixDurationNs !== null && prefixStartTsNs === null) {
      prefixStartTsNs = mbp1.ts_event;
      probeWindowEndTsNs = ns(prefixStartTsNs + prefixDurationNs);
      dataWindowEndTsNs = ns(probeWindowEndTsNs + SYNTHESIS_HORIZON_PAD_NS);
    }
    if (dataWindowEndTsNs !== null && mbp1.ts_event > dataWindowEndTsNs) {
      break;
    }
    records.push(mbp1);
    if (records.length % 100_000 === 0) {
      sampleRssMb();
    }
  }

  return { records, prefix_start_ts_ns: prefixStartTsNs, probe_window_end_ts_ns: probeWindowEndTsNs, data_window_end_ts_ns: dataWindowEndTsNs };
}

async function collectTradesRecords(
  path: string,
  prefixStartTsNs: UnixNs | null,
  dataWindowEndTsNs: UnixNs | null,
): Promise<DbnTradesRecord[]> {
  const records: DbnTradesRecord[] = [];
  for await (const record of loadDbnFile(path, 'trades')) {
    const trade = record as DbnTradesRecord;
    if (prefixStartTsNs !== null && trade.ts_event < prefixStartTsNs) {
      continue;
    }
    if (dataWindowEndTsNs !== null && trade.ts_event > dataWindowEndTsNs) {
      break;
    }
    records.push(trade);
    if (records.length % 100_000 === 0) {
      sampleRssMb();
    }
  }
  return records;
}

async function computeSynthesizedResults(
  probes: readonly QueueFidelityProbe[],
  mbp1Records: readonly DbnMbp1Record[],
  tradesRecords: readonly DbnTradesRecord[],
  symbol: string,
): Promise<{
  readonly results: ReadonlyMap<string, QueueFidelityProbeResult>;
  readonly sourceModes: Readonly<Record<string, number>>;
}> {
  const byProbeKey = new Map<string, QueueFidelityProbeResult>();
  const probeIdsByKey = new Map(probes.map((probe) => [probeKey(probe), probe.probe_id]));
  const sourceModes = new Map<string, number>();
  const options: QueueSynthesisOptions = {
    instrument_root: inferInstrumentRoot(symbol) ?? 'MNQ',
    manifest_symbol: symbol,
    input_schemas: ['mbp-1', 'trades'],
    corpus_tier: null,
    mode: 'mbp_trades_proxy',
    passive_order_quantity: DEFAULT_QUEUE_FIDELITY_POLICY_V1.order_quantity,
    fill_horizon_ns: DEFAULT_QUEUE_FIDELITY_POLICY_V1.fill_horizon_ns,
    depletion_lookback_ns: DEFAULT_QUEUE_FIDELITY_POLICY_V1.depletion_lookback_ns,
    allow_unverified_identity: true,
  };

  for await (const output of synthesizeQueue(
    [asyncRecords(mbp1Records), asyncRecords(tradesRecords)],
    options,
    asyncPassiveProbes(probes),
  )) {
    if (output.type !== 'passive_fill_estimate') {
      continue;
    }
    const estimate = output as PassiveFillEstimate;
    const mode = estimate.source_metadata.mode;
    sourceModes.set(mode, (sourceModes.get(mode) ?? 0) + 1);
    const estimateKey = passiveEstimateKey(estimate);
    byProbeKey.set(estimateKey, {
      probe_id: probeIdsByKey.get(estimateKey) ?? estimateKey,
      ts_ns: estimate.ts_ns,
      side: estimate.side,
      limit_price: estimate.limit_price,
      quantity: estimate.order_quantity,
      reference_fill_probability_ppm: null,
      synthesized_fill_probability_ppm: estimate.source_metadata.quality_flags.includes('queue_state_unavailable')
        ? null
        : estimate.estimated_fill_probability_ppm,
      absolute_error_ppm: null,
      within_tolerance: null,
      status: estimate.source_metadata.quality_flags.includes('queue_state_unavailable')
        ? 'synthesized_unavailable'
        : 'compared',
      synthesized_source_mode: estimate.source_metadata.mode,
    });
  }

  const results = new Map<string, QueueFidelityProbeResult>();
  for (const probe of probes) {
    const synthesized = byProbeKey.get(probeKey(probe)) ?? makeSynthesizedUnavailable(probe);
    results.set(probe.probe_id, {
      ...synthesized,
      probe_id: probe.probe_id,
    });
  }

  return {
    results,
    sourceModes: Object.fromEntries([...sourceModes.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
}

async function computeReferenceResults(
  probes: readonly QueueFidelityProbe[],
  mboPath: string,
): Promise<ReadonlyMap<string, QueueFidelityProbeResult>> {
  const sortedProbes = [...probes].sort(compareProbes);
  const results = new Array<QueueFidelityProbeResult>(sortedProbes.length);
  const activeOrders = new Map<string, OrderState>();
  const activeProbes: ActiveReferenceProbe[] = [];
  let probeIndex = 0;

  let mboRecordCount = 0;
  for await (const record of loadDbnFile(mboPath, 'mbo')) {
    const mbo = record as DbnMboRecord;
    mboRecordCount += 1;
    if (mboRecordCount % 100_000 === 0) {
      sampleRssMb();
    }
    while (probeIndex < sortedProbes.length && sortedProbes[probeIndex]!.ts_ns < mbo.ts_event) {
      retireExpired(activeProbes, sortedProbes[probeIndex]!.ts_ns, results);
      activateProbe(sortedProbes[probeIndex]!, probeIndex, activeOrders, activeProbes);
      probeIndex += 1;
    }

    retireExpired(activeProbes, mbo.ts_event, results);
    const previous = activeOrders.get(mbo.order_id.toString());
    applyRecordToActiveReferenceProbes(activeProbes, mbo, previous);
    applyRecordToOrderState(activeOrders, mbo, previous);

    while (probeIndex < sortedProbes.length && sortedProbes[probeIndex]!.ts_ns === mbo.ts_event) {
      activateProbe(sortedProbes[probeIndex]!, probeIndex, activeOrders, activeProbes);
      probeIndex += 1;
    }

    if (probeIndex >= sortedProbes.length && activeProbes.length === 0) {
      break;
    }
  }

  while (probeIndex < sortedProbes.length) {
    retireExpired(activeProbes, sortedProbes[probeIndex]!.ts_ns, results);
    activateProbe(sortedProbes[probeIndex]!, probeIndex, activeOrders, activeProbes);
    probeIndex += 1;
  }
  retireAll(activeProbes, results);

  return new Map(sortedProbes.map((probe, index) => [probe.probe_id, results[index]!]));
}

function activateProbe(
  probe: QueueFidelityProbe,
  resultIndex: number,
  activeOrders: ReadonlyMap<string, OrderState>,
  activeProbes: ActiveReferenceProbe[],
): void {
  let queueAhead = 0n;
  const aheadOrderIds = new Set<string>();
  for (const [orderId, order] of activeOrders.entries()) {
    if (!orderMatchesProbe(order, probe)) {
      continue;
    }
    queueAhead += order.size;
    aheadOrderIds.add(orderId);
  }
  activeProbes.push({
    probe,
    resultIndex,
    horizonEnd: ns(probe.ts_ns + probe.fill_horizon_ns),
    aheadOrderIds,
    queueAhead,
    filled: 0n,
  });
}

function retireExpired(
  activeProbes: ActiveReferenceProbe[],
  currentTs: UnixNs,
  results: QueueFidelityProbeResult[],
): void {
  let index = 0;
  while (index < activeProbes.length) {
    const active = activeProbes[index]!;
    if (active.horizonEnd < currentTs) {
      results[active.resultIndex] = referenceResult(active);
      activeProbes.splice(index, 1);
      continue;
    }
    index += 1;
  }
}

function retireAll(activeProbes: ActiveReferenceProbe[], results: QueueFidelityProbeResult[]): void {
  for (const active of activeProbes.splice(0)) {
    results[active.resultIndex] = referenceResult(active);
  }
}

function referenceResult(active: ActiveReferenceProbe): QueueFidelityProbeResult {
  return {
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
    synthesized_source_mode: null,
  };
}

function applyRecordToActiveReferenceProbes(
  activeProbes: readonly ActiveReferenceProbe[],
  record: DbnMboRecord,
  previous: OrderState | undefined,
): void {
  if (record.side === 'N') {
    return;
  }

  const orderKey = record.order_id.toString();
  const size = BigInt(record.size);

  for (const active of activeProbes) {
    if (record.action === 'A') {
      continue;
    }

    if (record.action === 'M') {
      if (previous !== undefined && active.aheadOrderIds.has(orderKey) && orderMatchesProbe(previous, active.probe)) {
        active.queueAhead = maxBigint(0n, active.queueAhead - previous.size);
        active.aheadOrderIds.delete(orderKey);
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
}

function applyRecordToOrderState(
  activeOrders: Map<string, OrderState>,
  record: DbnMboRecord,
  previous: OrderState | undefined,
): void {
  if (record.side === 'N') {
    return;
  }
  const orderKey = record.order_id.toString();
  const size = BigInt(record.size);

  if (record.action === 'A' || record.action === 'M') {
    activeOrders.set(orderKey, {
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
    activeOrders.set(orderKey, {
      ...previous,
      size: remaining,
    });
  } else {
    activeOrders.delete(orderKey);
  }
}

function applyReductionAtProbePrice(active: ActiveReferenceProbe, reduction: bigint, execution: boolean): void {
  const consumedAhead = minBigint(active.queueAhead, reduction);
  active.queueAhead -= consumedAhead;
  const remainingReduction = reduction - consumedAhead;
  if (!execution || remainingReduction <= 0n) {
    return;
  }

  const remainingProbeQty = active.probe.quantity - active.filled;
  active.filled += minBigint(remainingProbeQty, remainingReduction);
}

function orderMatchesProbe(
  order: { readonly side: DbnSide; readonly price: bigint },
  probe: { readonly side: QueueFidelitySide; readonly limit_price: bigint },
): boolean {
  return order.side === probeSideToMboSide(probe.side) && order.price === probe.limit_price;
}

function probeSideToMboSide(side: QueueFidelitySide): DbnSide {
  return side === 'buy' ? 'B' : 'A';
}

function fillFractionPpm(filled: bigint, quantity: bigint): number {
  if (quantity <= 0n) {
    return 0;
  }
  return Number((minBigint(filled, quantity) * 1_000_000n) / quantity);
}

function minBigint(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maxBigint(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function compareProbes(left: QueueFidelityProbe, right: QueueFidelityProbe): number {
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

async function runSession(
  selected: (typeof SELECTED_SESSIONS)[number],
  manifest: CorpusManifest,
): Promise<SessionSmokeResult> {
  const sessionStart = performance.now();
  const timings = new Map<string, number>();
  const session = manifest.sessions.find((candidate) => candidate.session_id === selected.sessionId);
  if (session === undefined) {
    throw new Error(`Session not found in ${selected.month} manifest: ${selected.sessionId}`);
  }
  const mboFile = session.schemas.mbo;
  const mbp1File = session.schemas['mbp-1'];
  const tradesFile = session.schemas.trades;
  if (mboFile === undefined || mbp1File === undefined || tradesFile === undefined) {
    throw new Error(`Session missing mbo, mbp-1, or trades schema: ${selected.sessionId}`);
  }

  console.log(`[qfa-402b] ${selected.sessionId}: loading mbp-1 ${mbp1File.path}`);
  const mbpLoadStart = performance.now();
  const mbp1Window = await collectMbp1Records(mbp1File.path, selected.prefix_duration_ns);
  const mbp1Records = mbp1Window.records;
  timings.set('load_mbp1_ms', elapsedMs(mbpLoadStart));

  console.log(`[qfa-402b] ${selected.sessionId}: loading trades ${tradesFile.path}`);
  const tradesLoadStart = performance.now();
  const tradesRecords = await collectTradesRecords(
    tradesFile.path,
    mbp1Window.prefix_start_ts_ns,
    mbp1Window.data_window_end_ts_ns,
  );
  timings.set('load_trades_ms', elapsedMs(tradesLoadStart));

  const probeSourceRecords = mbp1Window.probe_window_end_ts_ns === null
    ? mbp1Records
    : mbp1Records.filter((record) => record.ts_event < mbp1Window.probe_window_end_ts_ns!);

  console.log(`[qfa-402b] ${selected.sessionId}: generating probes from ${probeSourceRecords.length} mbp-1 records (${selected.scope})`);
  const probeStart = performance.now();
  const probes = generateQueueFidelityProbes(probeSourceRecords, { raw_symbol: session.symbol });
  timings.set('generate_probes_ms', elapsedMs(probeStart));

  console.log(`[qfa-402b] ${selected.sessionId}: synthesizing mbp_trades_proxy estimates for ${probes.length} probes from ${mbp1Records.length} mbp-1 + ${tradesRecords.length} trades records`);
  const synthStart = performance.now();
  const synthesized = await computeSynthesizedResults(probes, mbp1Records, tradesRecords, session.symbol);
  timings.set('synthesize_mbp_trades_proxy_ms', elapsedMs(synthStart));

  console.log(`[qfa-402b] ${selected.sessionId}: replaying mbo reference ${mboFile.path}`);
  const referenceStart = performance.now();
  const reference = await computeReferenceResults(probes, mboFile.path);
  timings.set('mbo_reference_replay_ms', elapsedMs(referenceStart));

  const compareStart = performance.now();
  const probeResults = probes.map((probe) => {
    const referenceResultForProbe = reference.get(probe.probe_id);
    const synthesizedResultForProbe = synthesized.results.get(probe.probe_id);
    if (referenceResultForProbe === undefined) {
      throw new Error(`Missing reference result for ${probe.probe_id}`);
    }
    if (synthesizedResultForProbe === undefined) {
      throw new Error(`Missing synthesized result for ${probe.probe_id}`);
    }
    return compareQueueFidelityProbe(referenceResultForProbe, synthesizedResultForProbe);
  });
  const summary = summarizeQueueFidelityRegime(selected.regime, probeResults);
  timings.set('compare_and_summarize_ms', elapsedMs(compareStart));
  timings.set('session_total_ms', elapsedMs(sessionStart));

  const result: SessionSmokeResult = {
    session_id: selected.sessionId,
    month: selected.month,
    regime: selected.regime,
    scope: selected.scope,
    prefix_duration_ns: selected.prefix_duration_ns?.toString() ?? null,
    synthesis_horizon_pad_ns: selected.prefix_duration_ns === null ? null : SYNTHESIS_HORIZON_PAD_NS.toString(),
    prefix_start_ts_ns: mbp1Window.prefix_start_ts_ns?.toString() ?? null,
    probe_window_end_ts_ns: mbp1Window.probe_window_end_ts_ns?.toString() ?? null,
    data_window_end_ts_ns: mbp1Window.data_window_end_ts_ns?.toString() ?? null,
    symbol: session.symbol,
    mbo_path: mboFile.path,
    mbp1_path: mbp1File.path,
    trades_path: tradesFile.path,
    mbo_bytes_manifest: mboFile.byte_count,
    mbo_bytes_observed: statSync(mboFile.path).size,
    mbp1_bytes_manifest: mbp1File.byte_count,
    mbp1_bytes_observed: statSync(mbp1File.path).size,
    trades_bytes_manifest: tradesFile.byte_count,
    trades_bytes_observed: statSync(tradesFile.path).size,
    mbp1_records: mbp1Records.length,
    probe_source_mbp1_records: probeSourceRecords.length,
    trades_records: tradesRecords.length,
    total_probes: summary.total_probes,
    comparable_probes: summary.comparable_probes,
    within_tolerance_probes: summary.within_tolerance_probes,
    within_tolerance_share_ppm: summary.within_tolerance_share_ppm,
    threshold_ppm: summary.threshold_ppm,
    status: summary.status,
    synthesized_source_modes: synthesized.sourceModes,
    unavailable_synthesized_probes: probeResults.filter((probe) => probe.status === 'synthesized_unavailable').length,
    timings_ms: Object.fromEntries([...timings.entries()]),
  };

  console.log(`[qfa-402b] ${selected.sessionId}: ${JSON.stringify(result)}`);
  return result;
}

function makeSynthesizedUnavailable(probe: QueueFidelityProbe): QueueFidelityProbeResult {
  return {
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
    synthesized_source_mode: 'mbp_trades_proxy',
  };
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

async function* asyncRecords(records: readonly DbnRecord[]): AsyncIterableIterator<DbnRecord> {
  for (const record of records) {
    yield record;
  }
}

async function* asyncPassiveProbes(probes: readonly QueueFidelityProbe[]): AsyncIterableIterator<PassiveOrderProbe> {
  for (const probe of probes) {
    yield {
      ts_ns: probe.ts_ns,
      instrument_id: probe.instrument_id,
      raw_symbol: probe.raw_symbol,
      side: probe.side,
      limit_price: probe.limit_price,
      order_quantity: probe.quantity,
      latency_ns: 0n,
    };
  }
}

function inferInstrumentRoot(rawSymbol: string | null): string | null {
  if (rawSymbol === null) {
    return null;
  }
  return /^([A-Z]{1,3})/u.exec(rawSymbol)?.[1] ?? null;
}

async function main(): Promise<void> {
  const runStart = performance.now();
  console.log(`[qfa-402b] archive_root=${ARCHIVE_ROOT}`);
  const feb = await loadManifest('feb');
  const mar = await loadManifest('mar');
  const manifests = { feb: feb.manifest, mar: mar.manifest };
  const manifestChecks = [feb.check, mar.check];
  console.log(`[qfa-402b] manifest_checks=${JSON.stringify(manifestChecks)}`);

  if (manifestChecks.some((check) =>
    check.manifest_content_hash_match !== true ||
    check.manifest_file_sha256_match !== true ||
    check.verified_file_sha256_match !== true
  )) {
    throw new Error('At least one locked manifest or verified-report hash did not match');
  }

  const sessions: SessionSmokeResult[] = [];
  for (const selected of SELECTED_SESSIONS) {
    sessions.push(await runSession(selected, manifests[selected.month]));
  }

  const totalProbes = sessions.reduce((sum, session) => sum + session.total_probes, 0);
  const comparableProbes = sessions.reduce((sum, session) => sum + session.comparable_probes, 0);
  const withinToleranceProbes = sessions.reduce((sum, session) => sum + session.within_tolerance_probes, 0);
  const withinToleranceSharePpm = comparableProbes === 0
    ? null
    : Number((BigInt(withinToleranceProbes) * 1_000_000n) / BigInt(comparableProbes));

  const output = {
    result_schema_version: 1,
    archive_root: ARCHIVE_ROOT,
    selected_sessions: SELECTED_SESSIONS.map((session) => session.sessionId),
    policy: {
      tolerance_ppm: DEFAULT_QUEUE_FIDELITY_POLICY_V1.tolerance_ppm,
      min_comparable_probes: DEFAULT_QUEUE_FIDELITY_POLICY_V1.min_comparable_probes,
      min_within_tolerance_share_ppm: DEFAULT_QUEUE_FIDELITY_POLICY_V1.min_within_tolerance_share_ppm,
      synthesized_mode: 'qfa105_mbp_trades_proxy',
    },
    manifest_checks: manifestChecks,
    sessions,
    aggregate: {
      total_probes: totalProbes,
      comparable_probes: comparableProbes,
      within_tolerance_probes: withinToleranceProbes,
      within_tolerance_share_ppm: withinToleranceSharePpm,
      threshold_ppm: DEFAULT_QUEUE_FIDELITY_POLICY_V1.min_within_tolerance_share_ppm,
      status: withinToleranceSharePpm !== null &&
        comparableProbes >= DEFAULT_QUEUE_FIDELITY_POLICY_V1.min_comparable_probes &&
        withinToleranceSharePpm >= DEFAULT_QUEUE_FIDELITY_POLICY_V1.min_within_tolerance_share_ppm
        ? 'pass'
        : 'fail',
    },
    runtime_ms: elapsedMs(runStart),
    cache_notes: {
      parquet_cache_used: false,
      qfa_103b_observation: 'Direct DBN loader path used for the smoke; no parquet cache artifacts were built or read.',
    },
    heap_config: process.env.NODE_OPTIONS ?? null,
    rss_mb: sampleRssMb(),
    peak_rss_mb: peakRssMb,
  };

  console.log(`[qfa-402b] final=${JSON.stringify(output, null, 2)}`);
}

await main();
