/// Every state transition in the package emits a typed event from this module.
///
/// Events are the accounting/receipt surface: indexers subscribe to
/// `{original_package_id}::events::*` and can rebuild a full ledger without
/// reading object state. Event type prefixes keep the ORIGINAL package ID
/// across upgrades, so indexers must filter on the original ID, never the
/// latest runtime ID.
///
/// Compatibility rule: once a package version has real consumers (mainnet,
/// or a testnet deployment indexers depend on), never change or remove an
/// existing event struct field; additions then require a new event struct
/// (e.g. `PaymentEventV2`). Pre-mainnet, field additions ride the next fresh
/// publish (testnet packages rotate rather than upgrade); indexers must
/// tolerate the older shapes emitted by still-live previous deployments.
module frontier_commerce::events;

use std::string::String;
use std::type_name::TypeName;
use sui::event;

// === Protocol / registry ===

public struct ProtocolConfigEvent has copy, drop {
    fee_bps: u64,
    paused: bool,
}

public struct MerchantListedEvent has copy, drop {
    name: String,
    merchant_id: ID,
}

public struct MerchantDelistedEvent has copy, drop {
    name: String,
    merchant_id: ID,
}

public struct RegistryMigratedEvent has copy, drop {
    version: u64,
}

// === Merchant lifecycle / authority ===

public struct MerchantCreatedEvent has copy, drop {
    merchant_id: ID,
    name: String,
    creator: address,
}

/// Snapshot of merchant toggles; emitted on any settings change.
public struct MerchantSettingsEvent has copy, drop {
    merchant_id: ID,
    paused: bool,
    refund_window_ms: u64,
    credits_enabled: bool,
    recovery_enabled: bool,
    enforce_split: bool,
}

/// role: 1 = operator, 2 = treasurer.
public struct CapMintedEvent has copy, drop {
    merchant_id: ID,
    cap_id: ID,
    role: u8,
}

public struct CapRevokedEvent has copy, drop {
    merchant_id: ID,
    cap_id: ID,
    role: u8,
}

public struct RootRotatedEvent has copy, drop {
    merchant_id: ID,
    old_cap_id: ID,
    new_cap_id: ID,
    /// true when the rotation was performed by protocol recovery rather than
    /// the previous root cap holder.
    via_recovery: bool,
}

/// Protocol recovery challenge window opened. Merchants MUST monitor this:
/// an unexpected request means the ProtocolCap is hostile - cancel with the
/// root cap and opt out before `executable_at_ms`.
public struct RecoveryRequestedEvent has copy, drop {
    merchant_id: ID,
    requested_at_ms: u64,
    executable_at_ms: u64,
}

/// Pending recovery cancelled (by the root cap, or implicitly by opting out).
public struct RecoveryCancelledEvent has copy, drop {
    merchant_id: ID,
}

public struct SplitPolicySetEvent has copy, drop {
    merchant_id: ID,
    recipients: vector<address>,
    bps: vector<u64>,
    enforce: bool,
}

public struct SplitPolicyClearedEvent has copy, drop {
    merchant_id: ID,
}

public struct MerchantMigratedEvent has copy, drop {
    merchant_id: ID,
    version: u64,
}

// === Catalog ===

public struct ProductCreatedEvent has copy, drop {
    merchant_id: ID,
    product_id: u64,
    name: String,
    kind: u8,
    currency: TypeName,
    price: u64,
    duration_ms: u64,
    entitlement_key: Option<String>,
}

public struct ProductUpdatedEvent has copy, drop {
    merchant_id: ID,
    product_id: u64,
    name: String,
    price: u64,
    active: bool,
    metadata_uri: String,
}

// === Payments ===

public struct PaymentEvent has copy, drop {
    merchant_id: ID,
    /// Merchant-scoped monotonic sequence; (merchant_id, payment_id) is
    /// globally unique.
    payment_id: u64,
    product_id: u64,
    payer: address,
    beneficiary: address,
    currency: TypeName,
    /// Total paid (fee included).
    amount: u64,
    /// Protocol fee portion of `amount`.
    fee: u64,
    quantity: u64,
    /// Caller-supplied idempotency/order reference. Uniqueness is NOT
    /// enforced on-chain; consumers must de-duplicate.
    external_ref: Option<String>,
    paid_at_ms: u64,
}

