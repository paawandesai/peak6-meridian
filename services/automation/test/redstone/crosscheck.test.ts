/**
 * Cross-check tests (M2-16 AC2)
 */

import { describe, it, expect } from 'vitest';
import { crossCheckOfficialClose } from '../../src/redstone/crosscheck.js';
import type { OfficialClose } from '../../src/redstone/types.js';

describe('crossCheckOfficialClose', () => {
  const tradingDate = 20261009;

  const tiingo: OfficialClose = {
    source: 'tiingo',
    symbol: 'AAPL',
    tradingDate,
    closeCents: 23000, // $230.00
  };

  const twelveData: OfficialClose = {
    source: 'twelve-data',
    symbol: 'AAPL',
    tradingDate,
    closeCents: 23001, // $230.01
  };

  it('passes when within 5 bps of both sources', () => {
    const result = crossCheckOfficialClose(23000, tiingo, twelveData, tradingDate);
    expect(result.passed).toBe(true);
    expect(result.tiingoBps).toBe(0);
    expect(result.twelveDataBps).toBeLessThanOrEqual(5);
  });

  it('fails when >5 bps off Tiingo', () => {
    const redstone = 23014; // 6.09 bps off 23000
    const result = crossCheckOfficialClose(redstone, tiingo, twelveData, tradingDate);
    expect(result.passed).toBe(false);
    expect(result.tiingoBps).toBeGreaterThan(5);
  });

  it('throws when trading date mismatch', () => {
    const wrongTiingo = { ...tiingo, tradingDate: 20261008 };
    expect(() =>
      crossCheckOfficialClose(23000, wrongTiingo, twelveData, tradingDate)
    ).toThrow('bar date');
  });
});
