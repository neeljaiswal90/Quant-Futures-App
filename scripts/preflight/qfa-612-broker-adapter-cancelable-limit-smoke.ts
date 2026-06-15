import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  createJournalEventEnvelope,
  makeCandidateId,
  makeCausationId,
  makeEventId,
  makeOrderIntentId,
  makeRunId,
  makeSessionId,
  makeSizingDecisionId,
  ns,
  type AnyJournalEventEnvelope,
  type UnixNs,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import type { BrokerAckEnvelope, OrderIntentEventEnvelope } from '../../apps/strategy_runtime/src/execution/brokers/broker-adapter.js';
import { BrokerAdapterRuntimeIntegration } from '../../apps/strategy_runtime/src/execution/brokers/broker-adapter-runtime.js';
import { PythonBrokerAdapter } from '../../apps/strategy_runtime/src/execution/brokers/python-broker-adapter.js';
import { SubmissionGate } from '../../apps/strategy_runtime/src/execution/order-lifecycle-state-machine.js';

const TICKET = 'QFA-612-BROKER-ADAPTER-CANCELABLE-LIMIT-SMOKE-01';
const DETERMINATION_PASS = 'BROKER_ADAPTER_CANCELABLE_LIMIT_SMOKE_PASSED_SUBMIT_CANCEL_NO_FILL';
const DETERMINATION_BLOCKED = 'BROKER_ADAPTER_CANCELABLE_LIMIT_SMOKE_BLOCKED';
const DETERMINATION_BLOCKED_AUTH_INVALID_SYSTEM =
  'BROKER_ADAPTER_CANCELABLE_LIMIT_SMOKE_BLOCKED_ORDER_PLANT_AUTH_INVALID_SYSTEM';
const DETERMINATION_BLOCKED_CLEANED =
  'BROKER_ADAPTER_CANCELABLE_LIMIT_SMOKE_BLOCKED_RUNTIME_ACK_LINEAGE_GAP_CLEANED_UP';
