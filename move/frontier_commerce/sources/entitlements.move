/// Entitlements: named, address-keyed grants (permanent or time-limited).
///
/// Stored as records in the merchant object rather than owned objects so
/// they are non-transferable by construction, revocable, and checkable both
/// off-chain (RPC/indexer) and on-chain (`is_entitled` is a public view any
/// Move package can call with a `&Merchant` reference).
///
/// Keying is by wallet address. EVE Frontier `Character` identity is richer
/// (stable object ID, mutable wallet link) but commerce consumers here are
/// web apps whose session identity IS the wallet; apps wanting
/// character-scoped grants can put the character ID in the entitlement key
/// string namespace they control (e.g. "premium:char-<id>").
module frontier_commerce::entitlements;

use std::string::String;
use frontier_commerce::events;
use frontier_commerce::merchant::{Merchant, OperatorCap};
use frontier_commerce::types;
use sui::clock::Clock;

const MAX_KEY_BYTES: u64 = 64;
/// Expiry values are clamped below u64::MAX so arithmetic can never abort.
const MAX_EXPIRY_MS: u64 = 0xFFFF_FFFF_FFFF_FFFE;

#[error]
const EKeyTooLong: vector<u8> = b"Entitlement key exceeds 64 bytes";
#[error]
const ENotEntitled: vector<u8> = b"No such entitlement";
#[error]
const EBadDuration: vector<u8> = b"duration_ms must be >= 1 for time-limited grants";

// === Operator grants ===

/// Grant a permanent entitlement (comp / manual fulfilment).
public fun grant_permanent(
    m: &mut Merchant,
    cap: &OperatorCap,
    key: String,
    owner: address,
) {
    m.assert_version();
    m.assert_operator(cap);
    assert!(key.length() <= MAX_KEY_BYTES, EKeyTooLong);
    apply_grant(m, key, owner, option::none(), option::none());
}

/// Grant/extend a time-limited entitlement by `duration_ms` from
/// max(now, current expiry).
public fun grant_timed(
    m: &mut Merchant,
    cap: &OperatorCap,
    key: String,
    owner: address,
    duration_ms: u64,
    clock: &Clock,
) {
    m.assert_version();
    m.assert_operator(cap);
    assert!(key.length() <= MAX_KEY_BYTES, EKeyTooLong);
    assert!(duration_ms >= 1, EBadDuration);
    let expires = extend_target(m, key, owner, duration_ms, clock);
    apply_grant(m, key, owner, option::some(expires), option::none());
}

/// Revoke an entitlement outright. Also used by refunds (via package call).
public fun revoke(m: &mut Merchant, cap: &OperatorCap, key: String, owner: address) {
    m.assert_version();
    m.assert_operator(cap);
    remove_entitlement(m, key, owner, false);
}

// === Views ===

/// True when `owner` holds `key` and it has not expired.
public fun is_entitled(m: &Merchant, key: String, owner: address, clock: &Clock): bool {
    let ekey = types::entitlement_key(key, owner);
    if (!m.entitlements().contains(ekey)) {
        return false
    };
    let record = m.entitlements().borrow(ekey);
    let expires = types::entitlement_expires_at_ms(record);
    if (expires.is_none()) {
        return true
    };
    *expires.borrow() > clock.timestamp_ms()
}

/// (exists, expires_at_ms) - expires_at_ms is none for permanent grants.
/// Note this returns the raw record; an expired record still `exists` until
/// pruned/overwritten, so callers wanting a boolean should use `is_entitled`.
public fun entitlement_info(m: &Merchant, key: String, owner: address): (bool, Option<u64>) {
    let ekey = types::entitlement_key(key, owner);
    if (!m.entitlements().contains(ekey)) {
        return (false, option::none())
    };
    let record = m.entitlements().borrow(ekey);
    (true, types::entitlement_expires_at_ms(record))
}

// === Package-internal (payment path) ===

