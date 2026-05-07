import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildMbp10ReferenceOfiBuckets,
  buildMbp1TradeSynthesizedOfiBuckets,
  buildOfiFidelityResult,
} from '../../apps/backtester/src/fidelity/ofi/index.js';
import { ns } from '../../apps/strategy_runtime/src/contracts/time.js';
import { loadDbnFile } from '../../apps/strategy_runtime/src/data/dbn-loader.js';
import type { DbnRecord } from '../../apps/strategy_runtime/src/data/dbn-types.js';

const DEFAULT_ARCHIVE_ROOT = 'D:/qfa-cache/databento/tier-a-feb-mar-2026';
const DEFAULT_SESSIONS = ['2026-02-25-rth', '2026-03-19-rth'] as const;
const EXPECTED_MANIFEST_HASHES = Object.freeze({
  'manifest-feb-2026.json': '05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c',
  'manifest-mar-2026.json': 'cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f',
});
const EXPECTED_SCHEMAS = ['mbo', 'mbp-1', 'mbp-10', 'tbbo', 'trades'] as const;
const ONE_SECOND_NS = 1_000_000_000n;

type MonthManifestName = keyof typeof EXPECTED_MANIFEST_HASHES;
type SmokeSchema = 'mbp-10' | 'mbp-1' | 'trades';

interface Args {
  readonly archiveRoot: string;
  readonly sessions: readonly string[];
  readonly maxSeconds: number | null;
}

interface ManifestSchemaEntry {
  readonly path: string;
  readonly byte_count: number;
  readonly status: string;
}

interface ManifestSession {
  readonly session_id: string;
  readonly symbol: string;
  readonly split: string;
  readonly status: string;
  readonly rth_window: {
    readonly start_ts_ns: string;
    readonly end_ts_ns: string;
  };
  readonly schemas: {
    readonly 'mbp-10': ManifestSchemaEntry;
    readonly 'mbp-1': ManifestSchemaEntry;
    readonly trades: ManifestSchemaEntry;
  };
}

interface ManifestFile {
  readonly event_schemas: readonly string[];
  readonly sessions: readonly ManifestSession[];
}

interface ManifestSummary {
  readonly manifest_name: MonthManifestName;
  readonly path: string;
  readonly sha256: string;
  readonly expected_sha256: string;
  readonly hash_status: 'pass' | 'fail';
  readonly event_schemas: readonly string[];
  readonly schema_status: 'pass' | 'fail';
}

interface RecordCounters {
  readonly records: Record<SmokeSchema, number>;
}

function parseArgs(argv: readonly string[]): Args {
  let archiveRoot = DEFAULT_ARCHIVE_ROOT;
  let maxSeconds: number | null = null;
  const sessions: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--archive-root') {
      archiveRoot = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--session') {
      sessions.push(requiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--max-seconds') {
      const value = Number(requiredValue(argv, index, arg));
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('--max-seconds must be a positive safe integer');
      }
      maxSeconds = value;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: tsx scripts/backtester/qfa-401-ofi-real-archive-smoke.mts [--archive-root <path>] [--session <id> ...] [--max-seconds <n>]',
        '',
        'Runs QFA-401 OFI fidelity against real Tier A DBN/ZST sessions.',
        'Use --max-seconds for a bounded partial RTH smoke when the cold full-session path is too large.',
      ].join('\n'));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    archiveRoot,
    sessions: sessions.length === 0 ? DEFAULT_SESSIONS : sessions,
    maxSeconds,
  };
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readManifest(archiveRoot: string, manifestName: MonthManifestName): {
  readonly manifest: ManifestFile;
  readonly summary: ManifestSummary;
} {
  const path = join(archiveRoot, manifestName);
  const bytes = readFileSync(path);
  const manifest = JSON.parse(bytes.toString('utf8')) as ManifestFile;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const expectedSha256 = EXPECTED_MANIFEST_HASHES[manifestName];
  const schemaStatus = JSON.stringify(manifest.event_schemas) === JSON.stringify(EXPECTED_SCHEMAS)
    ? 'pass'
    : 'fail';

  return {
    manifest,
    summary: {
      manifest_name: manifestName,
      path,
      sha256,
      expected_sha256: expectedSha256,
      hash_status: sha256 === expectedSha256 ? 'pass' : 'fail',
      event_schemas: manifest.event_schemas,
      schema_status: schemaStatus,
    },
  };
}

function manifestNameForSession(sessionId: string): MonthManifestName {
  if (sessionId.startsWith('2026-02-')) {
    return 'manifest-feb-2026.json';
  }
  if (sessionId.startsWith('2026-03-')) {
    return 'manifest-mar-2026.json';
  }
  throw new Error(`Unsupported session month for ${sessionId}`);
}

function localPath(path: string): string {
  return path.replace(/\\/gu, '/');
}

async function* boundedDbnRecords(
  path: string,
  schema: SmokeSchema,
  startTsNs: bigint,
  endTsNs: bigint,
  counters: RecordCounters,
): AsyncIterableIterator<DbnRecord> {
  for await (const record of loadDbnFile(localPath(path), schema)) {
    if (record.ts_event < startTsNs) {
      continue;
    }
    if (record.ts_event >= endTsNs) {
      break;
    }
    counters.records[schema] += 1;
    yield record;
  }
}

async function* concatRecords(
  left: AsyncIterable<DbnRecord>,
  right: AsyncIterable<DbnRecord>,
): AsyncIterableIterator<DbnRecord> {
  yield* left;
  yield* right;
}

