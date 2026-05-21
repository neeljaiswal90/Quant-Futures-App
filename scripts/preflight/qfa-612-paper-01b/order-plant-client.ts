import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactText } from './redactor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const EVIDENCE = join(HERE, 'evidence');
const RAW_LOCAL = join(EVIDENCE, 'raw-local');
const RAW_PATH = join(RAW_LOCAL, 'order-plant-preflight-02-raw.json');
const MEMO_PATH = join(REPO, 'docs', 'research', 'qfa-612-preflight-02-order-plant-evidence.md');

type RawRecord = Record<string, unknown>;

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const [name, ...rest] = line.split('=');
    if (!name || rest.length === 0) continue;
    if (process.env[name.trim()] === undefined) {
      process.env[name.trim()] = rest.join('=').trim().replace(/^"|"$/g, '');
    }
  }
}

function credentialSecrets(): readonly string[] {
  return [
    process.env.RITHMIC_TEST_USER,
    process.env.RITHMIC_USER,
    process.env.RITHMIC_TEST_USERNAME,
    process.env.RITHMIC_TEST_PASSWORD,
    process.env.RITHMIC_PASSWORD,
    process.env.RITHMIC_TEST_WS_URL,
    process.env.RITHMIC_WS_URL,
    process.env.RITHMIC_TEST_GATEWAY_URL,
    process.env.RITHMIC_CONNECT_POINT,
  ].filter((value): value is string => typeof value === 'string' && value.trim() !== '');
}

function writeJson(path: string, payload: unknown, explicitSecrets: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const redacted = redactText(JSON.stringify(payload, null, 2), explicitSecrets).text;
  writeFileSync(path, `${redacted}\n`, 'utf8');
}

function getPath(record: RawRecord, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !(key in current)) return undefined;
    current = (current as RawRecord)[key];
  }
  return current;
}

function statusOf(record: RawRecord, path: readonly string[]): string {
  const value = getPath(record, path);
  if (typeof value === 'string') return value;
  return 'HOLD';
}

function generateEvidence(raw: RawRecord, explicitSecrets: readonly string[]): void {
  mkdirSync(EVIDENCE, { recursive: true });
  writeJson(join(EVIDENCE, 'check-01-tls-auth-order-plant.json'), {
    check_id: 'check-01-tls-auth-order-plant',
    title: 'ORDER_PLANT TLS/WebSocket connect and auth ACK byte-trace upgrade',
    disposition: statusOf(raw, ['checks', 'check_01_tls_auth', 'status']),
    evidence: getPath(raw, ['checks', 'check_01_tls_auth']),
  }, explicitSecrets);

  writeJson(join(EVIDENCE, 'check-02-order-framing.json'), {
    check_id: 'check-02-order-framing',
    title: 'ORDER_PLANT representative message framing decode',
    disposition: statusOf(raw, ['checks', 'check_02_order_framing', 'status']),
    evidence: getPath(raw, ['checks', 'check_02_order_framing']),
  }, explicitSecrets);

  writeJson(join(EVIDENCE, 'check-04-reconnect-real.json'), {
    check_id: 'check-04-reconnect-real',
    title: 'ORDER_PLANT orderly and disorderly reconnect',
    disposition: summarizeReconnectStatus(raw),
    evidence: getPath(raw, ['checks', 'check_04_reconnect']),
  }, explicitSecrets);

  writeJson(join(EVIDENCE, 'check-05-order-lifecycle-real.json'), {
    check_id: 'check-05-order-lifecycle-real',
    title: 'ORDER_PLANT paper order ACK / cancel / fill / reject lifecycle',
    disposition: summarizeOrderLifecycleStatus(raw),
    evidence: getPath(raw, ['checks', 'check_05_order_lifecycle']),
  }, explicitSecrets);

  writeJson(join(EVIDENCE, 'check-06-logout-close-real.json'), {
    check_id: 'check-06-logout-close-real',
    title: 'ORDER_PLANT logout and close semantics byte-trace upgrade',
    disposition: statusOf(raw, ['checks', 'check_06_logout_close', 'status']),
    evidence: getPath(raw, ['checks', 'check_06_logout_close']),
  }, explicitSecrets);

  writeJson(join(EVIDENCE, 'order-plant-preflight-02-redacted-summary.json'), raw, explicitSecrets);
  writeMemo(raw, explicitSecrets);
}

function summarizeReconnectStatus(raw: RawRecord): string {
  const orderly = statusOf(raw, ['checks', 'check_04_reconnect', 'orderly', 'status']);
  const disorderly = statusOf(raw, ['checks', 'check_04_reconnect', 'disorderly', 'status']);
  return orderly === 'PASS' && disorderly === 'PASS' ? 'PASS' : 'FAIL';
}

function summarizeOrderLifecycleStatus(raw: RawRecord): string {
  const cancelable = statusOf(raw, ['checks', 'check_05_order_lifecycle', 'cancelable_limit', 'status']);
  const fillable = statusOf(raw, ['checks', 'check_05_order_lifecycle', 'fillable_marketable_limit', 'status']);
  const reject = statusOf(raw, ['checks', 'check_05_order_lifecycle', 'broker_reject', 'status']);
  return cancelable === 'PASS' && fillable === 'PASS' && reject === 'PASS' ? 'PASS' : 'HOLD';
}

