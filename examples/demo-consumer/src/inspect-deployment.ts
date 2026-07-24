/**
 * Read-only inspection of YOUR deployment's commerce state on testnet:
 * recent payment/entitlement events, product records, entitlement status
 * for chosen wallets, and merchant treasury/fee balances. No keys, no
 * mutations - safe to run any time.
 *
 * Reads deployments/testnet.json (as written by deploy-testnet.ts).
 *
 * Env (all optional):
 *   MERCHANT_ID   overrides evidence.merchant.merchantId from the descriptor
 *   ADDRESSES     comma-separated wallets to check entitlements for
 *                 (default: the descriptor's evidence.operator)
 *
 *   node --experimental-strip-types examples/demo-consumer/src/inspect-deployment.ts
 */
import { readFileSync } from 'node:fs';
import {
  entitlementInfo, getProductInfo, getTreasuryValue, getFeesAccruedValue,
  parseDeployment, eventType,
} from '@frontier-commerce/sdk';
import { testnetClient, testnetGraphqlUrl } from './chain.ts';

const raw = JSON.parse(readFileSync('deployments/testnet.json', 'utf8')) as {
  evidence?: {
    operator?: string;
    merchant?: { merchantId?: string; products?: Record<string, { productId: number; entitlementKey?: string }> };
  };
};
const d = parseDeployment(readFileSync('deployments/testnet.json', 'utf8'));

const MERCHANT = process.env.MERCHANT_ID ?? raw.evidence?.merchant?.merchantId;
if (!MERCHANT) throw new Error('Set MERCHANT_ID or include evidence.merchant.merchantId in the descriptor');
const ADDRESSES = (process.env.ADDRESSES ?? raw.evidence?.operator ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const products = Object.entries(raw.evidence?.merchant?.products ?? {});

const client = testnetClient(); // gRPC for object reads/views

// Event queries go over GraphQL - the only supported event-query transport
// (JSON-RPC removed 2026-07-31; gRPC has no event query in @mysten/sui 2.22).
interface GqlEventNode {
  timestamp: string | null;
  contents: { json: Record<string, unknown> | null } | null;
  transaction: { digest: string } | null;
}
async function queryEvents(moveEventType: string): Promise<GqlEventNode[]> {
  const r = await fetch(testnetGraphqlUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query($t: String!) { events(filter: { type: $t }, last: 20) {
        nodes { timestamp contents { json } transaction { digest } } } }`,
      variables: { t: moveEventType },
    }),
  });
  const j = (await r.json()) as {
    errors?: Array<{ message?: string }>;
    data?: { events?: { nodes?: GqlEventNode[] } };
  };
  if (j.errors?.length) throw new Error(j.errors[0]?.message ?? 'graphql error');
  return j.data?.events?.nodes ?? [];
}

function j(node: GqlEventNode): Record<string, unknown> {
  return node.contents?.json ?? {};
}

console.log('=== PaymentEvents (newest last) ===');
for (const ev of await queryEvents(eventType(d, 'PaymentEvent'))) {
  const p = j(ev);
  console.log(JSON.stringify({
    tx: ev.transaction?.digest,
    timestamp: ev.timestamp,
    payer: p.payer, beneficiary: p.beneficiary, product_id: p.product_id,
    amount: p.amount, fee: p.fee,
    currency: (p.currency as { name?: string } | undefined)?.name ?? p.currency,
    external_ref: p.external_ref,
  }));
}

console.log('\n=== EntitlementGrantedEvents ===');
for (const ev of await queryEvents(eventType(d, 'EntitlementGrantedEvent'))) {
  const g = j(ev);
  console.log(JSON.stringify({
    tx: ev.transaction?.digest,
    timestamp: ev.timestamp,
    key: g.key, owner: g.owner, expires_at_ms: g.expires_at_ms,
    source_payment_id: g.source_payment_id,
  }));
}

console.log('\n=== Products ===');
for (const [name, p] of products) {
  const info = await getProductInfo(client, d, { merchantId: MERCHANT, productId: BigInt(p.productId) });
  console.log(`product ${p.productId} (${name}):`, {
    active: info.active, kind: info.kind, price: info.price.toString(), durationMs: info.durationMs?.toString(),
  });
}

console.log('\n=== Entitlements ===');
const keys = [...new Set(products.map(([, p]) => p.entitlementKey).filter((k): k is string => !!k))];
for (const owner of ADDRESSES) {
  for (const key of keys) {
    const info = await entitlementInfo(client, d, { merchantId: MERCHANT, key, owner });
    console.log(`"${key}" for ${owner.slice(0, 10)}…:`, {
      exists: info.exists,
      expiresAtMs: info.expiresAtMs === null ? null : `${info.expiresAtMs} (${new Date(Number(info.expiresAtMs)).toISOString()})`,
    });
  }
}

console.log('\n=== Treasury / fees ===');
for (const [symbol, coin] of Object.entries(d.coins)) {
  console.log(`treasury ${symbol}:`, (await getTreasuryValue(client, d, { merchantId: MERCHANT, coinType: coin.coinType })).toString());
  console.log(`fees ${symbol}:`, (await getFeesAccruedValue(client, d, { merchantId: MERCHANT, coinType: coin.coinType })).toString());
}
