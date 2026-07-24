/**
 * Typed event definitions + tolerant parsing.
 *
 * Event JSON shapes differ subtly between transports (JSON-RPC vs gRPC vs
 * GraphQL) for Move `Option`, `TypeName` and `ID` values, so every field
 * goes through a coercion helper instead of a straight cast. Indexers that
 * need bit-exact stability should parse the BCS payload instead; for
 * accounting purposes the coerced JSON is sufficient and far simpler.
 */
import type { CommerceDeployment } from './config.js';
import { eventType } from './ids.js';

export interface CommerceEventBase {
  /** Full Move event type string. */
  type: string;
  /** Short struct name, e.g. "PaymentEvent". */
  name: string;
  txDigest?: string;
  timestampMs?: bigint;
}

export interface PaymentEvent extends CommerceEventBase {
  name: 'PaymentEvent';
  merchantId: string;
  paymentId: bigint;
  productId: bigint;
  payer: string;
  beneficiary: string;
  currency: string;
  amount: bigint;
  fee: bigint;
  quantity: bigint;
  externalRef: string | null;
  paidAtMs: bigint;
}

export interface RefundEvent extends CommerceEventBase {
  name: 'RefundEvent';
  merchantId: string;
  paymentId: bigint;
  /**
   * Refund currency. `null` for events emitted by package versions that
   * predate the field (e.g. the first testnet deployment) - resolve via the
   * referenced payment when exact multi-currency accounting matters.
   */
  currency: string | null;
  amount: bigint;
  to: string;
  entitlementRevoked: boolean;
}

export interface EntitlementGrantedEvent extends CommerceEventBase {
  name: 'EntitlementGrantedEvent';
  merchantId: string;
  key: string;
  owner: string;
  expiresAtMs: bigint | null;
  sourcePaymentId: bigint | null;
}

export interface EntitlementRevokedEvent extends CommerceEventBase {
  name: 'EntitlementRevokedEvent';
  merchantId: string;
  key: string;
  owner: string;
  byRefund: boolean;
}

export interface CreditEvent extends CommerceEventBase {
  name: 'CreditDepositedEvent' | 'CreditChargedEvent' | 'CreditWithdrawnEvent';
  merchantId: string;
  owner: string;
  currency: string;
  amount: bigint;
  fee?: bigint;
  memo?: string;
  newBalance: bigint;
}

export interface TreasuryEvent extends CommerceEventBase {
  name: 'TreasuryWithdrawalEvent' | 'FeesSweptEvent';
  merchantId: string;
  currency: string;
  amount: bigint;
  to: string;
}

export interface SplitDistributedEvent extends CommerceEventBase {
  name: 'SplitDistributedEvent';
  merchantId: string;
  currency: string;
  /** Treasury balance BEFORE distribution - NOT the amount debited. */
  total: bigint;
  /**
   * Amount actually debited (sum of `amounts`). Computed locally when the
   * emitting package predates the `distributed_total` field, so it is
   * always safe for `treasury -= distributedTotal` accounting.
   */
  distributedTotal: bigint;
  recipients: string[];
  amounts: bigint[];
}

export interface GenericCommerceEvent extends CommerceEventBase {
  fields: Record<string, unknown>;
}

export type CommerceEvent =
  | PaymentEvent
  | RefundEvent
  | EntitlementGrantedEvent
  | EntitlementRevokedEvent
  | CreditEvent
  | TreasuryEvent
  | SplitDistributedEvent
  | GenericCommerceEvent;

// === Coercion helpers (transport-shape tolerant) ===

export function asU64(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' || typeof v === 'string') return BigInt(v);
  throw new Error(`Cannot coerce to u64: ${JSON.stringify(v)}`);
}

export function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`Cannot coerce to bool: ${JSON.stringify(v)}`);
}

export function asAddress(v: unknown): string {
  if (typeof v === 'string') return v;
  throw new Error(`Cannot coerce to address: ${JSON.stringify(v)}`);
}

/** Move ID renders as a plain string on some transports, {bytes} on others. */
export function asId(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.bytes === 'string') return o.bytes;
    if (typeof o.id === 'string') return o.id;
  }
  throw new Error(`Cannot coerce to ID: ${JSON.stringify(v)}`);
}

/** TypeName renders as {name: "..."} or plain string depending on transport. */
export function asTypeName(v: unknown): string {
  if (typeof v === 'string') return v.startsWith('0x') ? v : `0x${v}`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.name === 'string') {
      return o.name.startsWith('0x') ? o.name : `0x${o.name}`;
    }
  }
  throw new Error(`Cannot coerce to TypeName: ${JSON.stringify(v)}`);
}

/** Move Option renders as null, direct value, or {vec: []} legacy shape. */
export function asOption<T>(v: unknown, inner: (x: unknown) => T): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.vec)) {
      return o.vec.length === 0 ? null : inner(o.vec[0]);
    }
    if ('Some' in o) return inner(o.Some);
    if ('None' in o) return null;
  }
  return inner(v);
}

