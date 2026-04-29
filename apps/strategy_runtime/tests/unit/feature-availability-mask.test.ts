import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  assertAuthoritative,
  buildFeatureAvailabilityMask,
  tierOf,
} from '../../src/features/availability-mask.js';

const PYTHON = process.env.PYTHON ?? 'python';
const V1_MASK_HASH = 'sha256:fd7672a243fe476e28e655a0a43ec8f31faf2abedda4fabd9f3d6f43bad3cb00';
const V2_MASK_HASH = 'sha256:f9039c8a9c19bd5de72cfd8d0200e44ff1c09ad439c02bcffbe2dbe639c4c4a3';
const V3_MASK_HASH = 'sha256:f6adf0fc9c985b0f5fb9dff490761c53fec7c8abeb65102046a8ef36535a6da3';
const CURRENT_MASK_HASH = 'sha256:fa69e095415f40475a3098cdb97790736437ebd08c2c5260aeae37873c3697aa';

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
      mask_version: 4,
      mask_id: 'feature-availability-mask-v4-adr0002-data03ps-mbo-shadow',
      lineage: {
        adr: 'ADR-0002',
        infra01e: 'MBP10_PRICE_STATE_ACCEPTED_SUBSCOPE',
        infra01f: 'MBO_PROVIDER_INTERNAL_ACCEPTED_SUBSCOPE',
        data01b_full_status: 'blocked',
        data01_full_status: 'blocked',
      },
    });
    expect(mask.mask_hash).toBe(CURRENT_MASK_HASH);
    expect(mask.mask_hash).not.toBe(V1_MASK_HASH);
    expect(mask.mask_hash).not.toBe(V2_MASK_HASH);
    expect(mask.mask_hash).not.toBe(V3_MASK_HASH);
    expect(tierOf(mask, 'mbp10_top_bid_px')).toBe('authoritative');
    expect(tierOf(mask, 'mbo_order_id')).toBe('subscope');
    expect(tierOf(mask, 'mbo_book_state')).toBe('subscope');
    expect(tierOf(mask, 'queue_position_estimate')).toBe('subscope');
    expect(tierOf(mask, 'microstructure_spread_ticks')).toBe('authoritative');
    expect(tierOf(mask, 'mbo_ofi_short')).toBe('subscope');
    expect(tierOf(mask, 'mbo_queue_imbalance')).toBe('subscope');
    expect(tierOf(mask, 'mbp10_size_diagnostic')).toBe('diagnostic_only');
    expect(tierOf(mask, 'mbo_record_count')).toBe('diagnostic_only');
    expect(tierOf(mask, 'mbo_taxonomy_status')).toBe('diagnostic_only');
    expect(tierOf(mask, 'cancel_add_ratio_shadow')).toBe('shadow_only');
    expect(tierOf(mask, 'absorption_score_shadow')).toBe('shadow_only');
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
    expect(() => assertAuthoritative(mask, 'queue_position_estimate')).toThrow(
      'Feature field queue_position_estimate is subscope, not authoritative',
    );
    expect(() => assertAuthoritative(mask, 'cancel_add_ratio_shadow')).toThrow(
      'Feature field cancel_add_ratio_shadow is shadow_only, not authoritative',
    );
    expect(() => assertAuthoritative(mask, 'queue_position')).toThrow(
      'Feature field queue_position is blocked, not authoritative',
    );
  });
});
