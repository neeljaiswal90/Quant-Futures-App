import {
  formatDurationMs,
  formatNs,
  renderPanel,
} from '../ansi-renderer.js';
import type { HeaderPanelState } from '../console-state.js';

export function render(state: HeaderPanelState): string {
  return renderPanel('Header', [
    [
      `session_id=${state.session_id ?? '--'}`,
      `mode=${state.mode ?? '--'}`,
      `uptime=${formatDurationMs(state.uptime_ms)}`,
    ].join(' '),
    [
      `strategy_id=${state.strategy_id ?? '--'}`,
      `capability_mask_version=${state.capability_mask_version ?? '--'}`,
      `manifest_ts_ns=${formatNs(state.manifest_ts_ns)}`,
    ].join(' '),
  ]);
}