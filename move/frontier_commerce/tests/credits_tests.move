#[test_only]
module frontier_commerce::credits_tests;

use frontier_commerce::credits;
use frontier_commerce::merchant::{Self, Merchant, OperatorCap};
use frontier_commerce::test_helpers as th;
use frontier_commerce::test_helpers::TEST_COIN;
use frontier_commerce::treasury;
use sui::coin::{Self, Coin};
use sui::test_scenario as ts;

#[test]
fun deposit_charge_withdraw_full_cycle_with_fee() {
    let mut s = th::setup();
    th::set_protocol_fee(&mut s, 100); // 1%
    th::enable_credits(&mut s);

    // User deposits 10_000.
    s.next_tx(th::user());
    {
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<TEST_COIN>(&mut s, 10_000);
        credits::deposit(&reg, &mut m, payment, s.ctx());
        assert!(credits::credit_balance<TEST_COIN>(&m, th::user()) == 10_000);
        assert!(credits::credit_escrow_value<TEST_COIN>(&m) == 10_000);
        th::return_state(reg, m);
    };

    // Operator charges 4_000 (fee 40 -> protocol, 3_960 -> treasury).
    s.next_tx(th::merchant_admin());
    {
        let (reg, mut m) = th::take_state(&s);
        let cap = s.take_from_sender<OperatorCap>();
        credits::charge<TEST_COIN>(&reg, &mut m, &cap, th::user(), 4_000, th::str(b"api-batch-1"));
        assert!(credits::credit_balance<TEST_COIN>(&m, th::user()) == 6_000);
        assert!(credits::credit_escrow_value<TEST_COIN>(&m) == 6_000);
        assert!(treasury::treasury_value<TEST_COIN>(&m) == 3_960);
        assert!(treasury::fees_accrued_value<TEST_COIN>(&m) == 40);
        s.return_to_sender(cap);
        th::return_state(reg, m);
    };

    // User withdraws the remaining 6_000; ledger entry disappears.
    s.next_tx(th::user());
    {
        let mut m = s.take_shared<Merchant>();
        let refund = credits::withdraw_credits<TEST_COIN>(&mut m, 6_000, s.ctx());
        assert!(coin::value(&refund) == 6_000);
        assert!(credits::credit_balance<TEST_COIN>(&m, th::user()) == 0);
        assert!(credits::credit_escrow_value<TEST_COIN>(&m) == 0);
        transfer::public_transfer(refund, th::user());
        ts::return_shared(m);
    };
    s.end();
}

#[test]
fun per_user_ledgers_are_isolated() {
    let mut s = th::setup();
    th::enable_credits(&mut s);
    s.next_tx(th::user());
    {
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<TEST_COIN>(&mut s, 5_000);
        credits::deposit(&reg, &mut m, payment, s.ctx());
        th::return_state(reg, m);
    };
    s.next_tx(th::user2());
    {
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<TEST_COIN>(&mut s, 3_000);
        credits::deposit(&reg, &mut m, payment, s.ctx());
        assert!(credits::credit_balance<TEST_COIN>(&m, th::user()) == 5_000);
        assert!(credits::credit_balance<TEST_COIN>(&m, th::user2()) == 3_000);
        th::return_state(reg, m);
    };
    // user2 cannot withdraw user1's balance: their own is the bound.
    s.next_tx(th::user2());
    {
        let mut m = s.take_shared<Merchant>();
        let c = credits::withdraw_credits<TEST_COIN>(&mut m, 3_000, s.ctx());
        transfer::public_transfer(c, th::user2());
        assert!(credits::credit_balance<TEST_COIN>(&m, th::user2()) == 0);
        assert!(credits::credit_balance<TEST_COIN>(&m, th::user()) == 5_000);
        assert!(credits::credit_escrow_value<TEST_COIN>(&m) == 5_000);
        ts::return_shared(m);
    };
    s.end();
}

#[test, expected_failure(abort_code = credits::ECreditsDisabled)]
fun deposit_when_disabled_aborts() {
    let mut s = th::setup();
    s.next_tx(th::user());
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 1_000);
    credits::deposit(&reg, &mut m, payment, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = credits::EInsufficientCredits)]
