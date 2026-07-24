# Frontier Commerce

A reusable, open-source commerce/payment layer for Sui applications,
originally built for the EVE Frontier ecosystem and currently used by
EF-Map Intelligence on Sui testnet.

One well-tested piece of infrastructure that any app can use to monetise -
instead of each app inventing its own payment plumbing. SUI is
infrastructure/gas; the economic currency (EVE, or anything else) is
**runtime configuration**: nothing here is compiled against any specific
coin, because EVE's package ID has already rotated between testnet cycles
and will rotate again at mainnet.

> **Status: testnet-proven, pre-mainnet.** Real purchases (including a real
> human purchase through a production UI, gas-sponsored) have run on Sui
> testnet. Nothing is deployed to mainnet, and a deliberate guard in the SDK
> refuses mainnet descriptors until the promotion checklist in
> [docs/security-model.md](docs/security-model.md) is executed. The code has
> had internal adversarial review (findings and remediation are summarised
> in [docs/decision-log.md](docs/decision-log.md)) but **no external
> security audit**. Breaking changes may land at any time. Use at your own
> risk.

## What it provides

| Capability | Where |
|---|---|
| One-off payments, free/comp products, gifting (`beneficiary`) | `payments::pay` |
| Subscriptions / time-limited entitlements (extend-from-max semantics) | `payments` + `entitlements` |
| Permanent entitlements, operator grants/revokes, on-chain `is_entitled` view | `entitlements` |
| Prepaid credits with merchant-side metering (bounded-trust, user-recoverable) | `credits` |
| Per-merchant multi-currency treasuries, revenue splits (bps), refunds | `treasury`, `payments` |
| Protocol fee (hard-capped at 10% in code), pull-based fee sweep | `registry`, `treasury` |
| Receipts/accounting via typed events + SQLite indexer that reconciles to chain | `events`, `packages/indexer` |
| Gas sponsorship with policy allowlists, rate limits, gas-coin reservation | `packages/gas-station` |
| Authority separation: root/operator/treasurer caps, revocation, rotation, recovery | `merchant`, `registry` |
| Optional operator observability: Grafana dashboard + collector | `observability/` |

## The deployment model (read this first)

This repository is **source code, not a service**. There is no shared
canonical deployment to join: every deployment of Frontier Commerce is a
sovereign instance owned by whoever published it. The authors run their own
instance for EF-Map; you run yours.

To use Frontier Commerce for your own application:

1. **Clone/fork and review** the Move package and services, then prove the
   whole flow locally: `run-demo.ts` publishes everything to a throwaway
   localnet chain and asserts every step.
2. **Publish your own instance to testnet** with the config-driven deploy
   tool: copy
   [`examples/demo-consumer/deploy.config.example.json`](examples/demo-consumer/deploy.config.example.json),
   fill in your merchant name, products and the **current-cycle** coin
   type, then run
   [`deploy-testnet.ts`](examples/demo-consumer/src/deploy-testnet.ts).
   Publishing runs `registry::init`, which creates *your* shared
   `CommerceRegistry` and delivers *your* `ProtocolCap` /
   `ProtocolTreasurerCap` / `UpgradeCap` to the publishing address, then
   creates *your* `Merchant`, caps and products, and writes
   `deployments/testnet.json` — the runtime descriptor everything else
   loads. See [deployments/README.md](deployments/README.md).
3. **Keep your caps in your custody**
   ([docs/key-management.md](docs/key-management.md)) — write and test a
   backup/restore runbook before real value exists.
4. **Integrate the SDK** payment + entitlement flow in your app
   ([docs/integration-guide.md](docs/integration-guide.md)).
5. Optionally run your own **gas station** (users pay zero gas), the
   **indexer** (accounting that reconciles to chain), and the **Grafana
   operator dashboard** ([observability/README.md](observability/README.md)).
6. Verify with the read-only tools:
   [`inspect-deployment.ts`](examples/demo-consumer/src/inspect-deployment.ts),
   [`validate-poller.ts`](examples/demo-consumer/src/validate-poller.ts),
   [`validate-sponsor.ts`](examples/demo-consumer/src/validate-sponsor.ts).

