#[test_only]
module frontier_commerce::payments_tests;

use frontier_commerce::credits;
use frontier_commerce::entitlements;
use frontier_commerce::merchant::{Self, Merchant, OperatorCap};
use frontier_commerce::payments;
use frontier_commerce::registry::{Self, CommerceRegistry, ProtocolCap};
use frontier_commerce::test_helpers as th;
use frontier_commerce::test_helpers::{TEST_COIN, ALT_COIN};
use frontier_commerce::treasury;
use sui::coin::{Self, Coin};
use sui::test_scenario as ts;

const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;

// === Happy paths ===

#[test]
fun pay_one_time_lands_in_treasury_and_returns_sequential_ids() {
    let mut s = th::setup();
    let pid = th::create_one_time_product(&mut s, 1_000_000, option::none());

    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 1_000_000);
    let id1 = payments::pay(
        &reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx(),
    );
    let payment2 = th::mint<TEST_COIN>(&mut s, 1_000_000);
    let id2 = payments::pay(
        &reg, &mut m, pid, 1, payment2, th::user(), option::none(), &clock, s.ctx(),
    );
    assert!(id1 == 1 && id2 == 2);
    assert!(treasury::treasury_value<TEST_COIN>(&m) == 2_000_000);
    assert!(treasury::fees_accrued_value<TEST_COIN>(&m) == 0);
    th::return_state(reg, m);
    clock.destroy_for_testing();
    s.end();
}

#[test]
fun pay_with_protocol_fee_carves_out_floor_bps() {
    let mut s = th::setup();
    th::set_protocol_fee(&mut s, 250); // 2.5%
    // Odd price so the fee floors: 999 * 250 / 10000 = 24.975 -> 24.
    let pid = th::create_one_time_product(&mut s, 999, option::none());

    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 999);
    payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
    assert!(treasury::fees_accrued_value<TEST_COIN>(&m) == 24);
    assert!(treasury::treasury_value<TEST_COIN>(&m) == 975);
    th::return_state(reg, m);
    clock.destroy_for_testing();
    s.end();
}

#[test]
fun pay_free_product_with_zero_coin() {
    let mut s = th::setup();
    let pid = th::create_one_time_product(&mut s, 0, option::some(th::str(b"welcome")));

    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = coin::zero<TEST_COIN>(s.ctx());
    payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
    assert!(entitlements::is_entitled(&m, th::str(b"welcome"), th::user(), &clock));
    assert!(treasury::treasury_value<TEST_COIN>(&m) == 0);
    th::return_state(reg, m);
    clock.destroy_for_testing();
    s.end();
}

#[test]
fun subscription_grants_and_stacks_expiry() {
    let mut s = th::setup();
    let pid = th::create_subscription_product(
        &mut s, 500, 30 * DAY_MS, option::some(th::str(b"premium")),
    );

    // Buy 1 month at t=1h.
    s.next_tx(th::user());
    let mut clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 500);
    payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
    let (exists, expiry) = entitlements::entitlement_info(&m, th::str(b"premium"), th::user());
    assert!(exists && *expiry.borrow() == HOUR_MS + 30 * DAY_MS);

    // Buy 2 more months immediately: extends from current expiry, not now.
    let payment2 = th::mint<TEST_COIN>(&mut s, 1_000);
    payments::pay(&reg, &mut m, pid, 2, payment2, th::user(), option::none(), &clock, s.ctx());
    let (_, expiry2) = entitlements::entitlement_info(&m, th::str(b"premium"), th::user());
    assert!(*expiry2.borrow() == HOUR_MS + 90 * DAY_MS);

    // Let it lapse, then renew: extends from now, not from stale expiry.
    clock.set_for_testing(HOUR_MS + 200 * DAY_MS);
    assert!(!entitlements::is_entitled(&m, th::str(b"premium"), th::user(), &clock));
    let payment3 = th::mint<TEST_COIN>(&mut s, 500);
    payments::pay(&reg, &mut m, pid, 1, payment3, th::user(), option::none(), &clock, s.ctx());
    let (_, expiry3) = entitlements::entitlement_info(&m, th::str(b"premium"), th::user());
    assert!(*expiry3.borrow() == HOUR_MS + 230 * DAY_MS);
    assert!(entitlements::is_entitled(&m, th::str(b"premium"), th::user(), &clock));

    th::return_state(reg, m);
    clock.destroy_for_testing();
    s.end();
}

#[test]
fun gift_purchase_entitles_beneficiary_not_payer() {
    let mut s = th::setup();
    let pid = th::create_one_time_product(&mut s, 100, option::some(th::str(b"pro")));

    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 100);
    payments::pay(&reg, &mut m, pid, 1, payment, th::user2(), option::none(), &clock, s.ctx());
    assert!(entitlements::is_entitled(&m, th::str(b"pro"), th::user2(), &clock));
    assert!(!entitlements::is_entitled(&m, th::str(b"pro"), th::user(), &clock));
    th::return_state(reg, m);
    clock.destroy_for_testing();
    s.end();
}

