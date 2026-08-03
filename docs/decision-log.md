# Decision log

Non-trivial decisions, newest first. This log starts at the public release;
it carries forward the architecture/security decisions from the private
development period (2026-07-19 → 2026-07-24) that a builder needs to
understand the system. The authors' deployment-operations history lives in
their private operations repo.

## 2026-08-03 - Claude Code loads CLAUDE.md, so CLAUDE.md imports AGENTS.md

- **Problem:** `CLAUDE.md` opened by *telling* the agent to read `AGENTS.md` and
  `.github/copilot-instructions.md`, then restated five non-negotiables in case the
  agent never did. Claude Code only ever loads `CLAUDE.md`; nothing else in the
  repo reaches the model automatically, so the rules were duplicated in the one
  file that loads and merely referenced in the two files that are canonical.
- **Decision:** first line of `CLAUDE.md` is now `@AGENTS.md`, which imports that
  file in full at launch (the documented import mechanism, preferred over symlinks
  on Windows). The duplicated bullets are gone; what remains below the import is
  only what is true of Claude Code specifically - that the canonical
  `.github/copilot-instructions.md` and the scoped `.github/instructions/*` files
  are *not* auto-loaded and must be read, and that `.claude/` is gitignored here.
- Added a `## Closeout` section to `AGENTS.md` so every task ends with the same
  report shape (repo, branch, commits, push/deploy state, files, validation, gaps,
  preserved dirt).
- Local-only: `.claude/settings.json` denies `git reset --hard`, `git clean` and
  force-push under both `Bash(...)` and `PowerShell(...)` matchers - PowerShell
  invocations are not covered by `Bash(...)` rules. It is gitignored, so it does
  not ship to contributors; the same prohibitions remain written in AGENTS.md.

## 2026-07-26 - Observability is multi-merchant; revenue attribution by product and app

- **Problem (found on the authors' live testnet deployment the day a second
  merchant started taking money):** the collector and dashboard were built
  around "the" merchant. `MERCHANT_ID` came from `evidence.merchant`,
  `chain_status` was a single row pinned to `id = 1`, and `product_status`
  was keyed by `product_id` **alone** — but product ids restart at 1 per
  merchant, so two merchants' product 1 are different products that
  overwrite each other. Meanwhile `raw_events` is polled per *package*, so
  the payment/revenue panels happily summed every merchant into one number.
  Net effect: a deployment could show "revenue 4001" at the top while
  reconciling only 901 of it and listing only the first merchant's catalog —
  the second merchant's treasury was never reconciled at all, silently.
  Nothing was wrong on chain; the *observability* was lying by omission.
