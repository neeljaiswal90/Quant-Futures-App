export interface RedactionResult {
  readonly text: string;
  readonly replacements: Readonly<Record<string, number>>;
}

const CREDENTIAL_KEYS = [
  'RITHMIC_TEST_USERNAME',
  'RITHMIC_TEST_PASSWORD',
  'RITHMIC_USERNAME',
  'RITHMIC_PASSWORD',
  'username',
  'password',
] as const;

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const IP_PATTERN = /\b(?!(?:127\.0\.0\.1|0\.0\.0\.0)\b)(?:\d{1,3}\.){3}\d{1,3}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/g;
const SESSION_ID_PATTERN = /\b(?:rithmic-|mock-)?session[-_:][A-Za-z0-9._-]+\b/gi;
const ORDER_ID_PATTERN = /\b(?:broker[-_])?order[-_:][A-Za-z0-9._-]+\b/gi;
const ACCOUNT_ID_PATTERN = /(\b(?:account(?:Id|_id)?["'\s:=]+))([A-Za-z0-9._-]{4,})\b/gi;

export function redactText(input: string, explicitSecrets: readonly string[] = []): RedactionResult {
  let text = input;
  const replacements: Record<string, number> = {};
  const replace = (pattern: string | RegExp, replacement: string): void => {
    const before = text;
    text = text.replace(pattern as RegExp, replacement);
    if (before !== text) {
      replacements[replacement] = (replacements[replacement] ?? 0) + 1;
    }
  };

  for (const secret of explicitSecrets) {
    if (secret.trim() !== '') {
      replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED:credential]');
    }
  }
  for (const key of CREDENTIAL_KEYS) {
    replace(new RegExp(`(${escapeRegExp(key)}["'\\s:=]+)([^,"'\\s}]+)`, 'gi'), `$1[REDACTED:credential]`);
  }
  replace(BEARER_PATTERN, 'Bearer [REDACTED:credential]');
  replace(EMAIL_PATTERN, '[REDACTED:credential]');
  replace(SESSION_ID_PATTERN, '[REDACTED:session-id-1]');
  replace(ORDER_ID_PATTERN, '[REDACTED:order-id-1]');
  replace(ACCOUNT_ID_PATTERN, '$1[REDACTED:account-id]');
  replace(IP_PATTERN, '[REDACTED:ip]');

  return { text, replacements };
}

export function redactJsonRecord(record: unknown, explicitSecrets: readonly string[] = []): unknown {
  return JSON.parse(redactText(JSON.stringify(record), explicitSecrets).text) as unknown;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
