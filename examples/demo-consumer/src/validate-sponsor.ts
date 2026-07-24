/**
 * Live validation of YOUR gas station: builds a real `payments::pay`
 * TransactionKind for a wallet you name and requests sponsorship. The
 * sponsored bytes are DISCARDED - no user signature ever exists, nothing
 * can execute, no funds move. Also probes the fail-closed path with an
 * off-policy target, which the station must reject.
 *
 * Env:
 *   SPONSOR_URL   your gas station base URL (required)
 *   SENDER        wallet address the payment would come from (required;
 *                 no key needed - sponsorship happens before any signing)
 *   MERCHANT_ID   overrides evidence.merchant.merchantId
 *   PRODUCT_ID    product to price the tx against (default 1)
 *   CURRENCY      coin symbol from the descriptor to pay in (default: first)
 *
 *   node --experimental-strip-types examples/demo-consumer/src/validate-sponsor.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Transaction } from '@mysten/sui/transactions';
import { buildPayTx, buildTransactionKindBytes, getProductInfo, parseDeployment, requestSponsorship, sponsoredTransactionFromB64 } from '@frontier-commerce/sdk';
import { testnetClient } from './chain.ts';

const raw = JSON.parse(readFileSync('deployments/testnet.json', 'utf8')) as {
  evidence?: { merchant?: { merchantId?: string } };
};
const d = parseDeployment(readFileSync('deployments/testnet.json', 'utf8'));

const SPONSOR_URL = process.env.SPONSOR_URL;
if (!SPONSOR_URL) throw new Error('Set SPONSOR_URL to your own gas station');
const SENDER = process.env.SENDER;
if (!SENDER) throw new Error('Set SENDER to the wallet address the payment would come from');
const MERCHANT = process.env.MERCHANT_ID ?? raw.evidence?.merchant?.merchantId;
if (!MERCHANT) throw new Error('Set MERCHANT_ID or include evidence.merchant.merchantId in the descriptor');
const PRODUCT_ID = BigInt(process.env.PRODUCT_ID ?? '1');
const symbol = process.env.CURRENCY ?? Object.keys(d.coins)[0]!;
const COIN = d.coins[symbol]?.coinType;
if (!COIN) throw new Error(`Currency ${symbol} not in descriptor coins`);

const client = testnetClient();

// 1. A real product transaction, priced from live on-chain state.
const info = await getProductInfo(client, d, { merchantId: MERCHANT, productId: PRODUCT_ID });
const payTx = await buildPayTx(d, client, {
  merchantId: MERCHANT,
  productId: PRODUCT_ID,
  coinType: COIN,
  amount: info.price,
  payer: SENDER,
  externalRef: 'sponsor-validation-dry',
});
payTx.setSender(SENDER);
const kindB64 = await buildTransactionKindBytes(payTx, client);

console.log('requesting sponsorship (real pay kind, will be discarded)…');
const res = await requestSponsorship({ url: SPONSOR_URL }, kindB64, SENDER);
assert.ok(res.txB64 && res.sponsorSignature, 'station returned sponsored bytes + signature');
const sponsored = sponsoredTransactionFromB64(res.txB64);
const data = sponsored.getData();
assert.equal(data.sender?.toLowerCase(), SENDER.toLowerCase(), 'sender preserved (payer attribution intact)');
assert.ok(data.gasData.owner && data.gasData.owner.toLowerCase() !== SENDER.toLowerCase(), 'gas owned by the sponsor, not the user');
console.log('OK: sponsored tx built. sender:', data.sender?.slice(0, 12), '… gas owner:', String(data.gasData.owner).slice(0, 12), '…');
console.log('(bytes discarded - no user signature exists, nothing can execute)');

// 2. Fail-closed probe: a target outside your policy must be rejected.
const evil = new Transaction();
evil.moveCall({ target: '0x2::coin::zero', typeArguments: [COIN], arguments: [] });
evil.setSender(SENDER);
const evilKind = await buildTransactionKindBytes(evil, client);
let rejected = false;
try {
  await requestSponsorship({ url: SPONSOR_URL }, evilKind, SENDER);
} catch (e) {
  rejected = true;
  console.log('OK: off-policy target rejected:', (e as Error).message.slice(0, 90));
}
assert.ok(rejected, 'station must reject targets outside your policy allowlist');

console.log('\nSPONSOR VALIDATION PASSED');
