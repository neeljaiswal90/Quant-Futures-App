import type { ConfigValidationIssue } from './types.js';

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigValidationIssue[];

  constructor(issues: readonly ConfigValidationIssue[], heading = 'Invalid application config') {
    const details = issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n');
    super(`${heading}:\n${details}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}
