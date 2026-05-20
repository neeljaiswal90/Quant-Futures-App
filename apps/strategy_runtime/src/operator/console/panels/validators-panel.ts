import {
  formatNs,
  renderPanel,
  tone,
  toneForSeverity,
} from '../ansi-renderer.js';
import type { ValidatorIssueSummary, ValidatorsPanelState } from '../console-state.js';

export function render(state: ValidatorsPanelState): string {
  if (state.issues.length === 0) {
    return renderPanel('Validators', ['last_5_issues=none']);
  }
  return renderPanel('Validators', state.issues.map(renderIssue));
}

function renderIssue(issue: ValidatorIssueSummary): string {
  const severity = tone(issue.severity, toneForSeverity(issue.severity));
  return [
    `severity=${severity}`,
    `validator=${issue.validator_id}`,
    `code=${issue.code}`,
    `source=${issue.source_event_type ?? '--'}`,
    `emitted_ts_ns=${formatNs(issue.emitted_ts_ns)}`,
    `message=${quoteCompact(issue.message)}`,
  ].join(' ');
}

function quoteCompact(value: string): string {
  return JSON.stringify(value.length > 96 ? `${value.slice(0, 93)}...` : value);
}