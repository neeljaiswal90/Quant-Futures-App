import {
  formatNs,
  renderPanel,
  shortHash,
  tone,
} from '../ansi-renderer.js';
import type { MaskPanelState } from '../console-state.js';

export function render(state: MaskPanelState): string {
  const driftTone = state.drift_status === 'drift_detected' ? 'breach' : 'pass';
  return renderPanel('Mask', [
    [
      `mask_id=${state.mask_id ?? '--'}`,
      `mask_version=${state.mask_version ?? '--'}`,
      `mask_hash8=${shortHash(state.mask_hash)}`,
    ].join(' '),
    [
      `exec_validator_07_drift_status=${tone(state.drift_status, driftTone)}`,
      `code=${state.drift_code ?? '--'}`,
      `severity=${state.drift_severity ?? '--'}`,
      `ts_ns=${formatNs(state.drift_ts_ns)}`,
    ].join(' '),
  ]);
}