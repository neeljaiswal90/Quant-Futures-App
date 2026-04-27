import { closeSync, openSync, readSync } from 'node:fs';

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

export function forEachJsonlLine(
  path: string,
  callback: (line: string, lineNumber: number) => void,
  chunkBytes = DEFAULT_CHUNK_BYTES,
): void {
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(chunkBytes);
  let carry = '';
  let lineNumber = 0;

  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }

      const chunk = carry + buffer.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split(/\r?\n/);
      carry = lines.pop() ?? '';

      for (const line of lines) {
        lineNumber += 1;
        const trimmed = line.trim();
        if (trimmed !== '') {
          callback(trimmed, lineNumber);
        }
      }
    }

    const trimmedCarry = carry.trim();
    if (trimmedCarry !== '') {
      lineNumber += 1;
      callback(trimmedCarry, lineNumber);
    }
  } finally {
    closeSync(fd);
  }
}

export function parseJsonlLine(line: string, lineNumber: number, label: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(
      `${label} line ${lineNumber}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
