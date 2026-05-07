import {
  OosReplayInputError,
  type OosReplayIssue,
} from './oos-replay-error.js';
import {
  TIER_B_OOS_REQUIRED_SCHEMAS,
  type BuildTierBOosInputSpecArgs,
  type TierBOosInputSpec,
} from './types.js';

const SHA256_HEX_RE = /^[a-f0-9]{64}$/u;

export function buildTierBOosInputSpec(args: BuildTierBOosInputSpecArgs): TierBOosInputSpec {
  const issues: OosReplayIssue[] = [];

  args.corpus_manifests.forEach((manifest, manifestIndex) => {
    for (const schema of TIER_B_OOS_REQUIRED_SCHEMAS) {
      if (!manifest.event_schemas.includes(schema)) {
        issues.push({
          path: `$.corpus_manifests[${manifestIndex}].event_schemas`,
          code: schema === 'mbp-1' ? 'missing_mbp1_schema' : 'missing_trades_schema',
          message: `Tier B OOS input requires ${schema}`,
        });
      }
    }
  });

  if (args.corpus_manifest_hashes.length !== args.corpus_manifests.length) {
    issues.push({
      path: '$.corpus_manifest_hashes',
      code: 'missing_manifest_hash',
      message: 'corpus_manifest_hashes must contain one hash per manifest',
    });
  }
  args.corpus_manifest_hashes.forEach((hash, hashIndex) => {
    if (!SHA256_HEX_RE.test(hash)) {
      issues.push({
        path: `$.corpus_manifest_hashes[${hashIndex}]`,
        code: 'missing_manifest_hash',
        message: 'corpus manifest hash must be a lowercase sha256 hex string',
      });
    }
  });

  if (issues.length > 0) {
    throw new OosReplayInputError(issues);
  }

  return Object.freeze({
    spec_schema_version: 1,
    data_mode: args.data_mode,
    required_schemas: TIER_B_OOS_REQUIRED_SCHEMAS,
    corpus_manifest_hashes: Object.freeze([...args.corpus_manifest_hashes]),
    fidelity_status: args.fidelity_status ?? 'pending',
  });
}
