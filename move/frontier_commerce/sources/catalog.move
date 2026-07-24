/// Product catalog management (operator-gated).
///
/// Products are append-only: they can be deactivated and re-priced but never
/// deleted, and their semantic fields (kind, currency, duration, entitlement
/// key) are immutable after creation. A price change is routine; a meaning
/// change is a new product. This keeps historical payments and refunds
/// resolvable and prevents bait-and-switch on what an entitlement key meant.
module frontier_commerce::catalog;

use std::string::String;
use frontier_commerce::events;
use frontier_commerce::merchant::{Merchant, OperatorCap};
use frontier_commerce::types::{Self, Product};
use frontier_commerce::vault;

const MAX_NAME_BYTES: u64 = 64;
const MAX_URI_BYTES: u64 = 256;
const MAX_KEY_BYTES: u64 = 64;

#[error]
const EBadKind: vector<u8> = b"Unknown product kind";
#[error]
const EBadDuration: vector<u8> =
    b"Subscriptions require duration_ms >= 1; one-time products require duration_ms == 0";
#[error]
const ENameTooLong: vector<u8> = b"Product name exceeds 64 bytes";
#[error]
const EUriTooLong: vector<u8> = b"Metadata URI exceeds 256 bytes";
#[error]
const EKeyTooLong: vector<u8> = b"Entitlement key exceeds 64 bytes";
#[error]
const EUnknownProduct: vector<u8> = b"No product with this ID";

/// Create a product priced in coin type `T`. Returns the product ID.
public fun create_product<T>(
    m: &mut Merchant,
    cap: &OperatorCap,
    name: String,
    kind: u8,
    price: u64,
    duration_ms: u64,
    entitlement_key: Option<String>,
    metadata_uri: String,
    _ctx: &mut TxContext,
): u64 {
    m.assert_version();
    m.assert_operator(cap);
    assert!(name.length() <= MAX_NAME_BYTES, ENameTooLong);
    assert!(metadata_uri.length() <= MAX_URI_BYTES, EUriTooLong);
    if (entitlement_key.is_some()) {
        assert!(entitlement_key.borrow().length() <= MAX_KEY_BYTES, EKeyTooLong);
    };
    assert!(
        kind == types::kind_one_time() || kind == types::kind_subscription(),
        EBadKind,
    );
    if (kind == types::kind_subscription()) {
        assert!(duration_ms >= 1, EBadDuration);
    } else {
        assert!(duration_ms == 0, EBadDuration);
    };

    let currency = vault::key_of<T>();
    let product_id = m.take_next_product_id();
    let product = types::new_product(
        name,
        kind,
        currency,
        price,
        duration_ms,
        entitlement_key,
        metadata_uri,
    );
    m.products_mut().add(product_id, product);

    events::emit_product_created(
        object::id(m),
        product_id,
        name,
        kind,
        currency,
        price,
        duration_ms,
        entitlement_key,
    );
    product_id
}

/// Update the mutable product fields: price, active flag, name, metadata.
public fun update_product(
    m: &mut Merchant,
    cap: &OperatorCap,
    product_id: u64,
    name: String,
    price: u64,
    active: bool,
    metadata_uri: String,
) {
    m.assert_version();
    m.assert_operator(cap);
    assert!(name.length() <= MAX_NAME_BYTES, ENameTooLong);
    assert!(metadata_uri.length() <= MAX_URI_BYTES, EUriTooLong);
    assert!(m.products().contains(product_id), EUnknownProduct);

    let product = m.products_mut().borrow_mut(product_id);
    types::set_product_name(product, name);
    types::set_product_price(product, price);
    types::set_product_active(product, active);
    types::set_product_metadata_uri(product, metadata_uri);

    events::emit_product_updated(object::id(m), product_id, name, price, active, metadata_uri);
}

// === Views ===

public fun product_exists(m: &Merchant, product_id: u64): bool {
    m.products().contains(product_id)
}

/// (active, kind, price, duration_ms) for a product.
public fun product_info(m: &Merchant, product_id: u64): (bool, u8, u64, u64) {
    assert!(m.products().contains(product_id), EUnknownProduct);
    let p = m.products().borrow(product_id);
    (types::product_active(p), types::product_kind(p), types::product_price(p),
        types::product_duration_ms(p))
}
