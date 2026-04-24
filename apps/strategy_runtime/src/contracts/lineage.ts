import type { ConfigHash } from './ids.js';

export interface ConfigLineageRef {
  readonly config_hash: ConfigHash;
  readonly config_version: number;
}

export interface FeatureLineageRef extends ConfigLineageRef {
  readonly feature_schema_version: number;
}
