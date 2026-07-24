/**
 * "Starmap Plus" - a fictional consumer app driving the commerce layer
 * end-to-end against a LOCAL Sui network, exactly the way a real product
 * would: publish once, configure a merchant, then run user flows through
 * the SDK (including a gas-station-sponsored payment) and reconcile the
 * indexer's event ledger against on-chain treasury state.
 *
 * Prereq: `sui start --with-faucet --with-graphql --force-regenesis` running
 * locally (--with-graphql serves :9125 for the indexer's event polling — the
 * poller is GraphQL-only since the 2026-07 JSON-RPC removal).
 * Run:    pnpm --filter @frontier-commerce/demo-consumer demo:localnet
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import {
  buildChargeCreditsTx,
  buildCreateMerchantTx,
  buildCreateProductTx,
  buildDepositCreditsTx,
  buildDistributeTx,
  buildPayTx,
  buildRefundTx,
  buildSetCreditsEnabledTx,
  buildSetProtocolFeeTx,
  buildSetRefundWindowTx,
  buildSetSplitPolicyTx,
  buildSweepFeesTx,
  buildTransactionKindBytes,
  buildWithdrawCreditsTx,
  executeSponsored,
  getCreditBalance,
  getFeesAccruedValue,
  getMerchantSummary,
  getRegistrySummary,
  getTreasuryValue,
  isEntitled,
  entitlementInfo,
  parseEventsFromTransaction,
  requestSponsorship,
  sponsoredTransactionFromB64,
  PRODUCT_KIND,
  type CommerceDeployment,
} from '@frontier-commerce/sdk';
import { startServer } from '@frontier-commerce/gas-station';
import { buildMerchantLedgers, expectedTreasury, formatLedgerReport, openLedger, pollOnce } from '@frontier-commerce/indexer';
import {
  coinBalance,
  exec,
  faucetFund,
  localnetClient,
  oneCreated,
  publishPackage,
  suiBalance,
} from './chain.ts';

const DAY_MS = 86_400_000n;
const MOCK = 1_000_000_000n; // 9 decimals, like EVE

function log(step: string): void {
  console.log(`\n=== ${step} ===`);
}

async function main(): Promise<void> {
  const client = localnetClient();

  // --- Actors: three separate keys, three separate duties ---
  const protocolKp = Ed25519Keypair.generate();
  const merchantKp = Ed25519Keypair.generate();
  const userKp = Ed25519Keypair.generate();
  const protocolAddr = protocolKp.getPublicKey().toSuiAddress();
  const merchantAddr = merchantKp.getPublicKey().toSuiAddress();
  const userAddr = userKp.getPublicKey().toSuiAddress();
  const partnerAddr = Ed25519Keypair.generate().getPublicKey().toSuiAddress();

  log('Funding actors from localnet faucet');
  await faucetFund(protocolAddr);
  await faucetFund(merchantAddr);
  await faucetFund(userAddr);
  console.log({ protocolAddr, merchantAddr, userAddr });

  // --- Publish packages (protocol = deployer) ---
  log('Publishing frontier_commerce');
  const commerce = await publishPackage(client, protocolKp, 'move/frontier_commerce');
  const registryId = oneCreated(commerce.result, '::registry::CommerceRegistry');
  const protocolCapId = oneCreated(commerce.result, '::registry::ProtocolCap');
  const protocolTreasurerCapId = oneCreated(commerce.result, '::registry::ProtocolTreasurerCap');
  console.log({ packageId: commerce.packageId, registryId });

  log('Publishing mock_eve');
  const mock = await publishPackage(client, protocolKp, 'move/mock_eve');
  const faucetId = oneCreated(mock.result, '::mock_eve::OpenFaucet');
  const MOCK_TYPE = `${mock.packageId}::mock_eve::MOCK_EVE`;
  console.log({ mockPackageId: mock.packageId, faucetId });

  const d: CommerceDeployment = {
    network: 'localnet',
    packageId: commerce.packageId,
    originalPackageId: commerce.packageId,
    registryId,
    coins: { MOCK: { coinType: MOCK_TYPE, decimals: 9, symbol: 'MOCK' } },
  };

  // --- Protocol config: 2.5% fee ---
  log('Setting protocol fee to 250 bps');
  await exec(client, protocolKp, buildSetProtocolFeeTx(d, { protocolCapId, feeBps: 250 }));
  const reg = await getRegistrySummary(client, d);
  assert.equal(reg.feeBps, 250n);
  assert.equal(reg.paused, false);

  // --- Merchant setup ---
  log('Creating merchant "starmap-plus"');
  const created = await exec(client, merchantKp, buildCreateMerchantTx(d, 'starmap-plus'));
  const merchantId = oneCreated(created, '::merchant::Merchant');
  const merchantCapId = oneCreated(created, '::merchant::MerchantCap');
  const operatorCapId = oneCreated(created, '::merchant::OperatorCap');
  const treasurerCapId = oneCreated(created, '::merchant::TreasurerCap');

  log('Configuring merchant: refund window 7d, credits on, split 70/25');
  await exec(client, merchantKp, buildSetRefundWindowTx(d, {
    merchantId, merchantCapId, windowMs: 7n * DAY_MS,
  }));
  await exec(client, merchantKp, buildSetCreditsEnabledTx(d, {
    merchantId, merchantCapId, enabled: true,
  }));
  await exec(client, merchantKp, buildSetSplitPolicyTx(d, {
    merchantId,
    merchantCapId,
    recipients: [merchantAddr, partnerAddr],
    bps: [7000, 2500],
    enforce: false,
  }));

  log('Creating products');
  const proUnlock = await exec(client, merchantKp, buildCreateProductTx(d, {
    merchantId,
    operatorCapId,
    name: 'pro-unlock',
    kind: PRODUCT_KIND.oneTime,
    coinType: MOCK_TYPE,
    price: 5n * MOCK,
    entitlementKey: 'pro',
    metadataUri: 'https://starmap.example/products/pro',
  }));
  const proProductId = 1n;
  const subMonthly = await exec(client, merchantKp, buildCreateProductTx(d, {
    merchantId,
    operatorCapId,
    name: 'premium-month',
    kind: PRODUCT_KIND.subscription,
    coinType: MOCK_TYPE,
    price: 2n * MOCK,
    durationMs: 30n * DAY_MS,
    entitlementKey: 'premium',
  }));
  const subProductId = 2n;
  void proUnlock;
  void subMonthly;

  // --- User acquires MOCK and buys ---
  log('User mints 100 MOCK from the open faucet');
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${mock.packageId}::mock_eve::mint`,
      arguments: [tx.object(faucetId), tx.pure.u64(100n * MOCK), tx.pure.address(userAddr)],
    });
    await exec(client, userKp, tx);
  }
  assert.equal(await coinBalance(client, userAddr, MOCK_TYPE), 100n * MOCK);

  log('User buys pro-unlock (5 MOCK, one-time, entitlement "pro")');
  const payRes = await exec(client, userKp, await buildPayTx(d, client, {
    merchantId,
    productId: proProductId,
    coinType: MOCK_TYPE,
    amount: 5n * MOCK,
    payer: userAddr,
    externalRef: 'order-0001',
  }));
  const payEvents = parseEventsFromTransaction(d, { digest: payRes.digest, events: payRes.events });
  const paymentEvent = payEvents.find((e) => e.name === 'PaymentEvent');
  assert.ok(paymentEvent, 'PaymentEvent emitted');
  assert.equal((paymentEvent as { amount: bigint }).amount, 5n * MOCK);
  assert.equal((paymentEvent as { externalRef: string | null }).externalRef, 'order-0001');
  const proFee = (5n * MOCK * 250n) / 10_000n;
  assert.equal(await getTreasuryValue(client, d, { merchantId, coinType: MOCK_TYPE }), 5n * MOCK - proFee);
  assert.equal(await getFeesAccruedValue(client, d, { merchantId, coinType: MOCK_TYPE }), proFee);
  assert.equal(await isEntitled(client, d, { merchantId, key: 'pro', owner: userAddr }), true);
  assert.equal(await isEntitled(client, d, { merchantId, key: 'premium', owner: userAddr }), false);

  log('User buys 2 months of premium subscription (4 MOCK)');
  await exec(client, userKp, await buildPayTx(d, client, {
    merchantId,
    productId: subProductId,
    quantity: 2n,
    coinType: MOCK_TYPE,
    amount: 4n * MOCK,
    payer: userAddr,
  }));
  const premium = await entitlementInfo(client, d, { merchantId, key: 'premium', owner: userAddr });
  assert.ok(premium.exists && premium.expiresAtMs !== null);
  console.log('premium expires at', new Date(Number(premium.expiresAtMs)).toISOString());

  // --- Credits ---
  log('User deposits 10 MOCK credits; operator charges 3; user withdraws rest');
  await exec(client, userKp, await buildDepositCreditsTx(d, client, {
    merchantId, coinType: MOCK_TYPE, amount: 10n * MOCK, owner: userAddr,
  }));
  assert.equal(await getCreditBalance(client, d, { merchantId, coinType: MOCK_TYPE, owner: userAddr }), 10n * MOCK);
  await exec(client, merchantKp, buildChargeCreditsTx(d, {
    merchantId, operatorCapId, coinType: MOCK_TYPE, owner: userAddr,
    amount: 3n * MOCK, memo: 'route-calc-batch-42',
  }));
  assert.equal(await getCreditBalance(client, d, { merchantId, coinType: MOCK_TYPE, owner: userAddr }), 7n * MOCK);
  await exec(client, userKp, buildWithdrawCreditsTx(d, {
    merchantId, coinType: MOCK_TYPE, amount: 7n * MOCK, owner: userAddr,
  }));
  assert.equal(await getCreditBalance(client, d, { merchantId, coinType: MOCK_TYPE, owner: userAddr }), 0n);
  const chargeFee = (3n * MOCK * 250n) / 10_000n;

  // --- Refund ---
  log('Treasurer refunds 2 MOCK of the pro-unlock payment (no revoke)');
  const userMockBefore = await coinBalance(client, userAddr, MOCK_TYPE);
  await exec(client, merchantKp, buildRefundTx(d, {
    merchantId, treasurerCapId, coinType: MOCK_TYPE,
    paymentId: (paymentEvent as { paymentId: bigint }).paymentId,
    amount: 2n * MOCK,
  }));
  assert.equal(await coinBalance(client, userAddr, MOCK_TYPE), userMockBefore + 2n * MOCK);
  assert.equal(await isEntitled(client, d, { merchantId, key: 'pro', owner: userAddr }), true);

  // --- Sponsored payment through the real gas station ---
  log('Sponsored payment: user pays 2 MOCK with ZERO SUI spent (gas station)');
  const stationEnv = {
    SPONSOR_ENABLED: 'true',
    SPONSOR_PRIVATE_KEY: protocolKp.getSecretKey(),
    // The station's client is now gRPC; localnet fullnodes serve gRPC on :9000.
    SUI_RPC_URL: 'http://127.0.0.1:9000',
    SUI_NETWORK: 'localnet',
    APP_POLICIES: JSON.stringify({
      apps: [{
        name: 'starmap-plus',
        allowedTargets: [
          `${commerce.packageId}::payments::pay`,
          `${mock.packageId}::mock_eve::mint_coin`,
        ],
        maxCommands: 8,
      }],
    }),
    GAS_BUDGET_MIST: '50000000',
    PORT: '8790',
  };
  const server = startServer(stationEnv);
  try {
    const userSuiBefore = await suiBalance(client, userAddr);
    // Build the payment as a TransactionKind (no gas info at all).
    const payTx = await buildPayTx(d, client, {
      merchantId,
      productId: subProductId,
      coinType: MOCK_TYPE,
      amount: 2n * MOCK,
      payer: userAddr,
      externalRef: 'sponsored-0001',
    });
    const kindB64 = await buildTransactionKindBytes(payTx, client);
    const sponsorship = await requestSponsorship(
      { url: 'http://127.0.0.1:8790' }, kindB64, userAddr,
    );
    const sponsoredTx = sponsoredTransactionFromB64(sponsorship.txB64);
    const txBytes = await sponsoredTx.build({ client });
    const { signature: userSig } = await userKp.signTransaction(txBytes);
    const { digest } = await executeSponsored(client, sponsorship.txB64, [
      userSig,
      sponsorship.sponsorSignature,
    ]);
    await client.core.waitForTransaction({ digest });
    const userSuiAfter = await suiBalance(client, userAddr);
    assert.equal(userSuiAfter, userSuiBefore, 'user paid zero gas');
    console.log('sponsored tx digest:', digest);

    // Adversarial check: the station must refuse a non-allowlisted call.
    const evilTx = new Transaction();
    evilTx.moveCall({
      target: `${commerce.packageId}::merchant::create_merchant`,
      arguments: [evilTx.pure.string('evil')],
    });
    const evilKind = await buildTransactionKindBytes(evilTx, client);
    let refused = false;
    try {
      await requestSponsorship({ url: 'http://127.0.0.1:8790' }, evilKind, userAddr);
    } catch {
      refused = true;
    }
    assert.ok(refused, 'gas station refused non-allowlisted target');
  } finally {
    server.close();
  }

  // --- Distribution + fee sweep ---
  log('Treasurer distributes per split policy; protocol sweeps fees');
  const partnerBefore = await coinBalance(client, partnerAddr, MOCK_TYPE);
  const treasuryBefore = await getTreasuryValue(client, d, { merchantId, coinType: MOCK_TYPE });
  await exec(client, merchantKp, buildDistributeTx(d, {
    merchantId, treasurerCapId, coinType: MOCK_TYPE,
  }));
  const partnerAfter = await coinBalance(client, partnerAddr, MOCK_TYPE);
  assert.equal(partnerAfter - partnerBefore, (treasuryBefore * 2500n) / 10_000n);

  await exec(client, protocolKp, buildSweepFeesTx(d, {
    merchantId, protocolTreasurerCapId, coinType: MOCK_TYPE, to: protocolAddr,
  }));
  assert.equal(await getFeesAccruedValue(client, d, { merchantId, coinType: MOCK_TYPE }), 0n);
  const protocolMock = await coinBalance(client, protocolAddr, MOCK_TYPE);
  const expectedFees = proFee + chargeFee + ((4n * MOCK * 250n) / 10_000n) + ((2n * MOCK * 250n) / 10_000n);
  assert.equal(protocolMock, expectedFees, 'protocol received exactly the accrued fees');

  // --- Indexer reconciliation ---
  // Localnet GraphQL (:9125) requires `sui start --with-graphql`, which needs
  // a local PostgreSQL. On machines without it the poller step is skipped
  // with an honest warning — the poller has its own vitest suite plus a live
  // testnet validation script (validate-poller-testnet.ts); everything else
  // in this demo remains fully asserted.
  log('Indexer: polling events and reconciling ledger vs chain');
  const graphqlUp = await fetch('http://127.0.0.1:9125/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ chainIdentifier }' }),
  }).then((r) => r.ok).catch(() => false);
  if (!graphqlUp) {
    console.warn(
      'WARNING: localnet GraphQL (:9125) is not running — indexer reconciliation SKIPPED. ' +
      'Start localnet with `sui start --with-faucet --with-graphql --force-regenesis` (requires local PostgreSQL) for full coverage.',
    );
  } else {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'fc-ledger-')), 'ledger.sqlite');
    const db = openLedger(dbPath);
    const poll = await pollOnce({ rpcUrl: 'http://127.0.0.1:9125/graphql', deployment: d, db });
    console.log(`indexed ${poll.inserted} events`);
    const ledgers = buildMerchantLedgers(db);
    const ledger = ledgers.get(merchantId);
    assert.ok(ledger, 'ledger exists for merchant');
    assert.equal(ledger.paymentCount, 3);
    assert.equal(ledger.refundCount, 1);
    const chainTreasury = await getTreasuryValue(client, d, { merchantId, coinType: MOCK_TYPE });
    assert.equal(ledger.unattributedRefunds, 0n, 'all refunds attributed to a currency');
    const ledgerTreasury = expectedTreasury(ledger, MOCK_TYPE.replace(/^0x/, '0x'));
    assert.equal(
      ledgerTreasury, chainTreasury,
      `event-derived treasury (${ledgerTreasury}) == on-chain treasury (${chainTreasury})`,
    );
    console.log(formatLedgerReport(ledgers, () => 9));
    db.close();
  }

  // --- Final state summary ---
  const summary = await getMerchantSummary(client, merchantId);
  console.log('\nmerchant summary:', {
    name: summary.name,
    nextPaymentId: summary.nextPaymentId,
    operatorCaps: summary.operatorCapIds.length,
    treasurerCaps: summary.treasurerCapIds.length,
  });

  console.log('\nALL DEMO ASSERTIONS PASSED');
}

main().catch((e) => {
  console.error('\nDEMO FAILED:', e);
  process.exitCode = 1;
});
