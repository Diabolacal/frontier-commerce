# @frontier-commerce/sdk

TypeScript SDK for [Frontier Commerce](https://github.com/Diabolacal/frontier-commerce) —
an open-source commerce/payment layer for Sui applications, built for the
EVE Frontier ecosystem.

> **Status: testnet-proven, pre-mainnet, pre-1.0.** No external security
> audit. Breaking changes may land in any 0.x minor. The SDK deliberately
> refuses `mainnet` deployment descriptors until the upstream promotion
> checklist is executed.

## The model in one paragraph

Frontier Commerce is **source you deploy, not a service you join**. You (or
your team) publish your own instance of the Move package to Sui — owning
your own `UpgradeCap`, registry, merchant, caps and treasury — and your
deploy writes a `deployments/<network>.json` descriptor. This SDK is
network-agnostic client code: it loads that descriptor at runtime and
builds transactions/queries against *your* instance. Installing this
package does not connect you to anyone else's deployment.

## Install

```bash
npm install @frontier-commerce/sdk @mysten/sui
# or: pnpm add @frontier-commerce/sdk @mysten/sui
```

## Use

```ts
import { parseDeployment, buildPayTx, isEntitled } from '@frontier-commerce/sdk';

const d = parseDeployment(await fs.readFile('deployments/testnet.json', 'utf8'));

// Checkout: build a payment transaction for one of your products
const tx = await buildPayTx(d, suiClient, {
  merchantId, productId: 1n,
  coinType: d.coins.EVE!.coinType,
  amount: price,
  payer: account.address,
  externalRef: orderId,          // your idempotency key, echoed in the event
});

// Gate features on the on-chain entitlement
const ok = await isEntitled(suiClient, d, { merchantId, key: 'pro', owner: userAddress });
```

What's exported: deployment-descriptor parsing/validation (`config`),
transaction builders for payments/subscriptions/credits/refunds/admin
(`tx`), read queries and entitlement checks (`queries`), typed event
decoding for receipts/indexing (`events`), and the gas-station sponsorship
client (`sponsor`).

## Getting a deployment to point at

Publishing your own instance (localnet/testnet), creating a merchant and
products, and generating the descriptor are covered in the main repository:

- [Deployment model & quickstart](https://github.com/Diabolacal/frontier-commerce#the-deployment-model-read-this-first)
- [Integration guide](https://github.com/Diabolacal/frontier-commerce/blob/main/docs/integration-guide.md)
- [Descriptor reference](https://github.com/Diabolacal/frontier-commerce/blob/main/deployments/README.md)

SDK versions track the repository's release tags: `@frontier-commerce/sdk@0.1.0`
is built from the `v0.1.0` tag, whose Move source is what you publish. Pin
the exact version and upgrade deliberately alongside your own deployment.

## Licence

[Apache-2.0](./LICENSE). EVE Frontier is a trademark of Fenris Creations
ehf; this is an independent community project.
