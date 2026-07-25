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
 * COROLLARY (operational, learned the hard way): the pool's concurrency
 * ceiling is the number of DISTINCT sponsor coins holding at least the gas
 * budget. A freshly funded sponsor address usually owns ONE coin, so the
 * station silently degrades to one in-flight sponsorship and returns 503
 * "gas pool depleted" for everything else. `inventory()` exposes that count
 * so /health can show it, and `reserveLargest()` lets a maintenance loop
 * (see selfcare.ts) split the float into many coins without ever racing a
 * live sponsorship for the same object.
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

/** Coin-inventory summary for /health and the self-care loop. */
export interface GasPoolInventory {
  /** Every SUI coin the sponsor owns (bounded by the page scan below). */
  totalCoins: number;
  /** Coins that can actually back a sponsorship (balance >= minCoinBalance). */
  usableCoins: number;
  totalBalanceMist: bigint;
  largestCoinMist: bigint;
  /** Epoch ms the inventory was fetched. */
  at: number;
}

interface Reservation {
  at: number;
  ttlMs: number;
}

/** Pages of coins scanned by `inventory()`. One page covers a normal float. */
const INVENTORY_MAX_PAGES = 5;

export class GasPool {
  private reserved = new Map<string, Reservation>(); // objectId -> reservation
  private lastInventory: GasPoolInventory | null = null;

  constructor(
    private readonly client: ClientWithCoreApi,
    private readonly sponsorAddress: string,
    private readonly opts: GasPoolOptions,
  ) {}

  private sweep(now: number): void {
    for (const [id, r] of this.reserved) {
      if (now - r.at >= r.ttlMs) this.reserved.delete(id);
    }
  }

  /**
   * List sponsor SUI coins, following the cursor for at most `maxPages`.
   * `reserve()` deliberately scans a single page (hot path, one RPC per
   * sponsorship); `inventory()` scans more so the reported coin count is
   * right for a station running a large pool.
   */
  private async fetchCoins(maxPages: number): Promise<GasCoinRef[]> {
    const out: GasCoinRef[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.client.core.listCoins({
        owner: this.sponsorAddress,
        coinType: '0x2::sui::SUI',
        ...(cursor ? { cursor } : {}),
      });
      for (const c of res.objects) {
        out.push({
          objectId: c.objectId,
          version: c.version,
          digest: c.digest,
          balanceMist: BigInt(c.balance),
        });
      }
      if (!res.hasNextPage || !res.cursor) break;
      cursor = res.cursor;
    }
    return out;
  }

  /**
   * Reserve one SUI coin with balance >= minCoinBalanceMist that is not
   * currently reserved. Returns null when none is free (caller -> 503).
   * Fresh object refs are fetched every call, so a coin consumed by an
   * executed sponsorship comes back with its new version automatically.
   */
  async reserve(now: number = Date.now()): Promise<GasCoinRef | null> {
    this.sweep(now);
    const candidates = (await this.fetchCoins(1))
      .filter((c) => c.balanceMist >= this.opts.minCoinBalanceMist)
      .sort((a, b) => (a.balanceMist < b.balanceMist ? -1 : 1)); // smallest usable first

    for (const c of candidates) {
      if (!this.reserved.has(c.objectId)) {
        this.reserved.set(c.objectId, { at: now, ttlMs: this.opts.ttlMs });
        return c;
      }
    }
    return null;
  }

  /**
   * Reserve the LARGEST free coin with balance >= minBalanceMist, optionally
   * with a longer TTL than a sponsorship gets. Used by pool maintenance:
   * splitting takes the fat coin (which `reserve()` hands out last, since it
   * prefers the smallest usable coin) and holds it for the duration of an
   * on-chain round trip, so a concurrent sponsorship can never pick the same
   * object and equivocate.
   */
  async reserveLargest(
    minBalanceMist: bigint,
    ttlMs: number = this.opts.ttlMs,
    now: number = Date.now(),
  ): Promise<GasCoinRef | null> {
    this.sweep(now);
    const candidates = (await this.fetchCoins(INVENTORY_MAX_PAGES))
      .filter((c) => c.balanceMist >= minBalanceMist)
      .sort((a, b) => (a.balanceMist > b.balanceMist ? -1 : 1)); // largest first

    for (const c of candidates) {
      if (!this.reserved.has(c.objectId)) {
        this.reserved.set(c.objectId, { at: now, ttlMs });
        return c;
      }
    }
    return null;
  }

  /**
   * Coin-count/balance summary. `maxAgeMs` serves a cached result so a
   * frequently polled /health does not add an RPC call per poll; pass 0
   * (default) to force a fresh read.
   */
  async inventory(maxAgeMs = 0, now: number = Date.now()): Promise<GasPoolInventory> {
    if (this.lastInventory && now - this.lastInventory.at <= maxAgeMs) {
      return this.lastInventory;
    }
    const coins = await this.fetchCoins(INVENTORY_MAX_PAGES);
    let total = 0n;
    let largest = 0n;
    let usable = 0;
    for (const c of coins) {
      total += c.balanceMist;
      if (c.balanceMist > largest) largest = c.balanceMist;
      if (c.balanceMist >= this.opts.minCoinBalanceMist) usable += 1;
    }
    this.lastInventory = {
      totalCoins: coins.length,
      usableCoins: usable,
      totalBalanceMist: total,
      largestCoinMist: largest,
      at: now,
    };
    return this.lastInventory;
  }

  release(objectId: string): void {
    this.reserved.delete(objectId);
  }

  snapshot(): { reserved: number } {
    return { reserved: this.reserved.size };
  }
}
