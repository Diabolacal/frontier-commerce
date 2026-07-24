# Integration guide

How a consumer application (EF-Map is the first; yours can be next) adopts
the commerce layer. The complete, runnable reference is
`examples/demo-consumer/src/run-demo.ts` - every snippet below is exercised
there or in the testnet smoke script.

> **Whose deployment?** Everything below assumes a published
> `frontier_commerce` package + registry. If you are not part of the
> authors' projects, publish your own instance first (see "The deployment
> model" in the [README](../README.md)) - the descriptor referenced
> throughout is then *your* descriptor, not the one committed in this repo.

## 0. What you need

- The deployment descriptor for your network: `deployments/<network>.json`
  (packageId, originalPackageId, registryId, coin types). Load it at
  runtime; never hard-code IDs in app code.
- Your own `Merchant` object + caps (one-time setup, below).
- `@frontier-commerce/sdk` (not published to npm; `"private": true` only
  blocks registry publishing - the consumption paths below all work).

**Consuming the SDK from an app outside this repo** - proven options, in
order of preference:

1. **Git submodule + workspace** (what the authors do): add this repo as a
   submodule of your app repo and include
   `<submodule>/packages/sdk` (and `packages/indexer` if you use it) in
   your `pnpm-workspace.yaml`; depend on `"@frontier-commerce/sdk":
   "workspace:*"`. Pins an exact upstream commit; updates are deliberate.
2. **File dependency on a built checkout:** clone this repo next to your
   app, `pnpm --filter @frontier-commerce/sdk build`, then depend on
   `"@frontier-commerce/sdk": "file:../frontier-commerce/packages/sdk"`.
3. **Publish to your own scope:** fork, rename the package into your npm
   scope, remove `"private": true` in your fork, publish. Apache-2.0
   permits this; please keep the licence/NOTICE intact.

## 1. One-time merchant setup (owner, from a trusted machine)

```ts
import { buildCreateMerchantTx, buildCreateProductTx, PRODUCT_KIND } from '@frontier-commerce/sdk';

// 1) Create your merchant - sender receives MerchantCap + OperatorCap + TreasurerCap.
await exec(client, ownerKeypair, buildCreateMerchantTx(d, 'my-app'));

// 2) Configure (root cap): refund window if you want refunds, credits if used,
//    split policy if revenue-sharing. See buildSet*Tx builders.

// 3) Products (operator cap). Currency binds HERE, per product, from config:
await exec(client, ownerKp, buildCreateProductTx(d, {
  merchantId, operatorCapId,
  name: 'pro-annual',
  kind: PRODUCT_KIND.subscription,
  coinType: d.coins.EVE!.coinType,     // config, not constant
  price: 12n * 10n ** 9n,              // base units (EVE has 9 decimals)
  durationMs: 365n * 86_400_000n,
  entitlementKey: 'pro',
}));
```

Then move the caps to their proper custody (key-management.md): MerchantCap
cold, OperatorCap to your backend, TreasurerCap to finance.

## 2. Wallet checkout (frontend)

Works with any Sui wallet-standard wallet (EVE Vault / in-game SSU wallet
included - detect via `preferredWallets: ['EVE Vault', 'EVE Frontier Client
Wallet']` exactly as Flappy Frontier does). With dapp-kit:

```ts
import { buildPayTx } from '@frontier-commerce/sdk';

const tx = await buildPayTx(d, suiClient, {
  merchantId, productId: 3n,
  coinType: d.coins.EVE!.coinType,
  amount: price,                      // read price via getProductInfo first
  payer: account.address,
  externalRef: orderId,               // YOUR idempotency key, echoed in the event
});
const { digest } = await signAndExecuteTransaction({ transaction: tx });
```

`buildPayTx` handles coin selection (merge-then-split-exact) internally.
Gifting: set `beneficiary` to another address - the entitlement lands there,
refunds still return to the payer.

## 3. Gating features on entitlements

Server- or client-side, transport-agnostic:

```ts
import { isEntitled } from '@frontier-commerce/sdk';
const ok = await isEntitled(client, d, { merchantId, key: 'pro', owner: userAddress });
```

This evaluates the on-chain view (clock-aware) via simulation - the same
logic payments use. **Bind `owner` to a wallet the user has PROVEN** (signed
login / wallet session). Trusting a claimed address is the classic
entitlement-spoof foot-gun and it lives in YOUR auth layer, not this SDK.
Other Move packages can gate on-chain via
`frontier_commerce::entitlements::is_entitled(&Merchant, key, addr, &Clock)`.

## 4. Backend operations (OperatorCap - no funds risk)

- Comp/support grants: `buildGrantPermanentTx` / `buildGrantTimedTx`.
- Usage billing: users `buildDepositCreditsTx`; your metering job calls
  `buildChargeCreditsTx(..., memo)` per batch; users can always
  `buildWithdrawCreditsTx` the remainder.
- Incident response: `buildSetPausedTx(true)` stops intake without touching
  withdrawals.

