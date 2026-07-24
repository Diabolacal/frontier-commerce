/// The payment hot path, refunds, and payment-record retention.
///
/// Design invariants:
/// - Exact-amount payments: the coin passed must equal price * quantity.
///   The SDK splits the exact amount in the same PTB; no change handling,
///   no partial-take semantics to audit.
/// - Sender identity: the payer is `ctx.sender()`. Gas sponsorship never
///   changes `sender`, so sponsored payments attribute correctly.
/// - Fees: protocol fee (bps, hard-capped) is carved out at intake into the
///   merchant's `fees_accrued` vault; everything else lands in `treasury`.
/// - Records: retained only while the merchant's refund window is open
///   (window 0 = no records, refunds disabled). Refunds are bounded by
///   amount - already-refunded and paid from the merchant treasury.
module frontier_commerce::payments;

use std::string::String;
use frontier_commerce::entitlements;
use frontier_commerce::events;
use frontier_commerce::merchant::{Merchant, OperatorCap, TreasurerCap};
use frontier_commerce::registry::CommerceRegistry;
use frontier_commerce::types;
use frontier_commerce::vault;
use sui::clock::Clock;
use sui::coin::{Self, Coin};

/// Sane upper bound on units per purchase (e.g. 120 months of subscription).
const MAX_QUANTITY: u64 = 1_200;
const MAX_REF_BYTES: u64 = 128;
const BPS_DENOMINATOR: u128 = 10_000;

#[error]
const EPaused: vector<u8> = b"Payments are paused (protocol or merchant)";
#[error]
const EUnknownProduct: vector<u8> = b"No product with this ID";
#[error]
const EProductInactive: vector<u8> = b"Product is not active";
#[error]
const EWrongCurrency: vector<u8> = b"Payment coin type does not match the product currency";
#[error]
const EWrongAmount: vector<u8> = b"Payment must equal price * quantity exactly";
#[error]
const EBadQuantity: vector<u8> = b"Quantity must be 1..=1200 (1 for one-time products)";
#[error]
const ERefTooLong: vector<u8> = b"external_ref exceeds 128 bytes";
#[error]
const ERefundsDisabled: vector<u8> = b"Merchant retains no payment records (refund window is 0)";
#[error]
const EUnknownPayment: vector<u8> = b"No payment record with this ID (may have been pruned)";
#[error]
const ERefundTooLarge: vector<u8> = b"Refund exceeds refundable remainder of this payment";
#[error]
const EWrongRefundCurrency: vector<u8> = b"Refund coin type does not match the payment currency";
#[error]
const EZeroAmount: vector<u8> = b"Amount must be > 0";
#[error]
const ERecordNotExpired: vector<u8> = b"Payment record is still inside the refund window";

/// Pay for `product_id` x `quantity`, crediting the entitlement (if the
/// product grants one) to `beneficiary`. Returns the payment ID.
///
/// `beneficiary` is usually the payer but may be any address (gifting).
/// `external_ref` is an opaque app-side order/idempotency reference echoed
/// in the event; uniqueness is NOT enforced on-chain.
public fun pay<T>(
    registry: &CommerceRegistry,
    m: &mut Merchant,
    product_id: u64,
    quantity: u64,
    payment: Coin<T>,
    beneficiary: address,
    external_ref: Option<String>,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    registry.assert_version();
    m.assert_version();
    assert!(!registry.is_protocol_paused() && !m.is_paused(), EPaused);
    if (external_ref.is_some()) {
        assert!(external_ref.borrow().length() <= MAX_REF_BYTES, ERefTooLong);
    };
    assert!(m.products().contains(product_id), EUnknownProduct);

    // Read product terms.
    let (active, kind, price, duration_ms, currency, entitlement_key) = {
        let p = m.products().borrow(product_id);
        (
            types::product_active(p),
            types::product_kind(p),
            types::product_price(p),
            types::product_duration_ms(p),
            types::product_currency(p),
            *types::product_entitlement_key(p),
        )
    };
    assert!(active, EProductInactive);
    assert!(quantity >= 1 && quantity <= MAX_QUANTITY, EBadQuantity);
    if (kind == types::kind_one_time()) {
        assert!(quantity == 1, EBadQuantity);
    };
    assert!(vault::key_of<T>() == currency, EWrongCurrency);

    // total = price * quantity, checked in u128 then required to fit u64.
    let total_u128 = (price as u128) * (quantity as u128);
    assert!(total_u128 <= (std::u64::max_value!() as u128), EWrongAmount);
    let total = total_u128 as u64;
    assert!(coin::value(&payment) == total, EWrongAmount);

    // Fee carve-out.
    let fee = ((total as u128) * (registry.protocol_fee_bps() as u128) / BPS_DENOMINATOR) as u64;
    let mut balance = coin::into_balance(payment);
    if (fee > 0) {
        let fee_part = sui::balance::split(&mut balance, fee);
        vault::join(m.fees_accrued_mut(), fee_part);
    };
    vault::join(m.treasury_mut(), balance);

    let payer = ctx.sender();
    let now = clock.timestamp_ms();
    let payment_id = m.take_next_payment_id();

    // Retain a record only when refunds are possible.
    if (m.refund_window_ms() > 0) {
        let record = types::new_payment_record(
            payer,
            beneficiary,
            product_id,
            currency,
            total,
            fee,
            now,
        );
        m.payment_records_mut().add(payment_id, record);
    };

    // Entitlement effect.
    if (entitlement_key.is_some()) {
        entitlements::grant_from_payment(
            m,
            *entitlement_key.borrow(),
            beneficiary,
            kind,
            duration_ms,
            quantity,
            payment_id,
            clock,
        );
    };

    events::emit_payment(
        object::id(m),
        payment_id,
        product_id,
        payer,
        beneficiary,
        currency,
        total,
        fee,
        quantity,
        external_ref,
        now,
    );
    payment_id
}

