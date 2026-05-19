import type { UnixNs } from '../../contracts/index.js';

const NS_PER_MS = 1_000_000n;
const anchorWallNs = BigInt(Date.now()) * NS_PER_MS;
const anchorMonotonicNs = process.hrtime.bigint();

/**
 * Validator-local timestamp capture for QFA-624 emitted issues.
 *
 * TODO(QFA-626): Replace this with the centralized local timestamp capture
 * helper once QFA-626 is available on this branch.
 */
export function captureValidatorIssueEmittedTsNs(): UnixNs {
  return (anchorWallNs + (process.hrtime.bigint() - anchorMonotonicNs)) as UnixNs;
}
