/// The `Merchant` shared object: one per consumer application.
///
/// A merchant is a self-contained commerce tenant - catalog, treasuries,
/// entitlements, credits and authority all live inside its own object, so
/// the blast radius of any compromise is one application, and payment
/// throughput never contends across applications.
///
/// Authority model (three cap tiers, all revocable/rotatable):
/// - `MerchantCap` (root, keep cold)  mint/revoke operator & treasurer caps,
///   rotate itself, structural config (split policy, refund window, credits
///   on/off, recovery opt-out), migration.
/// - `OperatorCap` (hot, per-service) day-to-day: catalog, entitlement
///   grants/revokes, credit charges, pause toggle, record pruning.
///   Cannot reach the treasury or withdraw; `charge` moves user credit
///   escrow -> treasury, bounded by what that user deposited.
/// - `TreasurerCap` withdrawals, distributions, refunds. CANNOT change
///   config or grant entitlements.
///
/// Revocation pattern: operator/treasurer caps are owned objects and cannot
/// be seized, so the merchant registers their IDs and every use re-checks
/// membership. Revoking = deleting the ID from the set; the stolen cap
/// object becomes inert. The root cap is validated against `root_cap_id`,
/// so rotating the root invalidates the previous cap object the same way.
///
/// Recovery: losing the root cap is otherwise unrecoverable, so merchants
/// opt in (default on) to protocol root recovery. Recovery is a TWO-STEP,
/// TIMELOCKED process: the ProtocolCap holder requests recovery (public
/// event), and only after `RECOVERY_DELAY_MS` can it mint the replacement
/// root. During the window the current root can `cancel_recovery` (proving
/// it still exists) and/or opt out entirely. This means a compromised
/// ProtocolCap cannot instantly seize opted-in merchants: every takeover
/// attempt is public for the full delay before it can bite. Sovereign
/// merchants opt out and rely purely on their own custody.
module frontier_commerce::merchant;

use std::string::String;
use frontier_commerce::events;
use frontier_commerce::registry;
use frontier_commerce::types::{Self, Product, PaymentRecord, EntitlementKey, EntitlementRecord,
    CreditKey, SplitShare};
use sui::bag::{Self, Bag};
use sui::clock::Clock;
use sui::table::{Self, Table};
use sui::vec_set::{Self, VecSet};

const MAX_NAME_BYTES: u64 = 64;
/// Bound on registered operator + treasurer caps (each), to keep the sets small.
const MAX_CAPS_PER_ROLE: u64 = 32;
/// Split policy bounds.
const MAX_SPLIT_RECIPIENTS: u64 = 16;
const BPS_DENOMINATOR: u64 = 10_000;

const ROLE_OPERATOR: u8 = 1;
const ROLE_TREASURER: u8 = 2;

/// Challenge window between a protocol recovery request and its execution:
/// 72 hours. Long enough for a monitoring merchant to cancel/opt out, short
/// enough that a genuinely lost root is not unrecoverable for weeks.
const RECOVERY_DELAY_MS: u64 = 259_200_000;

#[error]
const ENotMerchantCap: vector<u8> = b"Cap does not belong to this merchant";
#[error]
const ERevokedCap: vector<u8> = b"Cap has been revoked or superseded";
#[error]
const ENameTooLong: vector<u8> = b"Name exceeds 64 bytes";
#[error]
const ETooManyCaps: vector<u8> = b"Cap registry is full for this role";
#[error]
const EUnknownCap: vector<u8> = b"Cap ID is not registered for this role";
#[error]
const EWrongVersion: vector<u8> =
    b"Merchant version does not match this package version; run migration or use the current package";
#[error]
const ENotUpgrade: vector<u8> = b"Migration target version must be newer than the object version";
#[error]
const EBadSplitPolicy: vector<u8> =
    b"Split policy invalid: 1..=16 unique recipients, bps >= 1 each, sum <= 10000";
