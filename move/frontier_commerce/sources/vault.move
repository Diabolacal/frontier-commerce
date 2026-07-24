/// Internal multi-currency vault helpers.
///
/// A "vault" is a `Bag` mapping `TypeName` (of a coin type `T`) to `Balance<T>`.
/// Merchants hold three vaults (treasury, credit escrow, accrued protocol fees)
/// so the package never hard-codes any specific currency: the concrete coin
/// type is bound per call via the generic parameter and checked against stored
/// `TypeName` configuration by callers.
module frontier_commerce::vault;

use std::type_name::{Self, TypeName};
use sui::bag::{Self, Bag};
use sui::balance::{Self, Balance};

/// Deposit `b` into the vault bucket for its coin type, creating the bucket
/// on first use. Zero balances are destroyed without creating a bucket.
public(package) fun join<T>(vault: &mut Bag, b: Balance<T>) {
    if (balance::value(&b) == 0) {
        balance::destroy_zero(b);
        return
    };
    let key = type_name::with_defining_ids<T>();
    if (!bag::contains(vault, key)) {
        bag::add(vault, key, balance::zero<T>());
    };
    let bucket: &mut Balance<T> = bag::borrow_mut(vault, key);
    balance::join(bucket, b);
}

/// Split `amount` out of the vault bucket for `T`. Aborts if the bucket does
/// not exist or holds less than `amount` (balance::split aborts on underflow).
public(package) fun split<T>(vault: &mut Bag, amount: u64): Balance<T> {
    let key = type_name::with_defining_ids<T>();
    let bucket: &mut Balance<T> = bag::borrow_mut(vault, key);
    balance::split(bucket, amount)
}

/// Current value held for coin type `T` (0 if the bucket was never created).
public(package) fun value<T>(vault: &Bag): u64 {
    let key = type_name::with_defining_ids<T>();
    if (!bag::contains(vault, key)) {
        return 0
    };
    let bucket: &Balance<T> = bag::borrow(vault, key);
    balance::value(bucket)
}

/// Withdraw the full bucket for `T`, removing it from the bag (storage rebate).
/// Returns a zero balance if the bucket does not exist.
public(package) fun take_all<T>(vault: &mut Bag): Balance<T> {
    let key = type_name::with_defining_ids<T>();
    if (!bag::contains(vault, key)) {
        return balance::zero<T>()
    };
    bag::remove(vault, key)
}

/// TypeName key for external callers that need it.
public(package) fun key_of<T>(): TypeName {
    type_name::with_defining_ids<T>()
}