## 5. Money operations (TreasurerCap)

- `buildWithdrawTx` to any address (disabled if you enforce splits).
- `buildDistributeTx` splits the full treasury balance per policy.
- `buildRefundTx(paymentId, amount, revokeEntitlement?)` - bounded by the
  recorded payment, returns to the original payer.

## 6. Sponsorship (optional, "user pays zero gas")

Run your own gas-station instance per app (do NOT share one across apps -
per-app policies keep reasoning clean):

```bash
SPONSOR_ENABLED=true \
SPONSOR_PRIVATE_KEY=suiprivkey... \
SUI_RPC_URL=https://fullnode.testnet.sui.io:443 \  # gRPC endpoint (JSON-RPC is dead)
SUI_NETWORK=testnet \
APP_POLICIES='{"apps":[{"name":"my-app","allowedTargets":["<pkgId>::payments::pay","<pkgId>::credits::deposit"],"maxCommands":8}]}' \
ALLOWED_ORIGINS='https://your-app.example' \
node packages/gas-station/dist/server.js
```

**Browser callers need the origin allowlist.** Requests carrying an
`Origin` header are rejected 403 unless the origin matches
`ALLOWED_ORIGINS` (comma-separated exact origins) or
`ALLOWED_ORIGIN_SUFFIXES` (comma-separated hostname suffixes, https only -
e.g. `.pages.dev` for Cloudflare preview deploys). Without one of these
set, browser sponsorship fails out of the box; non-browser callers (no
`Origin` header) are unaffected by design, so treat the origin check as
hygiene, not security.

Policy rules that matter in practice:

- Allowlist only your own commerce entry points (`pay`, `credits::deposit`).
  Do NOT allowlist generic helpers like `0x2::coin::zero<T>` in production:
  the policy cannot see type arguments, and any allowlisted generic function
  becomes a free anchor for gas-burning no-op transactions. Generic
  functions you do allowlist must validate their own `T` on-chain (the
  commerce package's `pay<T>` does).
- Only `Pure` and ordinary object inputs are sponsorable; the station
  rejects address-balance withdrawal inputs and unknown input kinds outright.

Other envs (all optional): `SPONSOR_API_KEY` (bearer token - a soft
throttle if shipped to browsers, real auth only for server-to-server),
`BLOCKED_SENDERS`, `RATE_PER_SENDER_PER_MINUTE` (default 6),
`RATE_PER_IP_PER_MINUTE` (default 30), `TRUST_PROXY`,
`DAILY_BUDGET_SUI` (default 5), `GAS_BUDGET_MIST` (default 0.05 SUI),
`LOW_BALANCE_THRESHOLD_SUI`, `PORT`.

**Proxy warning:** the per-IP bucket keys on the socket address by
default. Behind a reverse proxy (Cloudflare, nginx) every client shares
the proxy's IP - one 30 req/min bucket for ALL users, so a single spammer
429s everyone. Set `TRUST_PROXY=true` there (keys on the first
`X-Forwarded-For` hop instead). Never set it on a directly exposed
station: the header is client-spoofable and would neuter the limit.

Frontend flow (all helpers in the SDK):

```ts
const kindB64 = await buildTransactionKindBytes(payTx, client);
const s = await requestSponsorship({ url: STATION_URL }, kindB64, userAddress);
const sponsoredTx = sponsoredTransactionFromB64(s.txB64);
const { signature } = await wallet.signTransaction({ transaction: sponsoredTx });
await executeSponsored(client, s.txB64, [signature, s.sponsorSignature]);
```

Fall back to normal `signAndExecute` when the station returns 503/429 - and
SURFACE that fallback to the user (silent fallback masked a real outage in
prior art). Note this is generic Sui sponsorship - unrelated to EVE
Frontier's `AdminACL` sponsor list, which only matters when a PTB composes
world-contract functions that call `verify_sponsor`.

## 7. Receipts / accounting

Poll events into the SQLite ledger (or adapt your existing indexing stack
to the same event contract):

```ts
const db = openLedger('ledger.sqlite');
// rpcUrl is a Sui GRAPHQL endpoint (e.g. https://graphql.testnet.sui.io/graphql)
// — GraphQL is the only supported event-query transport since the JSON-RPC removal.
await pollOnce({ rpcUrl, deployment: d, db });        // cron this
console.log(formatLedgerReport(buildMerchantLedgers(db), () => 9));
```

Filter events by the **original** package ID (the SDK's `eventType()` does
this) - never the latest package ID, which changes on upgrade. Deduplicate
fulfilment on your `external_ref`.

## 8. When the world/EVE packages rotate (new cycle, mainnet)

Nothing in your app code changes. Update the deployment descriptor: new EVE
coin type under `coins`, create/point products at the new currency (old-
currency treasury balances remain withdrawable per-currency), done. This
exact scenario was exercised in the testnet smoke: the operator wallet held
Utopia-tenant EVE, not Stillness EVE, and only config changed.
