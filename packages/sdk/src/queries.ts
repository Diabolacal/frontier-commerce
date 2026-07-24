/**
 * Read paths. Two mechanisms, both transport-agnostic (JSON-RPC or gRPC):
 *
 * 1. Object reads via `client.core.getObject({ include: { json: true } })` -
 *    registry/merchant top-level fields.
 * 2. On-chain view calls via `client.core.simulateTransaction` with
 *    `commandResults` - evaluates `is_entitled` / balances with the SAME
 *    Move logic production uses (no re-implementation drift), including
 *    clock-based expiry.
 *
 * For list-shaped queries (all payments, full ledgers) use the indexer -
 * object state is not enumerated here by design.
 */
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import { CLOCK_OBJECT_ID, type CommerceDeployment } from './config.js';
import { target } from './ids.js';

/** Address used as the simulated sender for read-only view calls. */
const VIEW_SENDER = '0x0000000000000000000000000000000000000000000000000000000000000001';

export interface RegistrySummary {
  version: bigint;
  paused: boolean;
  feeBps: bigint;
}

export interface MerchantSummary {
  id: string;
  version: bigint;
  name: string;
  paused: boolean;
  rootCapId: string;
  operatorCapIds: string[];
  treasurerCapIds: string[];
  recoveryEnabled: boolean;
  refundWindowMs: bigint;
  creditsEnabled: boolean;
  enforceSplit: boolean;
  nextPaymentId: bigint;
  nextProductId: bigint;
}

function fieldStr(json: Record<string, unknown>, key: string): string {
  const v = json[key];
  if (typeof v === 'string') return v;
  throw new Error(`Expected string field '${key}', got ${JSON.stringify(v)}`);
}

/** Move UID/ID fields render as "0x…" or {id: "0x…"} depending on transport. */
function fieldId(json: Record<string, unknown>, key: string): string {
  const v = json[key];
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
    return (v as { id: string }).id;
  }
  throw new Error(`Expected ID field '${key}', got ${JSON.stringify(v)}`);
}

function fieldBool(json: Record<string, unknown>, key: string): boolean {
  const v = json[key];
  if (typeof v === 'boolean') return v;
  throw new Error(`Expected bool field '${key}', got ${JSON.stringify(v)}`);
}

function fieldU64(json: Record<string, unknown>, key: string): bigint {
  const v = json[key];
  if (typeof v === 'string' || typeof v === 'number') return BigInt(v);
  throw new Error(`Expected u64 field '${key}', got ${JSON.stringify(v)}`);
}

function fieldIdSet(json: Record<string, unknown>, key: string): string[] {
  // VecSet<ID> renders as {contents: [...]} or the JSON-RPC struct wrapper
  // {type, fields: {contents: [...]}} depending on transport.
  let v = json[key];
  if (v && typeof v === 'object' && (v as Record<string, unknown>).fields) {
    v = (v as Record<string, unknown>).fields;
  }
  if (v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).contents)) {
    return ((v as Record<string, unknown>).contents as unknown[]).map((x) => String(x));
  }
  if (Array.isArray(v)) return v.map((x) => String(x));
  throw new Error(`Expected VecSet field '${key}', got ${JSON.stringify(v)}`);
}

async function objectJson(
  client: ClientWithCoreApi,
  objectId: string,
): Promise<Record<string, unknown>> {
  const res = await client.core.getObject({ objectId, include: { json: true } });
  const json = res.object.json;
  if (!json) throw new Error(`Object ${objectId} returned no JSON content`);
  return json;
}

export async function getRegistrySummary(
  client: ClientWithCoreApi,
  d: CommerceDeployment,
): Promise<RegistrySummary> {
  const json = await objectJson(client, d.registryId);
  return {
    version: fieldU64(json, 'version'),
    paused: fieldBool(json, 'paused'),
    feeBps: fieldU64(json, 'fee_bps'),
  };
}

export async function getMerchantSummary(
  client: ClientWithCoreApi,
  merchantId: string,
): Promise<MerchantSummary> {
  const json = await objectJson(client, merchantId);
  return {
    id: fieldId(json, 'id'),
    version: fieldU64(json, 'version'),
    name: fieldStr(json, 'name'),
    paused: fieldBool(json, 'paused'),
    rootCapId: fieldId(json, 'root_cap_id'),
    operatorCapIds: fieldIdSet(json, 'operator_cap_ids'),
    treasurerCapIds: fieldIdSet(json, 'treasurer_cap_ids'),
    recoveryEnabled: fieldBool(json, 'recovery_enabled'),
    refundWindowMs: fieldU64(json, 'refund_window_ms'),
    creditsEnabled: fieldBool(json, 'credits_enabled'),
    enforceSplit: fieldBool(json, 'enforce_split'),
    nextPaymentId: fieldU64(json, 'next_payment_id'),
    nextProductId: fieldU64(json, 'next_product_id'),
  };
}

