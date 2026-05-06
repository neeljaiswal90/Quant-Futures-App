import type { DatabentoSchema } from '../../contracts/tier-policy.js';

export const QUEUE_SCHEMA_PRIORITY_ORDER: readonly DatabentoSchema[] = Object.freeze([
  'definition',
  'status',
  'mbo',
  'mbp-10',
  'mbp-1',
  'tbbo',
  'trades',
  'bbo',
  'statistics',
  'ohlcv-1m',
]);

const QUEUE_SCHEMA_PRIORITY = new Map<DatabentoSchema, number>(
  QUEUE_SCHEMA_PRIORITY_ORDER.map((schema, index) => [schema, index]),
);

export function getQueueSchemaPriority(schema: DatabentoSchema): number {
  const priority = QUEUE_SCHEMA_PRIORITY.get(schema);
  if (priority === undefined) {
    throw new Error(`Unknown Databento schema priority: ${schema}`);
  }
  return priority;
}