fun charge_beyond_balance_aborts() {
    let mut s = th::setup();
    th::enable_credits(&mut s);
    s.next_tx(th::user());
    {
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<TEST_COIN>(&mut s, 1_000);
        credits::deposit(&reg, &mut m, payment, s.ctx());
        th::return_state(reg, m);
    };
    s.next_tx(th::merchant_admin());
    let (reg, mut m) = th::take_state(&s);
    let cap = s.take_from_sender<OperatorCap>();
    credits::charge<TEST_COIN>(&reg, &mut m, &cap, th::user(), 1_001, th::str(b"overreach"));
    abort 0
}

#[test, expected_failure(abort_code = credits::ENoCreditAccount)]
fun charge_unknown_account_aborts() {
    let mut s = th::setup();
    th::enable_credits(&mut s);
    s.next_tx(th::merchant_admin());
    let (reg, mut m) = th::take_state(&s);
    let cap = s.take_from_sender<OperatorCap>();
    credits::charge<TEST_COIN>(&reg, &mut m, &cap, th::user(), 1, th::str(b"ghost"));
    abort 0
}

#[test, expected_failure(abort_code = credits::EInsufficientCredits)]
fun withdraw_beyond_balance_aborts() {
    let mut s = th::setup();
    th::enable_credits(&mut s);
    s.next_tx(th::user());
    {
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<TEST_COIN>(&mut s, 1_000);
        credits::deposit(&reg, &mut m, payment, s.ctx());
        th::return_state(reg, m);
    };
    s.next_tx(th::user());
    let mut m = s.take_shared<Merchant>();
    let c = credits::withdraw_credits<TEST_COIN>(&mut m, 1_001, s.ctx());
    transfer::public_transfer(c, th::user());
    abort 0
}

#[test]
fun pause_blocks_intake_but_not_user_withdrawal() {
    let mut s = th::setup();
    th::enable_credits(&mut s);
    s.next_tx(th::user());
    {
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<TEST_COIN>(&mut s, 1_000);
        credits::deposit(&reg, &mut m, payment, s.ctx());
        th::return_state(reg, m);
    };
    // Merchant pauses.
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<OperatorCap>();
        merchant::set_paused(&mut m, &cap, true);
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    // User can still pull funds out while paused.
    s.next_tx(th::user());
    {
        let mut m = s.take_shared<Merchant>();
        let c = credits::withdraw_credits<TEST_COIN>(&mut m, 1_000, s.ctx());
        assert!(coin::value(&c) == 1_000);
        transfer::public_transfer(c, th::user());
        ts::return_shared(m);
    };
    s.end();
}

#[test, expected_failure(abort_code = credits::EPaused)]
fun pause_blocks_deposit() {
    let mut s = th::setup();
    th::enable_credits(&mut s);
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<OperatorCap>();
        merchant::set_paused(&mut m, &cap, true);
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    s.next_tx(th::user());
    let (reg, mut m) = th::take_state(&s);
    let payment = th::mint<TEST_COIN>(&mut s, 1_000);
    credits::deposit(&reg, &mut m, payment, s.ctx());
    abort 0
}

#[test, expected_failure(abort_code = credits::EPaused)]
fun pause_blocks_charge() {
    let mut s = th::setup();
    th::enable_credits(&mut s);
    s.next_tx(th::user());
    {
        let (reg, mut m) = th::take_state(&s);
        let payment = th::mint<TEST_COIN>(&mut s, 1_000);
        credits::deposit(&reg, &mut m, payment, s.ctx());
        th::return_state(reg, m);
    };
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<OperatorCap>();
        merchant::set_paused(&mut m, &cap, true);
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    s.next_tx(th::merchant_admin());
    let (reg, mut m) = th::take_state(&s);
    let cap = s.take_from_sender<OperatorCap>();
    credits::charge<TEST_COIN>(&reg, &mut m, &cap, th::user(), 1, th::str(b"paused"));
    abort 0
}
