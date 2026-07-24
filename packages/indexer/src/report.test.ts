/**
 * Ledger aggregation over raw events, focused on the accounting fixes from
 * the 2026-07-19 security remediation: per-currency refund attribution
 * (with legacy-event fallback + unattributed tracking) and distribution
 * accounting that subtracts what actually left the treasury.
 */
import { describe, expect, it } from 'vitest';
import { openLedger, type LedgerDb } from './db.js';
import { buildMerchantLedgers, expectedTreasury, formatLedgerReport } from './report.js';

const MERCHANT = '0x' + 'aa'.repeat(32);
const EVE = '0xac36::EVE::EVE';
const MOCK = '0x5384::mock_eve::MOCK_EVE';

let seq = 0;
function insert(db: LedgerDb, eventName: string, json: Record<string, unknown>): void {
  seq += 1;
  db.insertRawEvent({
    txDigest: `tx-${seq}`,
    eventSeq: 0,
    eventType: `0xpkg::events::${eventName}`,
    eventName,
    merchantId: MERCHANT,
    timestampMs: 1,
    json: JSON.stringify(json),
  });
}

function memoryLedger(): LedgerDb {
  return openLedger(':memory:');
}

describe('buildMerchantLedgers', () => {
  it('attributes refunds by the currency field when present (multi-currency safe)', () => {
    const db = memoryLedger();
    insert(db, 'PaymentEvent', { currency: EVE, amount: '1000', fee: '25' });
    insert(db, 'PaymentEvent', { currency: MOCK, amount: '500', fee: '0' });
    insert(db, 'RefundEvent', { currency: MOCK, amount: '200' });
    const l = buildMerchantLedgers(db).get(MERCHANT)!;
    expect(l.byCurrency.get(MOCK)!.refunds).toBe(200n);
    expect(l.byCurrency.get(EVE)!.refunds).toBe(0n);
    expect(l.unattributedRefunds).toBe(0n);
    db.close();
  });

  it('falls back to the single currency for legacy refund events', () => {
    const db = memoryLedger();
    insert(db, 'PaymentEvent', { currency: EVE, amount: '1000', fee: '0' });
    insert(db, 'RefundEvent', { amount: '300' }); // no currency field
    const l = buildMerchantLedgers(db).get(MERCHANT)!;
    expect(l.byCurrency.get(EVE)!.refunds).toBe(300n);
    expect(l.unattributedRefunds).toBe(0n);
    db.close();
  });

  it('tracks legacy multi-currency refunds as unattributed instead of guessing', () => {
    const db = memoryLedger();
    insert(db, 'PaymentEvent', { currency: EVE, amount: '1000', fee: '0' });
    insert(db, 'PaymentEvent', { currency: MOCK, amount: '500', fee: '0' });
    insert(db, 'RefundEvent', { amount: '300' }); // ambiguous
    const l = buildMerchantLedgers(db).get(MERCHANT)!;
    expect(l.byCurrency.get(EVE)!.refunds).toBe(0n);
    expect(l.byCurrency.get(MOCK)!.refunds).toBe(0n);
    expect(l.unattributedRefunds).toBe(300n);
    expect(formatLedgerReport(buildMerchantLedgers(db), () => 9)).toMatch(/WARNING/);
    db.close();
  });

  it('counts distributions by distributed_total, not the pre-split balance', () => {
    const db = memoryLedger();
    insert(db, 'PaymentEvent', { currency: EVE, amount: '1000', fee: '0' });
    insert(db, 'SplitDistributedEvent', {
      currency: EVE,
      total: '1000',
      distributed_total: '950',
      recipients: ['0x1', '0x2'],
      amounts: ['700', '250'],
    });
    const l = buildMerchantLedgers(db).get(MERCHANT)!;
    expect(l.byCurrency.get(EVE)!.distributions).toBe(950n);
    // 1000 in, 950 out -> 50 remainder stays in the treasury.
    expect(expectedTreasury(l, EVE)).toBe(50n);
    db.close();
  });

  it('sums the amounts vector for legacy distribution events (F2 under-count fix)', () => {
    const db = memoryLedger();
    insert(db, 'PaymentEvent', { currency: EVE, amount: '1000', fee: '0' });
    insert(db, 'SplitDistributedEvent', {
      currency: EVE,
      total: '1000', // legacy shape: no distributed_total
      recipients: ['0x1', '0x2'],
      amounts: ['700', '250'],
    });
    const l = buildMerchantLedgers(db).get(MERCHANT)!;
    expect(l.byCurrency.get(EVE)!.distributions).toBe(950n);
    expect(expectedTreasury(l, EVE)).toBe(50n);
    db.close();
  });

  it('expectedTreasury nets payments, fees, refunds, credits and outflows', () => {
    const db = memoryLedger();
    insert(db, 'PaymentEvent', { currency: EVE, amount: '1000', fee: '25' });
    insert(db, 'CreditDepositedEvent', { currency: EVE, amount: '400', new_balance: '400' });
    insert(db, 'CreditChargedEvent', { currency: EVE, amount: '100', fee: '2', new_balance: '300' });
    insert(db, 'RefundEvent', { currency: EVE, amount: '50' });
    insert(db, 'TreasuryWithdrawalEvent', { currency: EVE, amount: '200' });
    const l = buildMerchantLedgers(db).get(MERCHANT)!;
    // 1000 - 25 (fee) + (100 - 2) (net credit charge) - 50 - 200 = 823
    expect(expectedTreasury(l, EVE)).toBe(823n);
    db.close();
  });
});
