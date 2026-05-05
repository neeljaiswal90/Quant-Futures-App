/**
 * Error surface for DBN parsing and streaming load failures.
 *
 * Mirrors the existing ConfigValidationError pattern: stable shape, explicit
 * context fields, and a preformatted message suitable for test assertions and
 * operator diagnostics.
 */

export interface DbnFormatErrorArgs {
  readonly filePath: string;
  readonly byteOffset: number;
  readonly message?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export class DbnFormatError extends Error {
  public readonly filePath: string;
  public readonly byteOffset: number;
  public readonly expected?: string;
  public readonly actual?: string;

  constructor(args: DbnFormatErrorArgs) {
    const detailParts = [
      `path=${args.filePath}`,
      `offset=${args.byteOffset}`,
      args.expected === undefined ? undefined : `expected=${args.expected}`,
      args.actual === undefined ? undefined : `actual=${args.actual}`,
    ].filter((value): value is string => value !== undefined);
    super(`${args.message ?? 'Invalid DBN payload'} (${detailParts.join(', ')})`);
    this.name = 'DbnFormatError';
    this.filePath = args.filePath;
    this.byteOffset = args.byteOffset;
    this.expected = args.expected;
    this.actual = args.actual;
  }
}
