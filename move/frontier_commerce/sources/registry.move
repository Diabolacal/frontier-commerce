/// Protocol-level state and authority.
///
/// One `CommerceRegistry` is shared at publish. It holds protocol-wide
/// configuration only - never funds. Protocol fees accrue inside each
/// merchant's `fees_accrued` vault and are swept per merchant by the
/// `ProtocolTreasurerCap` holder, so a compromised registry never exposes a
/// pooled hot balance and payment throughput never serializes on a global
/// fee vault.
///
/// Authority separation at protocol level:
/// - `ProtocolCap`         config: fee bps (hard-capped), global pause,
///                         curated listings, registry migration, merchant
///                         root recovery (only where the merchant opted in).
/// - `ProtocolTreasurerCap` fee withdrawal only.
/// - `UpgradeCap` (Sui)    package upgrades; custody documented in
///                         docs/key-management.md, never used by services.
///
/// Blast-radius design: a stolen `ProtocolCap` can pause payments (temporary
/// DoS), raise the fee to at most MAX_FEE_BPS, edit listings, and REQUEST
/// root recovery of merchants that left recovery enabled. Recovery is
/// timelocked and public (see merchant.move): only if a merchant fails to
/// cancel/opt out within the 72h challenge window can the thief complete the
/// takeover - and a completed takeover of a merchant root ultimately reaches
/// that merchant's funds (root mints treasurer/operator caps). It can never
/// directly withdraw funds, never touch opted-out merchants, and never block
/// withdrawals. A lost `ProtocolCap` freezes protocol config in place; all
/// merchant/user flows keep working.
module frontier_commerce::registry;

use std::string::String;
use frontier_commerce::events;
use sui::table::{Self, Table};

/// Bump on package upgrades that change shared-object semantics. Every
/// mutating entry point asserts the object version matches, so stale package
/// versions can no longer touch migrated state.
const VERSION: u64 = 1;

/// Hard ceiling for the protocol fee: 10%. Enforced in code so no key
/// compromise can turn the fee into confiscation.
const MAX_FEE_BPS: u64 = 1_000;

const MAX_NAME_BYTES: u64 = 64;

#[error]
const EFeeTooHigh: vector<u8> = b"Protocol fee exceeds the hard cap (MAX_FEE_BPS)";
#[error]
const EWrongVersion: vector<u8> =
    b"Object version does not match this package version; run migration or use the current package";
#[error]
const ENotUpgrade: vector<u8> = b"Migration target version must be newer than the object version";
#[error]
const ENameTooLong: vector<u8> = b"Name exceeds 64 bytes";
#[error]
const EUnknownListing: vector<u8> = b"No listing under this name";

public struct CommerceRegistry has key {
    id: UID,
    version: u64,
    /// Global kill switch for revenue intake (pay / credit deposit / credit
    /// charge). Withdrawals, refunds and user credit recovery are NEVER
    /// gated by pause: funds must not be trappable by protocol keys.
    paused: bool,
    /// Protocol fee in basis points taken from every payment and credit
    /// charge. 0 by default.
    fee_bps: u64,
    /// Curated name -> merchant object ID index for first-party apps.
    /// Purely informational (discovery); grants no authority.
    listings: Table<String, ID>,
}

public struct ProtocolCap has key, store {
    id: UID,
}

public struct ProtocolTreasurerCap has key, store {
    id: UID,
}

fun init(ctx: &mut TxContext) {
    let registry = CommerceRegistry {
        id: object::new(ctx),
        version: VERSION,
        paused: false,
        fee_bps: 0,
        listings: table::new(ctx),
    };
    transfer::share_object(registry);
    transfer::transfer(ProtocolCap { id: object::new(ctx) }, ctx.sender());
    transfer::transfer(ProtocolTreasurerCap { id: object::new(ctx) }, ctx.sender());
}

// === Protocol admin (ProtocolCap) ===

public fun set_protocol_fee_bps(registry: &mut CommerceRegistry, _cap: &ProtocolCap, fee_bps: u64) {
    assert_version(registry);
    assert!(fee_bps <= MAX_FEE_BPS, EFeeTooHigh);
    registry.fee_bps = fee_bps;
    events::emit_protocol_config(registry.fee_bps, registry.paused);
}

public fun set_protocol_paused(registry: &mut CommerceRegistry, _cap: &ProtocolCap, paused: bool) {
    assert_version(registry);
    registry.paused = paused;
    events::emit_protocol_config(registry.fee_bps, registry.paused);
}

/// Add or update a curated listing (name -> merchant object ID).
public fun list_merchant(
    registry: &mut CommerceRegistry,
    _cap: &ProtocolCap,
    name: String,
    merchant_id: ID,
) {
    assert_version(registry);
    assert!(name.length() <= MAX_NAME_BYTES, ENameTooLong);
    if (registry.listings.contains(name)) {
        let entry = registry.listings.borrow_mut(name);
        *entry = merchant_id;
    } else {
        registry.listings.add(name, merchant_id);
    };
    events::emit_merchant_listed(name, merchant_id);
}

public fun delist_merchant(registry: &mut CommerceRegistry, _cap: &ProtocolCap, name: String) {
    assert_version(registry);
    assert!(registry.listings.contains(name), EUnknownListing);
    let merchant_id = registry.listings.remove(name);
    events::emit_merchant_delisted(name, merchant_id);
}

/// Bring the registry object to this package's version after an upgrade.
public fun migrate_registry(registry: &mut CommerceRegistry, _cap: &ProtocolCap) {
    assert!(registry.version < VERSION, ENotUpgrade);
    registry.version = VERSION;
    events::emit_registry_migrated(VERSION);
}

// === Views ===

public fun protocol_fee_bps(registry: &CommerceRegistry): u64 { registry.fee_bps }

public fun is_protocol_paused(registry: &CommerceRegistry): bool { registry.paused }

public fun lookup_listing(registry: &CommerceRegistry, name: String): Option<ID> {
    if (registry.listings.contains(name)) {
        option::some(*registry.listings.borrow(name))
    } else {
        option::none()
    }
}

// === Package-internal ===

public(package) fun assert_version(registry: &CommerceRegistry) {
    assert!(registry.version == VERSION, EWrongVersion);
}

public(package) fun current_version(): u64 { VERSION }

public(package) fun max_fee_bps(): u64 { MAX_FEE_BPS }

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}
