import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  assertAuthoritative,
  buildFeatureAvailabilityMask,
  tierOf,
} from '../../src/features/availability-mask.js';

const PYTHON = process.env.PYTHON ?? 'python';

function pythonMask(): Record<string, unknown> {
  const result = spawnSync(
    PYTHON,
    [
      '-c',
      [
        'import json',
        'from services.market_data_sidecar.features.availability_mask import build_feature_availability_mask',
        'print(json.dumps(build_feature_availability_mask(), sort_keys=True, separators=(",", ":")))',
      ].join('; '),
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(`Python availability mask failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

describe('DATA-03 feature availability mask', () => {
  it('keeps the TS and Python masks byte-equivalent after JSON parse', () => {
    expect(buildFeatureAvailabilityMask()).toEqual(pythonMask());
  });

  it('classifies currently accepted, diagnostic, and blocked fields explicitly', () => {
    const mask = buildFeatureAvailabilityMask();

    expect(mask).toMatchObject({
      schema_version: 1,
      mask_version: 1,
      mask_id: 'feature-availability-mask-v1-adr0002-infra01e-infra01f',
      lineage: {
        adr: 'ADR-0002',
        infra01e: 'MBP10_PRICE_STATE_ACCEPTED_SUBSCOPE',
        infra01f: 'MBO_PROVIDER_INTERNAL_ACCEPTED_SUBSCOPE',
        data01b_full_status: 'blocked',
        data01_full_status: 'blocked',
      },
    });
    expect(mask.mask_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(tierOf(mask, 'mbp10_top_bid_px')).toBe('authoritative');
    expect(tierOf(mask, 'mbo_order_id')).toBe('subscope');
    expect(tierOf(mask, 'mbp10_size_diagnostic')).toBe('diagnostic_only');
    expect(tierOf(mask, 'queue_position')).toBe('blocked');
  });

  it('guards authoritative consumers from accidental diagnostic or blocked fields', () => {
    const mask = buildFeatureAvailabilityMask();

    expect(() => assertAuthoritative(mask, 'mbp10_spread_ticks')).not.toThrow();
    expect(() => assertAuthoritative(mask, 'mbp10_size_diagnostic')).toThrow(
      'Feature field mbp10_size_diagnostic is diagnostic_only, not authoritative',
    );
    expect(() => assertAuthoritative(mask, 'mbo_order_id')).toThrow(
      'Feature field mbo_order_id is subscope, not authoritative',
    );
    expect(() => assertAuthoritative(mask, 'queue_position')).toThrow(
      'Feature field queue_position is blocked, not authoritative',
    );
  });
});
