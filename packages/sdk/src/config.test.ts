import { describe, expect, it } from 'vitest';
import { parseDeployment, validateDeployment } from './config.js';

const valid = {
  network: 'testnet' as const,
  packageId: '0xabc123',
  originalPackageId: '0xabc123',
  registryId: '0xdef456',
  coins: {
    EVE: { coinType: '0xac361aa5::EVE::EVE', decimals: 9, symbol: 'EVE' },
  },
};

describe('deployment config', () => {
  it('accepts a valid descriptor', () => {
    expect(validateDeployment({ ...valid })).toBeTruthy();
  });

  it('rejects malformed package IDs', () => {
    expect(() => validateDeployment({ ...valid, packageId: 'abc' })).toThrow(/packageId/);
    expect(() => validateDeployment({ ...valid, registryId: '0xZZ' })).toThrow(/registryId/);
  });

  it('rejects malformed coin types', () => {
    expect(() =>
      validateDeployment({
        ...valid,
        coins: { EVE: { coinType: 'EVE', decimals: 9, symbol: 'EVE' } },
      }),
    ).toThrow(/coin type/);
  });

  it('accepts Move identifiers containing digits (e.g. pool_v2::TOKEN2)', () => {
    expect(
      validateDeployment({
        ...valid,
        coins: { T2: { coinType: '0xabc123::pool_v2::TOKEN2', decimals: 9, symbol: 'T2' } },
      }),
    ).toBeTruthy();
    // Leading digits are still invalid Move identifiers.
    expect(() =>
      validateDeployment({
        ...valid,
        coins: { BAD: { coinType: '0xabc123::2pool::TOKEN', decimals: 9, symbol: 'BAD' } },
      }),
    ).toThrow(/coin type/);
  });

  it('refuses mainnet descriptors until the promotion checklist exists', () => {
    expect(() => validateDeployment({ ...valid, network: 'mainnet' })).toThrow(/mainnet/i);
  });

  it('parses JSON text', () => {
    expect(parseDeployment(JSON.stringify(valid)).registryId).toBe('0xdef456');
  });
});