#[error]
const ERecoveryDisabled: vector<u8> = b"This merchant has opted out of protocol recovery";
#[error]
const ERecoveryAlreadyPending: vector<u8> = b"A recovery request is already pending";
#[error]
const ENoPendingRecovery: vector<u8> = b"No recovery request is pending";
#[error]
const ERecoveryDelayNotElapsed: vector<u8> =
    b"The recovery challenge window (72h) has not elapsed yet";

public struct Merchant has key {
    id: UID,
    version: u64,
    name: String,
    /// Merchant-level kill switch for revenue intake. Same non-trapping rule
    /// as the protocol pause: withdrawals/refunds/credit recovery stay open.
    paused: bool,
    // --- authority ---
    root_cap_id: ID,
    operator_cap_ids: VecSet<ID>,
    treasurer_cap_ids: VecSet<ID>,
    /// Allows timelocked protocol root recovery. Default true; root can opt
    /// out (opting out also cancels any pending request).
    recovery_enabled: bool,
    /// Timestamp of the pending recovery request, if any. Execution is only
    /// possible `RECOVERY_DELAY_MS` after this.
    recovery_requested_at_ms: Option<u64>,
    // --- catalog ---
    products: Table<u64, Product>,
    next_product_id: u64,
    // --- payments / refunds ---
    payment_records: Table<u64, PaymentRecord>,
    next_payment_id: u64,
    /// How long payment records are retained for refunds. 0 = keep no
    /// records (refunds disabled; cheapest storage profile).
    refund_window_ms: u64,
    // --- entitlements ---
    entitlements: Table<EntitlementKey, EntitlementRecord>,
    // --- prepaid credits ---
    credits_enabled: bool,
    credit_ledger: Table<CreditKey, u64>,
    /// User-owned prepaid funds, segregated from merchant earnings.
    /// Invariant per currency: sum(credit_ledger) == credit_escrow value.
    credit_escrow: Bag,
    // --- funds ---
    /// Merchant earnings by currency (TypeName -> Balance<T>).
    treasury: Bag,
    /// Protocol's accrued fee cut by currency; swept by ProtocolTreasurerCap.
    fees_accrued: Bag,
    // --- revenue split ---
    split_policy: vector<SplitShare>,
    /// When true, plain `withdraw` is disabled: treasury funds leave only
    /// via `distribute` (binding treasurer-cap holders to the policy) or via
    /// `refund` (bounded per payment record, paid to the original payer).
    enforce_split: bool,
}

public struct MerchantCap has key, store {
    id: UID,
    merchant_id: ID,
}

public struct OperatorCap has key, store {
    id: UID,
    merchant_id: ID,
}

public struct TreasurerCap has key, store {
    id: UID,
    merchant_id: ID,
}

// === Creation ===

