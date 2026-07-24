#[test_only]
module frontier_commerce::admin_tests;

use std::string;
use frontier_commerce::catalog;
use frontier_commerce::merchant::{Self, Merchant, MerchantCap, OperatorCap, TreasurerCap};
use frontier_commerce::registry::{Self, CommerceRegistry, ProtocolCap};
use frontier_commerce::test_helpers as th;
use frontier_commerce::types;
use sui::test_scenario as ts;

// === Confused deputy: caps only work on their own merchant ===

#[test, expected_failure(abort_code = merchant::ENotMerchantCap)]
fun operator_cap_of_other_merchant_rejected() {
    let mut s = th::setup();
    // Capture the victim merchant's ID while it is the only one.
    let victim_id = {
        let m = s.take_shared<Merchant>();
        let id = object::id(&m);
        ts::return_shared(m);
        id
    };
    // Outsider creates their own merchant and gets their own caps.
    s.next_tx(th::outsider());
    merchant::create_merchant(string::utf8(b"evil-app"), s.ctx());
    s.next_tx(th::outsider());
    // Outsider tries to use THEIR operator cap on the victim merchant.
    let mut m_victim = s.take_shared_by_id<Merchant>(victim_id);
    let evil_cap = s.take_from_sender<OperatorCap>();
    catalog::create_product<th::TEST_COIN>(
        &mut m_victim,
        &evil_cap,
        th::str(b"fraud"),
        types::kind_one_time(),
        1,
        0,
        option::none(),
        th::str(b""),
        s.ctx(),
    );
    abort 0
}

#[test, expected_failure(abort_code = merchant::ERevokedCap)]
fun revoked_operator_cap_is_inert() {
    let mut s = th::setup();
    // Mint a second operator cap for a "service", then revoke it.
    s.next_tx(th::merchant_admin());
    let service_cap_id;
    {
        let mut m = s.take_shared<Merchant>();
        let root = s.take_from_sender<MerchantCap>();
        let service_cap = merchant::mint_operator_cap(&mut m, &root, s.ctx());
        service_cap_id = object::id(&service_cap);
        transfer::public_transfer(service_cap, th::outsider());
        s.return_to_sender(root);
        ts::return_shared(m);
    };
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let root = s.take_from_sender<MerchantCap>();
        merchant::revoke_operator_cap(&mut m, &root, service_cap_id);
        s.return_to_sender(root);
        ts::return_shared(m);
    };
    // The (stolen) cap holder tries to use it.
    s.next_tx(th::outsider());
    let mut m = s.take_shared<Merchant>();
    let cap = s.take_from_sender<OperatorCap>();
    catalog::create_product<th::TEST_COIN>(
        &mut m, &cap, th::str(b"x"), types::kind_one_time(), 1, 0, option::none(), th::str(b""),
        s.ctx(),
    );
    abort 0
}

#[test, expected_failure(abort_code = merchant::ERevokedCap)]
fun revoked_treasurer_cap_cannot_withdraw() {
    let mut s = th::setup();
    s.next_tx(th::merchant_admin());
    let cap_id;
    {
        let mut m = s.take_shared<Merchant>();
        let root = s.take_from_sender<MerchantCap>();
        let cap = merchant::mint_treasurer_cap(&mut m, &root, s.ctx());
        cap_id = object::id(&cap);
        transfer::public_transfer(cap, th::outsider());
        s.return_to_sender(root);
        ts::return_shared(m);
    };
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let root = s.take_from_sender<MerchantCap>();
        merchant::revoke_treasurer_cap(&mut m, &root, cap_id);
        s.return_to_sender(root);
        ts::return_shared(m);
    };
    s.next_tx(th::outsider());
    let mut m = s.take_shared<Merchant>();
    let cap = s.take_from_sender<TreasurerCap>();
    frontier_commerce::treasury::withdraw<th::TEST_COIN>(
        &mut m, &cap, 1, th::outsider(), s.ctx(),
    );
    abort 0
}

