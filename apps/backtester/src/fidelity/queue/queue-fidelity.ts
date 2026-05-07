import {
  DEFAULT_QUEUE_FIDELITY_POLICY_V1,
  type QueueFidelityPolicy,
  type QueueFidelityProbeResult,
  type QueueFidelityRegimeInput,
  type QueueFidelityRegimeResult,
  type QueueFidelityResult,
  type QueueFidelityStatus,
} from './types.js';

export function compareQueueFidelityProbe(
  reference: QueueFidelityProbeResult,
  synthesized: QueueFidelityProbeResult,
  policy: QueueFidelityPolicy = DEFAULT_QUEUE_FIDELITY_POLICY_V1,
): QueueFidelityProbeResult {
  const referencePpm = reference.reference_fill_probability_ppm;
  const synthesizedPpm = synthesized.synthesized_fill_probability_ppm;
  if (referencePpm === null) {
    return makeUnavailable(reference, synthesized, 'reference_unavailable');
  }
  if (synthesizedPpm === null) {
    return makeUnavailable(reference, synthesized, 'synthesized_unavailable');
  }

  const absoluteError = Math.abs(synthesizedPpm - referencePpm);
  return Object.freeze({
    probe_id: reference.probe_id,
    ts_ns: reference.ts_ns,
    side: reference.side,
    limit_price: reference.limit_price,
    quantity: reference.quantity,
    reference_fill_probability_ppm: referencePpm,
    synthesized_fill_probability_ppm: synthesizedPpm,
    absolute_error_ppm: absoluteError,
    within_tolerance: absoluteError <= policy.tolerance_ppm,
    status: 'compared',
    synthesized_source_mode: synthesized.synthesized_source_mode,
  });
}

export function summarizeQueueFidelityRegime(
  regime: 'baseline' | 'stress' | string,
  probeResults: readonly QueueFidelityProbeResult[],
  policy: QueueFidelityPolicy = DEFAULT_QUEUE_FIDELITY_POLICY_V1,
): QueueFidelityRegimeResult {
  const comparable = probeResults.filter(
    (result) =>
      result.status === 'compared' &&
      result.reference_fill_probability_ppm !== null &&
      result.synthesized_fill_probability_ppm !== null &&
      result.within_tolerance !== null,
  );
  const withinTolerance = comparable.filter((result) => result.within_tolerance === true).length;
  const sharePpm =
    comparable.length === 0
      ? null
      : Number((BigInt(withinTolerance) * 1_000_000n) / BigInt(comparable.length));

  return Object.freeze({
    regime,
    status: deriveRegimeStatus(probeResults, comparable.length, sharePpm, policy),
    total_probes: probeResults.length,
    comparable_probes: comparable.length,
    within_tolerance_probes: withinTolerance,
    within_tolerance_share_ppm: sharePpm,
    tolerance_ppm: policy.tolerance_ppm,
    threshold_ppm: policy.min_within_tolerance_share_ppm,
  });
}

export function buildQueueFidelityResult(
  regimes: readonly QueueFidelityRegimeInput[],
  policy: QueueFidelityPolicy = DEFAULT_QUEUE_FIDELITY_POLICY_V1,
): QueueFidelityResult {
  return Object.freeze({
    result_schema_version: 1,
    policy,
    regimes: regimes.map((regime) => summarizeQueueFidelityRegime(regime.regime, regime.probe_results, policy)),
  });
}

function deriveRegimeStatus(
  probeResults: readonly QueueFidelityProbeResult[],
  comparableProbeCount: number,
  sharePpm: number | null,
  policy: QueueFidelityPolicy,
): QueueFidelityStatus {
  if (probeResults.length > 0 && comparableProbeCount === 0) {
    const referenceUnavailable = probeResults.every((result) => result.status === 'reference_unavailable');
    const synthesizedUnavailable = probeResults.every((result) => result.status === 'synthesized_unavailable');
    if (referenceUnavailable) {
      return 'reference_unavailable';
    }
    if (synthesizedUnavailable) {
      return 'synthesized_unavailable';
    }
  }
  if (comparableProbeCount < policy.min_comparable_probes) {
    return 'insufficient_data';
  }
  if (sharePpm === null) {
    return 'insufficient_data';
  }
  return sharePpm >= policy.min_within_tolerance_share_ppm ? 'pass' : 'fail';
}

function makeUnavailable(
  reference: QueueFidelityProbeResult,
  synthesized: QueueFidelityProbeResult,
  status: 'reference_unavailable' | 'synthesized_unavailable',
): QueueFidelityProbeResult {
  return Object.freeze({
    probe_id: reference.probe_id,
    ts_ns: reference.ts_ns,
    side: reference.side,
    limit_price: reference.limit_price,
    quantity: reference.quantity,
    reference_fill_probability_ppm: reference.reference_fill_probability_ppm,
    synthesized_fill_probability_ppm: synthesized.synthesized_fill_probability_ppm,
    absolute_error_ppm: null,
    within_tolerance: null,
    status,
    synthesized_source_mode: synthesized.synthesized_source_mode,
  });
}