/** Run a single view moveCall via simulation and return its BCS return values. */
async function simulateView(
  client: ClientWithCoreApi,
  build: (tx: Transaction) => void,
): Promise<Uint8Array[]> {
  const tx = new Transaction();
  tx.setSender(VIEW_SENDER);
  build(tx);
  const res = await client.core.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
  });
  if (res.$kind === 'FailedTransaction') {
    throw new Error('View simulation failed - check object IDs and package version');
  }
  const results = res.commandResults;
  if (!results || results.length === 0) {
    throw new Error('Simulation returned no command results');
  }
  const last = results[results.length - 1]!;
  return last.returnValues.map((rv) => rv.bcs);
}

/** On-chain `entitlements::is_entitled` (clock-aware). */
export async function isEntitled(
  client: ClientWithCoreApi,
  d: CommerceDeployment,
  p: { merchantId: string; key: string; owner: string },
): Promise<boolean> {
  const [ret] = await simulateView(client, (tx) => {
    tx.moveCall({
      target: target(d, 'entitlements', 'is_entitled'),
      arguments: [
        tx.object(p.merchantId),
        tx.pure.string(p.key),
        tx.pure.address(p.owner),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });
  });
  return bcs.Bool.parse(ret!);
}

/** (exists, expiresAtMs?) - raw entitlement record info. */
export async function entitlementInfo(
  client: ClientWithCoreApi,
  d: CommerceDeployment,
  p: { merchantId: string; key: string; owner: string },
): Promise<{ exists: boolean; expiresAtMs: bigint | null }> {
  const rets = await simulateView(client, (tx) => {
    tx.moveCall({
      target: target(d, 'entitlements', 'entitlement_info'),
      arguments: [tx.object(p.merchantId), tx.pure.string(p.key), tx.pure.address(p.owner)],
    });
  });
  const exists = bcs.Bool.parse(rets[0]!);
  const expiry = bcs.option(bcs.U64).parse(rets[1]!);
  return { exists, expiresAtMs: expiry === null ? null : BigInt(expiry) };
}

export async function getCreditBalance(
  client: ClientWithCoreApi,
  d: CommerceDeployment,
  p: { merchantId: string; coinType: string; owner: string },
): Promise<bigint> {
  const [ret] = await simulateView(client, (tx) => {
    tx.moveCall({
      target: target(d, 'credits', 'credit_balance'),
      typeArguments: [p.coinType],
      arguments: [tx.object(p.merchantId), tx.pure.address(p.owner)],
    });
  });
  return BigInt(bcs.U64.parse(ret!));
}

export async function getTreasuryValue(
  client: ClientWithCoreApi,
  d: CommerceDeployment,
  p: { merchantId: string; coinType: string },
): Promise<bigint> {
  const [ret] = await simulateView(client, (tx) => {
    tx.moveCall({
      target: target(d, 'treasury', 'treasury_value'),
      typeArguments: [p.coinType],
      arguments: [tx.object(p.merchantId)],
    });
  });
  return BigInt(bcs.U64.parse(ret!));
}

export async function getFeesAccruedValue(
  client: ClientWithCoreApi,
  d: CommerceDeployment,
  p: { merchantId: string; coinType: string },
): Promise<bigint> {
  const [ret] = await simulateView(client, (tx) => {
    tx.moveCall({
      target: target(d, 'treasury', 'fees_accrued_value'),
      typeArguments: [p.coinType],
      arguments: [tx.object(p.merchantId)],
    });
  });
  return BigInt(bcs.U64.parse(ret!));
}

/** (active, kind, price, durationMs) for a product. */
export async function getProductInfo(
  client: ClientWithCoreApi,
  d: CommerceDeployment,
  p: { merchantId: string; productId: bigint | number },
): Promise<{ active: boolean; kind: number; price: bigint; durationMs: bigint }> {
  const rets = await simulateView(client, (tx) => {
    tx.moveCall({
      target: target(d, 'catalog', 'product_info'),
      arguments: [tx.object(p.merchantId), tx.pure.u64(p.productId)],
    });
  });
  return {
    active: bcs.Bool.parse(rets[0]!),
    kind: bcs.U8.parse(rets[1]!),
    price: BigInt(bcs.U64.parse(rets[2]!)),
    durationMs: BigInt(bcs.U64.parse(rets[3]!)),
  };
}
