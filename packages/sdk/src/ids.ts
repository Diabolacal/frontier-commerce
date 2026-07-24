/**
 * Move package surface: module names, call targets and event type builders.
 * Single source of truth so target strings never drift across the SDK.
 */
import type { CommerceDeployment } from './config.js';

export const MODULES = {
  registry: 'registry',
  merchant: 'merchant',
  catalog: 'catalog',
  payments: 'payments',
  entitlements: 'entitlements',
  credits: 'credits',
  treasury: 'treasury',
  events: 'events',
} as const;

export const PRODUCT_KIND = {
  oneTime: 1,
  subscription: 2,
} as const;
export type ProductKind = (typeof PRODUCT_KIND)[keyof typeof PRODUCT_KIND];

/** Move call target `pkg::module::fn` using the LATEST package ID. */
export function target(
  d: CommerceDeployment,
  module: keyof typeof MODULES,
  fn: string,
): `${string}::${string}::${string}` {
  return `${d.packageId}::${MODULES[module]}::${fn}`;
}

/** Event type string using the ORIGINAL package ID (stable across upgrades). */
export function eventType(d: CommerceDeployment, name: string): string {
  return `${d.originalPackageId}::${MODULES.events}::${name}`;
}

/** All event struct names emitted by the package. */
export const EVENT_NAMES = [
  'ProtocolConfigEvent',
  'MerchantListedEvent',
  'MerchantDelistedEvent',
  'RegistryMigratedEvent',
  'MerchantCreatedEvent',
  'MerchantSettingsEvent',
  'CapMintedEvent',
  'CapRevokedEvent',
  'RootRotatedEvent',
  'SplitPolicySetEvent',
  'SplitPolicyClearedEvent',
  'MerchantMigratedEvent',
  'ProductCreatedEvent',
  'ProductUpdatedEvent',
  'PaymentEvent',
  'RefundEvent',
  'PaymentRecordsPrunedEvent',
  'EntitlementGrantedEvent',
  'EntitlementRevokedEvent',
  'CreditDepositedEvent',
  'CreditChargedEvent',
  'CreditWithdrawnEvent',
  'TreasuryWithdrawalEvent',
  'SplitDistributedEvent',
  'FeesSweptEvent',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];
