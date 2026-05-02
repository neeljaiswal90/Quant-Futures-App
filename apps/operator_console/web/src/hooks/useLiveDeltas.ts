import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  applyConsoleStreamFrame,
  isConsoleStreamFrame,
} from '../lib/console-state.js';
import { consoleHttpBase, endpointUrl } from './useLiveSnapshot.js';
import type { ConsoleSnapshot } from '../../../server/src/types/snapshot.js';
import type { ConsoleStreamFrame } from '../../../server/src/types/delta.js';

export type LiveDeltaStatus =
  | 'disabled'
  | 'connecting'
  | 'open'
  | 'resync_required'
  | 'reconnecting'
  | 'closed'
  | 'unavailable';

export interface LiveDeltaState {
  readonly status: LiveDeltaStatus;
  readonly last_seq: string | null;
  readonly resync_required: boolean;
  readonly error_message: string | null;
}

export interface LiveDeltaOptions {
  readonly enabled: boolean;
  readonly setSnapshot: Dispatch<SetStateAction<ConsoleSnapshot>>;
  readonly reloadSnapshot?: () => void;
  readonly ws_url?: string;
  readonly reconnect_initial_delay_ms?: number;
  readonly reconnect_max_delay_ms?: number;
}

const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5_000;

export function useLiveDeltas(options: LiveDeltaOptions): LiveDeltaState {
  const [status, setStatus] = useState<LiveDeltaStatus>(options.enabled ? 'connecting' : 'disabled');
  const [lastSeq, setLastSeq] = useState<string | null>(null);
  const [resyncRequired, setResyncRequired] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const lastSeqRef = useRef<string | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!options.enabled) {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptRef.current = 0;
      setStatus('disabled');
      return;
    }

    if (typeof WebSocket === 'undefined') {
      setStatus('unavailable');
      setErrorMessage('WebSocket is unavailable in this browser');
      return;
    }

    let disposed = false;
    const ws = new WebSocket(options.ws_url ?? consoleWsUrl());
    setStatus('connecting');
    setErrorMessage(null);

    ws.addEventListener('open', () => {
      reconnectAttemptRef.current = 0;
      setStatus('open');
    });

    ws.addEventListener('message', (message) => {
      try {
        const parsed = parseConsoleStreamMessage(message.data);
        options.setSnapshot((current) => {
          const result = applyConsoleStreamFrame(current, lastSeqRef.current, parsed);
          lastSeqRef.current = result.last_seq;
          setLastSeq(result.last_seq);
          setResyncRequired(result.resync_required);
          setStatus(result.resync_required ? 'resync_required' : 'open');
          return result.snapshot;
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        setStatus('unavailable');
        setErrorMessage(messageText);
      }
    });

    ws.addEventListener('close', () => {
      if (disposed) {
        return;
      }

      const retryDelayMs = reconnectDelayMs(
        reconnectAttemptRef.current,
        options.reconnect_initial_delay_ms,
        options.reconnect_max_delay_ms,
      );
      reconnectAttemptRef.current += 1;
      setStatus((current) => current === 'resync_required' ? current : 'reconnecting');
      setErrorMessage(`WebSocket stream closed; reconnecting in ${retryDelayMs}ms`);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        options.reloadSnapshot?.();
        setConnectionAttempt((current) => current + 1);
      }, retryDelayMs);
    });

    ws.addEventListener('error', () => {
      setStatus('reconnecting');
      setErrorMessage('WebSocket stream failed');
    });

    return () => {
      disposed = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      ws.close();
    };
  }, [
    connectionAttempt,
    options.enabled,
    options.reloadSnapshot,
    options.reconnect_initial_delay_ms,
    options.reconnect_max_delay_ms,
    options.setSnapshot,
    options.ws_url,
  ]);

  return {
    status,
    last_seq: lastSeq,
    resync_required: resyncRequired,
    error_message: errorMessage,
  };
}

export function consoleWsUrl(): string {
  const explicit = import.meta.env.VITE_OPERATOR_CONSOLE_WS_URL;
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const snapshotBase = consoleHttpBase();
  const streamUrl = endpointUrl(snapshotBase, '/stream');
  return streamUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}

export function reconnectDelayMs(
  attempt: number,
  initialDelayMs = DEFAULT_RECONNECT_INITIAL_DELAY_MS,
  maxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
): number {
  const sanitizedAttempt = Math.max(0, Math.floor(attempt));
  const sanitizedInitial = Math.max(1, Math.floor(initialDelayMs));
  const sanitizedMax = Math.max(sanitizedInitial, Math.floor(maxDelayMs));
  return Math.min(sanitizedInitial * (2 ** sanitizedAttempt), sanitizedMax);
}

export function parseConsoleStreamMessage(data: unknown): ConsoleStreamFrame {
  if (typeof data !== 'string') {
    throw new Error('binary stream frames are unsupported');
  }
  const parsed = JSON.parse(data) as unknown;
  if (!isConsoleStreamFrame(parsed)) {
    throw new Error('stream frame shape is invalid');
  }
  return parsed;
}
