/**
 * Reservation accounting, and the NAMES it is reported under.
 *
 * These tests exist because of a live incident: /health reported 5.9 SUI of
 * "daySpendMist" while the wallet had actually spent ~0.3 SUI. Nothing was
 * miscounted — 118 sponsorships x a 0.05 SUI worst-case RESERVATION is
 * genuinely 5.9 — but the field name claimed it was money out the door, so
 * the operator went looking for a leak that did not exist.
 *
 * So the assertions below deliberately pin FIELD NAMES as well as arithmetic.
 * A rename that reintroduces "spend" for a reservation should fail here.
 */
import { describe, expect, it } from 'vitest';
import { RateLimiter } from './limits.js';

const BUDGET = 50_000_000n; // 0.05 SUI, the worst-case reservation per sponsorship
const SENDER = '0x' + 'ab'.repeat(32);
const DAY1 = Date.parse('2026-07-27T12:00:00.000Z');
const DAY2 = Date.parse('2026-07-28T00:00:00.000Z');

function limiter(over: Partial<ConstructorParameters<typeof RateLimiter>[0]> = {}) {
  return new RateLimiter({
    perSenderPerWindow: 6,
    windowMs: 60_000,
    dailyBudgetMist: 15_000_000_000n, // 15 SUI = 300 admissions at 0.05
    ...over,
  });
}

/** Distinct senders, so the per-sender bucket never masks a budget effect. */
const nth = (i: number) => '0x' + i.toString(16).padStart(64, '0');

describe('daily budget is a RESERVATION counter', () => {
  it('reserves the full worst-case budget per admission, not actual gas', () => {
    const l = limiter();
    for (let i = 0; i < 3; i++) expect(l.tryAdmit(nth(i), BUDGET, DAY1)).toBeNull();
    const s = l.snapshot();
    expect(s.dayReservedMist).toBe(3n * BUDGET);
    expect(s.dayAdmitted).toBe(3);
  });

  it('holds the invariant dayReservedMist == dayAdmitted * budget', () => {
    const l = limiter();
    for (let i = 0; i < 25; i++) l.tryAdmit(nth(i), BUDGET, DAY1);
    const s = l.snapshot();
    expect(s.dayReservedMist).toBe(BigInt(s.dayAdmitted) * BUDGET);
  });

  it('admits exactly dailyBudget/gasBudget sponsorships, then refuses', () => {
    // 1 SUI / 0.05 SUI = 20 admissions. This ratio is an ADMISSION COUNT,
    // which is the whole point: it is not a claim about SUI spent.
    const l = limiter({ dailyBudgetMist: 1_000_000_000n });
    for (let i = 0; i < 20; i++) expect(l.tryAdmit(nth(i), BUDGET, DAY1)).toBeNull();
    expect(l.tryAdmit(nth(99), BUDGET, DAY1)).toBe('Daily sponsorship budget exhausted');
    expect(l.snapshot().dayAdmitted).toBe(20);
  });

  it('a lower per-sponsorship budget admits proportionally more', () => {
    // The 2026-07-27 retune: 0.05 -> 0.03 SUI takes 15 SUI from 300 to 500.
    const l = limiter();
    let admitted = 0;
    for (let i = 0; i < 600; i++) if (l.tryAdmit(nth(i), 30_000_000n, DAY1) === null) admitted++;
    expect(admitted).toBe(500);
  });

  it('rejects an admission that would overshoot rather than clamping', () => {
    const l = limiter({ dailyBudgetMist: BUDGET });
    expect(l.tryAdmit(nth(1), BUDGET, DAY1)).toBeNull();
    expect(l.tryAdmit(nth(2), 1n, DAY1)).toBe('Daily sponsorship budget exhausted');
    expect(l.snapshot().dayReservedMist).toBe(BUDGET);
  });

  it('resets both counters on the UTC day rollover', () => {
    const l = limiter();
    l.tryAdmit(nth(1), BUDGET, DAY1);
    expect(l.snapshot().dayAdmitted).toBe(1);
    expect(l.tryAdmit(nth(2), BUDGET, DAY2)).toBeNull();
    const s = l.snapshot();
    expect(s.dayReservedMist).toBe(BUDGET);
    expect(s.dayAdmitted).toBe(1);
  });

  it('does not charge the budget when the per-sender bucket rejects', () => {
    const l = limiter({ perSenderPerWindow: 2 });
    expect(l.tryAdmit(SENDER, BUDGET, DAY1)).toBeNull();
    expect(l.tryAdmit(SENDER, BUDGET, DAY1)).toBeNull();
    expect(l.tryAdmit(SENDER, BUDGET, DAY1)).toBe('Rate limit exceeded for this sender');
    const s = l.snapshot();
    expect(s.dayReservedMist).toBe(2n * BUDGET);
    expect(s.dayAdmitted).toBe(2);
  });

  it('charges nothing for a zero-budget limiter (the per-IP bucket)', () => {
    const l = limiter({ dailyBudgetMist: 1n << 62n });
    for (let i = 0; i < 5; i++) l.tryAdmit('1.2.3.4', 0n, DAY1);
    expect(l.snapshot().dayReservedMist).toBe(0n);
  });
});