- **Decision: merchant is a first-class dimension, discovered from the
  descriptor.** Every object under `evidence` carrying a `merchantId` is a
  merchant of the deployment (`evidence.merchant` plus whatever else an
  operator's scripts record), with `MERCHANT_IDS` / `MERCHANT_ID` as
  overrides. All merchant-scoped tables are keyed by merchant
  (`chain_status` PK `merchant_id`, `product_status` PK
  `(merchant_id, product_id)`, `treasury_recon` already was), every merchant
  is reconciled each cycle, and one merchant failing (RPC hiccup, deleted
  object) is logged per merchant instead of aborting the run. Registry state
  is read once per cycle and stamped onto each row: deployment-global truth,
  denormalised so a single join answers "is intake paused for this
  merchant?".
- **Considered and rejected:** (a) running one collector process per
  merchant — N SQLite ledgers re-indexing the same package, N sponsor
  probes, and cross-merchant totals become impossible; (b) keeping the
  dashboard single-merchant behind a merchant variable — the operator's
  first question is "which product is earning", which a filter answers one
  merchant at a time and a breakdown answers at a glance; (c) a
  `merchant_id` column with the first configured merchant backfilled in —
  correct only by luck, and the tables are on-chain caches anyway.
- **Migration: move aside, don't rewrite.** `chain_status` and
  `product_status` are caches of chain state re-derived on the next
  reconciliation, so the DDL renames the pre-multi-merchant tables to
  `*_pre_multimerchant` (guarded on the absence of `merchant_id`, so it runs
  once) and creates the new shape beside them. Nothing is deleted, nothing
  is guessed, and the operator can inspect the old rows before dropping
  them.
- **Attribution needs a second axis: the app.** One product can serve
  several apps — the authors' two arcade games buy the *same* revive
  consumable — so no product-level split can separate them. The new
  `payments_labeled` view joins each payment to its merchant name and
  product slug and exposes `ref_prefix`, the app-defined `external_ref`
  namespace (everything before the first `:`). Apps that already namespace
  refs as `<app>:<order>:<n>` get per-app revenue for free. Documented as an
  app-side convention, not a guarantee: `external_ref` is opaque to the
  chain and its uniqueness is app-enforced (`payments.move` says so).
- **Dashboard (56 → 59 panels):** pause state now ORs every merchant;
  treasury reconciliation requires every merchant × currency in the latest
  snapshot to agree (and reports "no data" rather than MISMATCH when there
  is nothing to compare); treasury stats sum across merchants and say so;
  the deployment and product tables list one row per merchant; the daily
  payment/revenue series stack by merchant and product; and a new **Revenue
  attribution** row breaks all-time revenue down by merchant × product and
  by app. The support playbook no longer tells operators that `product_id 1`
  identifies a product.
- **Validation:** the generated DDL was applied against a real populated
  `ef_commerce` schema inside a transaction and rolled back — both migration
  branches fire, a second pass is a no-op, and all 49 dashboard queries run
  against the migrated schema and return the expected rows (an
  independently-verified 3100/901 EVE split across two merchants, and
  2900/200/901 across the two games and the subscription flow).

## 2026-07-26 - Gas station refill hysteresis: `REFILL_TARGET_SUI`

- **Problem (predicted on a live testnet station about to gain a third
  consumer):** `REFILL_THRESHOLD_SUI` is both the start and the stop line —
  the refill check is a single `balance >= threshold` early-return. Raising
  the threshold to hold a larger float therefore parks the balance exactly
  AT the threshold, where every sponsorship the station pays for re-arms a
  faucet request on the next eligible tick: an endless one-request-per-
  cooldown trickle (up to 48/day at the 30-min cooldown). Poor faucet
  citizenship, and `nextEligibleAt` is permanently near-now.
- **Decision:** add an optional `REFILL_TARGET_SUI` stop line with a
  hysteresis latch: arm when balance < threshold, keep requesting one grant
  per cooldown window while armed, disarm at target. Unset (or <=
  threshold) collapses the band — byte-equivalent to the old single check,
  so existing deployments are untouched. The latch starts disarmed, so a
  restart with the balance inside the band waits for a real dip.
- Cooldown/backoff, the structural faucet-network guard (mainnet cannot
  enable refill), and one-request-per-tick all unchanged. `/health` now
  reports `refill.thresholdMist` / `targetMist` / `active` (strings/bool —
  the snapshot must stay JSON-serialisable, bigints would 500 /health).

## 2026-07-25 - Gas station self-care: faucet auto-refill + gas-coin pool

- **Problem (found on a live testnet station):** the station's real
  concurrency ceiling is the number of DISTINCT sponsor coins holding at
  least `GAS_BUDGET_MIST`, because `GasPool` pins one coin per in-flight
  sponsorship. A freshly funded sponsor address owns **one** coin, so the
  station silently served one sponsorship at a time and answered 503
  "Sponsor gas pool depleted" to everything concurrent - with a perfectly
  healthy balance on `/health`. Nothing in the metrics said so, because
  `/health` reported a balance and never a coin count. Second, smaller
  problem: on a faucet network the float running dry is pure operator toil.
- **Decision:** both are platform concerns, not deployment scripts, so they
  live in the package - a new `selfcare.ts` with a `TestnetSelfCare`
  maintenance loop, both halves **opt-in and off by default**:
  - `TESTNET_AUTO_REFILL=true` + `REFILL_THRESHOLD_SUI` asks the network
    faucet when the float drops, with a cooldown after success and
    exponential backoff (capped) after refusals. Faucet refusals (rate
    limits, datacenter-IP blocks) are normal and never crash the station.
  - `GAS_POOL_TARGET_COINS=N` keeps N independently usable gas coins by
    splitting the largest coin (`GAS_POOL_COIN_MIST` each, leaving
    `GAS_POOL_RESERVE_MIST` in the parent, ≤ `GAS_POOL_MAX_SPLITS_PER_TX`
    per transaction).
- **Why in-process:** splitting needs the sponsor key to sign. The key
  only ever exists in this process's environment, so an external splitter
  script would have to be given it - strictly worse. The loop runs beside
  the server and shares its client and pool.
- **Anti-equivocation:** maintenance reserves its parent coin *through the
  same `GasPool`* (`reserveLargest`, long TTL), so a live sponsorship can
  never pick the object being split. Equivocating on the sponsor's coin
  would lock the address for an epoch - this is the only interesting
  hazard in the change, and it is closed by construction, with a test.
- **Mainnet:** the faucet half is gated on a `switch` over the networks
  that HAVE a faucet (testnet/devnet/localnet); `mainnet` cannot enable
  it even with a hand-set `FAUCET_HOST`.
- **Observability:** `/health` now reports `pool.coins`, `pool.usableCoins`,
  `pool.largestCoinMist` (30 s cached, no extra RPC per poll) and a
  `selfCare` block (last run, last error, refill attempt/result/next
  eligible time, split attempts/coins created). Operators can finally see
  the concurrency ceiling.
- **Scope:** `policy.ts` and `sponsor.ts` are untouched (the validation and
  co-signing paths are unchanged); `gasPool.ts` gains `reserveLargest()`
  and `inventory()` additively, `reserve()` keeps its exact semantics.
- **Validation:** `pnpm typecheck` + 40 vitest tests green (19 new,
  including "single-coin float admits exactly one concurrent sponsorship"
  and "a split float admits many"), then a live testnet station: one
  1.47 SUI coin split into 10, three parallel `/sponsor` calls all 200
  with three distinct gas coins.

## 2026-07-24 - Distribution model: npm + tagged releases, deliberately no MVR

- **Goal:** act on Builder Showcase feedback (Sketrov): consumers should
  depend on released, versioned packages rather than embedding this repo
  as a git submodule.
- **What changed:** `@frontier-commerce/sdk` is now publishable
  (npm-ready metadata, `files` whitelist, per-package README/LICENCE);
  `.github/workflows/release.yml` publishes it on GitHub releases via
  npm **trusted publishing** (OIDC - tokenless, automatic provenance);
  one release train (git tag `vX.Y.Z` = all workspace versions = SDK npm
  version) with `CHANGELOG.md`; `docs/distribution.md` documents the
  model; the integration guide now recommends npm first (submodules
  demoted to a source-hacking option); `deploy-testnet.ts` stamps
  `evidence.source` (git remote + `git describe`) into descriptors so
  every sovereign deployment records the released source it runs.
- **MVR decision (the nuance):** MVR resolves a name to a *registrant's
  published on-chain package* - its consumers build against that
  deployment and (for unpinned PTB callers) follow the registrant's
  upgrade governance. That fits shared-canonical-deployment protocols
  and is the opposite of this project's sovereign deploy-your-own
  default, so **no MVR name or PackageInfo is registered**. Move source
  distribution = GitHub release tags (`sui client verify-source` against
  the tag). Adopters may register *their own* instance under *their own*
  namespace; MVR naming for the authors' instance is revisited at
  mainnet promotion (checklist step 9). Registration would also require
  a SuiNS namespace and mainnet transactions - out of bounds pre-mainnet.
- **Publish surface:** SDK only. Gas station, indexer, obs-collector and
  demo-consumer remain private (operated infrastructure, not libraries);
  the indexer is the most plausible future candidate.
- **Risk:** low - no chain state touched; npm publication itself is an
  operator action (first publish cannot use trusted publishing).
- **Validation:** full gates (Move tests, `pnpm -r build/typecheck/test`),
  `npm pack` inspection, tarball install + import proof in a throwaway
  external consumer.
- **Follow-ups:** operator creates the npm org, first-publishes
  `@frontier-commerce/sdk@0.1.0` from the tag, registers the trusted
  publisher; internal ops repo pins the submodule to release tags.

## 2026-07-24 - Initial public release (clean import)

- **What:** the repository went public as a fresh-history import of the
  reviewed tree. It was developed privately 2026-07-19 → 2026-07-24,
  including an internal adversarial security review and its remediation
  (summarised below), a real testnet deployment powering EF-Map
  Intelligence, and a real human purchase with sponsored gas verified
  on-chain.
- **What was deliberately separated:** the authors' operational state
  (live deployment descriptors/IDs, custody and disaster-recovery
  runbooks, maintenance scripts, payment evidence) moved to a private
  operations repo. This repo is the canonical technology; deployments —
  including the authors' own — are sovereign instances of it.
- **Licence:** Apache-2.0 (patent grant, trademark carve-out, matches the
  Mysten/Sui ecosystem; all dependencies are permissive).
- **Status at release:** testnet-proven, pre-mainnet, internally reviewed,
  no external audit. The SDK's mainnet guard is active.

## 2026-07-24 - Transport migration: JSON-RPC retired

- **Why:** JSON-RPC is removed from Sui nodes at protocol level as of
  2026-07-31, and testnet endpoints (first-party and the community
  providers the gas station, indexer and testnet scripts depended on)
  dropped it ahead of that date.
- **Transport per job (chosen from the INSTALLED @mysten/sui 2.22 surface,
  not model memory):**
  - Reads/writes/simulation/sponsorship building → **`SuiGrpcClient`**. The
    gas station and SDK were already typed `ClientWithCoreApi` throughout,
    so only construction sites changed (`server.ts`; `SUI_NETWORK` env).
  - Event querying (indexer) → **`SuiGraphQLClient`** (`Query.events`,
    opaque Relay cursors, max page 50). gRPC has NO event-query API in 2.22
    (its SubscriptionService only streams whole checkpoints), so GraphQL is
    the only supported option — a requirement, not a preference.
  - Localnet demo tooling keeps `SuiJsonRpcClient` deliberately (`sui
    start` still serves it; localnet GraphQL needs a local PostgreSQL).
- **Semantics preserved:** `raw_events` schema, (tx_digest, event_seq)
  idempotency and ledger derivation unchanged. Cursor persistence stores
  the opaque GraphQL cursor; legacy `{txDigest,eventSeq}` cursors are
  detected and discarded (safe: re-sweep is idempotent). `publishPackage`
  finds the package id via the transport-agnostic `outputState ===
  'PackageWrite'` marker.
- **Validation:** `poller.test.ts` (fake GraphQL responder: pagination,
  cursor, dedupe, legacy-cursor reset, shape mapping); a live-testnet
  poller validation captured a real deployment's full event history and
  reconciled the ledger; full localnet E2E passed with the gRPC gas
  station co-signing a real sponsored zero-SUI payment and rejecting an
  off-policy target.

## 2026-07-19 - Security-review remediation

Acted on an internal three-reviewer adversarial review of the Move package
and gas station. All fixes are defensive engineering.

- **M1 (root recovery / false ProtocolCap claim):** replaced single-step
  `protocol_recover_root` with a two-step, 72h-timelocked flow:
  `protocol_request_recovery` (public `RecoveryRequestedEvent`) →
  `protocol_execute_recovery`; the merchant root can `cancel_recovery`, and
  `set_recovery_enabled(false)` both blocks requests and clears a pending
  one. Corrected the "ProtocolCap cannot withdraw funds" claim everywhere:
  a completed takeover of an opted-in merchant root transitively reaches
  that merchant's funds — the timelock makes it non-instant and public,
  not impossible. `recovery_enabled` stays default-ON (lost-root
  recoverability is the feature's purpose); sovereign merchants opt out.
- **G1 (gas station inputs):** `validateTransactionKind` validates
  `data.inputs` fail-closed: only `Pure` and ImmOrOwned/Shared/Receiving
  object inputs are sponsorable; `FundsWithdrawal` (address-balance
  withdrawal incl. `withdrawFrom: Sponsor`), `Unresolved*` and unknown
  kinds are rejected. Tested against real BCS bytes.
- **G2 (budget-drain DoS):** sender rate-limit + daily budget are charged
  only AFTER policy validation (admit callback inside the sponsor core),
  refunded when the sponsor fails without signing, clamped so stray
  refunds cannot mint allowance; plus a cheap per-IP pre-validation bucket
  (`RATE_PER_IP_PER_MINUTE`). `sender` remains unauthenticated by nature
  (users sign after sponsorship); documented as best-effort with the
  global budget + IP bucket as backstops.
- **B4:** SDK coin-type regex accepts digits in module/struct names
  (`pool_v2::TOKEN2`); generic instantiations remain unsupported (explicit).
- **B6:** `RefundEvent` carries `currency`; the indexer attributes refunds
  per-currency, falls back to single-currency for legacy events, and
  tracks `unattributedRefunds` (surfaced as a report WARNING).
- **F2:** `SplitDistributedEvent` carries `distributed_total` (sum of
  `amounts`); `expectedTreasury` needs no caller-supplied correction term.
- **Event-struct change policy:** pre-mainnet, additive field changes ride
  fresh publishes (testnet IDs rotate anyway; parsers tolerate both
  shapes). Once a deployment has real consumers, the V2-struct rule in
  `events.move` applies.
- **Confirmed-intended (documented, not changed):** `charge` not gated by
  `credits_enabled` (disabling stops new deposits only); refunds bypass
  `enforce_split` (bounded, payer-only); gross refunds absorb the protocol
  fee from the treasury.
- **Post-review refinements:** budget refunds do not return the per-sender
  bucket slot (build-failure spam keeps counting against the sender);
  per-IP bucket is proxy-aware via explicit `TRUST_PROXY=true` with a
  documented spoofing caveat — the default remains the socket address.

## 2026-07-19 - Agent governance structure

- **Goal:** keep the repo healthy under long-term LLM-agent development:
  no architecture drift, no oversized files, no stale assumptions, no
  unsafe deployment behavior, no per-agent invented conventions.
- **Structure:** `.github/copilot-instructions.md` is the single canonical
  rule set (explicit precedence). `AGENTS.md` (shortened mirror with hard
  boundaries), `CLAUDE.md` (thin pointer), `llms.txt` (machine map) all
  defer to it. Scoped rules in `.github/instructions/` attach by path.
- **Repo-specific rules:** chain-mutation safety ladder (localnet free /
  testnet explicit-only / mainnet forbidden); deployment descriptors as
  runtime truth; architectural-invariants list (authority separation,
  funds-never-trapped, timelocked recovery, sponsor blast radius,
  currency-as-config, events-as-accounting-surface, recoverability);
  event/stored-struct change escalation with upgrade-consequence
  statement.
- **Documented file-size exceptions** (cohesive; do not churn-split):
  `merchant.move` (~554 lines — the Merchant object + cap lifecycle is one
  authority domain) and `packages/sdk/src/tx.ts` (~538 — a flat catalog of
  independent PTB builders).

## 2026-07-19 - Foundation: Move package, SDK, gas station, indexer, E2E proofs

- **Goal:** a reusable commerce/payment layer for Sui apps in the EVE
  Frontier ecosystem — one shared piece of infrastructure instead of each
  app inventing payment plumbing. Mainnet-oriented, testnet-validated.
- **Key architecture decisions (rationale in docs/architecture.md):**
  - Move layer is 100% EVE-Frontier-agnostic: generic `Coin<T>` +
    per-product `TypeName` binding; zero dependency on world-contracts
    packages. Driven by observed EVE package rotation between testnet
    tenants/cycles.
  - One shared `Merchant` object per app (blast-radius + contention
    isolation); protocol `CommerceRegistry` holds config only, never
    funds; fees accrue per-merchant and are pull-swept.
  - Authority: root/operator/treasurer cap tiers with ID-registry
    revocation, root rotation, opt-out-able protocol recovery; pause gates
    intake only — withdrawals/refunds/credit exits are never blockable.
  - Exact-amount payments (SDK splits in-PTB) instead of
    split-change-in-contract; simpler audit surface.
  - Entitlements as table records (non-transferable, revocable, on-chain
    checkable), address-keyed; character-keying left to consumers via key
    namespacing.
  - Payment records retained only within a merchant-set refund window;
    operator-gated pruning that cannot fire early.
  - Events module is the single indexing surface; indexers filter by
    ORIGINAL package ID (upgrade-safe).
  - Gas station: dual-signature sponsorship with policy allowlists,
    per-sender/per-IP limits, daily budget, gas-coin reservation against
    equivocation, distinct depleted-vs-rejected statuses, health endpoint.
    Fixed-cap budget model chosen over estimation after observing a
    fixed-budget outage mode in prior art: predictable exposure + clean
    503s instead of universal 500s.
- **Validation:** full Move unit-test matrix (incl. adversarial tests);
  SDK/gas-station/indexer suites; full localnet E2E with assertions incl.
  sponsored zero-gas payment + policy rejection + event-ledger ==
  chain-treasury reconciliation; real testnet smoke with a real EVE
  payment round-tripped.
- **Follow-ups:** external audit + multisig custody before any mainnet
  step (checklist in security-model.md).
