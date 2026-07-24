/**
 * Sponsor gas-coin reservation pool.
 *
 * Why: two concurrent sponsorships that let the SDK auto-select gas can pick
 * the SAME sponsor coin; whichever executes second is rejected for a stale
 * object reference (equivocation risk / availability failure - a known gap
 * in the prior-art sponsor workers). This pool pins each in-flight
 * sponsorship to a distinct coin with a TTL, so concurrent requests never
 * share a gas object.
 *
 * IN-MEMORY, SINGLE-INSTANCE (same posture note as limits.ts). Reservations
 * expire after `ttlMs` because the station never learns whether the user
 * actually executed the sponsored transaction.
 */
import type { ClientWithCoreApi } from '@mysten/sui/client';

export interface GasCoinRef {
  objectId: string;
  version: string;
  digest: string;
  balanceMist: bigint;
}

export interface GasPoolOptions {
  /** How long a reservation blocks a coin from reuse. */
  ttlMs: number;
  /** Coins below this balance are not usable for sponsorship. */
  minCoinBalanceMist: bigint;
}

export class GasPool {
  private reserved = new Map<string, number>(); // objectId -> reservedAt

  constructor(
    private readonly client: ClientWithCoreApi,
    private readonly sponsorAddress: string,
    private readonly opts: GasPoolOptions,
  ) {}

  /**
   * Reserve one SUI coin with balance >= minCoinBalanceMist that is not
   * currently reserved. Returns null when none is free (caller -> 503).
   * Fresh object refs are fetched every call, so a coin consumed by an
   * executed sponsorship comes back with its new version automatically.
   */
  async reserve(now: number = Date.now()): Promise<GasCoinRef | null> {
    for (const [id, at] of this.reserved) {
      if (now - at >= this.opts.ttlMs) this.reserved.delete(id);
    }
    const page = await this.client.core.listCoins({
      owner: this.sponsorAddress,
      coinType: '0x2::sui::SUI',
    });
    const candidates = page.objects
      .map((c) => ({
        objectId: c.objectId,
        version: c.version,
        digest: c.digest,
        balanceMist: BigInt(c.balance),
      }))
      .filter((c) => c.balanceMist >= this.opts.minCoinBalanceMist)
      .sort((a, b) => (a.balanceMist < b.balanceMist ? -1 : 1)); // smallest usable first

    for (const c of candidates) {
      if (!this.reserved.has(c.objectId)) {
        this.reserved.set(c.objectId, now);
        return c;
      }
    }
    return null;
  }

  release(objectId: string): void {
    this.reserved.delete(objectId);
  }

  snapshot(): { reserved: number } {
    return { reserved: this.reserved.size };
  }
}
