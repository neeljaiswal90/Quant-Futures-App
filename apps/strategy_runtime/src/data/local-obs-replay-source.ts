import { existsSync, readFileSync } from 'node:fs';
import {
  createJournalEventEnvelope,
  journalEventFromJsonLine,
  makeEventId,
  ns,
  validateJournalEventEnvelope,
  type AnyJournalEventEnvelope,
  type JournalEventEnvelope,
  type JournalEventPayloadFor,
  type RunId,
  type SessionId,
  type UnixNs,
} from '../contracts/index.js';

export type LocalObsReplayPaceMode = 'realtime' | 'as_fast_as_possible';

export interface LocalObsReplaySourceOptions {
  readonly path: string;
  readonly run_id: RunId;
  readonly session_id: SessionId;
  readonly pace_mode?: LocalObsReplayPaceMode;
  readonly event_sink: (event: AnyJournalEventEnvelope) => void | Promise<void>;
}

type LocalObsEvent =
  | JournalEventEnvelope<'QUOTE', JournalEventPayloadFor<'QUOTE'>>
  | JournalEventEnvelope<'TRADE', JournalEventPayloadFor<'TRADE'>>;

export class LocalObsReplaySource {
  private readonly path: string;
  private readonly runId: RunId;
  private readonly sessionId: SessionId;
  private readonly paceMode: LocalObsReplayPaceMode;
  private readonly eventSink: (event: AnyJournalEventEnvelope) => void | Promise<void>;
  private completion: Promise<void> | undefined;
  private stopping = false;
  private sequence = 0;

  constructor(options: LocalObsReplaySourceOptions) {
    this.path = options.path;
    this.runId = options.run_id;
    this.sessionId = options.session_id;
    this.paceMode = options.pace_mode ?? 'realtime';
    this.eventSink = options.event_sink;
  }

  async start(): Promise<void> {
    if (this.completion !== undefined) {
      return this.paceMode === 'as_fast_as_possible' ? this.completion : undefined;
    }
    this.assertReadablePath();
    this.stopping = false;
    this.completion = this.replay();
    if (this.paceMode === 'as_fast_as_possible') {
      await this.completion;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.completion;
  }

  async done(): Promise<void> {
    await this.completion;
  }

  private assertReadablePath(): void {
    if (this.path.trim() === '') {
      throw new Error('QFA_PAPER_LOCAL_OBS_PATH must be a non-empty path when market_data_source=local_obs_replay');
    }
    if (!existsSync(this.path)) {
      throw new Error(`QFA_PAPER_LOCAL_OBS_PATH does not exist: ${this.path}`);
    }
    try {
      readFileSync(this.path, { encoding: 'utf8' });
    } catch (error) {
      throw new Error(`QFA_PAPER_LOCAL_OBS_PATH is not readable: ${this.path}: ${messageFrom(error)}`);
    }
  }

  private async replay(): Promise<void> {
    const text = readFileSync(this.path, 'utf8');
    let previousTsNs: UnixNs | undefined;
    let lineNumber = 0;
    for (const line of text.split(/\r?\n/u)) {
      lineNumber += 1;
      if (this.stopping) {
        return;
      }
      if (line.trim() === '') {
        continue;
      }
      const event = this.parseLine(line, lineNumber);
      if (event === undefined) {
        continue;
      }
      if (this.paceMode === 'realtime' && previousTsNs !== undefined) {
        await sleep(deltaMs(previousTsNs, event.ts_ns));
      }
      previousTsNs = event.ts_ns;
      await Promise.resolve(this.eventSink(this.rewriteEvent(event)));
    }
  }

  private parseLine(line: string, lineNumber: number): LocalObsEvent | undefined {
    let event: AnyJournalEventEnvelope;
    try {
      event = journalEventFromJsonLine(line) as AnyJournalEventEnvelope;
    } catch (error) {
      throw new Error(`malformed local OBS JSONL at ${this.path}:${lineNumber}: ${messageFrom(error)}`);
    }
    const validation = validateJournalEventEnvelope(event);
    if (validation.issues.length > 0) {
      throw new Error(
        `invalid local OBS event at ${this.path}:${lineNumber}: ${validation.issues
          .map((issue) => `${issue.path} ${issue.code} ${issue.message}`)
          .join('; ')}`,
      );
    }
    if (event.type !== 'QUOTE' && event.type !== 'TRADE') {
      return undefined;
    }
    return event as LocalObsEvent;
  }

  private rewriteEvent(event: LocalObsEvent): AnyJournalEventEnvelope {
    if (event.type === 'QUOTE') {
      const payload = normalizeQuotePayload(event.payload);
      return createJournalEventEnvelope({
        event_id: makeEventId(`local-obs-quote-${++this.sequence}`),
        type: 'QUOTE',
        ts_ns: event.ts_ns,
        run_id: this.runId,
        session_id: this.sessionId,
        ...(event.correlation_id === undefined ? {} : { correlation_id: event.correlation_id }),
        ...(event.causation_id === undefined ? {} : { causation_id: event.causation_id }),
        payload,
      }) as AnyJournalEventEnvelope;
    }
    const payload = normalizeTradePayload(event.payload);
    return createJournalEventEnvelope({
      event_id: makeEventId(`local-obs-trade-${++this.sequence}`),
      type: 'TRADE',
      ts_ns: event.ts_ns,
      run_id: this.runId,
      session_id: this.sessionId,
      ...(event.correlation_id === undefined ? {} : { correlation_id: event.correlation_id }),
      ...(event.causation_id === undefined ? {} : { causation_id: event.causation_id }),
      payload,
    }) as AnyJournalEventEnvelope;
  }
}

function normalizeQuotePayload(payload: JournalEventPayloadFor<'QUOTE'>): JournalEventPayloadFor<'QUOTE'> {
  const raw = payload as JournalEventPayloadFor<'QUOTE'> & { readonly tick_ts_ns?: UnixNs };
  return {
    exchange_event_ts_ns: raw.exchange_event_ts_ns ?? raw.tick_ts_ns,
    sidecar_recv_ts_ns: raw.sidecar_recv_ts_ns,
    ...(raw.rithmic_publish_ts_ns === undefined ? {} : { rithmic_publish_ts_ns: raw.rithmic_publish_ts_ns }),
    bid_px: raw.bid_px,
    bid_qty: raw.bid_qty,
    ask_px: raw.ask_px,
    ask_qty: raw.ask_qty,
    ...(raw.authority === undefined ? {} : { authority: raw.authority }),
  };
}

function normalizeTradePayload(payload: JournalEventPayloadFor<'TRADE'>): JournalEventPayloadFor<'TRADE'> {
  const raw = payload as JournalEventPayloadFor<'TRADE'> & { readonly tick_ts_ns?: UnixNs };
  return {
    exchange_event_ts_ns: raw.exchange_event_ts_ns ?? raw.tick_ts_ns,
    sidecar_recv_ts_ns: raw.sidecar_recv_ts_ns,
    ...(raw.rithmic_publish_ts_ns === undefined ? {} : { rithmic_publish_ts_ns: raw.rithmic_publish_ts_ns }),
    ...(raw.trade_id === undefined ? {} : { trade_id: raw.trade_id }),
    price: raw.price,
    quantity: raw.quantity,
    aggressor_side: raw.aggressor_side,
  };
}

function deltaMs(previousTsNs: UnixNs, currentTsNs: UnixNs): number {
  const deltaNs = BigInt(currentTsNs) - BigInt(previousTsNs);
  if (deltaNs <= 0n) {
    return 0;
  }
  const ms = Number(deltaNs / 1_000_000n);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

