/**
 * Abuse limits: per-sender token buckets plus a global daily spend budget.
 *
 * IN-MEMORY, SINGLE-INSTANCE. Restarting the process resets the buckets;
 * running multiple instances multiplies the effective limits. That is an
 * accepted testnet posture - the mainnet path (documented in
 * docs/security-model.md) moves these counters to a shared store. The
 * daily budget counts the WORST-CASE gas budget per sponsorship (not
 * actual usage), so the real spend is always <= what the limiter charged.
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
  /** Max total MIST of worst-case gas budget per UTC day. */
  dailyBudgetMist: bigint;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private daySpendMist = 0n;
  private dayKey = '';

  constructor(private readonly opts: LimiterOptions) {}

  private currentDayKey(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
  }

  /**
   * Try to admit one sponsorship for `sender` charging `budgetMist` against
   * the daily budget. Returns a rejection reason or null when admitted.
   */
  tryAdmit(sender: string, budgetMist: bigint, now: number = Date.now()): string | null {
    const dayKey = this.currentDayKey(now);
    if (dayKey !== this.dayKey) {
      this.dayKey = dayKey;
      this.daySpendMist = 0n;
    }
    if (this.daySpendMist + budgetMist > this.opts.dailyBudgetMist) {
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

    this.daySpendMist += budgetMist;
    // Opportunistic cleanup to bound memory.
    if (this.buckets.size > 10_000) {
      for (const [k, b] of this.buckets) {
        if (now - b.windowStart >= this.opts.windowMs) this.buckets.delete(k);
      }
    }
    return null;
  }

  /**
   * Return a previously admitted BUDGET charge after a sponsor-side failure
   * where nothing was signed (gas pool depleted, build error). Only call
   * after a successful `tryAdmit` for the same sender/budget; the counter
   * clamps at zero so a stray refund can never manufacture extra allowance.
   *
   * Deliberately does NOT return the per-sender bucket slot: build failures
   * are requester-influenced (e.g. referencing stale objects the policy
   * cannot see) and each one costs an RPC round trip, so failed attempts
   * must keep counting against the sender's rate. Only the global budget -
   * the resource an attacker could exhaust for everyone - is made whole.
   */
  refund(_sender: string, budgetMist: bigint, now: number = Date.now()): void {
    if (this.currentDayKey(now) === this.dayKey) {
      this.daySpendMist = this.daySpendMist >= budgetMist ? this.daySpendMist - budgetMist : 0n;
    }
  }

  snapshot(): { daySpendMist: bigint; trackedSenders: number; dailyBudgetMist: bigint } {
    return {
      daySpendMist: this.daySpendMist,
      trackedSenders: this.buckets.size,
      dailyBudgetMist: this.opts.dailyBudgetMist,
    };
  }
}