/// Refund up to the un-refunded remainder of a recorded payment, from the
/// merchant treasury, back to the original payer. Optionally revokes the
/// beneficiary's entitlement for the product's key (all-or-nothing:
/// entitlement time accounting across multiple payments is app policy, not
/// chain policy).
///
/// The refund comes out of `treasury`, which holds the fee-net proceeds;
/// refunding the full gross amount means the merchant absorbs the protocol
/// fee. Allowed while paused (making users whole is never blocked).
public fun refund<T>(
    m: &mut Merchant,
    cap: &TreasurerCap,
    payment_id: u64,
    amount: u64,
    revoke_entitlement: bool,
    ctx: &mut TxContext,
) {
    m.assert_version();
    m.assert_treasurer(cap);
    assert!(amount > 0, EZeroAmount);
    assert!(m.refund_window_ms() > 0, ERefundsDisabled);
    assert!(m.payment_records().contains(payment_id), EUnknownPayment);

    let (payer, beneficiary, product_id, currency, remaining) = {
        let r = m.payment_records().borrow(payment_id);
        (
            types::record_payer(r),
            types::record_beneficiary(r),
            types::record_product_id(r),
            types::record_currency(r),
            types::record_amount(r) - types::record_refunded(r),
        )
    };
    assert!(vault::key_of<T>() == currency, EWrongRefundCurrency);
    assert!(amount <= remaining, ERefundTooLarge);

    {
        let r = m.payment_records_mut().borrow_mut(payment_id);
        types::add_refunded(r, amount);
    };

    let refund_balance = vault::split<T>(m.treasury_mut(), amount);
    transfer::public_transfer(coin::from_balance(refund_balance, ctx), payer);

    let mut revoked = false;
    if (revoke_entitlement) {
        let key_opt = {
            let p = m.products().borrow(product_id);
            *types::product_entitlement_key(p)
        };
        if (key_opt.is_some()) {
            revoked = entitlements::revoke_for_refund(m, *key_opt.borrow(), beneficiary);
        };
    };

    events::emit_refund(object::id(m), payment_id, currency, amount, payer, revoked);
}

/// Remove payment records whose refund window has elapsed (storage rebate).
/// Operator-gated; the window check makes premature pruning impossible even
/// for the operator, so the refund promise implied by `refund_window_ms`
/// cannot be quietly shortened for already-made payments.
public fun prune_payment_records(
    m: &mut Merchant,
    cap: &OperatorCap,
    payment_ids: vector<u64>,
    clock: &Clock,
) {
    m.assert_version();
    m.assert_operator(cap);
    let now = clock.timestamp_ms();
    let window = m.refund_window_ms();
    let mut pruned = vector<u64>[];
    let mut i = 0;
    while (i < payment_ids.length()) {
        let pid = payment_ids[i];
        if (m.payment_records().contains(pid)) {
            let expired = {
                let r = m.payment_records().borrow(pid);
                let cutoff = (types::record_paid_at_ms(r) as u128) + (window as u128);
                (now as u128) >= cutoff
            };
            assert!(expired, ERecordNotExpired);
            let _r = m.payment_records_mut().remove(pid);
            pruned.push_back(pid);
        };
        i = i + 1;
    };
    if (pruned.length() > 0) {
        events::emit_payment_records_pruned(object::id(m), pruned);
    };
}

// === Views ===

/// (exists, payer, amount, fee, refunded, paid_at_ms) for a payment record.
public fun payment_record_info(
    m: &Merchant,
    payment_id: u64,
): (bool, address, u64, u64, u64, u64) {
    if (!m.payment_records().contains(payment_id)) {
        return (false, @0x0, 0, 0, 0, 0)
    };
    let r = m.payment_records().borrow(payment_id);
    (
        true,
        types::record_payer(r),
        types::record_amount(r),
        types::record_fee(r),
        types::record_refunded(r),
        types::record_paid_at_ms(r),
    )
}