async function runSession(session: ManifestSession, maxSeconds: number | null) {
  const counters: RecordCounters = {
    records: {
      'mbp-10': 0,
      'mbp-1': 0,
      trades: 0,
    },
  };
  const fullStart = BigInt(session.rth_window.start_ts_ns);
  const fullEnd = BigInt(session.rth_window.end_ts_ns);
  const smokeEnd = maxSeconds === null
    ? fullEnd
    : fullStart + (BigInt(maxSeconds) * ONE_SECOND_NS);
  const boundedEnd = smokeEnd > fullEnd ? fullEnd : smokeEnd;
  const runtimeStart = process.hrtime.bigint();

  for (const schema of ['mbp-10', 'mbp-1', 'trades'] as const) {
    const schemaEntry = session.schemas[schema];
    if (schemaEntry.status !== 'available') {
      throw new Error(`${session.session_id} ${schema} is not available`);
    }
    if (!existsSync(localPath(schemaEntry.path))) {
      throw new Error(`${session.session_id} ${schema} path does not exist: ${schemaEntry.path}`);
    }
  }

  const reference = await buildMbp10ReferenceOfiBuckets(
    boundedDbnRecords(
      session.schemas['mbp-10'].path,
      'mbp-10',
      fullStart,
      boundedEnd,
      counters,
    ),
  );
  const synthesized = await buildMbp1TradeSynthesizedOfiBuckets(
    concatRecords(
      boundedDbnRecords(
        session.schemas['mbp-1'].path,
        'mbp-1',
        fullStart,
        boundedEnd,
        counters,
      ),
      boundedDbnRecords(
        session.schemas.trades.path,
        'trades',
        fullStart,
        boundedEnd,
        counters,
      ),
    ),
  );
  const result = buildOfiFidelityResult([
    {
      regime: session.session_id,
      reference,
      synthesized,
    },
  ]);
  const regime = result.regimes[0]!;
  const runtimeMs = Number((process.hrtime.bigint() - runtimeStart) / 1_000_000n);
  const sourceBytes = {
    'mbp-10': session.schemas['mbp-10'].byte_count,
    'mbp-1': session.schemas['mbp-1'].byte_count,
    trades: session.schemas.trades.byte_count,
  };

  return {
    session_id: session.session_id,
    symbol: session.symbol,
    split: session.split,
    scope: maxSeconds === null ? 'full_rth' : 'partial_rth_prefix',
    requested_max_seconds: maxSeconds,
    window_start_ts_ns: ns(fullStart).toString(),
    window_end_ts_ns: ns(boundedEnd).toString(),
    window_seconds: Number((boundedEnd - fullStart) / ONE_SECOND_NS),
    source_bytes: sourceBytes,
    decoded_records: counters.records,
    reference_bucket_count: reference.length,
    synthesized_bucket_count: synthesized.length,
    aligned_bucket_count: regime.bucket_count,
    pearson_r_ppm: regime.pearson_r_ppm,
    threshold_ppm: regime.threshold_ppm,
    threshold_status: regime.status,
    missing_depth_level_count: regime.missing_depth_level_count,
    unknown_trade_side_count: regime.unknown_trade_side_count,
    runtime_ms: runtimeMs,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestCache = new Map<MonthManifestName, ReturnType<typeof readManifest>>();
  const getManifest = (name: MonthManifestName) => {
    const cached = manifestCache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const loaded = readManifest(args.archiveRoot, name);
    manifestCache.set(name, loaded);
    return loaded;
  };

  const verified = [
    'verified-feb-2026.json',
    'verified-mar-2026.json',
  ].map((name) => {
    const path = join(args.archiveRoot, name);
    return {
      name,
      path,
      exists: existsSync(path),
      sha256: existsSync(path) ? hashFile(path) : null,
    };
  });

  const sessions = await Promise.all(args.sessions.map(async (sessionId) => {
    const manifestName = manifestNameForSession(sessionId);
    const loaded = getManifest(manifestName);
    const session = loaded.manifest.sessions.find((item) => item.session_id === sessionId);
    if (session === undefined) {
      throw new Error(`Session ${sessionId} not found in ${manifestName}`);
    }
    if (session.status !== 'complete') {
      throw new Error(`Session ${sessionId} status is ${session.status}`);
    }
    return runSession(session, args.maxSeconds);
  }));

  const cacheRoot = process.env.QFA_PARQUET_CACHE_ROOT ?? 'D:/qfa-cache/parquet';
  const cacheExists = existsSync(cacheRoot);
  const output = {
    ticket_id: 'QFA-401-housekeeping-1',
    archive_root: args.archiveRoot,
    generated_at: new Date().toISOString(),
    manifest_verification: [...manifestCache.values()].map((item) => item.summary),
    verified_report_hashes: verified,
    cache_notes: {
      qfa_parquet_cache_root: cacheRoot,
      cache_root_exists: cacheExists,
      cache_root_path_type: cacheExists ? (statSync(cacheRoot).isDirectory() ? 'directory' : 'file') : 'missing',
      read_path: args.maxSeconds === null
        ? 'direct_dbn_loader_full_session'
        : 'direct_dbn_loader_bounded_partial_session',
      qfa_103b_characterization:
        'QFA-103 parquet cache is full-file content-hash keyed; no prebuilt cache was required for this bounded OFI smoke.',
    },
    build_notes: {
      helper_script: localPath(join(dirname(new URL(import.meta.url).pathname), 'qfa-401-ofi-real-archive-smoke.mts')),
      existing_ofi_module: 'apps/backtester/src/fidelity/ofi/index.ts',
      existing_dbn_loader: 'apps/strategy_runtime/src/data/dbn-loader.ts',
    },
    sessions,
  };

  console.log(JSON.stringify(output, null, 2));
}

await main();