/// Create a merchant. Permissionless by design: each merchant is isolated,
/// so open creation adds no cross-tenant risk and removes the ProtocolCap
/// from the onboarding critical path. All three caps go to the sender
/// (use a multisig sender for production merchants).
#[allow(lint(self_transfer))]
public fun create_merchant(name: String, ctx: &mut TxContext) {
    assert!(name.length() <= MAX_NAME_BYTES, ENameTooLong);
    let root_cap = MerchantCap { id: object::new(ctx), merchant_id: @0x0.to_id() };
    let operator_cap = OperatorCap { id: object::new(ctx), merchant_id: @0x0.to_id() };
    let treasurer_cap = TreasurerCap { id: object::new(ctx), merchant_id: @0x0.to_id() };

    let mut merchant = Merchant {
        id: object::new(ctx),
        version: registry::current_version(),
        name,
        paused: false,
        root_cap_id: object::id(&root_cap),
        operator_cap_ids: vec_set::empty(),
        treasurer_cap_ids: vec_set::empty(),
        recovery_enabled: true,
        recovery_requested_at_ms: option::none(),
        products: table::new(ctx),
        next_product_id: 1,
        payment_records: table::new(ctx),
        next_payment_id: 1,
        refund_window_ms: 0,
        entitlements: table::new(ctx),
        credits_enabled: false,
        credit_ledger: table::new(ctx),
        credit_escrow: bag::new(ctx),
        treasury: bag::new(ctx),
        fees_accrued: bag::new(ctx),
        split_policy: vector[],
        enforce_split: false,
    };

    let merchant_id = object::id(&merchant);
    let mut root_cap = root_cap;
    let mut operator_cap = operator_cap;
    let mut treasurer_cap = treasurer_cap;
    root_cap.merchant_id = merchant_id;
    operator_cap.merchant_id = merchant_id;
    treasurer_cap.merchant_id = merchant_id;

    merchant.root_cap_id = object::id(&root_cap);
    merchant.operator_cap_ids.insert(object::id(&operator_cap));
    merchant.treasurer_cap_ids.insert(object::id(&treasurer_cap));

    events::emit_merchant_created(merchant_id, merchant.name, ctx.sender());
    events::emit_cap_minted(merchant_id, object::id(&operator_cap), ROLE_OPERATOR);
    events::emit_cap_minted(merchant_id, object::id(&treasurer_cap), ROLE_TREASURER);

    transfer::share_object(merchant);
    transfer::transfer(root_cap, ctx.sender());
    transfer::transfer(operator_cap, ctx.sender());
    transfer::transfer(treasurer_cap, ctx.sender());
}

// === Authority checks (package-internal) ===

public(package) fun assert_root(merchant: &Merchant, cap: &MerchantCap) {
    assert!(cap.merchant_id == object::id(merchant), ENotMerchantCap);
    assert!(object::id(cap) == merchant.root_cap_id, ERevokedCap);
}

public(package) fun assert_operator(merchant: &Merchant, cap: &OperatorCap) {
    assert!(cap.merchant_id == object::id(merchant), ENotMerchantCap);
    assert!(merchant.operator_cap_ids.contains(&object::id(cap)), ERevokedCap);
}

public(package) fun assert_treasurer(merchant: &Merchant, cap: &TreasurerCap) {
    assert!(cap.merchant_id == object::id(merchant), ENotMerchantCap);
    assert!(merchant.treasurer_cap_ids.contains(&object::id(cap)), ERevokedCap);
}

public(package) fun assert_version(merchant: &Merchant) {
    assert!(merchant.version == registry::current_version(), EWrongVersion);
}

// === Cap lifecycle (root) ===

public fun mint_operator_cap(
    merchant: &mut Merchant,
    cap: &MerchantCap,
    ctx: &mut TxContext,
): OperatorCap {
    assert_version(merchant);
    assert_root(merchant, cap);
    assert!(merchant.operator_cap_ids.length() < MAX_CAPS_PER_ROLE, ETooManyCaps);
    let new_cap = OperatorCap { id: object::new(ctx), merchant_id: object::id(merchant) };
    merchant.operator_cap_ids.insert(object::id(&new_cap));
    events::emit_cap_minted(object::id(merchant), object::id(&new_cap), ROLE_OPERATOR);
    new_cap
}

public fun mint_treasurer_cap(
    merchant: &mut Merchant,
    cap: &MerchantCap,
    ctx: &mut TxContext,
): TreasurerCap {
    assert_version(merchant);
    assert_root(merchant, cap);
    assert!(merchant.treasurer_cap_ids.length() < MAX_CAPS_PER_ROLE, ETooManyCaps);
    let new_cap = TreasurerCap { id: object::new(ctx), merchant_id: object::id(merchant) };
    merchant.treasurer_cap_ids.insert(object::id(&new_cap));
    events::emit_cap_minted(object::id(merchant), object::id(&new_cap), ROLE_TREASURER);
    new_cap
}

