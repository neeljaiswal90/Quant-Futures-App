import { createHash, type Hash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export const STREAM_CHUNK_BYTES = 1024 * 1024;

export function sha256File(path: string): string {
  const digest = createHash('sha256');
  forEachFileChunk(path, (bytes) => {
    digest.update(bytes);
  });
  return digest.digest('hex');
}

export function forEachJsonlLine(
  path: string,
  callback: (line: string) => void,
  options: {
    readonly digest?: Hash;
    readonly chunkBytes?: number;
  } = {},
): void {
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  forEachFileChunk(
    path,
    (bytes) => {
      options.digest?.update(bytes);
      const text = remainder + decoder.write(bytes);
      const lines = text.split(/\r?\n/u);
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        callback(line);
      }
    },
    options.chunkBytes,
  );
  const finalText = remainder + decoder.end();
  if (finalText !== '') {
    callback(finalText);
  }
}

function forEachFileChunk(path: string, callback: (bytes: Buffer) => void, chunkBytes = STREAM_CHUNK_BYTES): void {
  const fd = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(chunkBytes);
  try {
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      callback(chunk.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
}