// === Root rotation & recovery ===

#[test]
fun rotate_root_new_cap_works() {
    let mut s = th::setup();
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let root = s.take_from_sender<MerchantCap>();
        let new_root = merchant::rotate_root(&mut m, root, s.ctx());
        // New root works immediately.
        merchant::set_refund_window_ms(&mut m, &new_root, 1000);
        assert!(merchant::refund_window_ms(&m) == 1000);
        transfer::public_transfer(new_root, th::merchant_admin());
        ts::return_shared(m);
    };
    s.end();
}

#[test, expected_failure(abort_code = merchant::ERevokedCap)]
fun recovery_after_delay_supersedes_old_root() {
    let mut s = th::setup();
    // Protocol requests recovery (merchant admin "lost" their root).
    s.next_tx(th::protocol_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let pcap = s.take_from_sender<ProtocolCap>();
        let clock = th::clock_at(&mut s, 1_000);
        merchant::protocol_request_recovery(&mut m, &pcap, &clock);
        assert!(merchant::recovery_requested_at_ms(&m) == option::some(1_000));
        clock.destroy_for_testing();
        s.return_to_sender(pcap);
        ts::return_shared(m);
    };
    // After the challenge window, execution succeeds.
    s.next_tx(th::protocol_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let pcap = s.take_from_sender<ProtocolCap>();
        let clock = th::clock_at(&mut s, 1_000 + merchant::recovery_delay_ms());
        let new_root = merchant::protocol_execute_recovery(&mut m, &pcap, &clock, s.ctx());
        assert!(merchant::recovery_requested_at_ms(&m).is_none());
        clock.destroy_for_testing();
        transfer::public_transfer(new_root, th::user2());
        s.return_to_sender(pcap);
        ts::return_shared(m);
    };
    // The old root cap must now be inert.
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let old_root = s.take_from_sender<MerchantCap>();
    merchant::set_refund_window_ms(&mut m, &old_root, 1000);
    abort 0
}

#[test, expected_failure(abort_code = merchant::ERecoveryDelayNotElapsed)]
fun recovery_execute_before_delay_rejected() {
    let mut s = th::setup();
    s.next_tx(th::protocol_admin());
    let mut m = s.take_shared<Merchant>();
    let pcap = s.take_from_sender<ProtocolCap>();
    let clock = th::clock_at(&mut s, 1_000);
    merchant::protocol_request_recovery(&mut m, &pcap, &clock);
    // One millisecond short of the window.
    let clock2 = th::clock_at(&mut s, 1_000 + merchant::recovery_delay_ms() - 1);
    let new_root = merchant::protocol_execute_recovery(&mut m, &pcap, &clock2, s.ctx());
    transfer::public_transfer(new_root, th::protocol_admin());
    abort 0
}

#[test, expected_failure(abort_code = merchant::ENoPendingRecovery)]
fun recovery_execute_without_request_rejected() {
    let mut s = th::setup();
    s.next_tx(th::protocol_admin());
    let mut m = s.take_shared<Merchant>();
    let pcap = s.take_from_sender<ProtocolCap>();
    let clock = th::clock_at(&mut s, merchant::recovery_delay_ms() * 2);
    let new_root = merchant::protocol_execute_recovery(&mut m, &pcap, &clock, s.ctx());
    transfer::public_transfer(new_root, th::protocol_admin());
    abort 0
}

#[test, expected_failure(abort_code = merchant::ERecoveryAlreadyPending)]
fun recovery_duplicate_request_rejected() {
    let mut s = th::setup();
    s.next_tx(th::protocol_admin());
    let mut m = s.take_shared<Merchant>();
    let pcap = s.take_from_sender<ProtocolCap>();
    let clock = th::clock_at(&mut s, 1_000);
    merchant::protocol_request_recovery(&mut m, &pcap, &clock);
    merchant::protocol_request_recovery(&mut m, &pcap, &clock);
    abort 0
}

