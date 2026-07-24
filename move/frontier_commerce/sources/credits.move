/// Prepaid credits: usage-based billing with bounded trust.
///
/// Model: a user deposits coins into a per-(currency, user) credit balance
/// held in the merchant's `credit_escrow` vault - segregated from merchant
/// earnings. The merchant's operator charges credits as the service is
/// consumed (moving value escrow -> treasury, minus protocol fee); the user
/// can withdraw their unspent remainder at any time, pause or no pause.
///
/// Trust statement (documented, not hidden): metering is merchant-side. A
/// malicious operator can charge a user's remaining credits with bogus
/// memos - bounded strictly by what that user deposited. A malicious user
/// can withdraw just before a charge lands; whichever tx executes first
/// wins. Both parties' exposure is bounded and every movement is evented.
module frontier_commerce::credits;

use std::string::String;
use frontier_commerce::events;
use frontier_commerce::merchant::{Merchant, OperatorCap};
use frontier_commerce::registry::CommerceRegistry;
use frontier_commerce::types;
use frontier_commerce::vault;
use sui::coin::{Self, Coin};

const MAX_MEMO_BYTES: u64 = 256;
const BPS_DENOMINATOR: u128 = 10_000;

#[error]
const EPaused: vector<u8> = b"Credit intake/charging is paused (protocol or merchant)";
#[error]
const ECreditsDisabled: vector<u8> = b"This merchant has not enabled credits";
#[error]
const EZeroAmount: vector<u8> = b"Amount must be > 0";
#[error]
const ENoCreditAccount: vector<u8> = b"No credit balance for this (currency, owner)";
#[error]
const EInsufficientCredits: vector<u8> = b"Charge/withdraw exceeds the credit balance";
#[error]
const EMemoTooLong: vector<u8> = b"Memo exceeds 256 bytes";

/// Deposit coins into the sender's prepaid credit balance for this merchant.
public fun deposit<T>(
    registry: &CommerceRegistry,
    m: &mut Merchant,
    payment: Coin<T>,
    ctx: &mut TxContext,
) {
    registry.assert_version();
    m.assert_version();
    assert!(!registry.is_protocol_paused() && !m.is_paused(), EPaused);
    assert!(m.credits_enabled(), ECreditsDisabled);
    let amount = coin::value(&payment);
    assert!(amount > 0, EZeroAmount);

    let owner = ctx.sender();
    let currency = vault::key_of<T>();
    let key = types::credit_key(currency, owner);

    let new_balance = if (m.credit_ledger().contains(key)) {
        let entry = m.credit_ledger_mut().borrow_mut(key);
        *entry = *entry + amount;
        *entry
    } else {
        m.credit_ledger_mut().add(key, amount);
        amount
    };
    vault::join(m.credit_escrow_mut(), coin::into_balance(payment));

    events::emit_credit_deposited(object::id(m), owner, currency, amount, new_balance);
}

/// Charge `amount` of `owner`'s credits for consumed service. Value moves
/// escrow -> treasury minus the protocol fee (escrow -> fees_accrued).
/// `memo` is the service-side reason (e.g. an internal usage batch ID).
///
/// Deliberately NOT gated by `credits_enabled`: disabling credits stops NEW
/// deposits only; balances deposited earlier remain chargeable (service was
/// already promised) and always user-withdrawable.
public fun charge<T>(
    registry: &CommerceRegistry,
    m: &mut Merchant,
    cap: &OperatorCap,
    owner: address,
    amount: u64,
    memo: String,
) {
    registry.assert_version();
    m.assert_version();
    m.assert_operator(cap);
    assert!(!registry.is_protocol_paused() && !m.is_paused(), EPaused);
    assert!(amount > 0, EZeroAmount);
    assert!(memo.length() <= MAX_MEMO_BYTES, EMemoTooLong);

    let currency = vault::key_of<T>();
    let key = types::credit_key(currency, owner);
    assert!(m.credit_ledger().contains(key), ENoCreditAccount);

    let new_balance = {
        let entry = m.credit_ledger_mut().borrow_mut(key);
        assert!(*entry >= amount, EInsufficientCredits);
        *entry = *entry - amount;
        *entry
    };
    if (new_balance == 0) {
        let _zero = m.credit_ledger_mut().remove(key);
    };

    let mut charged = vault::split<T>(m.credit_escrow_mut(), amount);
    let fee = ((amount as u128) * (registry.protocol_fee_bps() as u128) / BPS_DENOMINATOR) as u64;
    if (fee > 0) {
        let fee_part = sui::balance::split(&mut charged, fee);
        vault::join(m.fees_accrued_mut(), fee_part);
    };
    vault::join(m.treasury_mut(), charged);

    events::emit_credit_charged(object::id(m), owner, currency, amount, fee, memo, new_balance);
}

/// Withdraw the sender's unspent credits. Never pause-gated and requires no
/// merchant cooperation: prepaid funds are always recoverable by the user.
public fun withdraw_credits<T>(m: &mut Merchant, amount: u64, ctx: &mut TxContext): Coin<T> {
    m.assert_version();
    assert!(amount > 0, EZeroAmount);

    let owner = ctx.sender();
    let currency = vault::key_of<T>();
    let key = types::credit_key(currency, owner);
    assert!(m.credit_ledger().contains(key), ENoCreditAccount);

    let new_balance = {
        let entry = m.credit_ledger_mut().borrow_mut(key);
        assert!(*entry >= amount, EInsufficientCredits);
        *entry = *entry - amount;
        *entry
    };
    if (new_balance == 0) {
        let _zero = m.credit_ledger_mut().remove(key);
    };

    let withdrawn = vault::split<T>(m.credit_escrow_mut(), amount);
    events::emit_credit_withdrawn(object::id(m), owner, currency, amount, new_balance);
    coin::from_balance(withdrawn, ctx)
}

// === Views ===

public fun credit_balance<T>(m: &Merchant, owner: address): u64 {
    let key = types::credit_key(vault::key_of<T>(), owner);
    if (!m.credit_ledger().contains(key)) {
        return 0
    };
    *m.credit_ledger().borrow(key)
}

/// Total escrowed for currency `T` (should equal the sum of all credit
/// balances in that currency; used by tests and reconciliation).
public fun credit_escrow_value<T>(m: &Merchant): u64 {
    vault::value<T>(m.credit_escrow())
}