// === Parsing ===

/** Extract the short struct name from a full event type string. */
export function shortEventName(fullType: string): string {
  const parts = fullType.split('::');
  return parts[parts.length - 1] ?? fullType;
}

/** True when `type` is a frontier-commerce event for this deployment. */
export function isCommerceEventType(d: CommerceDeployment, type: string): boolean {
  return type.startsWith(`${d.originalPackageId}::events::`);
}

export interface RawEventInput {
  eventType: string;
  json: Record<string, unknown> | null;
  txDigest?: string;
  timestampMs?: bigint | number | string;
}

/**
 * Parse one raw event (from tx results or an event query) into a typed
 * CommerceEvent. Returns null for events not from this package.
 */
export function parseCommerceEvent(
  d: CommerceDeployment,
  raw: RawEventInput,
): CommerceEvent | null {
  if (!isCommerceEventType(d, raw.eventType)) return null;
  const f = raw.json ?? {};
  const name = shortEventName(raw.eventType);
  const base: CommerceEventBase = {
    type: raw.eventType,
    name,
    ...(raw.txDigest !== undefined ? { txDigest: raw.txDigest } : {}),
    ...(raw.timestampMs !== undefined ? { timestampMs: asU64(raw.timestampMs) } : {}),
  };

  switch (name) {
    case 'PaymentEvent':
      return {
        ...base,
        name,
        merchantId: asId(f.merchant_id),
        paymentId: asU64(f.payment_id),
        productId: asU64(f.product_id),
        payer: asAddress(f.payer),
        beneficiary: asAddress(f.beneficiary),
        currency: asTypeName(f.currency),
        amount: asU64(f.amount),
        fee: asU64(f.fee),
        quantity: asU64(f.quantity),
        externalRef: asOption(f.external_ref, (x) => String(x)),
        paidAtMs: asU64(f.paid_at_ms),
      };
    case 'RefundEvent':
      return {
        ...base,
        name,
        merchantId: asId(f.merchant_id),
        paymentId: asU64(f.payment_id),
        currency: f.currency !== undefined ? asTypeName(f.currency) : null,
        amount: asU64(f.amount),
        to: asAddress(f.to),
        entitlementRevoked: asBool(f.entitlement_revoked),
      };
    case 'EntitlementGrantedEvent':
      return {
        ...base,
        name,
        merchantId: asId(f.merchant_id),
        key: String(f.key),
        owner: asAddress(f.owner),
        expiresAtMs: asOption(f.expires_at_ms, asU64),
        sourcePaymentId: asOption(f.source_payment_id, asU64),
      };
    case 'EntitlementRevokedEvent':
      return {
        ...base,
        name,
        merchantId: asId(f.merchant_id),
        key: String(f.key),
        owner: asAddress(f.owner),
        byRefund: asBool(f.by_refund),
      };
    case 'CreditDepositedEvent':
    case 'CreditChargedEvent':
    case 'CreditWithdrawnEvent':
      return {
        ...base,
        name,
        merchantId: asId(f.merchant_id),
        owner: asAddress(f.owner),
        currency: asTypeName(f.currency),
        amount: asU64(f.amount),
        ...(f.fee !== undefined ? { fee: asU64(f.fee) } : {}),
        ...(f.memo !== undefined ? { memo: String(f.memo) } : {}),
        newBalance: asU64(f.new_balance),
      };
    case 'TreasuryWithdrawalEvent':
    case 'FeesSweptEvent':
      return {
        ...base,
        name,
        merchantId: asId(f.merchant_id),
        currency: asTypeName(f.currency),
        amount: asU64(f.amount),
        to: asAddress(f.to),
      };
    case 'SplitDistributedEvent': {
      const amounts = (f.amounts as unknown[] ?? []).map(asU64);
      return {
        ...base,
        name,
        merchantId: asId(f.merchant_id),
        currency: asTypeName(f.currency),
        total: asU64(f.total),
        distributedTotal:
          f.distributed_total !== undefined
            ? asU64(f.distributed_total)
            : amounts.reduce((a, b) => a + b, 0n),
        recipients: (f.recipients as unknown[] ?? []).map(asAddress),
        amounts,
      };
    }
    default:
      return { ...base, fields: f } as GenericCommerceEvent;
  }
}

/** Parse all commerce events out of a core-API transaction result. */
export function parseEventsFromTransaction(
  d: CommerceDeployment,
  tx: {
    digest?: string;
    events?: Array<{ eventType: string; json: Record<string, unknown> | null }> | null;
  },
): CommerceEvent[] {
  const out: CommerceEvent[] = [];
  for (const ev of tx.events ?? []) {
    const parsed = parseCommerceEvent(d, {
      eventType: ev.eventType,
      json: ev.json,
      ...(tx.digest !== undefined ? { txDigest: tx.digest } : {}),
    });
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Event type helper re-export for filters. */
export { eventType };