#[test, expected_failure(abort_code = merchant::ENoPendingRecovery)]
fun recovery_cancel_by_root_blocks_execution() {
    let mut s = th::setup();
    // Hostile-ProtocolCap scenario: request lands...
    s.next_tx(th::protocol_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let pcap = s.take_from_sender<ProtocolCap>();
        let clock = th::clock_at(&mut s, 1_000);
        merchant::protocol_request_recovery(&mut m, &pcap, &clock);
        clock.destroy_for_testing();
        s.return_to_sender(pcap);
        ts::return_shared(m);
    };
    // ...the still-live root cancels inside the window...
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let root = s.take_from_sender<MerchantCap>();
        merchant::cancel_recovery(&mut m, &root);
        assert!(merchant::recovery_requested_at_ms(&m).is_none());
        s.return_to_sender(root);
        ts::return_shared(m);
    };
    // ...so execution aborts even after the delay.
    s.next_tx(th::protocol_admin());
    let mut m = s.take_shared<Merchant>();
    let pcap = s.take_from_sender<ProtocolCap>();
    let clock = th::clock_at(&mut s, 1_000 + merchant::recovery_delay_ms());
    let new_root = merchant::protocol_execute_recovery(&mut m, &pcap, &clock, s.ctx());
    transfer::public_transfer(new_root, th::protocol_admin());
    abort 0
}

#[test, expected_failure(abort_code = merchant::ERecoveryDisabled)]
fun recovery_opt_out_clears_pending_and_blocks_execution() {
    let mut s = th::setup();
    s.next_tx(th::protocol_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let pcap = s.take_from_sender<ProtocolCap>();
        let clock = th::clock_at(&mut s, 1_000);
        merchant::protocol_request_recovery(&mut m, &pcap, &clock);
        clock.destroy_for_testing();
        s.return_to_sender(pcap);
        ts::return_shared(m);
    };
    // The durable defence: opt out mid-window (also clears the request).
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let root = s.take_from_sender<MerchantCap>();
        merchant::set_recovery_enabled(&mut m, &root, false);
        assert!(merchant::recovery_requested_at_ms(&m).is_none());
        s.return_to_sender(root);
        ts::return_shared(m);
    };
    s.next_tx(th::protocol_admin());
    let mut m = s.take_shared<Merchant>();
    let pcap = s.take_from_sender<ProtocolCap>();
    let clock = th::clock_at(&mut s, 1_000 + merchant::recovery_delay_ms());
    let new_root = merchant::protocol_execute_recovery(&mut m, &pcap, &clock, s.ctx());
    transfer::public_transfer(new_root, th::protocol_admin());
    abort 0
}

#[test, expected_failure(abort_code = merchant::ERecoveryDisabled)]
fun recovery_opt_out_blocks_request() {
    let mut s = th::setup();
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let root = s.take_from_sender<MerchantCap>();
        merchant::set_recovery_enabled(&mut m, &root, false);
        s.return_to_sender(root);
        ts::return_shared(m);
    };
    s.next_tx(th::protocol_admin());
    let mut m = s.take_shared<Merchant>();
    let pcap = s.take_from_sender<ProtocolCap>();
    let clock = th::clock_at(&mut s, 1_000);
    merchant::protocol_request_recovery(&mut m, &pcap, &clock);
    abort 0
}

// === Split policy validation ===

#[test, expected_failure(abort_code = merchant::EBadSplitPolicy)]
fun split_policy_sum_above_10000_rejected() {
    let mut s = th::setup();
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let root = s.take_from_sender<MerchantCap>();
    merchant::set_split_policy(
        &mut m, &root, vector[@0x1, @0x2], vector[6000, 5000], false,
    );
    abort 0
}

