# Changelog

All notable changes to Frontier Commerce. One version number rides the
whole release train (Move source + SDK + services + tooling); only
`@frontier-commerce/sdk` is published to npm. Versioning policy:
[docs/distribution.md](docs/distribution.md).

## v0.1.3 - 2026-07-28

Same shape as v0.1.2: **Move source and SDK source are byte-identical to
v0.1.0**, so the SDK republishes at 0.1.3 unchanged and no on-chain package
upgrade is implied. Patch, not minor: the Move/SDK pair the versioning policy
ties minors to is untouched.

Tagged urgently. The gas station is consumed by cloning at a release tag (see
[docs/distribution.md](docs/distribution.md)), and until this ships, **every
gas station on testnet or devnet is hard down** with no recovery available
from configuration alone.

**Operator action required if you run a gas station:** upgrade. There is no
env-var workaround.

- **Gas station: native gRPC instead of gRPC-web.** On 2026-07-28 the Sui
  testnet and devnet fullnodes stopped serving **gRPC-web** as part of the
  scheduled JSON-RPC shutdown. The gRPC-web content type now falls through to
  the JSON-RPC handler, which answers `application/json` with a "JSON-RPC has
  been deprecated" body, so `SuiGrpcClient`'s default `GrpcWebFetchTransport`
  threw `unexpected response content type: application/json` on **every** call:
  `/health` 500, no sponsorships, and a wallet that still looks perfectly
  healthy while the dashboard shows the station down.

  Same host, same path, same HTTP/2 connection: `application/grpc` is answered
  with `application/grpc`, `application/grpc-web+proto` with
  `application/json`. `fullnode.mainnet.sui.io` still served gRPC-web at the
  time of writing, so this is the shutdown rolling out per network rather than
  an endpoint outage — **mainnet operators should expect the same flip and
  upgrade before it lands.**

  The station now injects a native gRPC transport (`@grpc/grpc-js` via
  `@protobuf-ts/grpc-transport`, since Node has no fetch-based native gRPC)
  through the `transport` option `SuiGrpcClient` already exposes. Nothing
  downstream changes; every call still goes through `client.core.*`. Verified
  against `fullnode.testnet.sui.io` before shipping: `getBalance`, `listCoins`
  and `getObjects` all succeed on native gRPC and all fail on gRPC-web.

  Note for anyone diagnosing this from scratch: neither an SDK bump nor
  `SUI_RPC_URL` fixes it. `@mysten/sui@2.22.1` predates the change, and of six
  testnet endpoints probed only one still spoke gRPC-web — not a trade worth
  making for a gas-signing service.

- **`SUI_RPC_URL` keeps its meaning.** `@grpc/grpc-js` wants `host:port`
  rather than a URL, so the value is parsed: existing settings
  (`https://fullnode.testnet.sui.io:443`) work unchanged, a missing port
  defaults to 443 (80 for plaintext), and a bare `host` or `host:port` is
  accepted. Only an explicit `http://` or `grpc://` scheme selects plaintext
  credentials — a bare host stays TLS, so a typo degrades to a refused
  connection rather than a silently unencrypted link to a public fullnode.

## v0.1.2 - 2026-07-27

Operated-services release, same shape as v0.1.1: **Move source and SDK source
are byte-identical to v0.1.0.** Everything here is the gas station and the
observability pipeline, so the SDK republishes at 0.1.2 unchanged — an app on
`@frontier-commerce/sdk@0.1.1` has no reason to upgrade, and no on-chain
package upgrade is implied. Patch, not minor: the Move/SDK pair the versioning
policy ties minors to is untouched.

Tagged because the gas station, indexer and collector are consumed by cloning
at a release tag (see [docs/distribution.md](docs/distribution.md)), so until
this ships nobody following the documented path can get the fix.

**No operator action required.** The `/health` rename keeps a deprecated alias
and the schema migration is additive, so an existing collector and dashboard
keep working untouched across this upgrade.

- **Gas station: the daily budget counter is a RESERVATION, and now says
  so.** The limiter has to admit before the transaction exists, so it
  reserves the worst-case `GAS_BUDGET_MIST` per sponsorship and never learns
  the real cost — the station only co-signs, the CLIENT executes. That number
  was called `daySpendMist` and surfaced as "spent today" all the way out to
  a Grafana panel, so an operator saw 5.9 SUI of spend on a day that really
  cost 0.3 SUI and went hunting a leak that did not exist. The mechanism is
  unchanged — reserving before you know the cost is the correct abuse
  backstop — only the reporting is fixed.
  - `/health` gains `limiter.dayReservedMist` and `limiter.dayAdmitted`,
    related by `dayReservedMist == dayAdmitted * gasBudgetMist` so the
    mechanism is legible from the payload alone. `limiter.daySpendMist`
    remains as a **deprecated alias** carrying the identical value so
    existing collectors keep parsing — migrate off it.
  - `RateLimiter.snapshot()` now returns the exported `LimiterSnapshot`
    type, including that alias. A refund releases the admission count with
    the budget, and a refund arriving after UTC midnight is dropped rather
    than credited to the new day.
  - Sizing guidance added to the integration guide: `DAILY_BUDGET_SUI /
    GAS_BUDGET_MIST` is a sponsorship COUNT, and `GAS_BUDGET_MIST` must
    cover the GROSS cost (computation + storage, before the storage rebate)
    of the heaviest sponsored transaction, not the net wallet drain.
- **Gas station: routine faucet throttling is no longer reported as
  failure.** Public faucets throttle for hours at a time — the steady state
  for a healthy station — but every refusal landed in one counter and one
  error string, so the fault indicator stayed permanently lit and a genuine
  outage was invisible underneath it. `selfCare.refill` gains `state`
  (`idle` / `ok` / `rate-limited` / `failing`), `lastOutcome`,
  `consecutiveHardFailures`, `lastHardFailureAt` and
  `lastHardFailureResult`. **Alert on `state = failing` or
  `consecutiveHardFailures > 0`**, not on `consecutiveFailures` (unchanged
  semantics: every refusal). Backoff and scheduling are untouched — this is
  a reporting split, not a behaviour change.
- **Observability.** `sponsor_health` gains `day_reserved_mist`,
  `day_admitted`, `refill_state`, `refill_hard_failures` and
  `refill_last_hard_failure_at` (additive `ADD COLUMN IF NOT EXISTS`;
  `day_spend_mist` keeps receiving the same value so existing panels stay
  continuous). The collector prefers `dayReservedMist` and falls back to the
  alias, so it works against a station on either side of this change.
  Dashboard: "Daily gas budget spend (SUI)" → "Daily gas budget reserved
  (SUI)" with the series relabelled `spent today` → `reserved today`, and
  "Daily gas budget used" → "Daily admission allowance used"; both panels
  now say that a full bar stops admissions rather than draining the float.
- **New tests.** `limits.test.ts` and `server.test.ts` pin the reservation
  and refund arithmetic AND the reported field names — the original bug was
  a correct number under a misleading name, which only a name assertion
  catches. `buildHealthPayload` is exported so the `/health` shape can be
  tested without a fullnode or a sponsor key.

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
