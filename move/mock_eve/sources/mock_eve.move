/// MOCK EVE - a worthless, freely mintable stand-in for the EVE token.
///
/// TESTNET/LOCALNET ONLY. This coin exists so the commerce layer can be
/// exercised end-to-end (payments, credits, refunds, splits) without
/// consuming anyone's real EVE balance, and mirrors real EVE's 9 decimals.
/// It is a SEPARATE package from frontier_commerce and must NEVER be
/// published to mainnet or referenced by production config. Anyone can mint;
/// that is the point - it proves the commerce layer is currency-agnostic
/// config, not compiled-in trust.
module mock_eve::mock_eve;

use sui::coin::{Self, Coin, TreasuryCap};

/// Matches real EVE (assets::EVE) decimals so amounts translate 1:1.
const DECIMALS: u8 = 9;
/// Per-call mint cap: 1,000,000 MOCK (sanity bound, not a security control).
const MAX_MINT_PER_CALL: u64 = 1_000_000 * 1_000_000_000;

#[error]
const EMintTooLarge: vector<u8> = b"Mint exceeds per-call cap of 1,000,000 MOCK";

public struct MOCK_EVE has drop {}

// Real EVE uses the newer `coin_registry` flow; this mock deliberately uses
// the simpler legacy `create_currency` because the commerce layer never
// reads coin metadata on-chain - only the Coin<T> type matters for testing.

/// Shared wrapper around the treasury cap so ANYONE can mint (open faucet).
public struct OpenFaucet has key {
    id: UID,
    cap: TreasuryCap<MOCK_EVE>,
}

#[allow(deprecated_usage)]
fun init(witness: MOCK_EVE, ctx: &mut TxContext) {
    let (treasury_cap, metadata) = coin::create_currency(
        witness,
        DECIMALS,
        b"MOCKEVE",
        b"Mock EVE (testnet only)",
        b"Freely mintable stand-in for the EVE token. Worthless by design. Used to exercise the frontier-commerce layer on testnet/localnet.",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    transfer::share_object(OpenFaucet { id: object::new(ctx), cap: treasury_cap });
}

/// Mint up to 1,000,000 MOCK per call to any recipient. Open to everyone.
public fun mint(faucet: &mut OpenFaucet, amount: u64, recipient: address, ctx: &mut TxContext) {
    assert!(amount <= MAX_MINT_PER_CALL, EMintTooLarge);
    let minted = coin::mint(&mut faucet.cap, amount, ctx);
    transfer::public_transfer(minted, recipient);
}

/// Mint and return (for PTB composition, e.g. mint -> pay in one tx).
public fun mint_coin(faucet: &mut OpenFaucet, amount: u64, ctx: &mut TxContext): Coin<MOCK_EVE> {
    assert!(amount <= MAX_MINT_PER_CALL, EMintTooLarge);
    coin::mint(&mut faucet.cap, amount, ctx)
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(MOCK_EVE {}, ctx);
}
