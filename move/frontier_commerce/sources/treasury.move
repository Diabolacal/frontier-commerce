/// Treasury outflows: withdrawals, policy-driven distribution, fee sweeps.
///
/// All outflows are pull-based and evented. Nothing here is gated by pause
/// flags: a compromised or lost ProtocolCap must never trap merchant funds.
/// The separation of powers is:
/// - TreasurerCap        withdraw / distribute merchant earnings, refunds.
/// - ProtocolTreasurerCap sweep the protocol's accrued fee cut only.
/// - Nobody              can touch `credit_escrow` except through the
///                        credits module's charge/withdraw paths.
module frontier_commerce::treasury;

use frontier_commerce::events;
use frontier_commerce::merchant::{Merchant, TreasurerCap};
use frontier_commerce::registry::ProtocolTreasurerCap;
use frontier_commerce::types;
use frontier_commerce::vault;
use sui::coin;

const BPS_DENOMINATOR: u128 = 10_000;

#[error]
const EZeroAmount: vector<u8> = b"Amount must be > 0";
#[error]
const ESplitEnforced: vector<u8> =
    b"Plain withdrawals are disabled for this merchant; use distribute";
#[error]
const ENoSplitPolicy: vector<u8> = b"No split policy configured";
#[error]
const ENothingToDistribute: vector<u8> = b"Treasury holds no balance in this currency";

/// Withdraw `amount` of `T` from merchant earnings to `to`.
/// Disabled when the merchant enforces split-only outflows.
public fun withdraw<T>(
    m: &mut Merchant,
    cap: &TreasurerCap,
    amount: u64,
    to: address,
    ctx: &mut TxContext,
) {
    m.assert_version();
    m.assert_treasurer(cap);
    assert!(!m.enforce_split(), ESplitEnforced);
    assert!(amount > 0, EZeroAmount);
    let taken = vault::split<T>(m.treasury_mut(), amount);
    transfer::public_transfer(coin::from_balance(taken, ctx), to);
    events::emit_treasury_withdrawal(object::id(m), vault::key_of<T>(), amount, to);
}

/// Distribute the merchant's entire current `T` balance according to the
/// split policy. Each share is floor(balance * bps / 10000); the remainder
/// (rounding dust plus any unallocated bps) stays in the treasury.
public fun distribute<T>(m: &mut Merchant, cap: &TreasurerCap, ctx: &mut TxContext) {
    m.assert_version();
    m.assert_treasurer(cap);
    assert!(m.split_policy().length() > 0, ENoSplitPolicy);

    let total = vault::value<T>(m.treasury());
    assert!(total > 0, ENothingToDistribute);

    let policy = *m.split_policy();
    let mut recipients = vector<address>[];
    let mut amounts = vector<u64>[];
    let mut distributed_total: u64 = 0;
    let mut i = 0;
    while (i < policy.length()) {
        let share = &policy[i];
        let amount = ((total as u128) * (types::share_bps(share) as u128) / BPS_DENOMINATOR) as u64;
        if (amount > 0) {
            let part = vault::split<T>(m.treasury_mut(), amount);
            transfer::public_transfer(coin::from_balance(part, ctx), types::share_recipient(share));
            recipients.push_back(types::share_recipient(share));
            amounts.push_back(amount);
            distributed_total = distributed_total + amount;
        };
        i = i + 1;
    };

    events::emit_split_distributed(
        object::id(m),
        vault::key_of<T>(),
        total,
        distributed_total,
        recipients,
        amounts,
    );
}

/// Sweep the protocol's accrued fees in currency `T` from this merchant.
public fun sweep_fees<T>(
    m: &mut Merchant,
    _cap: &ProtocolTreasurerCap,
    to: address,
    ctx: &mut TxContext,
) {
    m.assert_version();
    let taken = vault::take_all<T>(m.fees_accrued_mut());
    let amount = taken.value();
    if (amount == 0) {
        taken.destroy_zero();
        return
    };
    transfer::public_transfer(coin::from_balance(taken, ctx), to);
    events::emit_fees_swept(object::id(m), vault::key_of<T>(), amount, to);
}

// === Views ===

public fun treasury_value<T>(m: &Merchant): u64 {
    vault::value<T>(m.treasury())
}

public fun fees_accrued_value<T>(m: &Merchant): u64 {
    vault::value<T>(m.fees_accrued())
}
