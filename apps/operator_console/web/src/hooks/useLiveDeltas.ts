import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  applyConsoleStreamFrame,
  isConsoleStreamFrame,
} from '../lib/console-state.js';
import { consoleHttpBase, endpointUrl } from './useLiveSnapshot.js';
import type { ConsoleSnapshot } from '../../../server/src/types/snapshot.js';

export type LiveDeltaStatus = 'disabled' | 'connecting' | 'open' | 'resync_required' | 'closed' | 'unavailable';

export interface LiveDeltaState {
  readonly status: LiveDeltaStatus;
  readonly last_seq: string | null;
  readonly resync_required: boolean;
  readonly error_message: string | null;
}

export interface LiveDeltaOptions {
  readonly enabled: boolean;
  readonly setSnapshot: Dispatch<SetStateAction<ConsoleSnapshot>>;
  readonly ws_url?: string;
}

export function useLiveDeltas(options: LiveDeltaOptions): LiveDeltaState {
  const [status, setStatus] = useState<LiveDeltaStatus>(options.enabled ? 'connecting' : 'disabled');
  const [lastSeq, setLastSeq] = useState<string | null>(null);
  const [resyncRequired, setResyncRequired] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const lastSeqRef = useRef<string | null>(null);

  useEffect(() => {
    if (!options.enabled) {
      setStatus('disabled');
      return;
    }

    if (typeof WebSocket === 'undefined') {
      setStatus('unavailable');
      setErrorMessage('WebSocket is unavailable in this browser');
      return;
    }

    const ws = new WebSocket(options.ws_url ?? consoleWsUrl());
    setStatus('connecting');
    setErrorMessage(null);

    ws.addEventListener('open', () => {
      setStatus('open');
    });

    ws.addEventListener('message', (message) => {
      try {
        const parsed = JSON.parse(String(message.data)) as unknown;
        if (!isConsoleStreamFrame(parsed)) {
          throw new Error('stream frame shape is invalid');
        }
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
      setStatus((current) => current === 'resync_required' ? current : 'closed');
    });

    ws.addEventListener('error', () => {
      setStatus('unavailable');
      setErrorMessage('WebSocket stream failed');
    });

    return () => {
      ws.close();
    };
  }, [options.enabled, options.setSnapshot, options.ws_url]);

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
