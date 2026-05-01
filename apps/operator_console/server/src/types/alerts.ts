export type OperatorConsoleAlertSeverity = 'info' | 'warning' | 'critical';

export type OperatorConsoleAlertKind =
  | 'malformed_or_schema_invalid_row'
  | 'feature_policy_violation'
  | 'missing_terminal_order_intent';

export interface OperatorConsoleAlertInput {
  readonly id: string;
  readonly kind: OperatorConsoleAlertKind;
  readonly severity: OperatorConsoleAlertSeverity;
  readonly message: string;
  readonly event_id?: string;
  readonly source_file?: string;
  readonly line_number?: number;
  readonly byte_offset_start?: number;
  readonly byte_offset_end?: number;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}
