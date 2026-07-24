# Key management, rotation & recovery

The rule this repo is built around: **no irreplaceable secret may exist on
only one machine, and no single hot key may both configure a merchant and
move its funds.**

## Inventory (what keys/caps exist and where they should live)

| Secret / cap | Kind | Testnet reality (today) | Mainnet custody target |
|---|---|---|---|
| Deployer key (holds `UpgradeCap`) | Sui keypair | Operator CLI keystore (`~/.sui`); keep a **tested** backup + restore runbook — verify a keystore copy on a second machine derives the expected address | Multisig (2-of-3); component mnemonics on paper/HSM in 2+ locations |
| `ProtocolCap`, `ProtocolTreasurerCap` | Owned objects | Operator address | Separate multisig custodians |
| `MerchantCap` per app | Owned object | Operator address | App owner's cold key/multisig; NOT on servers |
| `OperatorCap` per app backend | Owned object | Operator address | The app backend's service key (hot, expected to be exposed to servers) |
| `TreasurerCap` per app | Owned object | Operator address | App finance key (warm; ideally multisig) |
| Gas-station sponsor key | Sui keypair | Env var when running locally | Secret store (e.g. `wrangler secret`/KMS); float-limited; rotation is routine |
| Deployment descriptors, cap object IDs | Public data | Committed in `deployments/` | Same - these are NOT secrets; possession of an ID grants nothing |

**Never** commit: mnemonics, `suiprivkey...` strings, keystore files, `.env`.
The `.gitignore` enforces the obvious cases; the rule is behavioral too.

## Rotation & revocation runbooks

### Rotate a hot backend key (OperatorCap holder compromised or routine)
1. From the root (MerchantCap) key:
   `mint_operator_cap` -> transfer to the new service address.
2. `revoke_operator_cap(old_cap_id)` - the old object becomes inert
   immediately, wherever it is (no need to seize it).
3. Update the backend's env with the new cap ID. Verify with a no-op grant.
4. Check the event stream (`CapMintedEvent`/`CapRevokedEvent`) landed;
   review recent `CreditChargedEvent`s/`EntitlementGrantedEvent`s for abuse
   during the exposure window; revoke bogus grants.

### Rotate the treasurer
Same shape with `mint_treasurer_cap` / `revoke_treasurer_cap`. Additionally
review `TreasuryWithdrawalEvent`s; a compromised treasurer can have drained
the merchant treasury (bounded to that merchant; credit escrow is NOT
drainable this way - refunds only return to original payers).

### Rotate the merchant root (proactive)
`rotate_root` consumes the old cap object and returns a fresh one -
transfer it straight to the new custody address in the same PTB. The old
cap ID stops validating atomically.

### Merchant root LOST (machine dead, no backup)
If `recovery_enabled` (default): ProtocolCap holder calls
`protocol_request_recovery` (emits the public `RecoveryRequestedEvent`),
waits out the 72h challenge window, then `protocol_execute_recovery` and
delivers the fresh cap to the merchant's new address. Execution emits
`RootRotatedEvent { via_recovery: true }` - publicly visible. The 72h wait
is the price of making hostile recovery non-instant; plan for it in any
incident timeline. If the merchant opted out: the root is gone;
operator/treasurer caps keep working for continuity, but structural config
is frozen forever. That trade-off is the merchant's explicit choice.

### Merchant root STOLEN
Race: the thief can revoke your caps / change config, and can mint a
treasurer cap to reach the treasury - mint + drain takes them two steps
and both emit events, so speed matters. Response: `rotate_root` immediately
if you still hold the cap... but a *stolen* root means you don't. Then:
(1) protocol side starts `protocol_request_recovery` (if enabled) - note
the thief has the full 72h window to act, so simultaneously (2) treasurer
drains the treasury to a safe address (`withdraw`/`distribute`) before the
thief's minted cap can, and (3) after execution, re-mint
operator/treasurer caps and revoke everything minted during the exposure
window (all visible in `CapMintedEvent`s). A stolen ROOT is the worst-case
event; the timelock protects merchants from the protocol, not from their
own root leaking - keep roots cold/multisig.

### Hostile recovery request (ProtocolCap compromised or rogue)
Symptom: a `RecoveryRequestedEvent` for your merchant that you did not ask
for. You have 72h. Response with your root cap: `cancel_recovery`, then
`set_recovery_enabled(false)` - cancel alone only buys time because a
hostile ProtocolCap can re-request; opt-out is the durable defence (it also
clears any pending request atomically). Opted-in merchants MUST monitor
`RecoveryRequestedEvent` for their merchant ID.

### ProtocolCap stolen
Blast radius by design: global intake pause (DoS), fee to the 10% cap,
listing edits, timelocked recovery requests against opted-in merchants
(public, cancellable, 72h before any effect - see above). It cannot
directly move funds or block withdrawals. Response: caps are objects - the
thief's copy can't be revoked, so mainnet custody MUST be multisig; on
testnet, redeploying the registry (new package instance) is the acceptable
nuke. Notify all opted-in merchants to opt out immediately.

### Gas-station sponsor key compromised
It is designed to be expendable: (1) flip `SPONSOR_ENABLED=false` (kill
switch), (2) generate a new keypair, move remaining float, update the
secret, (3) restart. Loss bound = remaining float + whatever the rate
limits allowed. No cap objects are involved.

## "The server disappears tomorrow" drill

- **Chain state (funds, entitlements, credits, catalog):** unaffected -
  it lives on Sui, keyed by caps whose custody is off-server.
- **Gas station:** stateless; redeploy from this repo + set two secrets
  (sponsor key or a fresh one, optional API key). Users pay their own gas
  in the interim - payments never *require* sponsorship.
- **Indexer:** SQLite cache; rebuild from genesis of the deployment by
  running the poller with an empty DB (cursor starts from scratch;
  `raw_events` is idempotent).
- **This repo:** the recovery bootstrap - GitHub + local clones.
- **Caps:** owned objects on addresses whose keys must exist in >= 2 places
  (see inventory). If that discipline held, recovery is: clone repo,
  restore keys, redeploy services, point consumers at the same
  deployment descriptor. Nothing on the dead server was authoritative.

## Sponsor float policy

Keep only working float on the sponsor address (testnet: faucet refills;
mainnet: documented ceiling, e.g. enough for ~1 day of expected
sponsorships). The daily budget limiter should be set BELOW the float so
the service refuses before the wallet empties, and `/health.lowBalance`
should alert before either bound is hit.
