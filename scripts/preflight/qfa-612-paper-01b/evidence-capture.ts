import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText } from './redactor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, 'evidence');

export interface CheckSummary {
  readonly check_id: string;
  readonly title: string;
  readonly disposition: 'PASS' | 'PASS_PARTIAL' | 'HOLD' | 'FAIL';
  readonly evidence: readonly string[];
  readonly notes: readonly string[];
}

export async function writeCheckEvidence(summary: CheckSummary): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true });
  const safe = redactText(JSON.stringify(summary, null, 2)).text;
  writeFileSync(join(EVIDENCE, `${summary.check_id}.json`), `${safe}\n`, 'utf8');
}

export function summarizeJsonl(path: string): Record<string, unknown> {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const byStream: Record<string, number> = {};
  for (const record of records) {
    const stream = String(record.stream ?? 'unknown');
    byStream[stream] = (byStream[stream] ?? 0) + 1;
  }
  return {
    line_count: records.length,
    records_by_stream: byStream,
    first_sidecar_recv_ts_ns: records[0]?.sidecar_recv_ts_ns,
    last_sidecar_recv_ts_ns: records.at(-1)?.sidecar_recv_ts_ns,
    unknown_template_records: records.filter((record) => record.payload_kind === 'UNKNOWN').length,
  };
}
