---
applyTo: "**/*.move"
---

# Move rules — frontier_commerce + mock_eve

Authority for on-chain facts: **this package's current source and tests >
the installed Sui framework > https://docs.sui.io > this file.** These are
durable conventions, not canonical truth — when they disagree with the
code, the code wins; flag the discrepancy. Repo-wide rules live in
`.github/copilot-instructions.md` and always apply.

## Package identity (differs from other repos in this workspace)

- `frontier_commerce` has **zero compile-time dependency on EVE Frontier
  packages** (world-contracts, assets). That is a design premise
  ("currency is configuration"), not an accident. **Never add such a
  dependency**; coin types arrive as generic `T` + stored `TypeName`.
- `mock_eve` is a worthless testnet/localnet stand-in. It must never be
  published to mainnet and never gain real-value semantics.
- There is no vendored world-contracts submodule here; world-extension
  patterns (Auth witnesses, AdminACL tiers, hot-potato receipts from other
  packages) from sibling repos do not apply.

## Module layout (as built — keep it)

`registry` (protocol config + caps) · `merchant` (tenant object + cap
lifecycle) · `types` (stored structs; the visibility seam for Table/Bag
value types) · `catalog` · `payments` · `entitlements` · `credits` ·
`treasury` · `events` (ALL event structs + emit helpers) · `vault`
(internal `Bag<TypeName, Balance<T>>` helpers).

- Events are emitted **only** via `events` module helpers — never
  `event::emit` elsewhere. One indexing surface.
- Funds are reachable **only** through `vault` helpers behind
  `public(package)` accessors on `Merchant`. Never expose a `&mut Bag` or
  `Balance` publicly.
- Prefer `public(package)` over `public`; minimize the public surface.
  New `public fun`s on funds paths are High-risk (see canonical rules).

## Capability discipline

- No address-allowlist auth, no `ctx.sender()` god checks. Every
  privileged action takes a capability object.
- Every mutating entry asserts, in order: object `version` (via
  `assert_version`), then cap validity — `cap.merchant_id == object::id
  (merchant)` (confused deputy) AND registry membership / `root_cap_id`
  (revocation/rotation). Copy the existing assert helpers; do not inline
  new variants.
- New cap types must be revocable-by-ID and covered by mint/revoke events.

## Invariants your change must not break (each has tests)

1. Protocol fee hard cap ≤1000 bps; fee math in u128 with floor; fee ≤
   amount always.
2. Exact-amount payments (`coin value == price * quantity`, u64-fit check).
3. `sum(credit_ledger) == credit_escrow` per currency on every path.
4. Pause gates `pay`/`deposit`/`charge` only — `withdraw`, `refund`,
   `distribute`, `sweep_fees`, `withdraw_credits` must never be
   pause-gated.
5. Refunds bounded by the payment record, paid only to the original payer.
6. Protocol recovery: request → public event → 72h delay → execute;
   root cancel and opt-out (which clears pending) must keep working.
7. Version assert on every mutating entry; migration explicit and gated.

## Event / stored-struct compatibility

- Changing any event or stored struct layout breaks in-place upgrades.
  Pre-mainnet this is allowed and rides the next **fresh publish** (testnet
  IDs rotate; note it in `docs/deployments.md`). Once a deployment has
  real consumers: never change existing fields — add `...V2` structs (see
  `events.move` header). State the upgrade consequence in your PR.
- Bump `registry::VERSION` when shared-object semantics change; add
  migration coverage.

## Style (match the existing code)

- Move 2024 edition idioms: method syntax (`ctx.sender()`, `id.delete()`,
  `merchant.assert_version()`), vector literals, `b"...".to_string()`.
  Never `public entry fun` — `public fun` (composable) or `entry fun`.
- Errors: `#[error] const EPascalCase: vector<u8> = b"human message";`
  — descriptive bytes, per module, referenced in `expected_failure` tests.
- Naming: modules `snake_case`; structs/caps/events `PascalCase` with
  `Cap`/`Event` suffixes (events past tense); constants
  `SCREAMING_SNAKE_CASE`; getters = field name (no `get_`).
- Abilities in canonical order `key, copy, drop, store`. `///` doc
  comments; module headers explain the trust/threat reasoning, not syntax.
- Section markers `// === Section ===` in the existing order.
- Plan modules to stay <500 lines; split by concern before writing.
  Documented exception: `merchant.move` (single authority domain).

## Tests

- `tests/<module>_tests.move`, module `frontier_commerce::<module>_tests`,
  plus shared `test_helpers`. Do **not** prefix test functions with
  `test_`; name the behavior (`refund_beyond_remainder_aborts`).
- Merge attributes: `#[test, expected_failure(abort_code = mod::EName)]`.
- Use `test_scenario` for multi-tx flows (the norm here);
  `th::clock_at(...)` for Clock; abort-path tests may end with `abort 0`.
- Every new entry point needs at least: one success path, one authority-
  failure path, and one boundary case. Adversarial tests (wrong merchant's
  cap, revoked cap, stale version) are the house style — keep them.

## Toolchain quirks

- Commit `Move.lock`. On this Windows machine the Sui CLI writes
  platform-native separators into it and rewrites the file on every build;
  CI normalizes separators on the runner. **Never hand-"fix" the lock.**
- Verify Sui framework APIs (`sui::bag`, `sui::table`, `type_name`
  behavior, clock) against the pinned framework rev in `Move.lock` and
  docs.sui.io — not model memory.
