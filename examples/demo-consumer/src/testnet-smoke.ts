/**
 * Testnet smoke test - proves the layer against the REAL chain + REAL EVE.
 *
 * What it does (all with one operator key - explicitly a testnet-pragmatic
 * posture; role separation is exercised on localnet and enforced by object
 * capabilities, not by this script):
 *   1. Publishes frontier_commerce + mock_eve to the active testnet.
 *   2. Writes deployments/testnet.json (IDs + digests as evidence).
 *   3. Creates a merchant, one MOCK product, and one REAL-EVE product.
 *   4. Pays the EVE product with the wallet's actual EVE (Stillness assets
 *      package) - then withdraws the proceeds back to the same wallet, so
 *      the net EVE cost is ~zero and the flow is fully exercised.
 *   5. Mints MOCK and pays the MOCK product (publicly repeatable path).
 *   6. Verifies entitlements via view reads; polls events into the indexer
 *      and prints the reconciled ledger.
 *
 * Env:
 *   SUI_PRIVATE_KEY      suiprivkey... (bech32) - REQUIRED, never stored
 *   TESTNET_GRPC_URL     gRPC fullnode (default: fullnode.testnet.sui.io:443)
 *   TESTNET_GRAPHQL_URL  GraphQL endpoint for event polling (default:
 *                        graphql.testnet.sui.io/graphql). JSON-RPC is gone.
 *   EVE_COIN_TYPE        full Coin type of testnet EVE - REQUIRED for step 4;
 *                        omit to skip the real-EVE payment.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import {
  buildCreateMerchantTx,
  buildCreateProductTx,
  buildPayTx,
  buildWithdrawTx,
  getFeesAccruedValue,
  getTreasuryValue,
  isEntitled,
  parseEventsFromTransaction,
  PRODUCT_KIND,
  type CommerceDeployment,
} from '@frontier-commerce/sdk';
import {
  buildMerchantLedgers,
  formatLedgerReport,
  openLedger,
  pollOnce,
} from '@frontier-commerce/indexer';
import {
  chainIdHex, coinBalance, exec, oneCreated, publishPackage, suiBalance,
  testnetClient, testnetGraphqlUrl,
} from './chain.ts';

const EVE_DECIMALS = 9n;
const ONE_EVE = 10n ** EVE_DECIMALS;

function log(step: string): void {
  console.log(`\n=== ${step} ===`);
}

async function main(): Promise<void> {
  const pk = process.env.SUI_PRIVATE_KEY;
  if (!pk) throw new Error('SUI_PRIVATE_KEY (suiprivkey...) is required');
  const eveType = process.env.EVE_COIN_TYPE ?? null;

  // gRPC for reads/writes; GraphQL only for the indexer's event polling.
  const client = testnetClient();
  const graphqlUrl = testnetGraphqlUrl();
  const { secretKey } = decodeSuiPrivateKey(pk);
  const kp = Ed25519Keypair.fromSecretKey(secretKey);
  const addr = kp.getPublicKey().toSuiAddress();

  log(`Operator ${addr} (gRPC testnet)`);
  const gasBefore = await suiBalance(client, addr);
  console.log('SUI balance:', Number(gasBefore) / 1e9);
  assert.ok(gasBefore > 500_000_000n, 'need at least 0.5 SUI for the smoke test');
  const chainId = await chainIdHex(client);
  assert.equal(chainId, '4c78adac', 'refusing to run outside Sui testnet');

  log('Publishing frontier_commerce to testnet');
  const commerce = await publishPackage(client, kp, 'move/frontier_commerce');
  const registryId = oneCreated(commerce.result, '::registry::CommerceRegistry');
  const protocolCapId = oneCreated(commerce.result, '::registry::ProtocolCap');
  const protocolTreasurerCapId = oneCreated(commerce.result, '::registry::ProtocolTreasurerCap');
  const upgradeCapId = oneCreated(commerce.result, '::package::UpgradeCap');
  console.log({ packageId: commerce.packageId, registryId, digest: commerce.digest });

  log('Publishing mock_eve to testnet');
  const mock = await publishPackage(client, kp, 'move/mock_eve');
  const faucetId = oneCreated(mock.result, '::mock_eve::OpenFaucet');
  const MOCK_TYPE = `${mock.packageId}::mock_eve::MOCK_EVE`;
  console.log({ mockPackageId: mock.packageId, faucetId, digest: mock.digest });

  const d: CommerceDeployment = {
    network: 'testnet',
    chainId,
    packageId: commerce.packageId,
    originalPackageId: commerce.packageId,
    registryId,
    publishDigest: commerce.digest,
    coins: {
      MOCK: { coinType: MOCK_TYPE, decimals: 9, symbol: 'MOCK' },
      ...(eveType ? { EVE: { coinType: eveType, decimals: 9, symbol: 'EVE' } } : {}),
    },
  };

  log('Creating merchant "fc-smoke"');
  const created = await exec(client, kp, buildCreateMerchantTx(d, 'fc-smoke'));
  const merchantId = oneCreated(created, '::merchant::Merchant');
  const merchantCapId = oneCreated(created, '::merchant::MerchantCap');
  const operatorCapId = oneCreated(created, '::merchant::OperatorCap');
  const treasurerCapId = oneCreated(created, '::merchant::TreasurerCap');
  console.log({ merchantId });

  log('Creating products (MOCK unlock + optional real-EVE supporter pack)');
  await exec(client, kp, buildCreateProductTx(d, {
    merchantId,
    operatorCapId,
    name: 'smoke-unlock',
    kind: PRODUCT_KIND.oneTime,
    coinType: MOCK_TYPE,
    price: 5n * ONE_EVE,
    entitlementKey: 'smoke-pro',
  }));
  const mockProductId = 1n;

  let eveProductId: bigint | null = null;
  if (eveType) {
    await exec(client, kp, buildCreateProductTx(d, {
      merchantId,
      operatorCapId,
      name: 'supporter-pack',
      kind: PRODUCT_KIND.oneTime,
      coinType: eveType,
      price: ONE_EVE / 4n, // 0.25 EVE
      entitlementKey: 'supporter',
    }));
    eveProductId = 2n;
  }

  log('Minting MOCK and paying the MOCK product');
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${mock.packageId}::mock_eve::mint`,
      arguments: [tx.object(faucetId), tx.pure.u64(10n * ONE_EVE), tx.pure.address(addr)],
    });
    await exec(client, kp, tx);
  }
  const payRes = await exec(client, kp, await buildPayTx(d, client, {
    merchantId,
    productId: mockProductId,
    coinType: MOCK_TYPE,
    amount: 5n * ONE_EVE,
    payer: addr,
    externalRef: 'testnet-smoke-mock',
  }));
  console.log('MOCK payment digest:', payRes.digest);
  assert.equal(await isEntitled(client, d, { merchantId, key: 'smoke-pro', owner: addr }), true);

  if (eveType && eveProductId) {
    log('Paying the supporter pack with REAL testnet EVE (0.25 EVE)');
    const eveBefore = await coinBalance(client, addr, eveType);
    console.log('EVE balance before:', Number(eveBefore) / 1e9);
    assert.ok(eveBefore >= ONE_EVE / 4n, 'wallet lacks 0.25 EVE');
    const evePay = await exec(client, kp, await buildPayTx(d, client, {
      merchantId,
      productId: eveProductId,
      coinType: eveType,
      amount: ONE_EVE / 4n,
      payer: addr,
      externalRef: 'testnet-smoke-real-eve',
    }));
    console.log('REAL EVE payment digest:', evePay.digest);
    const events = parseEventsFromTransaction(d, { digest: evePay.digest, events: evePay.events });
    const pe = events.find((e) => e.name === 'PaymentEvent');
    assert.ok(pe, 'PaymentEvent for real EVE');
    assert.equal(await isEntitled(client, d, { merchantId, key: 'supporter', owner: addr }), true);
    assert.equal(
      await getTreasuryValue(client, d, { merchantId, coinType: eveType }),
      ONE_EVE / 4n,
    );

    log('Withdrawing the EVE proceeds back to the operator wallet');
    await exec(client, kp, buildWithdrawTx(d, {
      merchantId, treasurerCapId, coinType: eveType, amount: ONE_EVE / 4n, to: addr,
    }));
    const eveAfter = await coinBalance(client, addr, eveType);
    console.log('EVE balance after round-trip:', Number(eveAfter) / 1e9);
    assert.equal(eveAfter, eveBefore, 'EVE fully round-tripped (fee is 0)');
  }

  log('Indexer poll + ledger report');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fc-testnet-')), 'ledger.sqlite');
  const db = openLedger(dbPath);
  const poll = await pollOnce({ rpcUrl: graphqlUrl, deployment: d, db });
  console.log(`indexed ${poll.inserted} events`);
  const ledgers = buildMerchantLedgers(db);
  console.log(formatLedgerReport(ledgers, () => 9));
  const ledger = ledgers.get(merchantId);
  assert.ok(ledger && ledger.paymentCount >= (eveType ? 2 : 1), 'ledger captured payments');
  db.close();

  log('Writing deployments/testnet.json');
  const descriptor = {
    ...d,
    // Evidence + operational IDs (NOT secrets; caps are owned by the
    // operator address and worthless without its key).
    evidence: {
      publishDigests: { commerce: commerce.digest, mockEve: mock.digest },
      upgradeCapId,
      protocolCapId,
      protocolTreasurerCapId,
      smokeMerchant: { merchantId, merchantCapId, operatorCapId, treasurerCapId },
      mockEve: { packageId: mock.packageId, faucetId },
      operator: addr,
      ranAt: new Date().toISOString(),
    },
  };
  writeFileSync('deployments/testnet.json', `${JSON.stringify(descriptor, null, 2)}\n`);

  const gasAfter = await suiBalance(client, addr);
  console.log('\nSUI spent on smoke test:', Number(gasBefore - gasAfter) / 1e9);
  console.log('\nTESTNET SMOKE PASSED');
}

main().catch((e) => {
  console.error('\nTESTNET SMOKE FAILED:', e);
  process.exitCode = 1;
});
