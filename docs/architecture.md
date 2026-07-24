# Architecture

**Scope:** what lives on-chain vs SDK vs services, the object model, and the
reasoning behind each boundary. For threats/invariants see
[security-model.md](security-model.md).

## Design premises

1. **Currency is configuration, not code.** The EVE assets package ID has
   already rotated between testnet tenants/cycles (Stillness `0xac36…`,
   Utopia `0xf044…`) and will change at mainnet. The Move package therefore
   has **zero compile-time dependency** on EVE Frontier packages: every
   value-bearing function is generic over `Coin<T>`, and products bind their
   currency as a stored `TypeName` checked at call time. The layer would work
   with SUI, CRED, or any future coin without an upgrade.
2. **One shared object per merchant.** Catalog, treasuries, entitlements,
   credits and authority all live inside a single `Merchant` shared object:
   per-app blast radius, no cross-app contention, one object to reason about.
   (Human-scale commerce traffic nowhere near shared-object congestion
   limits; if a merchant ever needs more, shard by product family - noted as
   future work, not built speculatively.)
3. **Events are the accounting surface.** Every state transition emits a
   typed event from one module (`events`). An indexer can rebuild a complete
   ledger from events alone - the demo asserts event-derived treasury ==
   on-chain treasury. Object state is authority; events are the audit trail.
4. **Funds are never trapped.** Pause switches (protocol + merchant) gate
   revenue *intake* only. Withdrawals, refunds and user credit recovery are
   never pause-gated, so no key compromise or loss can freeze user/merchant
   funds behind an admin flag.
5. **Everything privileged is a revocable object capability.** No
   address-allowlist admin, no tx-sender god checks. Caps are objects; the
   merchant registers their IDs; revocation deletes the ID from the registry
   so a stolen cap object becomes inert without needing to seize it.

## On-chain object model

```
CommerceRegistry (shared, 1 per deployment)
  version, paused, fee_bps (<=1000 enforced), listings: Table<String, ID>
  ProtocolCap / ProtocolTreasurerCap (owned caps, minted once at publish)

Merchant (shared, 1 per consumer app)
  version, name, paused
  root_cap_id: ID                 <- current MerchantCap (rotation invalidates old)
  operator_cap_ids: VecSet<ID>    <- revocation registry (hot, day-to-day)
  treasurer_cap_ids: VecSet<ID>   <- revocation registry (funds outflow)
  recovery_enabled: bool          <- protocol root-recovery opt-in/out
  recovery_requested_at_ms: Option<u64>  <- pending timelocked recovery (72h window)
  products: Table<u64, Product>   <- append-only; semantic fields immutable
  payment_records: Table<u64, PaymentRecord>  <- kept only inside refund window
  entitlements: Table<{key, owner} -> {expires_at_ms: Option, ...}>
  credit_ledger: Table<{currency, owner} -> u64>
  credit_escrow: Bag<TypeName -> Balance<T>>  <- user funds, segregated
  treasury:      Bag<TypeName -> Balance<T>>  <- merchant earnings
  fees_accrued:  Bag<TypeName -> Balance<T>>  <- protocol's cut, pull-swept
  split_policy: vector<{recipient, bps}> + enforce_split
```

### Module map (`move/frontier_commerce`)

| Module | Responsibility |
|---|---|
| `registry` | Protocol config + caps, versioning constant, hard fee cap |
| `merchant` | Merchant object, cap lifecycle (mint/revoke/rotate/recover), config, auth asserts |
| `types` | Stored data structs (module-visibility seam for Table value types) |
| `catalog` | Product create/update (operator), immutability of semantic fields |
| `payments` | `pay<T>`, refunds (bounded by record), record pruning |
| `entitlements` | Grants (payment/operator), revocation, `is_entitled` public view |
| `credits` | Deposit/charge/withdraw with escrow/ledger invariant |
| `treasury` | Withdraw, split distribution, protocol fee sweep |
| `events` | Every event struct + emit helpers (single indexing surface) |
| `vault` | Internal Bag<TypeName, Balance<T>> helpers |

### Key flow: `pay<T>`

1. Version + pause asserts (registry read-only; merchant mutable).
2. Product must exist, be active; quantity 1..=1200 (1 for one-time).
3. `TypeName<T>` must equal the product's stored currency.
4. Coin value must equal `price * quantity` **exactly** (SDK splits the
   exact amount in the same PTB - no change-handling semantics to audit).
