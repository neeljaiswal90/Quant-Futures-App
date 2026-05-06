import {
  throwEquityMetricsIssue,
} from './equity-metrics-error.js';
import type {
  EquityMetricsOptions,
  InstrumentValuationSpec,
} from './types.js';

export interface ScaledDecimalInt {
  readonly value: bigint;
  readonly scale: bigint;
}

const POSITIVE_DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export function decimalStringToScaledInt(value: string): ScaledDecimalInt {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL_RE.test(value)) {
    throwEquityMetricsIssue({
      path: '$.decimal',
      code: 'invalid_valuation_spec',
      message: 'decimal value must be a non-negative base-10 decimal string',
    });
  }

  const [integerPart, fractionalPart = ''] = value.split('.');
  const scale = 10n ** BigInt(fractionalPart.length);
  return {
    value: BigInt(`${integerPart}${fractionalPart}`),
    scale,
  };
}

export function priceToTicks(price: number, tickSize: string): bigint {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throwEquityMetricsIssue({
      path: '$.price',
      code: 'invalid_price',
      message: 'price must be a positive finite number',
    });
  }

  const priceDecimal = parseNumberDecimal(price, '$.price', 'invalid_price');
  const tickDecimal = parseTickSize(tickSize);
  if (tickDecimal.value <= 0n) {
    throwEquityMetricsIssue({
      path: '$.valuation.tick_size',
      code: 'invalid_valuation_spec',
      message: 'tick_size must be positive',
    });
  }

  const numerator = priceDecimal.value * tickDecimal.scale;
  const denominator = priceDecimal.scale * tickDecimal.value;
  if (numerator % denominator !== 0n) {
    throwEquityMetricsIssue({
      path: '$.price',
      code: 'price_not_tick_aligned',
      message: `price ${price.toString()} is not an exact multiple of tick_size ${tickSize}`,
    });
  }

  return numerator / denominator;
}

export function usdNumberToCents(value: number): bigint {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throwEquityMetricsIssue({
      path: '$.fee',
      code: 'invalid_fee',
      message: 'fee or commission must be a non-negative finite number',
    });
  }

  const decimal = parseNumberDecimal(value, '$.fee', 'invalid_fee');
  const centsNumerator = decimal.value * 100n;
  if (centsNumerator % decimal.scale !== 0n) {
    throwEquityMetricsIssue({
      path: '$.fee',
      code: 'invalid_fee',
      message: 'fee or commission must be exactly convertible to cents',
    });
  }
  return centsNumerator / decimal.scale;
}

export function validateEquityMetricsOptions(options: EquityMetricsOptions): void {
  if (typeof options.initial_equity_cents !== 'bigint' || options.initial_equity_cents <= 0n) {
    throwEquityMetricsIssue({
      path: '$.initial_equity_cents',
      code: 'invalid_initial_equity',
      message: 'initial_equity_cents must be a positive bigint',
    });
  }
  validateInstrumentValuationSpec(options.valuation);
}

export function validateInstrumentValuationSpec(spec: InstrumentValuationSpec): void {
  if (typeof spec.instrument_root !== 'string' || spec.instrument_root.trim() === '') {
    throwEquityMetricsIssue({
      path: '$.valuation.instrument_root',
      code: 'invalid_valuation_spec',
      message: 'instrument_root must be a non-empty string',
    });
  }
  const tickSize = parseTickSize(spec.tick_size);
  if (tickSize.value <= 0n) {
    throwEquityMetricsIssue({
      path: '$.valuation.tick_size',
      code: 'invalid_valuation_spec',
      message: 'tick_size must be positive',
    });
  }
  if (
    typeof spec.tick_value_usd_cents !== 'bigint' ||
    spec.tick_value_usd_cents <= 0n
  ) {
    throwEquityMetricsIssue({
      path: '$.valuation.tick_value_usd_cents',
      code: 'invalid_valuation_spec',
      message: 'tick_value_usd_cents must be a positive bigint',
    });
  }
}

function parseTickSize(tickSize: string): ScaledDecimalInt {
  try {
    return decimalStringToScaledInt(tickSize);
  } catch {
    throwEquityMetricsIssue({
      path: '$.valuation.tick_size',
      code: 'invalid_valuation_spec',
      message: 'tick_size must be a positive base-10 decimal string',
    });
  }
}

function parseNumberDecimal(
  value: number,
  path: string,
  code: 'invalid_price' | 'invalid_fee',
): ScaledDecimalInt {
  const decimalString = value.toString();
  if (decimalString.includes('e') || decimalString.includes('E')) {
    throwEquityMetricsIssue({
      path,
      code,
      message: 'number value must stringify as a base-10 decimal',
    });
  }

  try {
    return decimalStringToScaledInt(decimalString);
  } catch {
    throwEquityMetricsIssue({
      path,
      code,
      message: 'number value must be a non-negative base-10 decimal',
    });
  }
}