/// Apply the entitlement effect of a paid product.
/// One-time products grant permanently; subscriptions extend from
/// max(now, current expiry) by duration_ms * quantity (clamped).
public(package) fun grant_from_payment(
    m: &mut Merchant,
    key: String,
    owner: address,
    kind: u8,
    duration_ms: u64,
    quantity: u64,
    payment_id: u64,
    clock: &Clock,
) {
    if (kind == types::kind_one_time()) {
        apply_grant(m, key, owner, option::none(), option::some(payment_id));
    } else {
        // duration_ms * quantity bounded: catalog enforces duration >= 1 and
        // payments enforces quantity bounds; clamp via u128 regardless.
        let total = (duration_ms as u128) * (quantity as u128);
        let capped = if (total > (MAX_EXPIRY_MS as u128)) { MAX_EXPIRY_MS } else { total as u64 };
        let expires = extend_target(m, key, owner, capped, clock);
        apply_grant(m, key, owner, option::some(expires), option::some(payment_id));
    }
}

/// Refund-triggered revocation. Returns silently if no record exists (the
/// entitlement may already have been revoked or replaced).
public(package) fun revoke_for_refund(m: &mut Merchant, key: String, owner: address): bool {
    let ekey = types::entitlement_key(key, owner);
    if (!m.entitlements().contains(ekey)) {
        return false
    };
    remove_entitlement(m, key, owner, true);
    true
}

// === Internals ===

/// New expiry timestamp for extending (key, owner) by duration_ms.
/// Expired or missing records extend from `now`; permanent records stay
/// permanent (caller handles: extend_target is only called for timed paths,
/// where extending a permanent record keeps it permanent via apply_grant
/// being skipped) - see apply_grant note below.
fun extend_target(
    m: &Merchant,
    key: String,
    owner: address,
    duration_ms: u64,
    clock: &Clock,
): u64 {
    let now = clock.timestamp_ms();
    let ekey = types::entitlement_key(key, owner);
    let base = if (m.entitlements().contains(ekey)) {
        let record = m.entitlements().borrow(ekey);
        let expires = types::entitlement_expires_at_ms(record);
        if (expires.is_none()) {
            // Permanent already: extending is a no-op; return the max so
            // apply_grant keeps a far-future value only if it overwrites.
            // apply_grant handles the permanent case explicitly below.
            MAX_EXPIRY_MS
        } else {
            let current = *expires.borrow();
            if (current > now) { current } else { now }
        }
    } else {
        now
    };
    let target = (base as u128) + (duration_ms as u128);
    if (target > (MAX_EXPIRY_MS as u128)) { MAX_EXPIRY_MS } else { target as u64 }
}

/// Insert or update the record and emit the grant event.
/// Permanent-preservation rule: a timed grant never downgrades an existing
/// permanent entitlement.
fun apply_grant(
    m: &mut Merchant,
    key: String,
    owner: address,
    expires_at_ms: Option<u64>,
    payment_id: Option<u64>,
) {
    let ekey = types::entitlement_key(key, owner);
    let merchant_id = object::id(m);
    if (m.entitlements().contains(ekey)) {
        let record = m.entitlements_mut().borrow_mut(ekey);
        let existing = types::entitlement_expires_at_ms(record);
        let effective = if (existing.is_none()) {
            // Already permanent: stay permanent.
            option::none()
        } else {
            expires_at_ms
        };
        types::update_entitlement(record, effective, payment_id);
        events::emit_entitlement_granted(merchant_id, key, owner, effective, payment_id);
    } else {
        let record = types::new_entitlement_record(expires_at_ms, payment_id);
        m.entitlements_mut().add(ekey, record);
        events::emit_entitlement_granted(merchant_id, key, owner, expires_at_ms, payment_id);
    }
}

fun remove_entitlement(m: &mut Merchant, key: String, owner: address, by_refund: bool) {
    let ekey = types::entitlement_key(key, owner);
    assert!(m.entitlements().contains(ekey), ENotEntitled);
    let _removed = m.entitlements_mut().remove(ekey);
    events::emit_entitlement_revoked(object::id(m), key, owner, by_refund);
}