/// Revoke by ID: works even when the cap object is in an attacker's hands.
public fun revoke_operator_cap(merchant: &mut Merchant, cap: &MerchantCap, cap_id: ID) {
    assert_version(merchant);
    assert_root(merchant, cap);
    assert!(merchant.operator_cap_ids.contains(&cap_id), EUnknownCap);
    merchant.operator_cap_ids.remove(&cap_id);
    events::emit_cap_revoked(object::id(merchant), cap_id, ROLE_OPERATOR);
}

public fun revoke_treasurer_cap(merchant: &mut Merchant, cap: &MerchantCap, cap_id: ID) {
    assert_version(merchant);
    assert_root(merchant, cap);
    assert!(merchant.treasurer_cap_ids.contains(&cap_id), EUnknownCap);
    merchant.treasurer_cap_ids.remove(&cap_id);
    events::emit_cap_revoked(object::id(merchant), cap_id, ROLE_TREASURER);
}

/// Rotate the root cap: consumes the current one, mints and returns a fresh
/// one. The old cap object is deleted; even a copy of its ID is useless.
public fun rotate_root(
    merchant: &mut Merchant,
    cap: MerchantCap,
    ctx: &mut TxContext,
): MerchantCap {
    assert_version(merchant);
    assert_root(merchant, &cap);
    let MerchantCap { id, merchant_id: _ } = cap;
    let old_cap_id = id.to_inner();
    id.delete();
    let new_cap = MerchantCap { id: object::new(ctx), merchant_id: object::id(merchant) };
    merchant.root_cap_id = object::id(&new_cap);
    events::emit_root_rotated(object::id(merchant), old_cap_id, object::id(&new_cap), false);
    new_cap
}

/// Step 1 of protocol-side root recovery (merchants that opted in only):
/// start the public challenge window. Emits `RecoveryRequestedEvent` so the
/// merchant (and anyone watching) sees the attempt immediately. The current
/// root can `cancel_recovery` or `set_recovery_enabled(false)` at any time
/// before execution.
public fun protocol_request_recovery(
    merchant: &mut Merchant,
    _cap: &registry::ProtocolCap,
    clock: &Clock,
) {
    assert_version(merchant);
    assert!(merchant.recovery_enabled, ERecoveryDisabled);
    assert!(merchant.recovery_requested_at_ms.is_none(), ERecoveryAlreadyPending);
    let now = clock.timestamp_ms();
    merchant.recovery_requested_at_ms = option::some(now);
    events::emit_recovery_requested(object::id(merchant), now, now + RECOVERY_DELAY_MS);
}

/// Step 2: after the challenge window has elapsed uncancelled, supersede the
/// old root cap (it stops validating) and return a fresh one for the caller
/// to deliver to the merchant's new custody address.
public fun protocol_execute_recovery(
    merchant: &mut Merchant,
    _cap: &registry::ProtocolCap,
    clock: &Clock,
    ctx: &mut TxContext,
): MerchantCap {
    assert_version(merchant);
    assert!(merchant.recovery_enabled, ERecoveryDisabled);
    assert!(merchant.recovery_requested_at_ms.is_some(), ENoPendingRecovery);
    let requested_at = *merchant.recovery_requested_at_ms.borrow();
    assert!(
        (clock.timestamp_ms() as u128) >= (requested_at as u128) + (RECOVERY_DELAY_MS as u128),
        ERecoveryDelayNotElapsed,
    );
    merchant.recovery_requested_at_ms = option::none();
    let old_cap_id = merchant.root_cap_id;
    let new_cap = MerchantCap { id: object::new(ctx), merchant_id: object::id(merchant) };
    merchant.root_cap_id = object::id(&new_cap);
    events::emit_root_rotated(object::id(merchant), old_cap_id, object::id(&new_cap), true);
    new_cap
}

/// Root-holder veto of a pending recovery request. Using the root cap here
/// is itself proof the root is not lost. Note: against a *compromised*
/// ProtocolCap (which can simply re-request), cancelling only buys time -
/// the durable defence is `set_recovery_enabled(false)`.
public fun cancel_recovery(merchant: &mut Merchant, cap: &MerchantCap) {
    assert_version(merchant);
    assert_root(merchant, cap);
    assert!(merchant.recovery_requested_at_ms.is_some(), ENoPendingRecovery);
    merchant.recovery_requested_at_ms = option::none();
    events::emit_recovery_cancelled(object::id(merchant));
}

