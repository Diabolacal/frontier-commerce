/**
 * Abuse limits: per-sender token buckets plus a global daily budget of
 * RESERVED gas.
 *
 * IN-MEMORY, SINGLE-INSTANCE. Restarting the process resets the buckets;
 * running multiple instances multiplies the effective limits. That is an
 * accepted testnet posture - the mainnet path (documented in
 * docs/security-model.md) moves these counters to a shared store.
 *
 * RESERVATION, NOT SPEND. The limiter has to decide before the transaction
 * exists, so it reserves the WORST-CASE gas budget per sponsorship and never
 * learns what that transaction actually cost - the station only co-signs, the
 * CLIENT executes, so no receipt ever comes back here. Real spend is
 * therefore always <= what was reserved, and on a live testnet station the
 * gap is roughly 20x: ~0.0025 SUI actually burned against a 0.05 SUI
 * reservation, measured over 426 sponsorships.
 *
 * That gap is why this counter is `dayReservedMist` and NOT `daySpendMist`.
 * It was renamed after an operator chased a phantom "5.9 SUI spent today"
 * that was really 0.3 SUI of spend and 118 reservations. `snapshot()` still
 * emits a deprecated `daySpendMist` alias so existing collectors keep
 * parsing, but do not reintroduce the word "spend" for this number anywhere
 * else. It is reported next to `dayAdmitted`, and the two are related by
 * exactly `dayReservedMist == dayAdmitted * gasBudgetMist` - which makes the
 * reservation mechanism self-evident on /health rather than a footnote.
 *
 * Sizing follows from that: `dailyBudgetMist / gasBudgetMist` is an ADMISSION
 * count, not a SUI figure. It caps how many sponsorships a day admits; the
 * actual wallet-drain backstops are elsewhere (the float itself, the low
 * balance threshold, and the per-sender/per-IP buckets).
 *
 * Trust note: `sender` is an UNAUTHENTICATED request field (the user only
 * signs after sponsorship), so the per-sender bucket is best-effort spam
 * control, defeated by rotating addresses. The real backstops are (a) the
 * global daily budget, charged only AFTER policy validation passes (see
 * sponsor.ts), and (b) the per-IP bucket in server.ts. Mainnet posture:
 * authenticated sessions or an upstream WAF/rate-limiter.
 */

export interface LimiterOptions {
  /** Sponsorships allowed per sender per window. */
  perSenderPerWindow: number;
  /** Window length in ms. */
  windowMs: number;
  /** Max total MIST of worst-case gas budget RESERVABLE per UTC day. */
  dailyBudgetMist: bigint;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export interface LimiterSnapshot {
  /**
   * Worst-case gas budget RESERVED today, in MIST. NOT money spent - see the
   * file header. Always >= the real on-chain cost, typically by ~20x.
   */
  dayReservedMist: bigint;
  /**
   * Sponsorships admitted today and not refunded. Invariant, for a limiter
   * driven with one fixed budget: dayReservedMist == dayAdmitted * budgetMist.
   */
  dayAdmitted: number;
  trackedSenders: number;
  dailyBudgetMist: bigint;
  /**
   * @deprecated Misleading name kept ONLY so collectors written against the
   * old shape keep working; identical to `dayReservedMist`. Read that
   * instead - this alias is scheduled for removal once consumers migrate.
   */
  daySpendMist: bigint;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private dayReservedMist = 0n;
  private dayAdmitted = 0;
  private dayKey = '';

  constructor(private readonly opts: LimiterOptions) {}

  private currentDayKey(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
  }

  /**
   * Try to admit one sponsorship for `sender`, RESERVING `budgetMist` against
   * the daily budget. Returns a rejection reason or null when admitted.
   */
  tryAdmit(sender: string, budgetMist: bigint, now: number = Date.now()): string | null {
    const dayKey = this.currentDayKey(now);
    if (dayKey !== this.dayKey) {
      this.dayKey = dayKey;
      this.dayReservedMist = 0n;
      this.dayAdmitted = 0;
    }
    if (this.dayReservedMist + budgetMist > this.opts.dailyBudgetMist) {
      return 'Daily sponsorship budget exhausted';
    }

    const key = sender.toLowerCase();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.opts.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
    } else if (bucket.count >= this.opts.perSenderPerWindow) {
      return 'Rate limit exceeded for this sender';
    } else {
      bucket.count += 1;
    }

    this.dayReservedMist += budgetMist;
    this.dayAdmitted += 1;
    // Opportunistic cleanup to bound memory.
    if (this.buckets.size > 10_000) {
      for (const [k, b] of this.buckets) {
        if (now - b.windowStart >= this.opts.windowMs) this.buckets.delete(k);
      }
    }
    return null;
  }

  /**
   * Release a previously RESERVED budget after a sponsor-side failure where
   * nothing was signed (gas pool depleted, build error). Only call after a
   * successful `tryAdmit` for the same sender/budget; the counters clamp at
   * zero so a stray refund can never manufacture extra allowance.
   *
   * A refund released across a UTC midnight is dropped, not applied to the
   * new day - reservations belong to the day that made them, and crediting
   * yesterday's reservation to today would hand out allowance that was never
   * reserved.
   *
   * Deliberately does NOT return the per-sender bucket slot: build failures
   * are requester-influenced (e.g. referencing stale objects the policy
   * cannot see) and each one costs an RPC round trip, so failed attempts
   * must keep counting against the sender's rate. Only the global budget -
   * the resource an attacker could exhaust for everyone - is made whole.
   */
  refund(_sender: string, budgetMist: bigint, now: number = Date.now()): void {
    if (this.currentDayKey(now) !== this.dayKey) return;
    // Clamp both counters together so `dayReservedMist == dayAdmitted *
    // budgetMist` survives a stray or oversized refund.
    if (this.dayReservedMist >= budgetMist) {
      this.dayReservedMist -= budgetMist;
      if (this.dayAdmitted > 0) this.dayAdmitted -= 1;
    } else {
      this.dayReservedMist = 0n;
      this.dayAdmitted = 0;
    }
  }

  snapshot(): LimiterSnapshot {
    return {
      dayReservedMist: this.dayReservedMist,
      dayAdmitted: this.dayAdmitted,
      trackedSenders: this.buckets.size,
      dailyBudgetMist: this.opts.dailyBudgetMist,
      // Deprecated alias - see LimiterSnapshot.daySpendMist.
      daySpendMist: this.dayReservedMist,
    };
  }
}