public struct RefundEvent has copy, drop {
    merchant_id: ID,
    payment_id: u64,
    /// Refund currency (the payment's currency). Lets indexers attribute
    /// refunds per-currency without resolving the referenced payment.
    currency: TypeName,
    amount: u64,
    to: address,
    entitlement_revoked: bool,
}

public struct PaymentRecordsPrunedEvent has copy, drop {
    merchant_id: ID,
    payment_ids: vector<u64>,
}

// === Entitlements ===

public struct EntitlementGrantedEvent has copy, drop {
    merchant_id: ID,
    key: String,
    owner: address,
    /// None = permanent.
    expires_at_ms: Option<u64>,
    /// Payment that caused the grant; None if operator-granted.
    source_payment_id: Option<u64>,
}

public struct EntitlementRevokedEvent has copy, drop {
    merchant_id: ID,
    key: String,
    owner: address,
    by_refund: bool,
}

// === Credits ===

public struct CreditDepositedEvent has copy, drop {
    merchant_id: ID,
    owner: address,
    currency: TypeName,
    amount: u64,
    new_balance: u64,
}

public struct CreditChargedEvent has copy, drop {
    merchant_id: ID,
    owner: address,
    currency: TypeName,
    amount: u64,
    fee: u64,
    memo: String,
    new_balance: u64,
}

public struct CreditWithdrawnEvent has copy, drop {
    merchant_id: ID,
    owner: address,
    currency: TypeName,
    amount: u64,
    new_balance: u64,
}

// === Treasury ===

public struct TreasuryWithdrawalEvent has copy, drop {
    merchant_id: ID,
    currency: TypeName,
    amount: u64,
    to: address,
}

public struct SplitDistributedEvent has copy, drop {
    merchant_id: ID,
    currency: TypeName,
    /// Treasury balance BEFORE distribution (not the amount debited).
    total: u64,
    /// Amount actually debited from the treasury: sum of `amounts`.
    /// `total - distributed_total` (rounding dust + unallocated bps) stays.
    distributed_total: u64,
    recipients: vector<address>,
    amounts: vector<u64>,
}

public struct FeesSweptEvent has copy, drop {
    merchant_id: ID,
    currency: TypeName,
    amount: u64,
    to: address,
}

// === Emit helpers (package-internal) ===

public(package) fun emit_protocol_config(fee_bps: u64, paused: bool) {
    event::emit(ProtocolConfigEvent { fee_bps, paused });
}

public(package) fun emit_merchant_listed(name: String, merchant_id: ID) {
    event::emit(MerchantListedEvent { name, merchant_id });
}

public(package) fun emit_merchant_delisted(name: String, merchant_id: ID) {
    event::emit(MerchantDelistedEvent { name, merchant_id });
}

public(package) fun emit_registry_migrated(version: u64) {
    event::emit(RegistryMigratedEvent { version });
}

public(package) fun emit_merchant_created(merchant_id: ID, name: String, creator: address) {
    event::emit(MerchantCreatedEvent { merchant_id, name, creator });
}

public(package) fun emit_merchant_settings(
    merchant_id: ID,
    paused: bool,
    refund_window_ms: u64,
    credits_enabled: bool,
    recovery_enabled: bool,
    enforce_split: bool,
) {
    event::emit(MerchantSettingsEvent {
        merchant_id,
        paused,
        refund_window_ms,
        credits_enabled,
        recovery_enabled,
        enforce_split,
    });
}

public(package) fun emit_cap_minted(merchant_id: ID, cap_id: ID, role: u8) {
    event::emit(CapMintedEvent { merchant_id, cap_id, role });
}

public(package) fun emit_cap_revoked(merchant_id: ID, cap_id: ID, role: u8) {
    event::emit(CapRevokedEvent { merchant_id, cap_id, role });
}

public(package) fun emit_root_rotated(
    merchant_id: ID,
    old_cap_id: ID,
    new_cap_id: ID,
    via_recovery: bool,
) {
    event::emit(RootRotatedEvent { merchant_id, old_cap_id, new_cap_id, via_recovery });
}

public(package) fun emit_recovery_requested(
    merchant_id: ID,
    requested_at_ms: u64,
    executable_at_ms: u64,
) {
    event::emit(RecoveryRequestedEvent { merchant_id, requested_at_ms, executable_at_ms });
}

public(package) fun emit_recovery_cancelled(merchant_id: ID) {
    event::emit(RecoveryCancelledEvent { merchant_id });
}

