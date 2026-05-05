import type { DatabentoSchema } from '../../contracts/tier-policy.js';
import { BarBuilderInputError } from './bar-builder-input-error.js';
import type { ParsedBarSpec } from './bar-spec.js';
import type { BarConstructionMethod } from './source-metadata.js';

export interface BarSpecConstructibilityOptions {
  readonly rollBoundaryExpected?: boolean;
}

export function assertBarSpecConstructible(
  barSpec: ParsedBarSpec,
  inputSchemas: readonly DatabentoSchema[],
  options: BarSpecConstructibilityOptions = {},
): BarConstructionMethod {
  const schemaSet = new Set<DatabentoSchema>(inputSchemas);
  const hasTrades = schemaSet.has('trades') || schemaSet.has('tbbo');
  const hasOhlcv = schemaSet.has('ohlcv-1m');

  if (barSpec.kind === 'tick') {
    if (hasTrades) {
      return 'trade_aggregation';
    }
    throw new BarBuilderInputError([
      {
        path: '$.input_schemas',
        code: 'incompatible_input_schema',
        message: 'tick, volume, and dollar bars require trade-shaped inputs',
      },
    ]);
  }

  if (hasTrades) {
    return 'trade_aggregation';
  }

  if (hasOhlcv) {
    if (options.rollBoundaryExpected) {
      throw new BarBuilderInputError([
        {
          path: '$.input_schemas',
          code: 'roll_unsplittable_aggregate',
          message:
            'pre-aggregated ohlcv-1m inputs cannot be split at an intra-session contract roll boundary',
        },
      ]);
    }
    if (barSpec.unit === 's') {
      throw new BarBuilderInputError([
        {
          path: '$.bar_spec',
          code: 'subminute_from_ohlcv',
          message: 'subminute time bars cannot be constructed from ohlcv-1m inputs',
        },
      ]);
    }
    if (barSpec.unit === 'm' && barSpec.count === 1) {
      return 'ohlcv_passthrough';
    }
    return 'ohlcv_aggregation';
  }

  throw new BarBuilderInputError([
    {
      path: '$.input_schemas',
      code: 'incompatible_input_schema',
      message: 'bar specification is incompatible with the available input schemas',
    },
  ]);
}