describe('refund returns the reservation', () => {
  it('returns budget and admission together', () => {
    const l = limiter();
    l.tryAdmit(SENDER, BUDGET, DAY1);
    l.tryAdmit(nth(2), BUDGET, DAY1);
    l.refund(SENDER, BUDGET, DAY1);
    const s = l.snapshot();
    expect(s.dayReservedMist).toBe(BUDGET);
    expect(s.dayAdmitted).toBe(1);
  });

  it('frees allowance again at the ceiling', () => {
    const l = limiter({ dailyBudgetMist: BUDGET });
    expect(l.tryAdmit(nth(1), BUDGET, DAY1)).toBeNull();
    expect(l.tryAdmit(nth(2), BUDGET, DAY1)).toBe('Daily sponsorship budget exhausted');
    l.refund(nth(1), BUDGET, DAY1);
    expect(l.tryAdmit(nth(2), BUDGET, DAY1)).toBeNull();
  });

  it('does NOT return the per-sender bucket slot', () => {
    // Deliberate: build failures are requester-influenced and cost an RPC
    // round trip each, so they keep counting against the sender's rate.
    const l = limiter({ perSenderPerWindow: 1 });
    expect(l.tryAdmit(SENDER, BUDGET, DAY1)).toBeNull();
    l.refund(SENDER, BUDGET, DAY1);
    expect(l.tryAdmit(SENDER, BUDGET, DAY1)).toBe('Rate limit exceeded for this sender');
  });

  it('clamps at zero, so a stray refund cannot manufacture allowance', () => {
    const l = limiter();
    l.refund(SENDER, BUDGET, DAY1);
    l.refund(SENDER, BUDGET, DAY1);
    const s = l.snapshot();
    expect(s.dayReservedMist).toBe(0n);
    expect(s.dayAdmitted).toBe(0);
  });

  it('keeps the invariant intact after an oversized refund', () => {
    const l = limiter();
    l.tryAdmit(nth(1), BUDGET, DAY1);
    l.refund(nth(1), BUDGET * 10n, DAY1);
    const s = l.snapshot();
    expect(s.dayReservedMist).toBe(0n);
    expect(s.dayAdmitted).toBe(0);
  });

  it('drops a refund that lands after the UTC rollover', () => {
    // Yesterday's reservation must not credit today's allowance.
    const l = limiter();
    l.tryAdmit(nth(1), BUDGET, DAY1);
    l.tryAdmit(nth(2), BUDGET, DAY2); // rolls the day over
    l.refund(nth(1), BUDGET, DAY1);
    const s = l.snapshot();
    expect(s.dayReservedMist).toBe(BUDGET);
    expect(s.dayAdmitted).toBe(1);
  });

  it('round-trips exactly: admit + refund leaves the day untouched', () => {
    const l = limiter();
    for (let i = 0; i < 10; i++) {
      l.tryAdmit(nth(i), BUDGET, DAY1);
      l.refund(nth(i), BUDGET, DAY1);
    }
    const s = l.snapshot();
    expect(s.dayReservedMist).toBe(0n);
    expect(s.dayAdmitted).toBe(0);
  });
});

describe('snapshot field names (pinned — see file header)', () => {
  it('reports the reservation under an honest name', () => {
    const l = limiter();
    l.tryAdmit(SENDER, BUDGET, DAY1);
    const s = l.snapshot();
    expect(Object.keys(s).sort()).toEqual([
      'dailyBudgetMist',
      'dayAdmitted',
      'dayReservedMist',
      'daySpendMist',
      'trackedSenders',
    ]);
    expect(s.dayReservedMist).toBe(BUDGET);
    expect(s.dailyBudgetMist).toBe(15_000_000_000n);
    expect(s.trackedSenders).toBe(1);
  });

  it('keeps daySpendMist as a byte-identical deprecated alias', () => {
    // EF-Map's commerce-obs collector reads this key. It must keep tracking
    // dayReservedMist exactly until that collector migrates.
    const l = limiter();
    for (let i = 0; i < 7; i++) l.tryAdmit(nth(i), BUDGET, DAY1);
    l.refund(nth(0), BUDGET, DAY1);
    const s = l.snapshot();
    expect(s.daySpendMist).toBe(s.dayReservedMist);
    expect(s.daySpendMist).toBe(6n * BUDGET);
  });
});
