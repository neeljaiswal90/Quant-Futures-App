import { describe, expect, it } from 'vitest';
import { buildExecutionCapabilityMask } from '../../../src/execution/execution-capability-mask.js';
import {
  PythonMaskExportTimeoutError,
  TsPythonParityValidator,
} from '../../../src/execution/validators/ts-python-parity.js';

describe('EXEC-VALIDATOR-08 TS/Python mask parity', () => {
  it('accepts a mocked Python mask that matches the TS mask', () => {
    const validator = new TsPythonParityValidator({
      pythonMaskExporter: () => JSON.stringify(buildExecutionCapabilityMask()),
    });

    expect(validator.runOnPeriodicCadence({ session_id: 'session-1' })).toEqual([]);
  });

  it('flags structural parity mismatches from the mocked Python export', () => {
    const validator = new TsPythonParityValidator({
      pythonMaskExporter: () => JSON.stringify({ ...buildExecutionCapabilityMask(), mask_hash: 'sha256:python' }),
    });

    expect(validator.runOnPeriodicCadence({ session_id: 'session-1' })).toContainEqual(
      expect.objectContaining({ code: 'ts_python_execution_mask_mismatch' }),
    );
  });

  it('flags invalid mocked Python output as unavailable', () => {
    const validator = new TsPythonParityValidator({
      pythonMaskExporter: () => 'not-json',
    });

    expect(validator.runOnPeriodicCadence({ session_id: 'session-1' })).toContainEqual(
      expect.objectContaining({ code: 'python_execution_mask_unavailable' }),
    );
  });

  it('flags timeout from the mocked Python exporter with the timeout-specific code', () => {
    const validator = new TsPythonParityValidator({
      pythonMaskExporter: () => {
        throw new PythonMaskExportTimeoutError(30_000, '', '');
      },
    });

    expect(validator.runOnPeriodicCadence({ session_id: 'session-1' })).toContainEqual(
      expect.objectContaining({ code: 'python_execution_mask_export_timeout' }),
    );
  });
});
