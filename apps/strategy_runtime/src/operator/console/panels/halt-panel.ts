import {
  formatBoolean,
  formatNs,
  noneIfEmpty,
  renderPanel,
  tone,
} from '../ansi-renderer.js';
import type { HaltEmissionSummary, HaltPanelState } from '../console-state.js';

export function render(state: HaltPanelState): string {
  const header = `current_block_sources=${noneIfEmpty(state.current_block_sources)}`;
  if (state.emissions.length === 0) {
    return renderPanel('Halt', [header, 'last_5_emissions=none']);
  }
  return renderPanel('Halt', [header, ...state.emissions.map(renderEmission)]);
}

function renderEmission(emission: HaltEmissionSummary): string {
  const type = emission.type === 'HALT' ? tone(emission.type, 'breach') : tone(emission.type, 'warn');
  return [
    `type=${type}`,
    `state=${emission.state}`,
    `reason=${emission.reason ?? '--'}`,
    `resolved=${formatBoolean(emission.resolved)}`,
    `ts_ns=${formatNs(emission.ts_ns)}`,
  ].join(' ');
}