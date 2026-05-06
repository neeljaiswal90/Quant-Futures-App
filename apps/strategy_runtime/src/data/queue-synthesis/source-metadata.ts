import type {
  QueueSynthesisConfidence,
  QueueSynthesisQualityFlag,
  QueueSynthesisSourceMetadata,
} from './types.js';

export function createQueueSynthesisSourceMetadata(
  input: QueueSynthesisSourceMetadata,
): QueueSynthesisSourceMetadata {
  return Object.freeze({
    mode: input.mode,
    corpus_tier: input.corpus_tier,
    input_schemas: Object.freeze([...input.input_schemas]) as readonly typeof input.input_schemas[number][],
    confidence: input.confidence,
    quality_flags: freezeUniqueFlags(input.quality_flags),
  });
}

export function withQueueSynthesisQualityFlags(
  metadata: QueueSynthesisSourceMetadata,
  flags: readonly QueueSynthesisQualityFlag[],
): QueueSynthesisSourceMetadata {
  return createQueueSynthesisSourceMetadata({
    ...metadata,
    quality_flags: [...metadata.quality_flags, ...flags],
  });
}

export function withQueueSynthesisConfidence(
  metadata: QueueSynthesisSourceMetadata,
  confidence: QueueSynthesisConfidence,
): QueueSynthesisSourceMetadata {
  return createQueueSynthesisSourceMetadata({
    ...metadata,
    confidence,
  });
}

function freezeUniqueFlags(
  flags: readonly QueueSynthesisQualityFlag[],
): readonly QueueSynthesisQualityFlag[] {
  return Object.freeze([...new Set(flags)]) as readonly QueueSynthesisQualityFlag[];
}