5. Fee = `total * fee_bps / 10000` (floor, u128 intermediate) into
   `fees_accrued`; remainder into `treasury`.
6. Payment record stored only if `refund_window_ms > 0`.
7. Entitlement effect: one-time -> permanent; subscription -> extend from
   `max(now, current expiry)` by `duration * quantity` (a timed purchase
   never downgrades an existing permanent grant).
8. `PaymentEvent` with merchant-scoped monotonic `payment_id`,
   payer/beneficiary, currency, amounts, optional `external_ref`.

Sender identity = `ctx.sender()`; Sui gas sponsorship changes the gas owner,
never the sender, so sponsored payments attribute correctly by construction.

## Off-chain components

### SDK (`packages/sdk`)
Pure client library - no keys, no state. Deployment descriptors
(`deployments/<network>.json`) carry all chain-specific data: package ID
(latest, for calls), original package ID (permanent, for event/type
filters), registry ID, coin types. Builders append to caller-supplied PTBs
so flows compose; queries go through `client.core.*` (transport-agnostic
across JSON-RPC/gRPC - Sui removed JSON-RPC from first-party nodes
2026-07-31, so nothing may assume one transport). On-chain view functions
(`is_entitled`, balances) are read via `simulateTransaction` +
`commandResults`, so the SAME Move logic answers dev-time and runtime
questions - no reimplementation drift.

### Gas station (`packages/gas-station`)
Framework-free Node service (core is portable to a Cloudflare Worker).
IP-limit -> validate -> admit (sender limits/budget) -> reserve -> build ->
co-sign:

- **Policy validation** (fail-closed): command kinds restricted to
  MoveCall/Split/Merge/MakeMoveVec; recursive `GasCoin`-reference block;
  input kinds restricted to `Pure` + ordinary object references
  (withdrawal/unresolved/unknown input kinds rejected); MoveCall targets
  must all fall inside ONE configured app policy; per-app command cap.
- **Limits:** cheap per-IP bucket before validation; per-sender token
  bucket + global daily budget counted at the worst-case gas budget per
  sponsorship, charged only AFTER policy validation passes and refunded
  (budget only) when the sponsor fails without signing.
- **Gas pool:** in-memory reservation of distinct sponsor coins per
  in-flight request (TTL), closing the equivocation/availability gap
  observed in the prior-art sponsor workers.
- Budget model: every sponsorship gets the configured cap as its budget and
  the reserved coin must cover it - predictable worst-case exposure, no
  estimation round-trip, no "wallet dipped below fixed budget so everything
  500s" failure mode (a real outage mode observed in a prior-art sponsor
  deployment; this design refuses cleanly with 503 + `lowBalance` on
  `/health` instead).

### Indexer (`packages/indexer`)
Cursor-persistent poller of `{original_package}::events::*` into SQLite
(`node:sqlite`, zero native deps): `raw_events` append-only (idempotent on
(tx_digest, event_seq)) + derived accounting report. The DB is a cache;
chain is the authority; rebuild is always possible. Transport is **Sui
GraphQL** (`Query.events`, opaque Relay cursors) — migrated 2026-07-24 when
JSON-RPC died; GraphQL is the only supported transport with an event-query
API (the gRPC surface only streams whole checkpoints). The query lives
behind one seam (`pollOnce`'s `queryFn`) with vitest coverage plus a live
testnet validation script. For production scale, any existing indexing
stack can adopt the same event contract instead.

## What integrators touch

An app needs: its `Merchant` ID + deployment descriptor (public data), an
`OperatorCap` on its backend for grants/charges (never funds), and the SDK.
Wallet-side flows (pay/deposit/withdraw) need no caps at all. See
[integration-guide.md](integration-guide.md).

## Consequences accepted

- **Table-based entitlements, not owned objects**: non-transferable and
  revocable by construction, on-chain checkable by other Move packages via
  `&Merchant`; the cost is no wallet-visible "badge" object (could be added
  later as a cosmetic mirror without changing the authority model).
- **Address-keyed entitlements**: web-app session identity IS the wallet.
  EVE Frontier `Character`-keyed grants can be namespaced inside the
  entitlement key string by the consumer; a first-party character binding
  would couple this package to world-contracts and is deliberately out.
- **Prepaid credits trust merchant metering** (bounded by deposit, fully
  evented, user can always withdraw the remainder). This is stated loudly in
  module docs rather than hidden.