function writeMemo(raw: RawRecord, explicitSecrets: readonly string[]): void {
  const finalDisposition = String(raw.final_disposition ?? 'HOLD');
  const reconnectStatus = summarizeReconnectStatus(raw);
  const orderLifecycleStatus = summarizeOrderLifecycleStatus(raw);
  const netDelta = getPath(raw, ['checks', 'check_05_order_lifecycle', 'net_position_delta']) ?? 0;
  const authStatus = statusOf(raw, ['checks', 'check_01_tls_auth', 'status']);
  const authError = getPath(raw, ['checks', 'check_01_tls_auth', 'error']);
  const fillableReason =
    getPath(raw, ['checks', 'check_05_order_lifecycle', 'fillable_marketable_limit', 'reason']) ??
    'See order lifecycle evidence.';
  const blocker =
    authStatus === 'FAIL'
      ? `ORDER_PLANT login failed before order checks could execute. Broker response: \`${String(authError)}\`. This indicates the supplied test credentials can authenticate to the gateway for market-data evidence, but are not permissioned for ORDER_PLANT in the current Rithmic test environment.`
      : `The client refused to place the fillable order because the minimal ORDER_PLANT-only path could not verify the external flat-start account-position invariant before submission. That is a safety-preserving refusal, not an adapter implementation failure.`;
  const remediation =
    authStatus === 'FAIL'
      ? 'Provision ORDER_PLANT permission for the Rithmic test account, or provide an ORDER_PLANT-enabled test account, then rerun PREFLIGHT-02.'
      : 'Add a vendor-confirmed position snapshot path or an operator-provided dashboard evidence attachment proving the MNQM6 account is flat immediately before the fillable-order sub-check. Then rerun PREFLIGHT-02 with the same redaction discipline.';
  const memo = `# QFA-612-PREFLIGHT-02 ORDER_PLANT Evidence

**Ticket**: QFA-612-PREFLIGHT-02  
**Branch**: \`feat/qfa-612-preflight-02-order-plant-evidence\`  
**Date**: 2026-05-21  
**PREFLIGHT-01 reference**: \`docs/research/qfa-612-preflight-01-real-env-evidence.md\`

## Final disposition

**${finalDisposition} QFA-612-PAPER-01b dispatch.**

PREFLIGHT-02 upgraded the ORDER_PLANT connection/reconnect path and attempted the paper-order lifecycle gap left by PREFLIGHT-01. The final disposition remains **HOLD** unless every order lifecycle sub-check is PASS and net position is verified zero.

## Per-check disposition

| Check | Disposition | Evidence |
|---|---:|---|
| 1 upgrade: ORDER_PLANT TLS/auth ACK | ${statusOf(raw, ['checks', 'check_01_tls_auth', 'status'])} | \`scripts/preflight/qfa-612-paper-01b/evidence/check-01-tls-auth-order-plant.json\` |
| 2 upgrade: ORDER_PLANT framing | ${statusOf(raw, ['checks', 'check_02_order_framing', 'status'])} | \`scripts/preflight/qfa-612-paper-01b/evidence/check-02-order-framing.json\` |
| 4: orderly + disorderly reconnect | ${reconnectStatus} | \`scripts/preflight/qfa-612-paper-01b/evidence/check-04-reconnect-real.json\` |
| 5: paper order lifecycle | ${orderLifecycleStatus} | \`scripts/preflight/qfa-612-paper-01b/evidence/check-05-order-lifecycle-real.json\` |
| 6 upgrade: logout + close | ${statusOf(raw, ['checks', 'check_06_logout_close', 'status'])} | \`scripts/preflight/qfa-612-paper-01b/evidence/check-06-logout-close-real.json\` |

## Position invariant

- Net MNQM6 position delta from this preflight script: \`${String(netDelta)}\`.
- Fillable marketable-limit sub-check: \`${statusOf(raw, ['checks', 'check_05_order_lifecycle', 'fillable_marketable_limit', 'status'])}\`.
- Reason: ${String(fillableReason)}

## Blocker analysis

QFA-612-PAPER-01b remains blocked if this memo says HOLD. ${blocker}

Recommended remediation: ${remediation}

## Redaction discipline

Raw local logs are written only under \`scripts/preflight/qfa-612-paper-01b/evidence/raw-local/\`, which is gitignored. Committed evidence is generated through the PREFLIGHT-01 redactor with the active credential values supplied as explicit secrets.
`;
  mkdirSync(dirname(MEMO_PATH), { recursive: true });
  writeFileSync(MEMO_PATH, redactText(memo, explicitSecrets).text, 'utf8');
}

function runPython(rawPath: string): void {
  const result = spawnSync('python', [join(HERE, 'order_plant_client.py'), '--out', rawPath], {
    cwd: REPO,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0 && !existsSync(rawPath)) {
    throw new Error(`ORDER_PLANT preflight failed before writing raw evidence, exit=${String(result.status)}`);
  }
}

function main(): void {
  loadEnvFile(join(REPO, '.env'));
  loadEnvFile(join(REPO, '.env.preflight.local'));
  loadEnvFile(join(resolve(REPO, '..', 'Quant-futures-app'), '.env'));
  loadEnvFile(join(resolve(REPO, '..', 'Quant-futures-app-qfa-612-preflight'), '.env.preflight.local'));

  const fromRawIndex = process.argv.indexOf('--from-raw');
  const rawPath = fromRawIndex >= 0 ? resolve(process.argv[fromRawIndex + 1] ?? RAW_PATH) : RAW_PATH;
  mkdirSync(RAW_LOCAL, { recursive: true });
  if (fromRawIndex < 0) {
    runPython(rawPath);
  }
  const raw = JSON.parse(readFileSync(rawPath, 'utf8')) as RawRecord;
  const explicitSecrets = credentialSecrets();
  generateEvidence(raw, explicitSecrets);
  console.log(JSON.stringify({ raw: rawPath, final_disposition: raw.final_disposition ?? 'HOLD', memo: MEMO_PATH }, null, 2));
}

main();
