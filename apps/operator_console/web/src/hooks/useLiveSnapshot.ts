import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { createUnavailableSnapshot } from '../lib/console-state.js';
import type { ConsoleSnapshot } from '../../../server/src/types/snapshot.js';

export type LiveSnapshotStatus = 'loading' | 'ready' | 'unavailable';

export interface LiveSnapshotState {
  readonly snapshot: ConsoleSnapshot;
  readonly status: LiveSnapshotStatus;
  readonly error_message: string | null;
  readonly reload: () => void;
  readonly setSnapshot: Dispatch<SetStateAction<ConsoleSnapshot>>;
}

export interface LiveSnapshotOptions {
  readonly base_url?: string;
  readonly headers?: HeadersInit;
}

const SERVER_UNAVAILABLE = 'operator console server unavailable';

export function useLiveSnapshot(options: LiveSnapshotOptions = {}): LiveSnapshotState {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot>(() => createUnavailableSnapshot(SERVER_UNAVAILABLE));
  const [status, setStatus] = useState<LiveSnapshotStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadIndex, setReloadIndex] = useState(0);

  const reload = useCallback(() => {
    setReloadIndex((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const snapshotUrl = endpointUrl(options.base_url ?? consoleHttpBase(), '/snapshot');
    setStatus('loading');
    setErrorMessage(null);

    void fetch(snapshotUrl, {
      headers: options.headers,
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`snapshot request failed: ${response.status}`);
        }
        return await response.json() as ConsoleSnapshot;
      })
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setSnapshot(createUnavailableSnapshot(message));
        setStatus('unavailable');
        setErrorMessage(message);
      });

    return () => controller.abort();
  }, [options.base_url, options.headers, reloadIndex]);

  return {
    snapshot,
    status,
    error_message: errorMessage,
    reload,
    setSnapshot,
  };
}

export function consoleHttpBase(): string {
  return import.meta.env.VITE_OPERATOR_CONSOLE_API_BASE ?? window.location.origin;
}

export function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}