const REPO_ROOT = process.cwd();
const PRIMARY_ENV_PATH = 'D:/Quant-futures-app/.env';
const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'broker', 'qfa-612-broker-adapter-cancelable-limit-smoke-01');
const BOUNDED_JSONL = path.join(ARTIFACT_DIR, 'bounded-broker-adapter-cancelable-limit-smoke.jsonl');
const REPORT_JSON = path.join(ARTIFACT_DIR, 'broker-adapter-cancelable-limit-smoke-report.json');
const REPORT_MD = path.join(ARTIFACT_DIR, 'broker-adapter-cancelable-limit-smoke-report.md');
const MEMO_PATH = path.join(REPO_ROOT, 'docs', 'research', 'qfa-612-broker-adapter-cancelable-limit-smoke-01.md');
const BACKLOG_PATH = path.join(REPO_ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const RUN_ID = makeRunId('run-qfa-612-broker-adapter-cancelable-limit-smoke-01');
const SESSION_ID = makeSessionId('session-qfa-612-broker-adapter-cancelable-limit-smoke-01');
const BASE_TS_NS = ns(BigInt(Date.now()) * 1_000_000n);
const TICK_SIZE = 0.25;
const NON_MARKETABLE_OFFSET_TICKS = 200;
const MAX_QUOTE_AGE_MS = 15 * 60 * 1000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface EnvResolution {
  readonly user: string;
  readonly password: string;
  readonly system_name: string;
  readonly gateway_url: string;
  readonly gateway_source: string;
  readonly rprotocol_home?: string;
  readonly env: NodeJS.ProcessEnv;
}

interface AccountEntry {
  readonly fcm_id?: string;
  readonly ib_id?: string;
  readonly account_id: string;
  readonly label?: string;
}

interface PriceContext {
  readonly source_path: string;
  readonly source_last_write_time: string;
  readonly ts_event_ns: string;
  readonly bid_px: number;
  readonly ask_px: number;
  readonly quote_age_ms: number;
  readonly limit_price: number;
}

function loadEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function normalizeSystemName(value: string): string {
  const trimmed = value.trim().replace(/^["']|["']$/g, '').trim();
  return trimmed.toLowerCase() === 'tradeify' ? 'Tradeify' : trimmed;
}

function resolveEnv(): EnvResolution {
  const dotenv = loadEnvFile(PRIMARY_ENV_PATH);
  const merged: NodeJS.ProcessEnv = { ...dotenv, ...process.env };
  const user = merged.RITHMIC_TEST_USERNAME ?? merged.RITHMIC_TEST_USER;
  const password = merged.RITHMIC_TEST_PASSWORD;
  const system = merged.RITHMIC_TEST_SYSTEM ?? merged.RITHMIC_TEST_SYSTEM_NAME;
  if (user === undefined || user.trim() === '') throw new Error('missing RITHMIC_TEST_USERNAME/RITHMIC_TEST_USER');
  if (password === undefined || password.trim() === '') throw new Error('missing RITHMIC_TEST_PASSWORD');
  if (system === undefined || system.trim() === '') throw new Error('missing RITHMIC_TEST_SYSTEM_NAME/RITHMIC_TEST_SYSTEM');
  const explicitGateway = merged.RITHMIC_TEST_GATEWAY_URL ?? merged.RITHMIC_TEST_WS_URL;
  if (explicitGateway === undefined || explicitGateway.trim() === '') {
    throw new Error('missing RITHMIC_TEST_GATEWAY_URL/RITHMIC_TEST_WS_URL for order-placement path');
  }
  const gatewayUrl = explicitGateway.trim();
  const gatewaySource = 'RITHMIC_TEST_GATEWAY_URL_OR_WS_URL';
  const pyPathParts = [path.join(REPO_ROOT, 'services'), REPO_ROOT];
  if (merged.PYTHONPATH !== undefined && merged.PYTHONPATH.trim() !== '') pyPathParts.push(merged.PYTHONPATH);
  const childEnv: NodeJS.ProcessEnv = {
    ...merged,
    PYTHONPATH: pyPathParts.join(path.delimiter),
    RITHMIC_LUCID_USER: user,
    RITHMIC_LUCID_PASSWORD: password,
    RITHMIC_LUCID_GATEWAY: gatewayUrl,
    RITHMIC_LUCID_CONNECT_POINT: gatewayUrl,
    RITHMIC_LUCID_SYSTEM_NAME: normalizeSystemName(system),
    QFA_BROKER_ADAPTER_KIND: 'rithmic',
    QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED: 'true',
  };
  if (merged.RITHMIC_RPROTOCOL_HOME !== undefined) {
    childEnv.RITHMIC_RPROTOCOL_HOME = merged.RITHMIC_RPROTOCOL_HOME;
  }
  return {
    user,
    password,
    system_name: normalizeSystemName(system),
    gateway_url: gatewayUrl,
    gateway_source: gatewaySource,
    rprotocol_home: merged.RITHMIC_RPROTOCOL_HOME,
    env: childEnv,
  };
}

function command(messageType: string, correlationId: string, payload: Record<string, unknown>, idempotencyKey?: string): Record<string, unknown> {
  return {
    schema_version: 1,
    message_type: messageType,
    direction: 'command',
    run_id: RUN_ID,
    session_id: SESSION_ID,
    correlation_id: correlationId,
    causation_id: 'operator',
    event_ts_ns: String(Date.now() * 1_000_000),
    adapter_version: 'qfa-612-broker-adapter-cancelable-limit-smoke-01',
    ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
    payload,
  };
}

async function discoverAccounts(env: NodeJS.ProcessEnv): Promise<{ readonly events: readonly Record<string, unknown>[]; readonly accounts: readonly AccountEntry[] }> {
  return await new Promise((resolve, reject) => {
    const python = process.env.PYTHON ?? 'python';
    const helper = `
import asyncio
import importlib.util
import json
import os
import pathlib
import sys

repo = pathlib.Path(${JSON.stringify(REPO_ROOT)}).resolve()
module_path = repo / "scripts" / "preflight" / "qfa-612-paper-01b" / "order_plant_client.py"
spec = importlib.util.spec_from_file_location("qfa612_order_plant_client", module_path)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

async def main():
    paths = mod.resolve_sdk_paths()
    modules = mod.load_modules(paths)
    uri = os.environ["RITHMIC_LUCID_GATEWAY"]
    system = os.environ["RITHMIC_LUCID_SYSTEM_NAME"]
    user = os.environ["RITHMIC_LUCID_USER"]
    password = os.environ["RITHMIC_LUCID_PASSWORD"]
    ctx = await mod.open_order_session(uri, paths, modules, system, user, password, "qfa612-adapter-account-discovery")
    try:
        info = await mod.login_info(ctx)
        account = await mod.list_accounts(ctx, info)
        ctx.account = account
        route = await mod.list_trade_routes(ctx, "CME")
        await mod.logout(ctx.ws, modules)
        await ctx.ws.close(1000, "qfa612-adapter-account-discovery-complete")
        print(json.dumps({"message_type": "account_discovery", "account": account, "trade_route": route}, sort_keys=True))
    finally:
        with mod.contextlib.suppress(Exception):
            await ctx.ws.close(1000, "qfa612-adapter-account-discovery-finally")

asyncio.run(main())
`;
    const child = spawn(python, ['-c', helper], {
      cwd: REPO_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('account discovery sidecar timeout'));
    }, 45_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdoutLines.push(...chunk.split(/\r?\n/).filter(Boolean)));
    child.stderr.on('data', (chunk: string) => stderrLines.push(...chunk.split(/\r?\n/).filter(Boolean)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`account discovery helper exited ${code}; stderr=${stderrLines.join(' | ')}`));
        return;
      }
      const events = stdoutLines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const discovery = events.find((event) => event.message_type === 'account_discovery');
      const accountRaw = record(discovery?.account);
      const accountsRaw = Object.keys(accountRaw).length === 0 ? [] : [accountRaw];
      const accounts = accountsRaw.map((item) => ({
        fcm_id: stringOrUndefined(item.fcm_id),
        ib_id: stringOrUndefined(item.ib_id),
        account_id: String(item.account_id ?? ''),
        label: stringOrUndefined(item.label),
      })).filter((account) => account.account_id.trim() !== '');
      resolve({ events, accounts });
    });
    child.stdin.end();
  });
}

