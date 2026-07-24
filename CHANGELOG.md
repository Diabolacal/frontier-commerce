# Changelog

All notable changes to Frontier Commerce. One version number rides the
whole release train (Move source + SDK + services + tooling); only
`@frontier-commerce/sdk` is published to npm. Versioning policy:
[docs/distribution.md](docs/distribution.md).

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