#[test, expected_failure(abort_code = merchant::EBadSplitPolicy)]
fun split_policy_zero_bps_rejected() {
    let mut s = th::setup();
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let root = s.take_from_sender<MerchantCap>();
    merchant::set_split_policy(&mut m, &root, vector[@0x1, @0x2], vector[5000, 0], false);
    abort 0
}

#[test, expected_failure(abort_code = merchant::EBadSplitPolicy)]
fun split_policy_duplicate_recipient_rejected() {
    let mut s = th::setup();
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let root = s.take_from_sender<MerchantCap>();
    merchant::set_split_policy(&mut m, &root, vector[@0x1, @0x1], vector[100, 100], false);
    abort 0
}

#[test, expected_failure(abort_code = merchant::EBadSplitPolicy)]
fun split_policy_mismatched_vectors_rejected() {
    let mut s = th::setup();
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let root = s.take_from_sender<MerchantCap>();
    merchant::set_split_policy(&mut m, &root, vector[@0x1, @0x2], vector[100], false);
    abort 0
}

// === Registry admin ===

#[test, expected_failure(abort_code = registry::EFeeTooHigh)]
fun protocol_fee_above_hard_cap_rejected() {
    let mut s = th::setup();
    s.next_tx(th::protocol_admin());
    let mut reg = s.take_shared<CommerceRegistry>();
    let cap = s.take_from_sender<ProtocolCap>();
    registry::set_protocol_fee_bps(&mut reg, &cap, 1_001);
    abort 0
}

#[test]
fun listings_add_update_remove() {
    let mut s = th::setup();
    s.next_tx(th::protocol_admin());
    {
        let mut reg = s.take_shared<CommerceRegistry>();
        let cap = s.take_from_sender<ProtocolCap>();
        let m = s.take_shared<Merchant>();
        let mid = object::id(&m);
        registry::list_merchant(&mut reg, &cap, th::str(b"ef-map"), mid);
        assert!(registry::lookup_listing(&reg, th::str(b"ef-map")) == option::some(mid));
        registry::delist_merchant(&mut reg, &cap, th::str(b"ef-map"));
        assert!(registry::lookup_listing(&reg, th::str(b"ef-map")).is_none());
        s.return_to_sender(cap);
        ts::return_shared(reg);
        ts::return_shared(m);
    };
    s.end();
}

#[test, expected_failure(abort_code = registry::ENotUpgrade)]
fun migrate_current_version_rejected() {
    let mut s = th::setup();
    s.next_tx(th::protocol_admin());
    let mut reg = s.take_shared<CommerceRegistry>();
    let cap = s.take_from_sender<ProtocolCap>();
    registry::migrate_registry(&mut reg, &cap);
    abort 0
}

// === Catalog constraints ===

#[test, expected_failure(abort_code = catalog::EBadDuration)]
fun subscription_without_duration_rejected() {
    let mut s = th::setup();
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let cap = s.take_from_sender<OperatorCap>();
    catalog::create_product<th::TEST_COIN>(
        &mut m, &cap, th::str(b"bad"), types::kind_subscription(), 100, 0, option::none(),
        th::str(b""), s.ctx(),
    );
    abort 0
}

#[test, expected_failure(abort_code = catalog::EBadDuration)]
fun one_time_with_duration_rejected() {
    let mut s = th::setup();
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let cap = s.take_from_sender<OperatorCap>();
    catalog::create_product<th::TEST_COIN>(
        &mut m, &cap, th::str(b"bad"), types::kind_one_time(), 100, 1000, option::none(),
        th::str(b""), s.ctx(),
    );
    abort 0
}

#[test, expected_failure(abort_code = catalog::EBadKind)]
fun unknown_product_kind_rejected() {
    let mut s = th::setup();
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let cap = s.take_from_sender<OperatorCap>();
    catalog::create_product<th::TEST_COIN>(
        &mut m, &cap, th::str(b"bad"), 99, 100, 0, option::none(), th::str(b""), s.ctx(),
    );
    abort 0
}
