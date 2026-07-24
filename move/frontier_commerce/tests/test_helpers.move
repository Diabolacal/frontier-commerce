#[test_only]
module frontier_commerce::test_helpers;

use std::string::{Self, String};
use frontier_commerce::catalog;
use frontier_commerce::merchant::{Self, Merchant, MerchantCap, OperatorCap, TreasurerCap};
use frontier_commerce::registry::{Self, CommerceRegistry, ProtocolCap};
use frontier_commerce::types;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts, Scenario};

/// Test currency the merchant prices products in.
public struct TEST_COIN has drop {}

/// A second currency for wrong-currency adversarial tests.
public struct ALT_COIN has drop {}

public fun protocol_admin(): address { @0xA1 }

public fun merchant_admin(): address { @0xB1 }

public fun user(): address { @0xC1 }

public fun user2(): address { @0xC2 }

public fun outsider(): address { @0xD1 }

/// Start a scenario with the registry initialized (as protocol admin) and a
/// merchant created (as merchant admin, holding all three caps).
public fun setup(): Scenario {
    let mut scenario = ts::begin(protocol_admin());
    registry::init_for_testing(scenario.ctx());
    scenario.next_tx(merchant_admin());
    merchant::create_merchant(string::utf8(b"test-app"), scenario.ctx());
    scenario.next_tx(merchant_admin());
    scenario
}

/// A clock owned by the test, set to `ms`.
public fun clock_at(scenario: &mut Scenario, ms: u64): Clock {
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(ms);
    clock
}

public fun mint<T>(scenario: &mut Scenario, amount: u64): Coin<T> {
    coin::mint_for_testing<T>(amount, scenario.ctx())
}

public fun str(bytes: vector<u8>): String {
    string::utf8(bytes)
}

/// Create a one-time product priced in TEST_COIN. Runs as merchant_admin and
/// leaves the scenario on a fresh merchant_admin tx. Returns the product ID.
public fun create_one_time_product(
    scenario: &mut Scenario,
    price: u64,
    entitlement_key: Option<String>,
): u64 {
    scenario.next_tx(merchant_admin());
    let mut m = scenario.take_shared<Merchant>();
    let cap = scenario.take_from_sender<OperatorCap>();
    let id = catalog::create_product<TEST_COIN>(
        &mut m,
        &cap,
        str(b"one-time"),
        types::kind_one_time(),
        price,
        0,
        entitlement_key,
        str(b""),
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);
    ts::return_shared(m);
    scenario.next_tx(merchant_admin());
    id
}

/// Create a subscription product priced in TEST_COIN.
public fun create_subscription_product(
    scenario: &mut Scenario,
    price: u64,
    duration_ms: u64,
    entitlement_key: Option<String>,
): u64 {
    scenario.next_tx(merchant_admin());
    let mut m = scenario.take_shared<Merchant>();
    let cap = scenario.take_from_sender<OperatorCap>();
    let id = catalog::create_product<TEST_COIN>(
        &mut m,
        &cap,
        str(b"subscription"),
        types::kind_subscription(),
        price,
        duration_ms,
        entitlement_key,
        str(b""),
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);
    ts::return_shared(m);
    scenario.next_tx(merchant_admin());
    id
}

/// Set the protocol fee as the protocol admin; leaves scenario on a fresh tx.
public fun set_protocol_fee(scenario: &mut Scenario, fee_bps: u64) {
    scenario.next_tx(protocol_admin());
    let mut registry = scenario.take_shared<CommerceRegistry>();
    let cap = scenario.take_from_sender<ProtocolCap>();
    registry::set_protocol_fee_bps(&mut registry, &cap, fee_bps);
    scenario.return_to_sender(cap);
    ts::return_shared(registry);
    scenario.next_tx(merchant_admin());
}

/// Set the merchant refund window as root; leaves scenario on a fresh tx.
public fun set_refund_window(scenario: &mut Scenario, window_ms: u64) {
    scenario.next_tx(merchant_admin());
    let mut m = scenario.take_shared<Merchant>();
    let cap = scenario.take_from_sender<MerchantCap>();
    merchant::set_refund_window_ms(&mut m, &cap, window_ms);
    scenario.return_to_sender(cap);
    ts::return_shared(m);
    scenario.next_tx(merchant_admin());
}

/// Enable credits as root; leaves scenario on a fresh tx.
public fun enable_credits(scenario: &mut Scenario) {
    scenario.next_tx(merchant_admin());
    let mut m = scenario.take_shared<Merchant>();
    let cap = scenario.take_from_sender<MerchantCap>();
    merchant::set_credits_enabled(&mut m, &cap, true);
    scenario.return_to_sender(cap);
    ts::return_shared(m);
    scenario.next_tx(merchant_admin());
}

/// Convenience bundle for a caller tx: take registry + merchant shared.
public fun take_state(scenario: &Scenario): (CommerceRegistry, Merchant) {
    (scenario.take_shared<CommerceRegistry>(), scenario.take_shared<Merchant>())
}

public fun return_state(registry: CommerceRegistry, m: Merchant) {
    ts::return_shared(registry);
    ts::return_shared(m);
}

/// Take/return helpers for the merchant admin's caps from any tx context.
public fun with_operator_cap(scenario: &Scenario): OperatorCap {
    scenario.take_from_address<OperatorCap>(merchant_admin())
}

public fun return_operator_cap(scenario: &Scenario, cap: OperatorCap) {
    ts::return_to_address(merchant_admin(), cap);
}

public fun with_treasurer_cap(scenario: &Scenario): TreasurerCap {
    scenario.take_from_address<TreasurerCap>(merchant_admin())
}

public fun return_treasurer_cap(scenario: &Scenario, cap: TreasurerCap) {
    ts::return_to_address(merchant_admin(), cap);
}
