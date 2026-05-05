import { ns, type UnixNs } from '../../contracts/time.js';
import type { TimeBarSpec } from './bar-spec.js';

const SECOND_NS = 1_000_000_000n;

export interface TimeBucket {
  readonly bucket_start_ts_ns: UnixNs;
  readonly bucket_end_ts_ns: UnixNs;
}

export function deriveTimeBucket(ts_ns: UnixNs, barSpec: TimeBarSpec): TimeBucket {
  const bucketNs =
    barSpec.unit === 's'
      ? BigInt(barSpec.count) * SECOND_NS
      : barSpec.unit === 'm'
        ? BigInt(barSpec.count) * 60n * SECOND_NS
        : barSpec.unit === 'h'
          ? BigInt(barSpec.count) * 3_600n * SECOND_NS
          : BigInt(barSpec.count) * 86_400n * SECOND_NS;

  const raw = ts_ns as bigint;
  const bucketStart = raw - (raw % bucketNs);
  return {
    bucket_start_ts_ns: ns(bucketStart),
    bucket_end_ts_ns: ns(bucketStart + bucketNs),
  };
}
