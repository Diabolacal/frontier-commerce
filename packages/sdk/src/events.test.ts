import { describe, expect, it } from 'vitest';
import type { CommerceDeployment } from './config.js';
import {
  asId,
  asOption,
  asTypeName,
  asU64,
  parseCommerceEvent,
  shortEventName,
} from './events.js';

const d: CommerceDeployment = {
  network: 'testnet',
  packageId: '0xbbb',
  originalPackageId: '0xaaa',
  registryId: '0xreg',
  coins: {},
};

describe('coercion helpers tolerate transport shape drift', () => {
  it('asU64 handles string, number, bigint', () => {
    expect(asU64('42')).toBe(42n);
    expect(asU64(42)).toBe(42n);
    expect(asU64(42n)).toBe(42n);
  });

  it('asOption handles null, direct value, legacy vec, Some/None', () => {
    expect(asOption(null, asU64)).toBeNull();
    expect(asOption('7', asU64)).toBe(7n);
    expect(asOption({ vec: [] }, asU64)).toBeNull();
    expect(asOption({ vec: ['9'] }, asU64)).toBe(9n);
    expect(asOption({ Some: '3' }, asU64)).toBe(3n);
    expect(asOption({ None: true }, asU64)).toBeNull();
  });

  it('asTypeName handles {name} and plain string, normalizes 0x prefix', () => {
    expect(asTypeName({ name: 'ac36::EVE::EVE' })).toBe('0xac36::EVE::EVE');
    expect(asTypeName('0xac36::EVE::EVE')).toBe('0xac36::EVE::EVE');
  });

  it('asId handles plain string and wrapped shapes', () => {
    expect(asId('0x1')).toBe('0x1');
    expect(asId({ bytes: '0x2' })).toBe('0x2');
  });
});

describe('parseCommerceEvent', () => {
  it('parses a PaymentEvent and ignores foreign events', () => {
    const parsed = parseCommerceEvent(d, {
      eventType: '0xaaa::events::PaymentEvent',
      json: {
        merchant_id: '0xm',
        payment_id: '1',
        product_id: '2',
        payer: '0xp',
        beneficiary: '0xb',
        currency: { name: 'ac36::EVE::EVE' },
        amount: '1000',
        fee: '25',
        quantity: '1',
        external_ref: 'order-77',
        paid_at_ms: '1690000000000',
      },
      txDigest: 'DIG',
    });
    expect(parsed).toMatchObject({
      name: 'PaymentEvent',
      paymentId: 1n,
      amount: 1000n,
      fee: 25n,
      externalRef: 'order-77',
      currency: '0xac36::EVE::EVE',
      txDigest: 'DIG',
    });

    expect(
      parseCommerceEvent(d, { eventType: '0xother::events::PaymentEvent', json: {} }),
    ).toBeNull();
    // Latest (non-original) package prefix must NOT match event filters.
    expect(
      parseCommerceEvent(d, { eventType: '0xbbb::events::PaymentEvent', json: {} }),
    ).toBeNull();
  });

  it('parses RefundEvent currency, tolerating legacy events without it', () => {
    const modern = parseCommerceEvent(d, {
      eventType: '0xaaa::events::RefundEvent',
      json: {
        merchant_id: '0xm',
        payment_id: '4',
        currency: { name: 'ac36::EVE::EVE' },
        amount: '500',
        to: '0xp',
        entitlement_revoked: true,
      },
    });
    expect(modern).toMatchObject({
      name: 'RefundEvent',
      currency: '0xac36::EVE::EVE',
      amount: 500n,
      entitlementRevoked: true,
    });

    const legacy = parseCommerceEvent(d, {
      eventType: '0xaaa::events::RefundEvent',
      json: {
        merchant_id: '0xm',
        payment_id: '4',
        amount: '500',
        to: '0xp',
        entitlement_revoked: false,
      },
    });
    expect(legacy).toMatchObject({ name: 'RefundEvent', currency: null, amount: 500n });
  });

  it('derives SplitDistributedEvent.distributedTotal for both event shapes', () => {
    const base = {
      merchant_id: '0xm',
      currency: { name: 'ac36::EVE::EVE' },
      total: '1000',
      recipients: ['0x1', '0x2'],
      amounts: ['700', '250'],
    };
    const modern = parseCommerceEvent(d, {
      eventType: '0xaaa::events::SplitDistributedEvent',
      json: { ...base, distributed_total: '950' },
    });
    expect(modern).toMatchObject({ total: 1000n, distributedTotal: 950n });

    // Legacy shape: distributed total falls back to sum(amounts), never
    // the pre-distribution `total` (the F2 under-count bug).
    const legacy = parseCommerceEvent(d, {
      eventType: '0xaaa::events::SplitDistributedEvent',
      json: base,
    });
    expect(legacy).toMatchObject({ total: 1000n, distributedTotal: 950n });
  });

  it('falls back to a generic event for unknown names (forward compat)', () => {
    const parsed = parseCommerceEvent(d, {
      eventType: '0xaaa::events::PaymentEventV2',
      json: { anything: 1 },
    });
    expect(parsed?.name).toBe('PaymentEventV2');
    expect((parsed as { fields?: unknown }).fields).toEqual({ anything: 1 });
  });

  it('shortEventName extracts struct name', () => {
    expect(shortEventName('0xaaa::events::RefundEvent')).toBe('RefundEvent');
  });
});
