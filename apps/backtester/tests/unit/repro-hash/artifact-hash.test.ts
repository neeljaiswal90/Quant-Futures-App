import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeReproJson,
  computeRawUtf8ArtifactHash,
  computeReproArtifactHash,
} from '../../../src/repro-hash/index.js';

describe('QFA-205 artifact hashing', () => {
  it('hashes journal_jsonl as raw UTF-8 bytes', () => {
    const journal = '{"type":"BACKTEST_RUN_META"}\n';
    const first = computeRawUtf8ArtifactHash('journal_jsonl', journal);
    const second = computeRawUtf8ArtifactHash('journal_jsonl', `${journal} `);

    expect(first.encoding).toBe('raw_utf8_bytes');
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.sha256).not.toBe(second.sha256);
    expect(first.byte_length).toBe(Buffer.byteLength(journal, 'utf8'));
  });

  it('hashes equivalent journal strings and UTF-8 bytes identically', () => {
    const journal = '{"x":"é"}\n';
    expect(computeRawUtf8ArtifactHash('journal_jsonl', journal)).toEqual(
      computeRawUtf8ArtifactHash('journal_jsonl', Buffer.from(journal, 'utf8')),
    );
  });

  it('uses canonical_json_v1 for structured artifacts', () => {
    const first = computeReproArtifactHash('trade_ledger', { b: 2, a: 1n });
    const second = computeReproArtifactHash('trade_ledger', { a: 1n, b: 2 });

    expect(first.encoding).toBe('canonical_json_v1');
    expect(first.sha256).toBe(second.sha256);
    expect(first.byte_length).toBe(Buffer.byteLength(
      canonicalizeReproJson({ a: 1n, b: 2 }),
      'utf8',
    ));
  });

  it('changes structured hashes when array order changes', () => {
    expect(computeReproArtifactHash('trade_pnl', [1, 2]).sha256).not.toBe(
      computeReproArtifactHash('trade_pnl', [2, 1]).sha256,
    );
  });
});