public(package) fun emit_split_policy_set(
    merchant_id: ID,
    recipients: vector<address>,
    bps: vector<u64>,
    enforce: bool,
) {
    event::emit(SplitPolicySetEvent { merchant_id, recipients, bps, enforce });
}

public(package) fun emit_split_policy_cleared(merchant_id: ID) {
    event::emit(SplitPolicyClearedEvent { merchant_id });
}

public(package) fun emit_merchant_migrated(merchant_id: ID, version: u64) {
    event::emit(MerchantMigratedEvent { merchant_id, version });
}

public(package) fun emit_product_created(
    merchant_id: ID,
    product_id: u64,
    name: String,
    kind: u8,
    currency: TypeName,
    price: u64,
    duration_ms: u64,
    entitlement_key: Option<String>,
) {
    event::emit(ProductCreatedEvent {
        merchant_id,
        product_id,
        name,
        kind,
        currency,
        price,
        duration_ms,
        entitlement_key,
    });
}

public(package) fun emit_product_updated(
    merchant_id: ID,
    product_id: u64,
    name: String,
    price: u64,
    active: bool,
    metadata_uri: String,
) {
    event::emit(ProductUpdatedEvent { merchant_id, product_id, name, price, active, metadata_uri });
}

public(package) fun emit_payment(
    merchant_id: ID,
    payment_id: u64,
    product_id: u64,
    payer: address,
    beneficiary: address,
    currency: TypeName,
    amount: u64,
    fee: u64,
    quantity: u64,
    external_ref: Option<String>,
    paid_at_ms: u64,
) {
    event::emit(PaymentEvent {
        merchant_id,
        payment_id,
        product_id,
        payer,
        beneficiary,
        currency,
        amount,
        fee,
        quantity,
        external_ref,
        paid_at_ms,
    });
}

public(package) fun emit_refund(
    merchant_id: ID,
    payment_id: u64,
    currency: TypeName,
    amount: u64,
    to: address,
    entitlement_revoked: bool,
) {
    event::emit(RefundEvent { merchant_id, payment_id, currency, amount, to, entitlement_revoked });
}

public(package) fun emit_payment_records_pruned(merchant_id: ID, payment_ids: vector<u64>) {
    event::emit(PaymentRecordsPrunedEvent { merchant_id, payment_ids });
}

public(package) fun emit_entitlement_granted(
    merchant_id: ID,
    key: String,
    owner: address,
    expires_at_ms: Option<u64>,
    source_payment_id: Option<u64>,
) {
    event::emit(EntitlementGrantedEvent {
        merchant_id,
        key,
        owner,
        expires_at_ms,
        source_payment_id,
    });
}

public(package) fun emit_entitlement_revoked(
    merchant_id: ID,
    key: String,
    owner: address,
    by_refund: bool,
) {
    event::emit(EntitlementRevokedEvent { merchant_id, key, owner, by_refund });
}

public(package) fun emit_credit_deposited(
    merchant_id: ID,
    owner: address,
    currency: TypeName,
    amount: u64,
    new_balance: u64,
) {
    event::emit(CreditDepositedEvent { merchant_id, owner, currency, amount, new_balance });
}

public(package) fun emit_credit_charged(
    merchant_id: ID,
    owner: address,
    currency: TypeName,
    amount: u64,
    fee: u64,
    memo: String,
    new_balance: u64,
) {
    event::emit(CreditChargedEvent { merchant_id, owner, currency, amount, fee, memo, new_balance });
}

public(package) fun emit_credit_withdrawn(
    merchant_id: ID,
    owner: address,
    currency: TypeName,
    amount: u64,
    new_balance: u64,
) {
    event::emit(CreditWithdrawnEvent { merchant_id, owner, currency, amount, new_balance });
}

public(package) fun emit_treasury_withdrawal(
    merchant_id: ID,
    currency: TypeName,
    amount: u64,
    to: address,
) {
    event::emit(TreasuryWithdrawalEvent { merchant_id, currency, amount, to });
}

public(package) fun emit_split_distributed(
    merchant_id: ID,
    currency: TypeName,
    total: u64,
    distributed_total: u64,
    recipients: vector<address>,
    amounts: vector<u64>,
) {
    event::emit(SplitDistributedEvent {
        merchant_id,
        currency,
        total,
        distributed_total,
        recipients,
        amounts,
    });
}

public(package) fun emit_fees_swept(merchant_id: ID, currency: TypeName, amount: u64, to: address) {
    event::emit(FeesSweptEvent { merchant_id, currency, amount, to });
}
