# Changelog

All notable changes to Frontier Commerce. One version number rides the
whole release train (Move source + SDK + services + tooling); only
`@frontier-commerce/sdk` is published to npm. Versioning policy:
[docs/distribution.md](docs/distribution.md).

## v0.1.1 - 2026-07-26

Operated-services release: **Move source and SDK source are byte-identical
to v0.1.0.** One version rides the whole train, so the SDK is republished at
0.1.1 even though nothing in it changed — an app on
`@frontier-commerce/sdk@0.1.0` has no reason to upgrade, and no on-chain
package upgrade is implied by this release.

- **Observability: multi-merchant.** One package/registry can host many
  merchants, and product ids restart at 1 per merchant — so the collector
  overwrote one merchant's catalog with another's, reconciled only the first
  merchant's treasury, and still summed every merchant into the revenue
  panels. Merchants are now discovered from the descriptor (every
  `evidence.*` object carrying a `merchantId`; `MERCHANT_IDS` / `MERCHANT_ID`
  override), every one is reconciled per cycle, and a single merchant failing
  no longer aborts the run. New `payments_labeled` view attributes revenue by
  merchant, product and app — the latter via `ref_prefix`, the `external_ref`
  namespace, which is the only way to split two apps that share one product.
  Dashboard 56 → 59 panels.
- **⚠️ Operator action if you already run the collector.** The schema
  migration is automatic and non-destructive (old single-merchant rows are
  renamed to `*_pre_multimerchant`, not deleted), but **import the updated
  dashboard JSON in the same change** — the old panels query
  `chain_status WHERE id = 1` and show no data against the new schema.
  Upgrade note: [observability/README.md](observability/README.md).
- **Gas station: testnet self-care.** Faucet auto-refill and gas-coin pool
  maintenance (sponsorship concurrency is coin count, not balance), plus the
  optional `REFILL_TARGET_SUI` hysteresis stop line so a raised float stops
  parking at the threshold and trickling one faucet request per cooldown
  window. Left unset, behaviour is byte-equivalent to v0.1.0. `/health` gains
  pool, self-care and refill fields.

## v0.1.0 - 2026-07-24

First tagged release. **Testnet-proven, pre-mainnet, no external security
audit.** Breaking changes may land in any 0.x minor.

- Move package `frontier_commerce`: payments (one-off/free/gifting),
  subscriptions and permanent entitlements, prepaid credits with
  merchant-side metering, per-merchant multi-currency treasuries, revenue
  splits, refunds, capped protocol fee, capability-based authority
  separation with timelocked recovery. 66+ unit tests.
- Move package `mock_eve`: freely-mintable test currency for
  localnet/testnet validation (never mainnet).
- `@frontier-commerce/sdk` (npm): deployment-descriptor config with
  mainnet guard, transaction builders, queries/entitlement checks, typed
  event decoding, gas-sponsorship client.
- Gas station (clone-and-run service): fail-closed policy validation,
  rate limits, budget caps, gas-coin pool, origin allowlists.
- Indexer (clone-and-run service): GraphQL event poller, SQLite ledger,
  accounting reports that reconcile to on-chain treasuries.
- Observability (optional): Grafana operator dashboard + Postgres
  collector.
- Config-driven sovereign deploy tooling (`deploy-testnet.ts`), localnet
  E2E proof (`run-demo.ts`), read-only validators; descriptors now record
  the source revision they were deployed from (`evidence.source`).
- Distribution model established: GitHub tagged releases for source, npm
  for the SDK (trusted publishing + provenance), no MVR registration by
  design ([docs/distribution.md](docs/distribution.md)).