function latestMbp1File(): string {
  const base = path.join('D:/Quant-futures-app/tools/rithmic_analytics/data/captures');
  const candidates: string[] = [];
  for (const day of readdirSync(base, { withFileTypes: true })) {
    if (!day.isDirectory()) continue;
    const candidate = path.join(base, day.name, 'MNQ_globex.mbp1.jsonl');
    if (existsSync(candidate)) candidates.push(candidate);
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (candidates.length === 0) throw new Error('no local MNQ mbp1 capture file found');
  return candidates[0]!;
}

function tailLines(filePath: string, maxBytes = 131_072): string[] {
  const stat = statSync(filePath);
  const length = Math.min(maxBytes, stat.size);
  const buffer = Buffer.alloc(length);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buffer, 0, length, stat.size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function priceContext(): PriceContext {
  const sourcePath = latestMbp1File();
  const lines = tailLines(sourcePath);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = JSON.parse(lines[i]!) as Record<string, unknown>;
    const bid = numberOrUndefined(parsed.bid_px_00);
    const ask = numberOrUndefined(parsed.ask_px_00);
    const ts = stringOrUndefined(parsed.ts_event_ns);
    if (bid === undefined || ask === undefined || ts === undefined || !Number.isFinite(bid) || !Number.isFinite(ask)) continue;
    const eventMs = Number(BigInt(ts) / 1_000_000n);
    const ageMs = Date.now() - eventMs;
    if (ageMs > MAX_QUOTE_AGE_MS) throw new Error(`latest local quote is stale: age_ms=${ageMs}`);
    const rawLimit = bid - NON_MARKETABLE_OFFSET_TICKS * TICK_SIZE;
    if (rawLimit <= 0) throw new Error('computed non-marketable limit price is not positive');
    const limit = Math.floor(rawLimit / TICK_SIZE) * TICK_SIZE;
    return {
      source_path: sourcePath,
      source_last_write_time: statSync(sourcePath).mtime.toISOString(),
      ts_event_ns: ts,
      bid_px: bid,
      ask_px: ask,
      quote_age_ms: ageMs,
      limit_price: limit,
    };
  }
  throw new Error('no finite bid/ask found in latest local mbp1 capture tail');
}

function makeIntent(accountId: string, limitPrice: number): OrderIntentEventEnvelope {
  const eventId = makeEventId('qfa612-adapter-cancelable-limit-smoke-intent-1');
  return createJournalEventEnvelope({
    event_id: eventId,
    type: 'ORDER_INTENT',
    ts_ns: BASE_TS_NS,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    causation_id: makeCausationId('qfa612-adapter-cancelable-limit-smoke-sizing-1'),
    payload: {
      order_intent_id: makeOrderIntentId('qfa612-adapter-cancelable-limit-smoke-order-1'),
      candidate_id: makeCandidateId('qfa612-adapter-cancelable-limit-smoke-candidate-1'),
      sizing_decision_id: makeSizingDecisionId('qfa612-adapter-cancelable-limit-smoke-sizing-1'),
      account_id: accountId,
      instrument_symbol: 'MNQM6',
      exchange: 'CME',
      side: 'buy' as const,
      order_type: 'limit' as const,
      quantity: 1,
      limit_price: limitPrice,
      time_in_force: 'day' as const,
    },
  });
}

function localTimestampSource(): () => UnixNs {
  let index = 0n;
  return () => ns(BigInt(Date.now()) * 1_000_000n + index++);
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(producer: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let current = producer();
  while (current === undefined && Date.now() < deadline) {
    await waitMs(100);
    current = producer();
  }
  return current;
}

async function main(): Promise<void> {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  mkdirSync(path.dirname(MEMO_PATH), { recursive: true });

  const envResolution = resolveEnv();
  const price = priceContext();
  let discovery: { readonly events: readonly Record<string, unknown>[]; readonly accounts: readonly AccountEntry[] };
  try {
    discovery = await discoverAccounts(envResolution.env);
  } catch (error: unknown) {
    writeBlockedAccountDiscoveryReport(envResolution, price, error);
    return;
  }
  if (discovery.accounts.length === 0) throw new Error('account discovery returned zero accounts');
  const selected = discovery.accounts[0]!;
  const allowlist = [{
    fcm_id: selected.fcm_id ?? 'RITHMIC_TEST_FCM_UNKNOWN',
    ib_id: selected.ib_id ?? 'RITHMIC_TEST_IB_UNKNOWN',
    account_id: selected.account_id,
    label: 'Rithmic Test order account discovered for QFA-612 smoke',
    max_position_contracts: 1,
    daily_loss_cap_usd: 100,
    max_session_duration_ms: 60_000,
    time_of_day_restriction: 'unrestricted',
  }];

  const events: AnyJournalEventEnvelope[] = [];
  const rawAdapterAckEvents: BrokerAckEnvelope[] = [];
  const submissionGate = new SubmissionGate();
  const adapter = new PythonBrokerAdapter({
    mode: 'paper',
    env: envResolution.env,
    boot_timeout_ms: 90_000,
    shutdown_timeout_ms: 10_000,
    heartbeat_timeout_ms: 60_000,
    submission_gate: submissionGate,
    live_account_allowlist: allowlist as never,
    account_list_verification_enabled: false,
  });
  const runtime = new BrokerAdapterRuntimeIntegration({
    adapter,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    submission_gate: submissionGate,
      event_sink: (event) => events.push(event),
    capture_local_timestamp_ns: localTimestampSource(),
    ack_timeout_policy: { enabled: false },
  });

  const intent = makeIntent(selected.account_id, price.limit_price);
  let submitResult: { readonly accepted: boolean; readonly broker_intent_correlation_id?: string } | undefined;
  let cancelResult: { readonly accepted: boolean } | undefined;
  let submitError: string | undefined;
  let cancel_path = 'not_attempted';
  let cleanup_cancel_accepted = false;
  const unsubscribeRawAck = adapter.subscribeAckEvents((event) => rawAdapterAckEvents.push(event));
  try {
    await runtime.start();
    try {
      submitResult = await runtime.handleOrderIntent(intent);
    } catch (error: unknown) {
      submitError = error instanceof Error ? error.message : String(error);
    }

    if (submitResult?.accepted === true || rawAdapterAckEvents.some((event) => event.type === 'ORDER_ACK_SUBMISSION')) {
      const runtimeSubmission = await waitFor(
        () => events.find((event) => event.type === 'ORDER_ACK_SUBMISSION'),
        5_000,
      );
      if (runtimeSubmission !== undefined) {
        cancel_path = 'runtime_request_cancel';
        cancelResult = await runtime.requestCancel({
          intent_id: intent.event_id,
          submission_ack_id: makeEventId(String(runtimeSubmission.payload.submission_ack_id)),
        });
      } else {
        const rawSubmission = rawAdapterAckEvents.find((event) => event.type === 'ORDER_ACK_SUBMISSION');
        const fallbackBrokerOrderId =
          rawSubmission?.payload.broker_order_id ?? String(intent.event_id);
        const fallbackAccountId =
          rawSubmission?.payload.broker_account_id ?? selected.account_id;
        const fallbackSubmissionAckId =
          rawSubmission?.payload.submission_ack_id ?? makeEventId(`fallback-submission-ack-${intent.event_id}`);
        cancel_path =
          rawSubmission === undefined ? 'adapter_request_cancel_fallback_intent_event_id' : 'adapter_request_cancel_raw_ack_lineage';
        cancelResult = await adapter.requestCancel({
          intent_id: intent.event_id,
          submission_ack_id: makeEventId(String(fallbackSubmissionAckId)),
          broker_order_id: fallbackBrokerOrderId,
          account_id: fallbackAccountId,
        });
      }
      cleanup_cancel_accepted = cancelResult.accepted;
      await waitFor(
        () =>
          events.find((event) => event.type === 'ORDER_ACK_CANCEL') ??
          rawAdapterAckEvents.find((event) => event.type === 'ORDER_ACK_CANCEL'),
        7_500,
      );
      await waitMs(1_000);
    }
  } finally {
    unsubscribeRawAck();
    await runtime.stop();
  }

  const counts = countEvents(events);
  const submissionEvents = events.filter((event) => event.type === 'ORDER_ACK_SUBMISSION');
  const cancelEvents = events.filter((event) => event.type === 'ORDER_ACK_CANCEL');
  const fillEvents = events.filter((event) => event.type === 'ORDER_ACK_FILL');
  const rejectEvents = events.filter((event) => event.type === 'ORDER_BROKER_REJECT' || event.type === 'VALIDATOR_ISSUE');
  const rawSubmissionEvents = rawAdapterAckEvents.filter((event) => event.type === 'ORDER_ACK_SUBMISSION');
  const rawCancelEvents = rawAdapterAckEvents.filter((event) => event.type === 'ORDER_ACK_CANCEL');
  const rawFillEvents = rawAdapterAckEvents.filter((event) => event.type === 'ORDER_ACK_FILL');
  const acceptedLike = submissionEvents.length;
  const cancelLike = cancelEvents.length;
  const allFillEvents = [...fillEvents, ...rawFillEvents];
  const netPositionDelta = allFillEvents.reduce((sum, event) => {
    const payload = record(event.payload);
    const signed = numberOrUndefined(payload.signed_quantity_delta) ?? 0;
    return sum + signed;
  }, 0);
  const pass =
    submitResult?.accepted === true &&
    cancelResult?.accepted === true &&
    acceptedLike >= 1 &&
    cancelLike >= 1 &&
    allFillEvents.length === 0 &&
    netPositionDelta === 0;
  const determination = pass
    ? DETERMINATION_PASS
    : cleanup_cancel_accepted && rawSubmissionEvents.length >= 1 && rawCancelEvents.length >= 1 && allFillEvents.length === 0
      ? DETERMINATION_BLOCKED_CLEANED
      : DETERMINATION_BLOCKED;
  const brokerOrderHash = firstString([...submissionEvents, ...rawSubmissionEvents].map((event) => record(event.payload).broker_order_id)).map(hash).at(0);
  const cancelBrokerOrderHash = firstString([...cancelEvents, ...rawCancelEvents].map((event) => record(event.payload).broker_order_id)).map(hash).at(0);

  const requestShape = {
    symbol: 'MNQM6',
    exchange: 'CME',
    side: 'BUY',
    quantity: 1,
    price_type: 'LIMIT',
    limit_price: price.limit_price,
    limit_basis: `BUY_LIMIT_${NON_MARKETABLE_OFFSET_TICKS}_TICKS_BELOW_LOCAL_BID`,
    local_bid_px: price.bid_px,
    local_ask_px: price.ask_px,
    account_id_hash: hash(selected.account_id),
  };

  const boundedRecords = [
    { record_type: 'RUN_MANIFEST', ticket: TICKET, determination, substrate: 'origin/main@4d21df3a41a5214e4ffd21027e401bdfe376079c' },
    {
      record_type: 'CREDENTIAL_BOUNDARY',
      order_credential_env_prefix: 'RITHMIC_TEST_*',
      child_sidecar_env_prefix: 'RITHMIC_LUCID_*',
      capture_credentials_touched: false,
      gateway_source: envResolution.gateway_source,
      system_name: envResolution.system_name,
      password_redacted: true,
      username_hash: hash(envResolution.user),
    },
    {
      record_type: 'ACCOUNT_DISCOVERY',
      account_list_status: 'PASS',
      account_discovery_method: 'PROTOCOL_LEVEL_QFA612_PREFLIGHT_ACCOUNT_LIST_NO_ORDER',
      discovered_account_count: discovery.accounts.length,
      selected_account_id_hash: hash(selected.account_id),
      selected_fcm_id_hash: selected.fcm_id === undefined ? null : hash(selected.fcm_id),
      selected_ib_id_hash: selected.ib_id === undefined ? null : hash(selected.ib_id),
      allowlist_entries: 1,
    },
    { record_type: 'PRICE_CONTEXT', ...price, source_path_hash: hash(price.source_path) },
    { record_type: 'ORDER_SUBMIT_REQUEST', request_sha256: hash(stableJson(requestShape)), ...requestShape },
    {
      record_type: 'BROKER_ADAPTER_RUNTIME_RESULT',
      submit_accepted: submitResult?.accepted ?? false,
      submit_error: submitError ?? null,
      cancel_accepted: cancelResult?.accepted ?? false,
      cancel_path,
      cleanup_cancel_accepted,
      counts,
      raw_adapter_ack_counts: countRawAckEvents(rawAdapterAckEvents),
      broker_order_id_hash: brokerOrderHash ?? null,
      cancel_broker_order_id_hash: cancelBrokerOrderHash ?? null,
      fill_event_count: allFillEvents.length,
      net_position_delta_observed_from_fill_events: netPositionDelta,
      reject_or_validator_issue_count: rejectEvents.length,
    },
    {
      record_type: 'AUTHORITY_LOCKS',
      production_account_used: false,
      live_trading_authority_created: false,
      phase_6_authority_created: false,
      roster_mutated: false,
      marketable_order_submitted: false,
      fill_target: false,
      automatic_shutdown_flattening: false,
      net_position_exposure_created: false,
    },
  ];

  const boundedJsonl = boundedRecords.map((record) => stableJson(record)).join('\n') + '\n';
  writeFileSync(BOUNDED_JSONL, boundedJsonl, 'utf8');

  const report = {
    ticket: TICKET,
    determination,
    worktree: REPO_ROOT,
    substrate: 'origin/main@4d21df3a41a5214e4ffd21027e401bdfe376079c',
    broker_scope: 'RITHMIC_TEST_BROKER_ADAPTER_CANCELABLE_LIMIT_SUBMIT_CANCEL_NO_FILL',
    credential_boundary: boundedRecords[1],
    account_boundary: boundedRecords[2],
    request: requestShape,
    runtime_result: boundedRecords[5],
    authority_locks: boundedRecords[6],
    output_hashes: {
      bounded_jsonl_lf_sha256: sha256Lf(boundedJsonl),
    },
    sanitized_event_counts: counts,
    sanitized_event_summaries: events.map(sanitizeJournalEvent),
    raw_adapter_ack_counts: countRawAckEvents(rawAdapterAckEvents),
    raw_adapter_ack_summaries: rawAdapterAckEvents.map(sanitizeRawAckEvent),
  };
  const reportJson = stableJson(report) + '\n';
  writeFileSync(REPORT_JSON, reportJson, 'utf8');
  const reportMd = markdownReport(report, price, selected, reportJson, boundedJsonl);
  writeFileSync(REPORT_MD, reportMd, 'utf8');
  writeFileSync(MEMO_PATH, memo(report, price, reportJson, boundedJsonl, reportMd), 'utf8');
  updateBacklog();

  console.log(JSON.stringify({
    state: 'PENDING_REVIEW',
    ticket: TICKET,
    determination,
    counts,
    fill_event_count: fillEvents.length,
    net_position_delta_observed_from_fill_events: netPositionDelta,
    bounded_jsonl_lf_sha256: sha256Lf(boundedJsonl),
    report_json_lf_sha256: sha256Lf(reportJson),
    report_md_lf_sha256: sha256Lf(reportMd),
    memo_lf_sha256: sha256Lf(readFileSync(MEMO_PATH, 'utf8')),
  }, null, 2));
}

function writeBlockedAccountDiscoveryReport(envResolution: EnvResolution, price: PriceContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const determination = message.includes("1067")
    ? DETERMINATION_BLOCKED_AUTH_INVALID_SYSTEM
    : DETERMINATION_BLOCKED;
  const boundedRecords = [
    { record_type: 'RUN_MANIFEST', ticket: TICKET, determination, substrate: 'origin/main@4d21df3a41a5214e4ffd21027e401bdfe376079c' },
    {
      record_type: 'CREDENTIAL_BOUNDARY',
      order_credential_env_prefix: 'RITHMIC_TEST_*',
      child_sidecar_env_prefix: 'RITHMIC_LUCID_*',
      capture_credentials_touched: false,
      gateway_source: envResolution.gateway_source,
      system_name: envResolution.system_name,
      password_redacted: true,
      username_hash: hash(envResolution.user),
    },
    {
      record_type: 'ORDER_PLANT_AUTH_BLOCK',
      account_discovery_status: 'FAILED_BEFORE_ACCOUNT_LIST',
      order_submit_attempted: false,
      cancel_required: false,
      rp_code_observed: message.includes("1067") ? ['1067', 'Rithmic System name received is invalid'] : null,
      failure_summary: redactErrorMessage(message),
    },
    { record_type: 'PRICE_CONTEXT', ...price, source_path_hash: hash(price.source_path) },
    {
      record_type: 'BROKER_ADAPTER_RUNTIME_RESULT',
      submit_accepted: false,
      cancel_accepted: false,
      cancel_path: 'not_attempted_auth_block',
      cleanup_cancel_accepted: false,
      counts: {},
      raw_adapter_ack_counts: {},
      broker_order_id_hash: null,
      cancel_broker_order_id_hash: null,
      fill_event_count: 0,
      net_position_delta_observed_from_fill_events: 0,
      reject_or_validator_issue_count: 0,
    },
    {
      record_type: 'AUTHORITY_LOCKS',
      production_account_used: false,
      live_trading_authority_created: false,
      phase_6_authority_created: false,
      roster_mutated: false,
      marketable_order_submitted: false,
      fill_target: false,
      automatic_shutdown_flattening: false,
      net_position_exposure_created: false,
    },
  ];
  const boundedJsonl = boundedRecords.map((record) => stableJson(record)).join('\n') + '\n';
  writeFileSync(BOUNDED_JSONL, boundedJsonl, 'utf8');
  const report = {
    ticket: TICKET,
    determination,
    worktree: REPO_ROOT,
    substrate: 'origin/main@4d21df3a41a5214e4ffd21027e401bdfe376079c',
    broker_scope: 'RITHMIC_TEST_BROKER_ADAPTER_CANCELABLE_LIMIT_SUBMIT_CANCEL_NO_FILL',
    credential_boundary: boundedRecords[1],
    account_boundary: boundedRecords[2],
    request: {
      symbol: 'MNQM6',
      exchange: 'CME',
      side: 'buy' as const,
      quantity: 1,
      price_type: 'LIMIT',
      limit_basis: `BUY_LIMIT_${NON_MARKETABLE_OFFSET_TICKS}_TICKS_BELOW_LOCAL_BID`,
      limit_price: price.limit_price,
      local_bid_px: price.bid_px,
      local_ask_px: price.ask_px,
    },
    runtime_result: boundedRecords[4],
    authority_locks: boundedRecords[5],
    output_hashes: { bounded_jsonl_lf_sha256: sha256Lf(boundedJsonl) },
  };
  const reportJson = stableJson(report) + '\n';
  writeFileSync(REPORT_JSON, reportJson, 'utf8');
  const reportMd =
    `# ${TICKET}\n\n` +
    `## Determination\n\n\`\`\`text\n${determination}\n\`\`\`\n\n` +
    `## Result\n\nORDER_PLANT account discovery failed before any submit/cancel action.\n\n` +
    `\`\`\`text\nrp_code = ${message.includes("1067") ? '["1067", "Rithmic System name received is invalid"]' : 'not parsed'}\norder_submit_attempted = false\ncancel_required = false\nfill_event_count = 0\nnet_position_delta_observed_from_fill_events = 0\n\`\`\`\n\n` +
    `## Boundary\n\nRITHMIC_TEST_* order-placement credentials were used process-locally. Capture credentials were not modified. No production account, live authority, Phase 6 authority, roster mutation, marketable order, fill target, automatic shutdown flattening, or net position exposure was created.\n\n` +
    `## Output hashes\n\n\`\`\`text\nbounded_jsonl_lf_sha256 = ${sha256Lf(boundedJsonl)}\nreport_json_lf_sha256 = ${sha256Lf(reportJson)}\n\`\`\`\n`;
  writeFileSync(REPORT_MD, reportMd, 'utf8');
  writeFileSync(
    MEMO_PATH,
    `# ${TICKET}\n\nSTATE: PENDING-REVIEW\n\nDetermination: \`${determination}\`.\n\nORDER_PLANT auth/account discovery failed before submit with the recorded invalid-system blocker. No order was submitted, no cancel was required, no fill occurred, and no broker/live/Phase 6/roster authority was created.\n\n`,
    'utf8',
  );
  updateBacklog();
  console.log(JSON.stringify({
    state: 'PENDING_REVIEW',
    ticket: TICKET,
    determination,
    order_submit_attempted: false,
    cancel_required: false,
    fill_event_count: 0,
    net_position_delta_observed_from_fill_events: 0,
    bounded_jsonl_lf_sha256: sha256Lf(boundedJsonl),
    report_json_lf_sha256: sha256Lf(reportJson),
    report_md_lf_sha256: sha256Lf(reportMd),
    memo_lf_sha256: sha256Lf(readFileSync(MEMO_PATH, 'utf8')),
  }, null, 2));
}

function redactErrorMessage(value: string): string {
  return value
    .replace(/RITHMIC_TEST_PASSWORD=[^\s|]+/g, 'RITHMIC_TEST_PASSWORD=[REDACTED]')
    .replace(/RITHMIC_LUCID_PASSWORD=[^\s|]+/g, 'RITHMIC_LUCID_PASSWORD=[REDACTED]');
}

function sanitizeJournalEvent(event: AnyJournalEventEnvelope): Record<string, Json> {
  const payload = record(event.payload);
  return {
    type: event.type,
    event_id: String(event.event_id),
    broker_order_id_hash: typeof payload.broker_order_id === 'string' ? hash(payload.broker_order_id) : null,
    broker_account_id_hash: typeof payload.broker_account_id === 'string' ? hash(payload.broker_account_id) : null,
    intent_id: typeof payload.intent_id === 'string' ? payload.intent_id : null,
    submission_ack_id: typeof payload.submission_ack_id === 'string' ? payload.submission_ack_id : null,
    fill_kind: typeof payload.fill_kind === 'string' ? payload.fill_kind : null,
    cancel_reason: typeof payload.cancel_reason === 'string' ? payload.cancel_reason : null,
    validator_code: typeof payload.code === 'string' ? payload.code : null,
  };
}

function countEvents(events: readonly AnyJournalEventEnvelope[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

function countRawAckEvents(events: readonly BrokerAckEnvelope[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

function sanitizeRawAckEvent(event: BrokerAckEnvelope): Record<string, Json> {
  const payload = record(event.payload);
  return {
    type: event.type,
    broker_order_id_hash: typeof payload.broker_order_id === 'string' ? hash(payload.broker_order_id) : null,
    broker_account_id_hash: typeof payload.broker_account_id === 'string' ? hash(payload.broker_account_id) : null,
    intent_id: typeof payload.intent_id === 'string' ? payload.intent_id : null,
    submission_ack_id: typeof payload.submission_ack_id === 'string' ? payload.submission_ack_id : null,
    cancel_ack_id: typeof payload.cancel_ack_id === 'string' ? payload.cancel_ack_id : null,
    fill_ack_id: typeof payload.fill_ack_id === 'string' ? payload.fill_ack_id : null,
  };
}

function markdownReport(report: Record<string, unknown>, price: PriceContext, account: AccountEntry, reportJson: string, boundedJsonl: string): string {
  const result = record(report.runtime_result);
  return `# ${TICKET}\n\n` +
    `## Determination\n\n\`\`\`text\n${report.determination}\n\`\`\`\n\n` +
    `## Broker adapter smoke result\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| submit accepted | ${String(result.submit_accepted)} |\n` +
    `| cancel accepted | ${String(result.cancel_accepted)} |\n` +
    `| fill_event_count | ${String(result.fill_event_count)} |\n` +
    `| net_position_delta_observed_from_fill_events | ${String(result.net_position_delta_observed_from_fill_events)} |\n` +
    `| selected account hash | ${hash(account.account_id)} |\n` +
    `| local bid/ask | ${price.bid_px} / ${price.ask_px} |\n` +
    `| limit price | ${price.limit_price} |\n\n` +
    `## Boundary\n\n` +
    `- Uses RITHMIC_TEST_* order-placement credentials only.\n` +
    `- Maps to RITHMIC_LUCID_* only inside the broker sidecar process.\n` +
    `- Capture credentials were not modified and are not broker fallback.\n` +
    `- Production account use, live trading authority, Phase 6 authority, and roster mutation remain false.\n` +
    `- Non-marketable BUY LIMIT only; no fill target; cancel required.\n\n` +
    `## Output hashes\n\n\`\`\`text\nbounded_jsonl_lf_sha256 = ${sha256Lf(boundedJsonl)}\nreport_json_lf_sha256 = ${sha256Lf(reportJson)}\n\`\`\`\n`;
}

function memo(report: Record<string, unknown>, price: PriceContext, reportJson: string, boundedJsonl: string, reportMd: string): string {
  const result = record(report.runtime_result);
  return `# ${TICKET}\n\n` +
    `STATE: PENDING-REVIEW\n\n` +
    `## Determination\n\n\`\`\`text\n${report.determination}\n\`\`\`\n\n` +
    `## Scope\n\n` +
    `Ran a bounded Rithmic Test broker-adapter cancelable-limit smoke through PythonBrokerAdapter and BrokerAdapterRuntimeIntegration.\n\n` +
    `## Evidence\n\n` +
    `- submit accepted: ${String(result.submit_accepted)}\n` +
    `- cancel accepted: ${String(result.cancel_accepted)}\n` +
    `- fill_event_count: ${String(result.fill_event_count)}\n` +
    `- net_position_delta_observed_from_fill_events: ${String(result.net_position_delta_observed_from_fill_events)}\n` +
    `- local quote source hash: ${hash(price.source_path)}\n` +
    `- limit price: ${price.limit_price}\n\n` +
    `## Authority caveat\n\n` +
    `No production account use, no live trading authority, no Phase 6 authority, no roster mutation, no marketable order authority, no fill target, no automatic shutdown flattening authority, and no net position exposure created.\n\n` +
    `## Output hashes\n\n\`\`\`text\nbounded_jsonl_lf_sha256 = ${sha256Lf(boundedJsonl)}\nreport_json_lf_sha256 = ${sha256Lf(reportJson)}\nreport_md_lf_sha256 = ${sha256Lf(reportMd)}\n\`\`\`\n`;
}

function updateBacklog(): void {
  const row = 'QFA-612-BROKER-ADAPTER-CANCELABLE-LIMIT-SMOKE-01,P1,1.0,QFA-612-BROKER-ADAPTER-CANCELABLE-LIMIT-INTEGRATION-IMPL-01,Run bounded Rithmic Test broker adapter submit cancel smoke through PythonBrokerAdapter with non-marketable limit order no fill net flat and no live Phase 6 roster authority,broker_order_plant_lifecycle';
  const existing = existsSync(BACKLOG_PATH) ? readFileSync(BACKLOG_PATH, 'utf8') : '';
  if (existing.includes('QFA-612-BROKER-ADAPTER-CANCELABLE-LIMIT-SMOKE-01')) return;
  const next = existing.endsWith('\n') || existing.length === 0 ? existing + row + '\n' : existing + '\n' + row + '\n';
  writeFileSync(BACKLOG_PATH, next, 'utf8');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), jsonReplacer);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) result[key] = sortJson(entryValue);
    return result;
  }
  return value;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function sha256Lf(text: string): string {
  return hash(text.replace(/\r\n/g, '\n'));
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeEvent(value: Record<string, unknown>): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const payload = record(cloned.payload);
  for (const key of ['account_id', 'broker_account_id', 'user', 'username', 'password']) {
    if (typeof payload[key] === 'string') payload[key] = `${key}_hash:${hash(payload[key])}`;
  }
  return cloned;
}

function firstString(values: readonly unknown[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
