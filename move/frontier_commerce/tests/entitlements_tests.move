#[test_only]
module frontier_commerce::entitlements_tests;

use frontier_commerce::entitlements;
use frontier_commerce::merchant::{Merchant, OperatorCap};
use frontier_commerce::test_helpers as th;
use sui::test_scenario as ts;

const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;

#[test]
fun operator_grant_permanent_and_revoke() {
    let mut s = th::setup();
    let clock = th::clock_at(&mut s, HOUR_MS);
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<OperatorCap>();
        entitlements::grant_permanent(&mut m, &cap, th::str(b"beta"), th::user());
        assert!(entitlements::is_entitled(&m, th::str(b"beta"), th::user(), &clock));
        // Different key and different owner are both unaffected.
        assert!(!entitlements::is_entitled(&m, th::str(b"other"), th::user(), &clock));
        assert!(!entitlements::is_entitled(&m, th::str(b"beta"), th::user2(), &clock));
        entitlements::revoke(&mut m, &cap, th::str(b"beta"), th::user());
        assert!(!entitlements::is_entitled(&m, th::str(b"beta"), th::user(), &clock));
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    clock.destroy_for_testing();
    s.end();
}

#[test]
fun timed_grant_expires_exactly_at_boundary() {
    let mut s = th::setup();
    let mut clock = th::clock_at(&mut s, HOUR_MS);
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<OperatorCap>();
        entitlements::grant_timed(&mut m, &cap, th::str(b"trial"), th::user(), DAY_MS, &clock);
        // One ms before expiry: entitled.
        clock.set_for_testing(HOUR_MS + DAY_MS - 1);
        assert!(entitlements::is_entitled(&m, th::str(b"trial"), th::user(), &clock));
        // At expiry exactly: NOT entitled (strict >).
        clock.set_for_testing(HOUR_MS + DAY_MS);
        assert!(!entitlements::is_entitled(&m, th::str(b"trial"), th::user(), &clock));
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    clock.destroy_for_testing();
    s.end();
}

#[test]
fun timed_grant_stacks_and_survives_lapse() {
    let mut s = th::setup();
    let mut clock = th::clock_at(&mut s, HOUR_MS);
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<OperatorCap>();
        entitlements::grant_timed(&mut m, &cap, th::str(b"trial"), th::user(), DAY_MS, &clock);
        entitlements::grant_timed(&mut m, &cap, th::str(b"trial"), th::user(), DAY_MS, &clock);
        let (_, expiry) = entitlements::entitlement_info(&m, th::str(b"trial"), th::user());
        assert!(*expiry.borrow() == HOUR_MS + 2 * DAY_MS);
        // Lapse, then re-grant: base is now, not the stale expiry.
        clock.set_for_testing(HOUR_MS + 10 * DAY_MS);
        entitlements::grant_timed(&mut m, &cap, th::str(b"trial"), th::user(), DAY_MS, &clock);
        let (_, expiry2) = entitlements::entitlement_info(&m, th::str(b"trial"), th::user());
        assert!(*expiry2.borrow() == HOUR_MS + 11 * DAY_MS);
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    clock.destroy_for_testing();
    s.end();
}

#[test]
fun timed_grant_on_permanent_stays_permanent() {
    let mut s = th::setup();
    let clock = th::clock_at(&mut s, HOUR_MS);
    s.next_tx(th::merchant_admin());
    {
        let mut m = s.take_shared<Merchant>();
        let cap = s.take_from_sender<OperatorCap>();
        entitlements::grant_permanent(&mut m, &cap, th::str(b"vip"), th::user());
        entitlements::grant_timed(&mut m, &cap, th::str(b"vip"), th::user(), DAY_MS, &clock);
        let (_, expiry) = entitlements::entitlement_info(&m, th::str(b"vip"), th::user());
        assert!(expiry.is_none());
        s.return_to_sender(cap);
        ts::return_shared(m);
    };
    clock.destroy_for_testing();
    s.end();
}

#[test, expected_failure(abort_code = entitlements::ENotEntitled)]
fun revoke_nonexistent_aborts() {
    let mut s = th::setup();
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let cap = s.take_from_sender<OperatorCap>();
    entitlements::revoke(&mut m, &cap, th::str(b"ghost"), th::user());
    abort 0
}

#[test, expected_failure(abort_code = entitlements::EKeyTooLong)]
fun oversized_key_rejected() {
    let mut s = th::setup();
    s.next_tx(th::merchant_admin());
    let mut m = s.take_shared<Merchant>();
    let cap = s.take_from_sender<OperatorCap>();
    // 65 bytes.
    entitlements::grant_permanent(
        &mut m,
        &cap,
        th::str(b"01234567890123456789012345678901234567890123456789012345678901234"),
        th::user(),
    );
    abort 0
}
