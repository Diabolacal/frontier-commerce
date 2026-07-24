# Security model

**Posture:** built mainnet-oriented, validated on testnet. This document is
the honest ledger of what is enforced by code, what is enforced by custody,
and what is explicitly deferred. Nothing below claims more than the tests
and demos actually demonstrate.

## Authority matrix

| Capability | Held by | Can | Cannot | Compromise blast radius | Loss impact |
|---|---|---|---|---|---|
| `UpgradeCap` (Sui) | Deployer custody (cold; multisig at mainnet) | Replace package logic entirely | Touch existing object versions without users migrating | Total (upgrade = new logic) - custody is THE control | No more upgrades; system keeps running as-is |
| `ProtocolCap` | Protocol custody (cold) | Pause intake globally; set fee up to **10% hard cap in code**; edit curated listings; migrate registry; **request** timelocked root recovery of merchants that opted in (72h public challenge window; the merchant root can cancel or opt out during it) | Directly withdraw any funds; block withdrawals; touch opted-out merchants; complete a recovery inside the challenge window | Temporary DoS + fee raise to cap. Against recovery-enabled merchants that fail to react within 72h of the public `RecoveryRequestedEvent`: full root takeover, which transitively reaches that merchant's treasury and credit escrow (a recovered root mints treasurer/operator caps). This is the honest cost of offering recovery at all - sovereign merchants opt out | Protocol config frozen; recovery unavailable; all merchant/user flows keep working |
| `ProtocolTreasurerCap` | Protocol finance | Sweep accrued protocol fees per merchant | Anything else | Loss of accrued fees only | Fees accumulate unswept |
| `MerchantCap` (root) | App owner (cold) | Mint/revoke operator+treasurer caps; rotate itself; structural config (split, refund window, credits, recovery opt-out); cancel pending recovery; migrate | Pay-path interference beyond config; touch other merchants | Full control of that one merchant (transitively including its funds, via minted caps) | Recoverable via the timelocked `protocol_request_recovery` / `protocol_execute_recovery` flow if opted in (default); otherwise permanent |
| `OperatorCap` (hot) | App backend(s) | Catalog, entitlement grants/revokes, credit charges, pause toggle, record pruning | Reach the merchant treasury; withdraw anything; mint caps; change structural config. (`charge` moves user credit escrow -> treasury, bounded per user by that user's own deposits - it cannot create an outflow to the operator) | Bogus grants/charges (charges bounded per-user by deposits), catalog vandalism, pause DoS - all revocable + evented | Root mints a replacement |
| `TreasurerCap` | App finance | Withdraw/distribute earnings, refunds | Config, grants, credits escrow beyond refund paths | Drain of that merchant's **treasury** (not credit escrow beyond legit refund amounts; refunds only return to original payers, bounded per payment) | Root mints a replacement |
| User wallet | Player | Pay, deposit credits, withdraw own credits | Anything privileged | Own funds only | Own funds |

Design rule behind the matrix: **no single hot key can both configure and
move funds.** The hot path (OperatorCap) is fund-less; the funds path
(TreasurerCap) is config-less; the root that binds them is meant to be cold.

## Code-enforced invariants (each has at least one test)

1. Exact-amount payments; `price * quantity` computed in u128, must fit u64.
2. Protocol fee hard-capped: `set_protocol_fee_bps` aborts above 1000 bps.
3. Fee arithmetic floors; fee <= amount always.
4. Refund total across partial refunds can never exceed the recorded
   payment; refunds only flow to the original payer; wrong-currency refunds
   abort; refunds impossible when no record was kept (window = 0).
5. Payment records cannot be pruned before their refund window elapses -
   not even by the operator.
6. Credits: escrow segregated from treasury; per-(currency,user) ledger;
   charge/withdraw bounded by balance; sum(ledger) == escrow (asserted in
   tests via `credit_escrow_value`).
7. Pauses gate `pay`/`deposit`/`charge` only; `withdraw_credits`, `refund`,
   `withdraw`, `distribute`, `sweep_fees` ignore pause.
8. Split policy: 1..=16 unique recipients, bps >= 1 each, sum <= 10000;
   distribution floors each share, remainder stays in treasury;
   `enforce_split` disables plain withdrawals.
9. Cap checks always verify BOTH `cap.merchant_id == merchant` (confused
   deputy) AND registry membership (revocation); root additionally against
   `root_cap_id` (rotation).
9b. Protocol root recovery is two-step and timelocked: request emits a
    public event, execution aborts before 72h elapse, the merchant root can
    cancel, and opting out both blocks new requests and clears a pending
    one. All five paths are tested.
10. Versioned shared objects: every mutating entry asserts object version ==
    package version; migration is explicit and admin-gated - post-upgrade,
    stale package code cannot touch migrated state.
11. Entitlements: expiry strictly `>` now; timed grants extend from
    max(now, current); a timed grant never downgrades a permanent one;
    revocation deletes the record (storage rebate) with event trail.
12. All string/byte inputs length-capped (names 64, URIs/memos 256,
    external refs 128, entitlement keys 64); quantity capped at 1200;
    caps per role capped at 32; split recipients at 16.

## Gas-station threat handling

| Threat | Control |
|---|---|
| Sponsor coin theft via PTB (split/transfer sponsor gas) | Recursive `GasCoin`-reference rejection + command-kind allowlist (no TransferObjects/Publish/Upgrade) - tested against real BCS bytes |
| Sponsor-side value sources smuggled via INPUTS (e.g. `FundsWithdrawal { withdrawFrom: Sponsor }` address-balance withdrawal) | Input-kind allowlist: only `Pure` and ImmOrOwned/Shared/Receiving object inputs are sponsorable; withdrawal, unresolved and unknown input kinds rejected fail-closed - tested against real BCS bytes |
| Sponsoring arbitrary calls | Per-app package::module::function allowlist; cross-app mixing rejected; fail-closed on missing/invalid policy. Policy cannot see type arguments: allowlisted generic functions must validate their own `T` on-chain (the commerce package does); never allowlist generic value-minting helpers like `coin::zero<T>` in production |
| Griefing / gas burn | Per-sender token bucket, global daily budget (counted at worst-case cap), per-IP pre-validation bucket, body-size cap, timestamp freshness, optional bearer key, sender deny-list, kill switch |
| Budget-drain DoS via well-formed junk (unauthenticated `sender` rotation) | Sender/budget accounting is charged only AFTER policy validation passes, and refunded when the sponsor itself fails without signing (pool depleted / build error). Only policy-passing transactions can consume the daily budget. Residual: `sender` remains unauthenticated (users sign only after sponsorship), so the per-sender bucket is best-effort; mainnet posture is authenticated sessions or an upstream rate-limiter |
| Equivocation (two sponsorships sharing a gas coin) | In-memory per-coin reservation with TTL (single-instance; multi-instance requires a shared store - documented gap) |
| Sponsor outage ambiguity | Distinct 503 "pool depleted" vs 403 "rejected"; `/health` exposes balance + `lowBalance`; structured JSON audit log for every decision |
| Key exposure | Key only ever in env/secret store; sponsor address holds a small SUI float only - it is *designed to be expendable and rotatable* (see key-management.md) |

Residual: the sponsor key IS hot by nature. The bound on damage is the float
balance and the rate/daily caps, not key secrecy heroics.

## Economic-logic review (attack classes considered)

- **Replay/double-spend:** Sui object model (coins are owned objects; a
  consumed coin cannot be respent). Payment IDs are merchant-scoped
  monotonic; `external_ref` uniqueness is deliberately app-side (documented)
  - on-chain uniqueness would add a table write per payment for a property
  only the app can interpret.
- **Entitlement forgery:** grants originate only from the pay path or a
  registered OperatorCap; records are non-transferable table entries;
  cross-merchant forgery blocked by cap↔merchant binding.
- **Fee bypass:** fee carved inside `pay`/`charge` before any funds land in
  the merchant treasury; no alternative intake path exists.
- **Confused deputy:** every cap function re-derives authority from the
  (cap, merchant) pair; caps embed their merchant ID at mint.
- **Rounding/precision:** all bps math in u128 with floor; dust stays in
  treasury (never minted/lost); tests pin exact values incl. odd amounts.
- **Stale-state / upgrade abuse:** versioned objects + explicit migrate;
  original-vs-latest package ID discipline in SDK (event filters pinned to
  original ID; call targets to latest).
- **Griefing via state growth:** everything an attacker can grow costs them
  gas/storage deposit on their own key (credit dust accounts, tiny
  payments); merchant-side records are prunable after the refund window.
- **Sponsorship abuse of the commerce layer:** `pay` uses `ctx.sender()`,
  never the sponsor, for attribution; the station only sponsors allowlisted
  targets.

## Known limitations (deliberate, documented)

1. **Credits metering trusts the merchant operator** - bounded by the
   user's own deposit, fully evented, user can always exit. This is the
   honest shape of prepaid usage billing without per-call user signatures.
2. **Protocol root recovery is a centralization lever** - default-on
   because all initial merchants are first-party; sovereign merchants opt
   out (`set_recovery_enabled(false)`) and accept that a lost root is then
   unrecoverable. Mitigations: recovery is two-step with a 72h public
   challenge window (`RecoveryRequestedEvent` fires at request time, the
   root can cancel, opt-out clears pending requests), and execution emits
   `RootRotatedEvent { via_recovery: true }`. The honest residual: a
   merchant that neither monitors events nor opts out can be taken over 72h
   after a hostile request, and a taken-over root reaches that merchant's
   funds. Opted-in merchants MUST monitor `RecoveryRequestedEvent` for
   their merchant ID.
3. **Refund window is advisory retention, not a consumer-protection
   guarantee** - the treasurer chooses whether to refund; the chain only
   guarantees refunds cannot exceed what was paid and cannot be forged.
4. **Gas-station limits are in-memory single-instance.**
5. **The indexer trusts RPC event JSON** (shape-tolerant parsing); BCS
   parsing is the hardening path if a provider misbehaves.
6. **`enforce_split` binds treasurer caps, not the merchant root** (root can
   change the policy; changes are evented), and it disables plain
   withdrawals only - refunds (bounded per payment record, paid to the
   original payer) remain possible. Partners should treat the event stream,
   not the flag, as their audit tool.

## Testnet vs mainnet posture

| Concern | Testnet today (deliberate) | Mainnet requirement (before ANY real value) |
|---|---|---|
| UpgradeCap / ProtocolCap / MerchantCap custody | Operator's single CLI key | Sui native **multisig** addresses (threshold >= 2-of-3) with keys on separate media/locations; documented holders |
| Key backup | Operator keystore + password manager | Every cap-holding key derivable from backed-up mnemonics stored in >= 2 physical locations; no key exists on only one machine |
| Sponsor float | Faucet-funded, ad hoc | Dedicated funding wallet, monitored `/health`, auto-alerts, documented refill ceiling |
| Rate limits / daily budget | In-memory defaults | Shared store (or single pinned instance), tuned caps, alerting on 429/503 rates |
| Package immutability | Upgradeable freely | Consider `make_immutable` or a timelocked upgrade policy once the surface stabilises; at minimum multisig-held UpgradeCap |
| Deployment descriptor | `deployments/testnet.json` committed | Mainnet descriptor added ONLY via the promotion checklist below; SDK guard removed in the same reviewed change |
| Independent review | This repo's adversarial self-review | External audit of the Move package before value at risk |
| Protocol fee | 0 (default) | Explicit fee decision + comms before enabling |

### Mainnet promotion checklist (execute in order, tick in the PR)

1. Re-run the full Move test suite + localnet E2E on the release commit.
2. External (or at minimum independent-agent) security review of
   `move/frontier_commerce` at that commit; findings resolved.
3. Create multisig addresses for: deployer/UpgradeCap holder, ProtocolCap,
   ProtocolTreasurerCap. Record custody (who/where/threshold) in
   key-management.md.
4. Publish from the multisig deployer on mainnet; verify bytecode with
   `sui client verify-source` against the tagged commit.
5. Transfer ProtocolCap + ProtocolTreasurerCap + UpgradeCap to their
   multisig custodians; verify on-chain ownership.
6. Write `deployments/mainnet.json`; remove the SDK mainnet guard in the
   same reviewed PR; pin the EVE mainnet coin type from the official assets
   package (verify against CCP's published address, not memory).
7. Stand up gas station + indexer on monitored infra with alerting; fund
   sponsor float from a tracked wallet.
8. Run a real-value canary: one paid product at trivial price; full
   pay->entitle->refund->sweep cycle verified on mainnet before any consumer
   integrates.
