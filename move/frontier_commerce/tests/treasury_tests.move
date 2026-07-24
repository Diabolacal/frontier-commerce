#[test_only]
module frontier_commerce::treasury_tests;

use frontier_commerce::merchant::{Self, Merchant, MerchantCap, TreasurerCap};
use frontier_commerce::payments;
use frontier_commerce::registry::ProtocolTreasurerCap;
use frontier_commerce::test_helpers as th;
use frontier_commerce::test_helpers::{TEST_COIN, ALT_COIN};
use frontier_commerce::treasury;
use sui::coin::{Self, Coin};
use sui::test_scenario as ts;

const HOUR_MS: u64 = 3_600_000;

/// Pay `amount` into the merchant treasury as `th::user()` via a real payment.
fun fund_treasury(s: &mut ts::Scenario, amount: u64) {
    let pid = th::create_one_time_product(s, amount, option::none());
    s.next_tx(th::user());
    let clock = th::clock_at(s, HOUR_MS);
    let (reg, mut m) = th::take_state(s);
    let payment = th::mint<TEST_COIN>(s, amount);
    payments::pay(&reg, &mut m, pid, 1, payment, th::user(), option::none(), &clock, s.ctx());
    th::return_state(reg, m);
    clock.destroy_for_testing();
    s.next_tx(th::merchant_admin());
}

#[test]
fun withdraw_moves_earnings_to_target() {
    let mut s = th::setup();
    fund_treasury(&mut s, 10_000);
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<TreasurerCap>();
        treasury::withdraw<TEST_COIN>(&mut m, &cap, 7_500, th::user2(), s.ctx());
        assert!(treasury::treasury_value<TEST_COIN>(&m) == 2_500);
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    s.next_tx(th::user2());
    {
        let c = s.take_from_sender<Coin<TEST_COIN>>();
        assert!(coin::value(&c) == 7_500);
        s.return_to_sender(c);
    };
    s.end();
}

#[test]
fun distribute_splits_by_bps_and_keeps_remainder() {
    let mut s = th::setup();
    fund_treasury(&mut s, 10_001); // odd total to exercise flooring
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let root = s.take_from_sender<MerchantCap>();
        // 60% / 39% split; 1% deliberately unallocated.
        merchant::set_split_policy(
            &mut m, &root, vector[th::user(), th::user2()], vector[6_000, 3_900], false,
        );
        s.return_to_sender(root);
        ts::return_shared(m);
    };
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<TreasurerCap>();
        treasury::distribute<TEST_COIN>(&mut m, &cap, s.ctx());
        // 10_001 * 6000/10000 = 6000 (floor 6000.6); * 3900/10000 = 3900 (floor 3900.39)
        assert!(treasury::treasury_value<TEST_COIN>(&m) == 10_001 - 6_000 - 3_900);
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    s.next_tx(th::user());
    {
        let c = s.take_from_sender<Coin<TEST_COIN>>();
        assert!(coin::value(&c) == 6_000);
        s.return_to_sender(c);
    };
    s.next_tx(th::user2());
    {
        let c = s.take_from_sender<Coin<TEST_COIN>>();
        assert!(coin::value(&c) == 3_900);
        s.return_to_sender(c);
    };
    s.end();
}

#[test, expected_failure(abort_code = treasury::ESplitEnforced)]
fun enforce_split_blocks_plain_withdraw() {
    let mut s = th::setup();
    fund_treasury(&mut s, 10_000);
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let root = s.take_from_sender<MerchantCap>();
        merchant::set_split_policy(
            &mut m, &root, vector[th::user(), th::user2()], vector[5_000, 5_000], true,
        );
        s.return_to_sender(root);
        ts::return_shared(m);
    };
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let cap = s.take_from_sender<TreasurerCap>();
    treasury::withdraw<TEST_COIN>(&mut m, &cap, 1, th::merchant_admin(), s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = treasury::ENoSplitPolicy)]
fun distribute_without_policy_aborts() {
    let mut s = th::setup();
    fund_treasury(&mut s, 10_000);
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let cap = s.take_from_sender<TreasurerCap>();
    treasury::distribute<TEST_COIN>(&mut m, &cap, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = treasury::ENothingToDistribute)]
fun distribute_empty_treasury_aborts() {
    let mut s = th::setup();
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let root = s.take_from_sender<MerchantCap>();
        merchant::set_split_policy(&mut m, &root, vector[th::user()], vector[10_000], false);
        s.return_to_sender(root);
        ts::return_shared(m);
    };
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let cap = s.take_from_sender<TreasurerCap>();
    treasury::distribute<TEST_COIN>(&mut m, &cap, s.ctx());
    abort 0
}

#[test]
fun sweep_fees_isolates_protocol_cut() {
    let mut s = th::setup();
    th::set_protocol_fee(&mut s, 1_000); // 10% (the max)
    fund_treasury(&mut s, 10_000); // fee 1_000, net 9_000

    s.next_tx(th::protocol_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<ProtocolTreasurerCap>();
        assert!(treasury::fees_accrued_value<TEST_COIN>(&m) == 1_000);
        treasury::sweep_fees<TEST_COIN>(&mut m, &cap, th::protocol_admin(), s.ctx());
        assert!(treasury::fees_accrued_value<TEST_COIN>(&m) == 0);
        // Merchant earnings untouched by the sweep.
        assert!(treasury::treasury_value<TEST_COIN>(&m) == 9_000);
        // Sweeping again is a harmless no-op.
        treasury::sweep_fees<TEST_COIN>(&mut m, &cap, th::protocol_admin(), s.ctx());
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    s.next_tx(th::protocol_admin());
    {
        let c = s.take_from_sender<Coin<TEST_COIN>>();
        assert!(coin::value(&c) == 1_000);
        s.return_to_sender(c);
    };
    s.end();
}

#[test]
fun multi_currency_buckets_are_independent() {
    let mut s = th::setup();
    // TEST_COIN product via helper; ALT_COIN product created inline.
    fund_treasury(&mut s, 5_000);
    s.next_tx(th::merchant_admin());
    let alt_pid;
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<frontier_commerce::merchant::OperatorCap>();
        alt_pid = frontier_commerce::catalog::create_product<ALT_COIN>(
            &mut m,
            &cap,
            th::str(b"alt-product"),
            frontier_commerce::types::kind_one_time(),
            3_000,
            0,
            option::none(),
            th::str(b""),
            s.ctx(),
        );
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    s.next_tx(th::user());
    {
        let clock = th::clock_at(&mut s, HOUR_MS);
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<ALT_COIN>(&mut s, 3_000);
        payments::pay(
            &reg, &mut m, alt_pid, 1, payment, th::user(), option::none(), &clock, s.ctx(),
        );
        assert!(treasury::treasury_value<TEST_COIN>(&m) == 5_000);
        assert!(treasury::treasury_value<ALT_COIN>(&m) == 3_000);
        th::return_state(reg, m);
        clock.destroy_for_testing();
    };
    // Withdrawing ALT leaves TEST untouched.
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<TreasurerCap>();
        treasury::withdraw<ALT_COIN>(&mut m, &cap, 3_000, th::merchant_admin(), s.ctx());
        assert!(treasury::treasury_value<ALT_COIN>(&m) == 0);
        assert!(treasury::treasury_value<TEST_COIN>(&m) == 5_000);
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    s.end();
}