#[test]
fun one_time_purchase_never_downgrades_permanent_entitlement() {
    let mut s = th::setup();
    let sub = th::create_subscription_product(
        &mut s, 500, 30 * DAY_MS, option::some(th::str(b"premium")),
    );
    let unlock = th::create_one_time_product(&mut s, 900, option::some(th::str(b"premium")));

    s.next_tx(th::user());
    let mut clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    // Lifetime unlock first.
    let payment = th::mint<TEST_COIN>(&mut s, 900);
    payments::pay(&reg, &mut m, unlock, 1, payment, th::user(), option::none(), &clock, s.ctx());
    // Then a timed subscription on top must not downgrade to timed.
    let payment2 = th::mint<TEST_COIN>(&mut s, 500);
    payments::pay(&reg, &mut m, sub, 1, payment2, th::user(), option::none(), &clock, s.ctx());
    let (_, expiry) = entitlements::entitlement_info(&m, th::str(b"premium"), th::user());
    assert!(expiry.is_none());
    clock.set_for_testing(HOUR_MS + 1000 * DAY_MS);
    assert!(entitlements::is_entitled(&m, th::str(b"premium"), th::user(), &clock));
    th::return_state(reg, m);
    clock.destroy_for_testing();
    s.end();
}

// === Adversarial / failure paths ===

#[test, expected_failure(abort_code = payments::EWrongAmount)]
fun pay_underpayment_aborts() {
    let mut s = th::setup();
    let pid = th::create_one_time_product(&mut s, 1_000, option::none());
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 999);
    payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = payments::EWrongAmount)]
fun pay_overpayment_aborts() {
    let mut s = th::setup();
    let pid = th::create_one_time_product(&mut s, 1_000, option::none());
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 1_001);
    payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = payments::EWrongCurrency)]
fun pay_wrong_currency_aborts() {
    let mut s = th::setup();
    let pid = th::create_one_time_product(&mut s, 1_000, option::none());
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<ALT_COIN>(&mut s, 1_000);
    payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = payments::EProductInactive)]
fun pay_inactive_product_aborts() {
    let mut s = th::setup();
    let pid = th::create_one_time_product(&mut s, 1_000, option::none());
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<OperatorCap>();
        frontier_commerce::catalog::update_product(
            &mut m, &cap, pid, th::str(b"one-time"), 1_000, false, th::str(b""),
        );
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 1_000);
    payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = payments::EUnknownProduct)]
fun pay_unknown_product_aborts() {
    let mut s = th::setup();
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 1_000);
    payments::pay(&reg, &mut m, 42, 1, payment, th::user(), option::none(), &clock, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = payments::EBadQuantity)]
fun pay_one_time_with_quantity_two_aborts() {
    let mut s = th::setup();
    let pid = th::create_one_time_product(&mut s, 1_000, option::none());
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 2_000);
    payments::pay(&reg, &mut m, pid, 2, payment, th::user(), option::none(), &clock, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = payments::EBadQuantity)]
fun pay_zero_quantity_aborts() {
    let mut s = th::setup();
    let pid = th::create_subscription_product(&mut s, 500, DAY_MS, option::none());
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = coin::zero<TEST_COIN>(s.ctx());
    payments::pay(&reg, &mut m, pid, 0, payment, th::user(), option::none(), &clock, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = payments::EBadQuantity)]
fun pay_quantity_above_cap_aborts() {
    let mut s = th::setup();
    let pid = th::create_subscription_product(&mut s, 1, DAY_MS, option::none());
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 1_201);
    payments::pay(&reg, &mut m, pid, 1_201, payment, th::user(), option::none(), &clock, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = payments::EPaused)]
fun pay_while_protocol_paused_aborts() {
    let mut s = th::setup();
    let pid = th::create_one_time_product(&mut s, 1_000, option::none());
    s.next_tx(th::protocol_admin());
    {
        let mut reg = s.take_shared<CommerceRegistry>();
        let cap = s.take_from_sender<ProtocolCap>();
        registry::set_protocol_paused(&mut reg, &cap, true);
        s.return_to_sender(cap);
        ts::return_shared(reg);
    };
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 1_000);
    payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = payments::EPaused)]
fun pay_while_merchant_paused_aborts() {
    let mut s = th::setup();
    let pid = th::create_one_time_product(&mut s, 1_000, option::none());
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<OperatorCap>();
        merchant::set_paused(&mut m, &cap, true);
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 1_000);
    payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
    abort 0
}

// === Refunds ===

