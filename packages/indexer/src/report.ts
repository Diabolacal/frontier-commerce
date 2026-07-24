/**
 * Accounting report over the raw-event ledger.
 *
 * Pure SQL+JS aggregation - no chain access. The numbers here should always
 * reconcile with on-chain treasury values; the demo harness asserts exactly
 * that, which is the point: events are a sufficient accounting surface.
 */
import type { LedgerDb } from './db.js';

export interface MerchantLedger {
  merchantId: string;
  /** currency -> aggregates (all bigint, base units) */
  byCurrency: Map<
    string,
    {
      grossPayments: bigint;
      fees: bigint;
      refunds: bigint;
      creditDeposits: bigint;
      creditCharges: bigint;
      creditChargeFees: bigint;
      creditWithdrawals: bigint;
      treasuryWithdrawals: bigint;
      distributions: bigint;
      feesSwept: bigint;
    }
  >;
  paymentCount: number;
  refundCount: number;
  /**
   * Refund amount that could not be attributed to a currency: the event
   * predates the `currency` field AND the merchant uses several currencies.
   * Non-zero means per-currency treasury reconciliation is unreliable for
   * this merchant - surface it, never silently reconcile past it.
   */
  unattributedRefunds: bigint;
  entitlementGrants: number;
  entitlementRevocations: number;
}

interface RawRow {
  event_name: string;
  merchant_id: string | null;
  json: string;
}

function currencyOf(j: Record<string, unknown>): string {
  const c = j.currency;
  if (typeof c === 'string') return c.startsWith('0x') ? c : `0x${c}`;
  if (c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string') {
    const n = (c as { name: string }).name;
    return n.startsWith('0x') ? n : `0x${n}`;
  }
  return 'unknown';
}

function u64(j: Record<string, unknown>, key: string): bigint {
  const v = j[key];
  if (typeof v === 'string' || typeof v === 'number') return BigInt(v);
  return 0n;
}

export function buildMerchantLedgers(db: LedgerDb): Map<string, MerchantLedger> {
  const rows = db.db
    .prepare(`SELECT event_name, merchant_id, json FROM raw_events ORDER BY rowid`)
    .all() as unknown as RawRow[];

  const ledgers = new Map<string, MerchantLedger>();
  const led = (id: string): MerchantLedger => {
    let l = ledgers.get(id);
    if (!l) {
      l = {
        merchantId: id,
        byCurrency: new Map(),
        paymentCount: 0,
        refundCount: 0,
        unattributedRefunds: 0n,
        entitlementGrants: 0,
        entitlementRevocations: 0,
      };
      ledgers.set(id, l);
    }
    return l;
  };
  const cur = (l: MerchantLedger, c: string) => {
    let agg = l.byCurrency.get(c);
    if (!agg) {
      agg = {
        grossPayments: 0n,
        fees: 0n,
        refunds: 0n,
        creditDeposits: 0n,
        creditCharges: 0n,
        creditChargeFees: 0n,
        creditWithdrawals: 0n,
        treasuryWithdrawals: 0n,
        distributions: 0n,
        feesSwept: 0n,
      };
      l.byCurrency.set(c, agg);
    }
    return agg;
  };

  for (const row of rows) {
    if (!row.merchant_id) continue;
    const j = JSON.parse(row.json) as Record<string, unknown>;
    const l = led(row.merchant_id);
    switch (row.event_name) {
      case 'PaymentEvent': {
        const a = cur(l, currencyOf(j));
        a.grossPayments += u64(j, 'amount');
        a.fees += u64(j, 'fee');
        l.paymentCount += 1;
        break;
      }
      case 'RefundEvent': {
        l.refundCount += 1;
        if (j.currency !== undefined) {
          // Current package versions carry the currency on the event.
          cur(l, currencyOf(j)).refunds += u64(j, 'amount');
          break;
        }
        // Legacy events (first testnet deployment): attribute to the single
        // currency when unambiguous, otherwise track as unattributed so the
        // reconciliation gap is visible instead of silent.
        const currencies = [...l.byCurrency.keys()];
        if (currencies.length === 1) {
          cur(l, currencies[0]!).refunds += u64(j, 'amount');
        } else {
          l.unattributedRefunds += u64(j, 'amount');
        }
        break;
      }
      case 'EntitlementGrantedEvent':
        l.entitlementGrants += 1;
        break;
      case 'EntitlementRevokedEvent':
        l.entitlementRevocations += 1;
        break;
      case 'CreditDepositedEvent':
        cur(l, currencyOf(j)).creditDeposits += u64(j, 'amount');
        break;
      case 'CreditChargedEvent': {
        const a = cur(l, currencyOf(j));
        a.creditCharges += u64(j, 'amount');
        a.creditChargeFees += u64(j, 'fee');
        break;
      }
      case 'CreditWithdrawnEvent':
        cur(l, currencyOf(j)).creditWithdrawals += u64(j, 'amount');
        break;
      case 'TreasuryWithdrawalEvent':
        cur(l, currencyOf(j)).treasuryWithdrawals += u64(j, 'amount');
        break;
      case 'SplitDistributedEvent': {
        // `total` is the PRE-distribution balance; the amount actually
        // debited is `distributed_total` (or the sum of `amounts` for
        // events from packages predating that field).
        const a = cur(l, currencyOf(j));
        if (j.distributed_total !== undefined) {
          a.distributions += u64(j, 'distributed_total');
        } else {
          const amounts = Array.isArray(j.amounts) ? (j.amounts as unknown[]) : [];
          a.distributions += amounts.reduce<bigint>(
            (sum, v) => sum + (typeof v === 'string' || typeof v === 'number' ? BigInt(v) : 0n),
            0n,
          );
        }
        break;
      }
      case 'FeesSweptEvent':
        cur(l, currencyOf(j)).feesSwept += u64(j, 'amount');
        break;
      default:
        break;
    }
  }
  return ledgers;
}

