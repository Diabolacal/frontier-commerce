/**
 * Generic testnet deployment: publish YOUR OWN sovereign Frontier Commerce
 * instance, driven entirely by a deploy config file - no IDs are hardcoded.
 *
 * What it does, in order:
 *   1. publishes `frontier_commerce` (fresh publish -> your own registry +
 *      ProtocolCap/ProtocolTreasurerCap/UpgradeCap land on the deployer)
 *   2. optionally publishes `mock_eve` (freely-mintable test currency, so a
 *      validation purchase never touches real EVE)
 *   3. creates your Merchant (deployer receives MerchantCap/OperatorCap/
 *      TreasurerCap) and every product in the config
 *   4. optionally executes a MOCK-priced validation purchase and asserts the
 *      entitlement semantics (granted key present, real keys NOT granted)
 *   5. writes `deployments/testnet.json` - the runtime descriptor your app,
 *      gas station, indexer and observability all load
 *
 * MUTATING: spends real testnet SUI (~0.3) and creates permanent objects.
 * Run deliberately. After it succeeds, move the caps to proper custody
 * (docs/key-management.md) - they all sit on the deployer address.
 *
 * Env:
 *   DEPLOY_CONFIG      path to your config (default:
 *                      examples/demo-consumer/deploy.config.json; start from
 *                      deploy.config.example.json)
 *   SUI_PRIVATE_KEY    suiprivkey... (bech32) - optional if keystore is used
 *   SUI_KEYSTORE_PATH  path to sui.keystore (default: ~/.sui/sui_config/sui.keystore)
 *   DEPLOYER_ADDRESS   address to select from the keystore (required with keystore)
 *   TESTNET_GRPC_URL   gRPC endpoint (default: fullnode.testnet.sui.io:443)
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import {
  buildCreateMerchantTx,
  buildCreateProductTx,
  buildPayTx,
  entitlementInfo,
  getProductInfo,
  getTreasuryValue,
  isEntitled,
  parseEventsFromTransaction,
  PRODUCT_KIND,
  type CommerceDeployment,
} from '@frontier-commerce/sdk';
import { chainIdHex, exec, oneCreated, publishPackage, suiBalance, testnetClient } from './chain.ts';

interface DeployCoin { coinType: string; decimals: number; symbol: string }
interface DeployProduct {
  name: string;
  kind: 'oneTime' | 'subscription';
  currency: string;
  priceRaw: string;
  durationMs?: number;
  entitlementKey?: string;
  metadataUri?: string;
}
interface DeployConfig {
  merchantName: string;
  coins: Record<string, DeployCoin>;
  publishMockEve?: boolean;
  products: DeployProduct[];
  validationPurchase?: { productName: string; assertNotGranted?: string[] };
}

function log(step: string): void {
  console.log(`\n=== ${step} ===`);
}

/** Load the deployer keypair without the secret ever leaving this process. */
function loadKeypair(): Ed25519Keypair {
  const pk = process.env.SUI_PRIVATE_KEY;
  if (pk) {
    const { secretKey } = decodeSuiPrivateKey(pk);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  const target = process.env.DEPLOYER_ADDRESS;
  if (!target) throw new Error('Set SUI_PRIVATE_KEY or DEPLOYER_ADDRESS (+ keystore)');
  const path =
    process.env.SUI_KEYSTORE_PATH ?? join(homedir(), '.sui', 'sui_config', 'sui.keystore');
  const entries = JSON.parse(readFileSync(path, 'utf8')) as string[];
  for (const b64 of entries) {
    const bytes = Buffer.from(b64, 'base64');
    if (bytes[0] !== 0x00) continue; // Ed25519 flag only
    const kp = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
    if (kp.getPublicKey().toSuiAddress() === target.toLowerCase()) return kp;
  }
  throw new Error(`No Ed25519 key for ${target} in ${path}`);
}

function loadConfig(): DeployConfig {
  const path = process.env.DEPLOY_CONFIG ?? 'examples/demo-consumer/deploy.config.json';
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `Deploy config not found at ${path}. Copy deploy.config.example.json to ` +
        `deploy.config.json, fill in YOUR values, and re-run (or set DEPLOY_CONFIG).`,
    );
  }
  const cfg = JSON.parse(raw) as DeployConfig;
  assert.ok(cfg.merchantName && !cfg.merchantName.includes('REPLACE'), 'config: set merchantName');
  assert.ok(cfg.products?.length, 'config: at least one product');
  for (const [symbol, coin] of Object.entries(cfg.coins ?? {})) {
    if (/REPLACE|</.test(coin.coinType)) {
      throw new Error(
        `config: coins.${symbol}.coinType is still a placeholder. Coin types are ` +
          `runtime configuration and rotate (EVE rotates every cycle) - verify the ` +
          `current on-chain coin type and paste it explicitly.`,
      );
    }
  }
  for (const p of cfg.products) {
    assert.ok(p.kind === 'oneTime' || p.kind === 'subscription', `config: product ${p.name}: kind must be oneTime|subscription`);
    assert.ok(/^\d+$/.test(p.priceRaw), `config: product ${p.name}: priceRaw must be a base-unit integer string`);
    if (p.kind === 'subscription') assert.ok(p.durationMs && p.durationMs > 0, `config: product ${p.name}: subscription needs durationMs`);
    const known = p.currency in (cfg.coins ?? {}) || (p.currency === 'MOCK' && cfg.publishMockEve);
    assert.ok(known, `config: product ${p.name}: currency ${p.currency} not in coins (MOCK requires publishMockEve)`);
  }
  return cfg;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = testnetClient(); // gRPC - JSON-RPC is gone from testnet
  const kp = loadKeypair();
  const addr = kp.getPublicKey().toSuiAddress();

  log(`Deployer ${addr} (gRPC testnet)`);
  const gasBefore = await suiBalance(client, addr);
  console.log('SUI balance:', Number(gasBefore) / 1e9);
  assert.ok(gasBefore > 500_000_000n, 'need at least 0.5 SUI');
  const chainId = await chainIdHex(client);
  assert.equal(chainId, '4c78adac', 'refusing to run outside Sui testnet');

  log('Publishing frontier_commerce (fresh publish - your own sovereign registry)');
  const commerce = await publishPackage(client, kp, 'move/frontier_commerce');
  const registryId = oneCreated(commerce.result, '::registry::CommerceRegistry');
  const protocolCapId = oneCreated(commerce.result, '::registry::ProtocolCap');
  const protocolTreasurerCapId = oneCreated(commerce.result, '::registry::ProtocolTreasurerCap');
  const upgradeCapId = oneCreated(commerce.result, '::package::UpgradeCap');
  console.log({ packageId: commerce.packageId, registryId, digest: commerce.digest });

  const coins: CommerceDeployment['coins'] = {};
  for (const [symbol, c] of Object.entries(cfg.coins)) {
    coins[symbol] = { coinType: c.coinType, decimals: c.decimals, symbol: c.symbol };
  }

  let mock: { packageId: string; digest: string } | null = null;
  let faucetId: string | null = null;
  if (cfg.publishMockEve) {
    log('Publishing mock_eve (freely-mintable test currency for validation purchases)');
    const pub = await publishPackage(client, kp, 'move/mock_eve');
    faucetId = oneCreated(pub.result, '::mock_eve::OpenFaucet');
    mock = { packageId: pub.packageId, digest: pub.digest };
    coins.MOCK = { coinType: `${pub.packageId}::mock_eve::MOCK_EVE`, decimals: 9, symbol: 'MOCK' };
    console.log({ mockPackageId: pub.packageId, faucetId });
  }

  const d: CommerceDeployment = {
    network: 'testnet',
    chainId,
    packageId: commerce.packageId,
    originalPackageId: commerce.packageId,
    registryId,
    publishDigest: commerce.digest,
    coins,
  };

  log(`Creating merchant "${cfg.merchantName}"`);
  const created = await exec(client, kp, buildCreateMerchantTx(d, cfg.merchantName));
  const merchantId = oneCreated(created, '::merchant::Merchant');
  const merchantCapId = oneCreated(created, '::merchant::MerchantCap');
  const operatorCapId = oneCreated(created, '::merchant::OperatorCap');
  const treasurerCapId = oneCreated(created, '::merchant::TreasurerCap');
  console.log({ merchantId });

  const productRecords: Record<string, Record<string, unknown>> = {};
  let productId = 0n;
  for (const p of cfg.products) {
    productId += 1n;
    const coinType = coins[p.currency]!.coinType;
    const price = BigInt(p.priceRaw);
    log(`Creating product ${productId}: ${p.name} (${p.kind}, ${p.priceRaw} base units of ${p.currency})`);
    await exec(client, kp, buildCreateProductTx(d, {
      merchantId,
      operatorCapId,
      name: p.name,
      kind: PRODUCT_KIND[p.kind],
      coinType,
      price,
      ...(p.durationMs ? { durationMs: BigInt(p.durationMs) } : {}),
      ...(p.entitlementKey ? { entitlementKey: p.entitlementKey } : {}),
      ...(p.metadataUri ? { metadataUri: p.metadataUri } : {}),
    }));
    const info = await getProductInfo(client, d, { merchantId, productId });
    assert.equal(info.active, true, `${p.name}: active on-chain`);
    assert.equal(info.price, price, `${p.name}: price matches config`);
    productRecords[p.name] = {
      productId: Number(productId),
      kind: p.kind,
      priceRaw: p.priceRaw,
      durationMs: p.durationMs,
      entitlementKey: p.entitlementKey,
      coinType,
    };
  }

  if (cfg.validationPurchase) {
    const target = cfg.products.find((p) => p.name === cfg.validationPurchase!.productName);
    assert.ok(target, `validationPurchase: unknown product ${cfg.validationPurchase.productName}`);
    assert.equal(target!.currency, 'MOCK',
      'validationPurchase must use a MOCK-priced product so automation never spends real currency');
    assert.ok(mock && faucetId, 'validationPurchase requires publishMockEve');
    const vProductId = BigInt(productRecords[target!.name]!.productId as number);
    const price = BigInt(target!.priceRaw);
    const MOCK_TYPE = coins.MOCK!.coinType;

    log(`Validation purchase: mint ${target!.priceRaw} MOCK, pay ${target!.name}`);
    {
      const tx = new Transaction();
      tx.moveCall({
        target: `${mock!.packageId}::mock_eve::mint`,
        arguments: [tx.object(faucetId!), tx.pure.u64(price), tx.pure.address(addr)],
      });
      await exec(client, kp, tx);
    }
    const payRes = await exec(client, kp, await buildPayTx(d, client, {
      merchantId,
      productId: vProductId,
      coinType: MOCK_TYPE,
      amount: price,
      payer: addr,
      externalRef: 'deploy-validation',
    }));
    console.log('Validation payment digest:', payRes.digest);
    const events = parseEventsFromTransaction(d, { digest: payRes.digest, events: payRes.events });
    assert.ok(events.find((e) => e.name === 'PaymentEvent'), 'PaymentEvent emitted');
    assert.ok(events.find((e) => e.name === 'EntitlementGrantedEvent'), 'EntitlementGrantedEvent emitted');

    log('Verifying entitlement semantics');
    const key = target!.entitlementKey;
    if (key) {
      assert.equal(await isEntitled(client, d, { merchantId, key, owner: addr }), true,
        `validation purchase grants ${key}`);
      const info = await entitlementInfo(client, d, { merchantId, key, owner: addr });
      if (target!.kind === 'subscription') {
        assert.ok(info.exists && info.expiresAtMs !== null, 'timed entitlement has expiry');
        console.log(`${key} expires at`, new Date(Number(info.expiresAtMs)).toISOString());
      }
    }
    for (const mustNot of cfg.validationPurchase.assertNotGranted ?? []) {
      assert.equal(await isEntitled(client, d, { merchantId, key: mustNot, owner: addr }), false,
        `validation purchase must NOT grant "${mustNot}" - keep real and smoke keys distinct`);
    }
    assert.equal(await getTreasuryValue(client, d, { merchantId, coinType: MOCK_TYPE }), price,
      'treasury holds the validation payment');
  }

  log('Writing deployments/testnet.json');
  const descriptor = {
    ...d,
    // Evidence + operational IDs (NOT secrets; caps are owned objects on the
    // deployer address and worthless without its key). Your app loads this
    // file at runtime; your indexer/observability read merchant/products
    // from `evidence.merchant`.
    evidence: {
      publishDigests: { commerce: commerce.digest, ...(mock ? { mockEve: mock.digest } : {}) },
      upgradeCapId,
      protocolCapId,
      protocolTreasurerCapId,
      merchant: {
        name: cfg.merchantName,
        merchantId,
        merchantCapId,
        operatorCapId,
        treasurerCapId,
        products: productRecords,
      },
      ...(mock ? { mockEve: { packageId: mock.packageId, faucetId } } : {}),
      operator: addr,
      ranAt: new Date().toISOString(),
    },
  };
  writeFileSync('deployments/testnet.json', `${JSON.stringify(descriptor, null, 2)}\n`);

  const gasAfter = await suiBalance(client, addr);
  console.log('\nSUI spent on deployment:', Number(gasBefore - gasAfter) / 1e9);
  console.log('\nTESTNET DEPLOYMENT COMPLETE');
  console.log('Next: move MerchantCap/TreasurerCap/ProtocolCap to proper custody (docs/key-management.md),');
  console.log('wire your app to deployments/testnet.json, and optionally stand up the gas station,');
  console.log('indexer and observability (observability/README.md).');
}

main().catch((e) => {
  console.error('\nTESTNET DEPLOYMENT FAILED:', e);
  process.exitCode = 1;
});