#[test]
fun refund_partial_then_full_returns_to_payer_and_revokes() {
    let mut s = th::setup();
    th::set_refund_window(&mut s, 7 * DAY_MS);
    let pid = th::create_one_time_product(&mut s, 10_000, option::some(th::str(b"pro")));

    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    {
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<TEST_COIN>(&mut s, 10_000);
        payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
        th::return_state(reg, m);
    };

    // Partial refund (no revoke).
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = th::with_treasurer_cap(&s);
        payments::refund<TEST_COIN>(&mut m, &cap, 1, 4_000, false, s.ctx());
        assert!(treasury::treasury_value<TEST_COIN>(&m) == 6_000);
        assert!(entitlements::is_entitled(&m, th::str(b"pro"), th::user(), &clock));
        let (_, _, amount, _, refunded, _) = payments::payment_record_info(&m, 1);
        assert!(amount == 10_000 && refunded == 4_000);
        th::return_treasurer_cap(&s, cap);
        ts::return_shared(m);
    };

    // Refund the remainder with entitlement revocation.
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = th::with_treasurer_cap(&s);
        payments::refund<TEST_COIN>(&mut m, &cap, 1, 6_000, true, s.ctx());
        assert!(treasury::treasury_value<TEST_COIN>(&m) == 0);
        assert!(!entitlements::is_entitled(&m, th::str(b"pro"), th::user(), &clock));
        th::return_treasurer_cap(&s, cap);
        ts::return_shared(m);
    };

    // The refunded coins actually arrived at the payer.
    s.next_tx(th::user());
    {
        let c1 = s.take_from_sender<Coin<TEST_COIN>>();
        let c2 = s.take_from_sender<Coin<TEST_COIN>>();
        assert!(coin::value(&c1) + coin::value(&c2) == 10_000);
        s.return_to_sender(c1);
        s.return_to_sender(c2);
    };
    clock.destroy_for_testing();
    s.end();
}

#[test, expected_failure(abort_code = payments::ERefundTooLarge)]
fun refund_beyond_remainder_aborts() {
    let mut s = th::setup();
    th::set_refund_window(&mut s, 7 * DAY_MS);
    let pid = th::create_one_time_product(&mut s, 10_000, option::none());
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    {
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<TEST_COIN>(&mut s, 10_000);
        payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
        th::return_state(reg, m);
    };
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let cap = th::with_treasurer_cap(&s);
    payments::refund<TEST_COIN>(&mut m, &cap, 1, 6_000, false, s.ctx());
    payments::refund<TEST_COIN>(&mut m, &cap, 1, 6_000, false, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = payments::ERefundsDisabled)]
fun refund_with_no_window_aborts() {
    let mut s = th::setup();
    let pid = th::create_one_time_product(&mut s, 10_000, option::none());
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    {
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<TEST_COIN>(&mut s, 10_000);
        payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
        th::return_state(reg, m);
    };
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let cap = th::with_treasurer_cap(&s);
    payments::refund<TEST_COIN>(&mut m, &cap, 1, 1, false, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = payments::EWrongRefundCurrency)]
fun refund_wrong_currency_aborts() {
    let mut s = th::setup();
    th::set_refund_window(&mut s, 7 * DAY_MS);
    let pid = th::create_one_time_product(&mut s, 10_000, option::none());
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    {
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<TEST_COIN>(&mut s, 10_000);
        payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
        th::return_state(reg, m);
    };
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let cap = th::with_treasurer_cap(&s);
    payments::refund<ALT_COIN>(&mut m, &cap, 1, 1_000, false, s.ctx());
    abort 0
}

#[test]
fun refund_window_zero_stores_no_records() {
    let mut s = th::setup();
    let pid = th::create_one_time_product(&mut s, 1_000, option::none());
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 1_000);
    payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
    let (exists, _, _, _, _, _) = payments::payment_record_info(&m, 1);
    assert!(!exists);
    th::return_state(reg, m);
    clock.destroy_for_testing();
    s.end();
}

// === Pruning ===

#[test]
fun prune_after_window_removes_records() {
    let mut s = th::setup();
    th::set_refund_window(&mut s, DAY_MS);
    let pid = th::create_one_time_product(&mut s, 1_000, option::none());
    s.next_tx(th::user());
    let mut clock = th::clock_at(&mut s, HOUR_MS);
    {
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<TEST_COIN>(&mut s, 1_000);
        payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
        th::return_state(reg, m);
    };
    s.next_tx(th::merchant_admin());
    clock.set_for_testing(HOUR_MS + DAY_MS);
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<OperatorCap>();
        // Unknown IDs are skipped silently; known-expired are removed.
        payments::prune_payment_records(&mut m, &cap, vector[1, 999], &clock);
        let (exists, _, _, _, _, _) = payments::payment_record_info(&m, 1);
        assert!(!exists);
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    clock.destroy_for_testing();
    s.end();
}

#[test, expected_failure(abort_code = payments::ERecordNotExpired)]
fun prune_inside_window_aborts() {
    let mut s = th::setup();
    th::set_refund_window(&mut s, DAY_MS);
    let pid = th::create_one_time_product(&mut s, 1_000, option::none());
    s.next_tx(th::user());
    let clock = th::clock_at(&mut s, HOUR_MS);
    {
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<TEST_COIN>(&mut s, 1_000);
        payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
        th::return_state(reg, m);
    };
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let cap = s.take_from_sender<OperatorCap>();
    payments::prune_payment_records(&mut m, &cap, vector[1], &clock);
    abort 0
}