// === Merchant config ===

/// Pause/unpause revenue intake. Operator-level: pausing is incident
/// response and must not require cold root keys.
public fun set_paused(merchant: &mut Merchant, cap: &OperatorCap, paused: bool) {
    assert_version(merchant);
    assert_operator(merchant, cap);
    merchant.paused = paused;
    emit_settings(merchant);
}

public fun set_recovery_enabled(merchant: &mut Merchant, cap: &MerchantCap, enabled: bool) {
    assert_version(merchant);
    assert_root(merchant, cap);
    merchant.recovery_enabled = enabled;
    // Opting out is the durable defence against a hostile ProtocolCap, so it
    // must also kill any in-flight request.
    if (!enabled && merchant.recovery_requested_at_ms.is_some()) {
        merchant.recovery_requested_at_ms = option::none();
        events::emit_recovery_cancelled(object::id(merchant));
    };
    emit_settings(merchant);
}

public fun set_refund_window_ms(merchant: &mut Merchant, cap: &MerchantCap, window_ms: u64) {
    assert_version(merchant);
    assert_root(merchant, cap);
    merchant.refund_window_ms = window_ms;
    emit_settings(merchant);
}

public fun set_credits_enabled(merchant: &mut Merchant, cap: &MerchantCap, enabled: bool) {
    assert_version(merchant);
    assert_root(merchant, cap);
    merchant.credits_enabled = enabled;
    emit_settings(merchant);
}

/// Set the revenue split policy. `recipients`/`bps` are parallel vectors;
/// 1..=16 unique recipients, each bps >= 1, sum <= 10000. Any remainder
/// (10000 - sum) stays in the treasury on distribution.
public fun set_split_policy(
    merchant: &mut Merchant,
    cap: &MerchantCap,
    recipients: vector<address>,
    bps: vector<u64>,
    enforce: bool,
) {
    assert_version(merchant);
    assert_root(merchant, cap);
    let n = recipients.length();
    assert!(n >= 1 && n <= MAX_SPLIT_RECIPIENTS && bps.length() == n, EBadSplitPolicy);

    let mut shares = vector<SplitShare>[];
    let mut sum: u64 = 0;
    let mut i = 0;
    while (i < n) {
        let share_bps = bps[i];
        assert!(share_bps >= 1, EBadSplitPolicy);
        sum = sum + share_bps;
        // Reject duplicate recipients (hygiene; bounds are small).
        let mut j = 0;
        while (j < i) {
            assert!(recipients[j] != recipients[i], EBadSplitPolicy);
            j = j + 1;
        };
        shares.push_back(types::split_share(recipients[i], share_bps));
        i = i + 1;
    };
    assert!(sum <= BPS_DENOMINATOR, EBadSplitPolicy);

    merchant.split_policy = shares;
    merchant.enforce_split = enforce;
    events::emit_split_policy_set(object::id(merchant), recipients, bps, enforce);
    emit_settings(merchant);
}

public fun clear_split_policy(merchant: &mut Merchant, cap: &MerchantCap) {
    assert_version(merchant);
    assert_root(merchant, cap);
    merchant.split_policy = vector[];
    merchant.enforce_split = false;
    events::emit_split_policy_cleared(object::id(merchant));
    emit_settings(merchant);
}

/// Bring the merchant object to this package's version after an upgrade.
public fun migrate_merchant(merchant: &mut Merchant, cap: &MerchantCap) {
    // Root check against stored fields only; deliberately no version assert
    // (the whole point is the versions differ).
    assert!(cap.merchant_id == object::id(merchant), ENotMerchantCap);
    assert!(object::id(cap) == merchant.root_cap_id, ERevokedCap);
    assert!(merchant.version < registry::current_version(), ENotUpgrade);
    merchant.version = registry::current_version();
    events::emit_merchant_migrated(object::id(merchant), merchant.version);
}

