/**
 * Read-only validation of the GraphQL event poller against YOUR live
 * testnet deployment: sweeps all events into a throwaway SQLite ledger,
 * proves cursor persistence + idempotent re-poll, and derives the
 * accounting ledger. Run it after deploy-testnet.ts (whose validation
 * purchase guarantees at least one payment event exists).
 *
 * Env (optional): MERCHANT_ID overrides evidence.merchant.merchantId.
 *
 *   node --experimental-strip-types examples/demo-consumer/src/validate-poller.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDeployment } from '@frontier-commerce/sdk';
import { buildMerchantLedgers, openLedger, pollOnce } from '@frontier-commerce/indexer';
import { testnetGraphqlUrl } from './chain.ts';

const raw = JSON.parse(readFileSync('deployments/testnet.json', 'utf8')) as {
  evidence?: { merchant?: { merchantId?: string } };
};
const d = parseDeployment(readFileSync('deployments/testnet.json', 'utf8'));
const MERCHANT = process.env.MERCHANT_ID ?? raw.evidence?.merchant?.merchantId;

const dbPath = join(mkdtempSync(join(tmpdir(), 'fc-poll-validate-')), 'ledger.sqlite');
const db = openLedger(dbPath);

const first = await pollOnce({ rpcUrl: testnetGraphqlUrl(), deployment: d, db });
console.log('first sweep:', first);
assert.ok(first.inserted > 0, 'expected at least one event (run deploy-testnet.ts first)');
assert.ok(first.cursor, 'opaque cursor persisted');

// Idempotency: cursor-resumed second sweep inserts nothing new.
const second = await pollOnce({ rpcUrl: testnetGraphqlUrl(), deployment: d, db });
console.log('second sweep (cursor-resumed):', second);
assert.equal(second.inserted, 0, 'no duplicates on re-poll');

const rows = db.db
  .prepare('SELECT tx_digest, event_name FROM raw_events ORDER BY rowid')
  .all() as Array<{ tx_digest: string; event_name: string }>;
console.log(`\n${rows.length} raw events captured:`);
for (const r of rows) console.log(` ${r.event_name.padEnd(28)} ${r.tx_digest.slice(0, 12)}…`);

// Ledger derivation works over the captured events.
const ledgers = buildMerchantLedgers(db);
if (MERCHANT) {
  const ledger = ledgers.get(MERCHANT);
  assert.ok(ledger, 'ledger derived for your merchant');
  console.log('\nledger paymentCount:', ledger!.paymentCount);
} else {
  console.log('\nmerchants in ledger:', [...ledgers.keys()].map((m) => `${m.slice(0, 10)}…`).join(', ') || '(none)');
}

db.close();
console.log('\nPOLLER VALIDATION PASSED');