Multiple merchants *can* share one deployment (one registry, one protocol
fee), but that makes the registry publisher a trusted party for recovery
and fees — the sovereign publish-your-own path above is the recommended
default, and the authors do not operate a shared instance for third
parties.

## Repository layout

```
move/frontier_commerce/   The Move package (8 domain + 2 helper modules, 66 unit tests at last count)
move/mock_eve/            Freely-mintable mock EVE for testnet/localnet validation (never mainnet)
packages/sdk/             TypeScript SDK: config, PTB builders, queries, events, sponsor client
packages/gas-station/     Sponsorship service: policy validation, limits, gas-coin pool, HTTP server
packages/indexer/         Event poller -> SQLite ledger -> accounting reports
examples/demo-consumer/   Localnet E2E proof + config-driven testnet deploy/inspect/validate tooling
deployments/              Descriptor template + README (your deploy generates the real one)
observability/            Optional Grafana operator dashboard + Postgres collector
docs/                     Architecture, security model, key management, integration guide
```

## Quickstart

```bash
pnpm install
pnpm move:test        # Move unit tests
pnpm -r build && pnpm -r test   # SDK + gas-station + indexer tests

# Full end-to-end proof against a throwaway local network:
sui start --with-faucet --force-regenesis   # separate terminal
node --experimental-strip-types examples/demo-consumer/src/run-demo.ts
```

The localnet demo publishes both packages, configures a merchant, and runs:
one-time purchase -> subscription -> credits cycle -> refund -> **sponsored
payment through the real gas station (user pays zero gas)** -> split
distribution -> fee sweep -> indexer reconciliation (event-derived treasury
must equal on-chain treasury). Every step asserts.

## Documentation

- [docs/architecture.md](docs/architecture.md) - object model, module map, flows, what lives on/off chain
- [docs/security-model.md](docs/security-model.md) - threat model, authority matrix, invariants, testnet vs mainnet posture
- [docs/key-management.md](docs/key-management.md) - custody, rotation, revocation, recovery runbooks
- [docs/integration-guide.md](docs/integration-guide.md) - how a consumer app integrates
- [docs/decision-log.md](docs/decision-log.md) - engineering decisions, newest first
- [deployments/README.md](deployments/README.md) - the descriptor model
- [observability/README.md](observability/README.md) - the optional operator dashboard

## Security

The security model assumes this code is public: authority is object
capabilities on-chain, the gas station validates fail-closed with
env-injected secrets, and object/package IDs grant nothing. No security
property depends on source secrecy. Found a vulnerability? **Please report
it privately** - see [SECURITY.md](SECURITY.md).

## Status, support & contributions

This is experimental, solo-operated open-source infrastructure. Issues and
PRs are welcome; there is no SLA, no guaranteed support, and no promise of
backwards compatibility before a mainnet release. If you deploy it, you
operate it - including your keys, your sponsor float and your treasury.

This repo was developed privately (2026-07-19 → 2026-07-24, including an
internal adversarial security review) and published as a clean-history
import; the authors' own deployment operations live in a separate private
repo and are not part of this project.

Working in this repo (human or agent)? Read [AGENTS.md](AGENTS.md); the
canonical rule set is
[.github/copilot-instructions.md](.github/copilot-instructions.md).
Load-bearing rules:

- **No mainnet deploys** without executing the promotion checklist (multisig
  custody, external review, monitoring) in the security model doc.
- **Never commit key material.** `.gitignore` blocks `.env`/`*.key`; secrets
  live in environment/secret stores only.
- Deployment package IDs are **evidence, not production truth** - they
  rotate; all consumers must load `deployments/<network>.json` at runtime.

## Licence

[Apache-2.0](LICENSE).

EVE Frontier is a trademark of CCP ehf. This is an independent community
project: not affiliated with, endorsed by, or supported by CCP or Mysten
Labs.