fun emit_settings(merchant: &Merchant) {
    events::emit_merchant_settings(
        object::id(merchant),
        merchant.paused,
        merchant.refund_window_ms,
        merchant.credits_enabled,
        merchant.recovery_enabled,
        merchant.enforce_split,
    );
}

// === Views ===

public fun merchant_name(merchant: &Merchant): String { merchant.name }

public fun is_paused(merchant: &Merchant): bool { merchant.paused }

public fun refund_window_ms(merchant: &Merchant): u64 { merchant.refund_window_ms }

public fun credits_enabled(merchant: &Merchant): bool { merchant.credits_enabled }

public fun recovery_enabled(merchant: &Merchant): bool { merchant.recovery_enabled }

/// Timestamp of the pending protocol recovery request (None when idle).
public fun recovery_requested_at_ms(merchant: &Merchant): Option<u64> {
    merchant.recovery_requested_at_ms
}

/// The recovery challenge window length.
public fun recovery_delay_ms(): u64 { RECOVERY_DELAY_MS }

public fun enforce_split(merchant: &Merchant): bool { merchant.enforce_split }

public fun merchant_version(merchant: &Merchant): u64 { merchant.version }

public fun cap_merchant_id_of_root(cap: &MerchantCap): ID { cap.merchant_id }

public fun cap_merchant_id_of_operator(cap: &OperatorCap): ID { cap.merchant_id }

public fun cap_merchant_id_of_treasurer(cap: &TreasurerCap): ID { cap.merchant_id }

// === Package-internal state accessors ===

public(package) fun products(merchant: &Merchant): &Table<u64, Product> { &merchant.products }

public(package) fun products_mut(merchant: &mut Merchant): &mut Table<u64, Product> {
    &mut merchant.products
}

public(package) fun take_next_product_id(merchant: &mut Merchant): u64 {
    let id = merchant.next_product_id;
    merchant.next_product_id = id + 1;
    id
}

public(package) fun payment_records(merchant: &Merchant): &Table<u64, PaymentRecord> {
    &merchant.payment_records
}

public(package) fun payment_records_mut(merchant: &mut Merchant): &mut Table<u64, PaymentRecord> {
    &mut merchant.payment_records
}

public(package) fun take_next_payment_id(merchant: &mut Merchant): u64 {
    let id = merchant.next_payment_id;
    merchant.next_payment_id = id + 1;
    id
}

public(package) fun entitlements(merchant: &Merchant): &Table<EntitlementKey, EntitlementRecord> {
    &merchant.entitlements
}

public(package) fun entitlements_mut(
    merchant: &mut Merchant,
): &mut Table<EntitlementKey, EntitlementRecord> {
    &mut merchant.entitlements
}

public(package) fun credit_ledger(merchant: &Merchant): &Table<CreditKey, u64> {
    &merchant.credit_ledger
}

public(package) fun credit_ledger_mut(merchant: &mut Merchant): &mut Table<CreditKey, u64> {
    &mut merchant.credit_ledger
}

public(package) fun credit_escrow_mut(merchant: &mut Merchant): &mut Bag {
    &mut merchant.credit_escrow
}

public(package) fun credit_escrow(merchant: &Merchant): &Bag { &merchant.credit_escrow }

public(package) fun treasury_mut(merchant: &mut Merchant): &mut Bag { &mut merchant.treasury }

public(package) fun treasury(merchant: &Merchant): &Bag { &merchant.treasury }

public(package) fun fees_accrued_mut(merchant: &mut Merchant): &mut Bag {
    &mut merchant.fees_accrued
}

public(package) fun fees_accrued(merchant: &Merchant): &Bag { &merchant.fees_accrued }

public(package) fun split_policy(merchant: &Merchant): &vector<SplitShare> {
    &merchant.split_policy
}
