import { describe, expect, it } from 'vitest';
import { AnsiFrameDiffer } from '../../src/operator/console/ansi-renderer.js';

describe('AnsiFrameDiffer', () => {
  it('returns a full paint with a terminal reset for the first render', () => {
    const differ = new AnsiFrameDiffer();

    const result = differ.render(['alpha', 'beta']);

    expect(result.is_full_paint).toBe(true);
    expect(result.ansi).toContain('\u001bc');
    expect(result.ansi).toBe('\u001bcalpha\nbeta');
  });

  it('returns empty output without a terminal reset for identical second render', () => {
    const differ = new AnsiFrameDiffer();
    differ.render(['alpha', 'beta']);

    const result = differ.render(['alpha', 'beta']);

    expect(result.is_full_paint).toBe(false);
    expect(result.ansi).not.toContain('\u001bc');
    expect(result.ansi).toBe('');
  });

  it('returns only the changed row with cursor positioning and line clear', () => {
    const differ = new AnsiFrameDiffer();
    differ.render(['alpha', 'beta', 'gamma']);

    const result = differ.render(['alpha', 'BETA', 'gamma']);

    expect(result.is_full_paint).toBe(false);
    expect(result.ansi).not.toContain('\u001bc');
    expect(result.ansi).toContain('\u001b[2;1H\u001b[2KBETA');
    expect(result.ansi).toBe('\u001b[2;1H\u001b[2KBETA');
  });

  it('forceFullPaint triggers a full paint on the next render', () => {
    const differ = new AnsiFrameDiffer();
    differ.render(['alpha']);
    differ.forceFullPaint();

    const result = differ.render(['alpha']);

    expect(result.is_full_paint).toBe(true);
    expect(result.ansi).toContain('\u001bc');
    expect(result.ansi).toBe('\u001bcalpha');
  });
});
