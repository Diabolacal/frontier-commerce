/// Plain data records stored inside a `Merchant`.
///
/// These live in their own module because `merchant.move` embeds them in
/// `Table` fields: value types must be defined in a module the merchant
/// module can depend on without a dependency cycle. Domain modules
/// (`payments`, `entitlements`, `credits`, `treasury`, `catalog`) construct
/// and mutate them via `public(package)` helpers only.
module frontier_commerce::types;

use std::string::String;
use std::type_name::TypeName;

// === Product ===

/// Product kinds. u8 rather than enum so future kinds are additive.
const KIND_ONE_TIME: u8 = 1;
const KIND_SUBSCRIPTION: u8 = 2;

public(package) fun kind_one_time(): u8 { KIND_ONE_TIME }
public(package) fun kind_subscription(): u8 { KIND_SUBSCRIPTION }

/// A purchasable item defined by a merchant.
///
/// `currency`, `kind`, `duration_ms` and `entitlement_key` are immutable after
/// creation: changing the meaning of a product mid-flight is an audit hazard.
/// Price / active / metadata are operator-adjustable.
public struct Product has store {
    /// false = not purchasable (soft delete; products are never removed so
    /// payment records and refunds can always resolve their product).
    active: bool,
    /// Short human label, <= 64 bytes.
    name: String,
    /// KIND_* constant.
    kind: u8,
    /// Coin type this product is priced in (defining-ID qualified).
    currency: TypeName,
    /// Price per unit in the currency's base units. 0 = free (comp products).
    price: u64,
    /// Entitlement period per unit for subscriptions; 0 for one-time products.
    duration_ms: u64,
    /// Entitlement granted on purchase (none = pure payment, no entitlement).
    /// One-time products grant permanently; subscriptions extend expiry.
    entitlement_key: Option<String>,
    /// Off-chain metadata pointer (URI or opaque app reference), <= 256 bytes.
    metadata_uri: String,
}

public(package) fun new_product(
    name: String,
    kind: u8,
    currency: TypeName,
    price: u64,
    duration_ms: u64,
    entitlement_key: Option<String>,
    metadata_uri: String,
): Product {
    Product { active: true, name, kind, currency, price, duration_ms, entitlement_key, metadata_uri }
}

public(package) fun product_active(p: &Product): bool { p.active }
public(package) fun product_name(p: &Product): String { p.name }
public(package) fun product_kind(p: &Product): u8 { p.kind }
public(package) fun product_currency(p: &Product): TypeName { p.currency }
public(package) fun product_price(p: &Product): u64 { p.price }
public(package) fun product_duration_ms(p: &Product): u64 { p.duration_ms }
public(package) fun product_entitlement_key(p: &Product): &Option<String> { &p.entitlement_key }
public(package) fun product_metadata_uri(p: &Product): String { p.metadata_uri }

public(package) fun set_product_active(p: &mut Product, active: bool) { p.active = active; }
public(package) fun set_product_price(p: &mut Product, price: u64) { p.price = price; }
public(package) fun set_product_metadata_uri(p: &mut Product, uri: String) { p.metadata_uri = uri; }
public(package) fun set_product_name(p: &mut Product, name: String) { p.name = name; }

// === Payment record (refund support) ===

/// Retained only while the merchant's refund window is open; pruned after.
public struct PaymentRecord has store, drop {
    /// Address that paid (refunds return here).
    payer: address,
    /// Address that received the entitlement (may differ from payer: gifting).
    beneficiary: address,
    product_id: u64,
    currency: TypeName,
    /// Total paid, including the protocol fee portion.
    amount: u64,
    /// Protocol fee taken out of `amount` at payment time.
    fee: u64,
    /// Cumulative refunded so far; invariant: refunded <= amount.
    refunded: u64,
    paid_at_ms: u64,
}

public(package) fun new_payment_record(
    payer: address,
    beneficiary: address,
    product_id: u64,
    currency: TypeName,
    amount: u64,
    fee: u64,
    paid_at_ms: u64,
): PaymentRecord {
    PaymentRecord { payer, beneficiary, product_id, currency, amount, fee, refunded: 0, paid_at_ms }
}

public(package) fun record_payer(r: &PaymentRecord): address { r.payer }
public(package) fun record_beneficiary(r: &PaymentRecord): address { r.beneficiary }
public(package) fun record_product_id(r: &PaymentRecord): u64 { r.product_id }
public(package) fun record_currency(r: &PaymentRecord): TypeName { r.currency }
public(package) fun record_amount(r: &PaymentRecord): u64 { r.amount }
public(package) fun record_fee(r: &PaymentRecord): u64 { r.fee }
public(package) fun record_refunded(r: &PaymentRecord): u64 { r.refunded }
public(package) fun record_paid_at_ms(r: &PaymentRecord): u64 { r.paid_at_ms }
public(package) fun add_refunded(r: &mut PaymentRecord, amount: u64) {
    r.refunded = r.refunded + amount;
}

// === Entitlements ===

/// Table key: an entitlement name scoped to an owner address.
public struct EntitlementKey has copy, drop, store {
    key: String,
    owner: address,
}

public(package) fun entitlement_key(key: String, owner: address): EntitlementKey {
    EntitlementKey { key, owner }
}

/// A granted entitlement. Absent record = not entitled.
public struct EntitlementRecord has store, drop {
    /// None = permanent. Some(ms) = expires at that clock time.
    expires_at_ms: Option<u64>,
    /// How many grants/extensions have touched this record (audit aid).
    grant_count: u64,
    /// Payment that last granted/extended it; None if operator-granted.
    last_payment_id: Option<u64>,
}

public(package) fun new_entitlement_record(
    expires_at_ms: Option<u64>,
    last_payment_id: Option<u64>,
): EntitlementRecord {
    EntitlementRecord { expires_at_ms, grant_count: 1, last_payment_id }
}

public(package) fun entitlement_expires_at_ms(r: &EntitlementRecord): Option<u64> { r.expires_at_ms }
public(package) fun entitlement_grant_count(r: &EntitlementRecord): u64 { r.grant_count }
public(package) fun entitlement_last_payment_id(r: &EntitlementRecord): Option<u64> {
    r.last_payment_id
}

public(package) fun update_entitlement(
    r: &mut EntitlementRecord,
    expires_at_ms: Option<u64>,
    last_payment_id: Option<u64>,
) {
    r.expires_at_ms = expires_at_ms;
    r.grant_count = r.grant_count + 1;
    r.last_payment_id = last_payment_id;
}

// === Credits ===

/// Table key: a prepaid credit balance is scoped to (currency, owner).
public struct CreditKey has copy, drop, store {
    currency: TypeName,
    owner: address,
}

public(package) fun credit_key(currency: TypeName, owner: address): CreditKey {
    CreditKey { currency, owner }
}

// === Revenue split ===

public struct SplitShare has copy, drop, store {
    recipient: address,
    bps: u64,
}

public(package) fun split_share(recipient: address, bps: u64): SplitShare {
    SplitShare { recipient, bps }
}

public(package) fun share_recipient(s: &SplitShare): address { s.recipient }
public(package) fun share_bps(s: &SplitShare): u64 { s.bps }
