# Decision log

Non-trivial decisions, newest first. This log starts at the public release;
it carries forward the architecture/security decisions from the private
development period (2026-07-19 → 2026-07-24) that a builder needs to
understand the system. The authors' deployment-operations history lives in
their private operations repo.

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

- **Why:** JSON-RPC was removed from Sui nodes at protocol level
  2026-07-31, killing the community providers the gas station, indexer and
  testnet scripts depended on.
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