/**
 * Expected on-chain treasury balance implied by the event ledger:
 * gross payments - fees + net credit charges - refunds - withdrawals -
 * distributed amounts. `distributions` already counts only what actually
 * left the treasury (undistributed remainder stays), so no correction
 * factor is needed. Callers should check `ledger.unattributedRefunds`
 * before trusting the result for multi-currency merchants fed by legacy
 * (pre-currency-field) refund events.
 */
export function expectedTreasury(ledger: MerchantLedger, currency: string): bigint {
  const a = ledger.byCurrency.get(currency);
  if (!a) return 0n;
  return (
    a.grossPayments -
    a.fees -
    a.refunds +
    (a.creditCharges - a.creditChargeFees) -
    a.treasuryWithdrawals -
    a.distributions
  );
}

export function formatLedgerReport(
  ledgers: Map<string, MerchantLedger>,
  decimalsFor: (currency: string) => number,
): string {
  const lines: string[] = [];
  for (const l of ledgers.values()) {
    lines.push(`Merchant ${l.merchantId}`);
    lines.push(
      `  payments: ${l.paymentCount}  refunds: ${l.refundCount}  grants: ${l.entitlementGrants}  revocations: ${l.entitlementRevocations}`,
    );
    if (l.unattributedRefunds > 0n) {
      lines.push(
        `  WARNING: ${l.unattributedRefunds} base units of refunds could not be attributed to a currency (legacy events, multi-currency merchant); per-currency reconciliation is unreliable`,
      );
    }
    for (const [c, a] of l.byCurrency) {
      const d = decimalsFor(c);
      const fmt = (v: bigint) => {
        const neg = v < 0n;
        const abs = neg ? -v : v;
        const base = 10n ** BigInt(d);
        return `${neg ? '-' : ''}${abs / base}.${(abs % base).toString().padStart(d, '0')}`;
      };
      lines.push(`  currency ${c}`);
      lines.push(`    gross payments : ${fmt(a.grossPayments)}`);
      lines.push(`    protocol fees  : ${fmt(a.fees + a.creditChargeFees)}`);
      lines.push(`    refunds        : ${fmt(a.refunds)}`);
      lines.push(
        `    credits        : +${fmt(a.creditDeposits)} charged ${fmt(a.creditCharges)} withdrawn ${fmt(a.creditWithdrawals)}`,
      );
      lines.push(`    withdrawals    : ${fmt(a.treasuryWithdrawals)}`);
      lines.push(`    distributions  : ${fmt(a.distributions)}`);
      lines.push(`    fees swept     : ${fmt(a.feesSwept)}`);
    }
  }
  return lines.join('\n');
}
