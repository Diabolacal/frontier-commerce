/**
 * Deployment configuration.
 *
 * Everything chain-specific is DATA, never code: package IDs, the registry
 * object, and coin types all rotate between networks/cycles (the EVE assets
 * package ID has already rotated between testnet cycles), so consumers load
 * a deployment descriptor at startup and the SDK never hard-codes an ID.
 *
 * Two package IDs matter (Sui upgrade semantics):
 * - `originalPackageId`: the first-published package. Event types and struct
 *   type tags keep this prefix FOREVER, across upgrades. Use for event
 *   filters and type strings.
 * - `packageId`: the latest package. Use for Move call targets. Equal to
 *   `originalPackageId` until the first upgrade.
 */

export type NetworkName = 'localnet' | 'testnet' | 'mainnet';

export interface CommerceDeployment {
  /** Network this descriptor describes. */
  network: NetworkName;
  /** Chain identifier (first 4 bytes of genesis digest), e.g. "4c78adac". */
  chainId?: string;
  /** Latest package ID - Move call targets. */
  packageId: string;
  /** Original package ID - event/type prefixes. */
  originalPackageId: string;
  /** Shared CommerceRegistry object ID. */
  registryId: string;
  /** Publish/init transaction digest (provenance evidence). */
  publishDigest?: string;
  /**
   * Known coin types by symbol, e.g. { EVE: "0x…::EVE::EVE" }.
   * Coin types are config: they rotate when upstream packages redeploy.
   */
  coins: Record<string, CoinInfo>;
}

export interface CoinInfo {
  coinType: string;
  decimals: number;
  symbol: string;
}

/** Well-known Sui system objects (stable across networks). */
export const CLOCK_OBJECT_ID = '0x6';

/** Throws with a clear message when a descriptor is structurally invalid. */
export function validateDeployment(d: CommerceDeployment): CommerceDeployment {
  const isHex = (s: string) => /^0x[0-9a-fA-F]{1,64}$/.test(s);
  if (!isHex(d.packageId)) throw new Error(`Invalid packageId: ${d.packageId}`);
  if (!isHex(d.originalPackageId)) {
    throw new Error(`Invalid originalPackageId: ${d.originalPackageId}`);
  }
  if (!isHex(d.registryId)) throw new Error(`Invalid registryId: ${d.registryId}`);
  if (d.network === 'mainnet') {
    // Deliberate guard: no mainnet descriptor should exist yet. Remove only
    // via the mainnet promotion checklist (docs/security-model.md).
    throw new Error(
      'No mainnet deployment is defined for frontier-commerce yet. ' +
        'See docs/security-model.md - mainnet promotion checklist.',
    );
  }
  for (const [key, coin] of Object.entries(d.coins)) {
    // Move identifiers allow digits and underscores after the first char
    // (e.g. `pool_v2::TOKEN2`). Generic instantiations (`…::lp::LP<…>`) are
    // not supported as product currencies; extend deliberately if needed.
    if (!/^0x[0-9a-fA-F]+::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/.test(coin.coinType)) {
      throw new Error(`Invalid coin type for ${key}: ${coin.coinType}`);
    }
  }
  return d;
}

/** Parse a deployment descriptor from JSON text (e.g. deployments/testnet.json). */
export function parseDeployment(jsonText: string): CommerceDeployment {
  return validateDeployment(JSON.parse(jsonText) as CommerceDeployment);
}
