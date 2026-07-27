/**
 * /health response SHAPE.
 *
 * The incident this guards against was not a wrong number — it was a right
 * number under a wrong name (`daySpendMist` for a reservation), which an
 * operator dashboard then plotted as "spent today". So these tests assert
 * KEYS and their meaning, not just values, and they run against
 * `buildHealthPayload` so no fullnode or sponsor key is needed.
 */
import { describe, expect, it } from 'vitest';
import { buildHealthPayload, type HealthInputs } from './server.js';
import { RateLimiter } from './limits.js';
import { TestnetSelfCare } from './selfcare.js';

const SPONSOR = '0x' + '99'.repeat(32);
const GAS_BUDGET = 30_000_000n; // 0.03 SUI

/** A self-care instance with both halves off — snapshot() only, no ticks. */
function idleSelfCare() {
  return new TestnetSelfCare({
    client: {} as never,
    keypair: {} as never,
    sponsorAddress: SPONSOR,
    gasPool: {} as never,
    opts: {
      network: 'testnet',
      autoRefill: false,
      refillThresholdMist: 5_000_000_000n,
      refillTargetMist: 10_000_000_000n,
      faucetHost: 'https://faucet.example',
      refillCooldownMs: 240 * 60_000,
      refillMaxBackoffMs: 360 * 60_000,
      poolTargetCoins: 0,
      minCoinBalanceMist: GAS_BUDGET,
      splitCoinMist: 100_000_000n,
      splitGasBudgetMist: GAS_BUDGET,
      parentReserveMist: 100_000_000n,
      maxSplitsPerTx: 20,
      intervalMs: 300_000,
    },
  }).snapshot();
}

function inputs(over: Partial<HealthInputs> = {}): HealthInputs {
  const limiter = new RateLimiter({
    perSenderPerWindow: 6,
    windowMs: 60_000,
    dailyBudgetMist: 15_000_000_000n,
  });
  const at = Date.parse('2026-07-27T12:00:00.000Z');
  for (let i = 0; i < 4; i++) {
    limiter.tryAdmit('0x' + i.toString(16).padStart(64, '0'), GAS_BUDGET, at);
  }
  return {
    sponsorAddress: SPONSOR,
    balanceMist: 4_462_714_568n,
    lowBalanceThresholdMist: 300_000_000n,
    gasBudgetMist: GAS_BUDGET,
    pool: { reserved: 0 },
    inventory: {
      totalCoins: 30,
      usableCoins: 12,
      largestCoinMist: 1_000_000_000n,
    },
    selfCare: idleSelfCare(),
    limiter: limiter.snapshot(),
    stats: { approved: 130, rejected: 0, depleted: 0, error: 1 },
    startedAt: '2026-07-27T00:45:36.917Z',
    ...over,
  };
}

type Limiter = Record<string, unknown>;
const limiterOf = (h: Record<string, unknown>) => h.limiter as Limiter;

describe('/health top-level shape', () => {
  it('exposes the documented top-level keys', () => {
    expect(Object.keys(buildHealthPayload(inputs())).sort()).toEqual([
      'balanceMist',
      'config',
      'limiter',
      'lowBalance',
      'pool',
      'selfCare',
      'sponsorAddress',
      'stats',
    ]);
  });

  it('is JSON-serialisable — every bigint stringified', () => {
    const h = buildHealthPayload(inputs());
    expect(() => JSON.stringify(h)).not.toThrow();
    expect(h.balanceMist).toBe('4462714568');
    expect(limiterOf(h).dayReservedMist).toBe('120000000');
  });

  it('flags a low balance against the configured threshold', () => {
    expect(buildHealthPayload(inputs()).lowBalance).toBe(false);
    expect(buildHealthPayload(inputs({ balanceMist: 299_999_999n })).lowBalance).toBe(true);
    // Exactly at the threshold is NOT low — the comparison is strict.
    expect(buildHealthPayload(inputs({ balanceMist: 300_000_000n })).lowBalance).toBe(false);
  });

  it('reports a null inventory rather than failing when the RPC is down', () => {
    const pool = buildHealthPayload(inputs({ inventory: null })).pool as Record<string, unknown>;
    expect(pool).toEqual({
      reserved: 0,
      coins: null,
      usableCoins: null,
      largestCoinMist: null,
    });
  });
});

describe('/health limiter block reports RESERVATION, not spend', () => {
  it('exposes the honest name alongside the deprecated alias', () => {
    const l = limiterOf(buildHealthPayload(inputs()));
    expect(Object.keys(l).sort()).toEqual([
      'dailyBudgetMist',
      'dayAdmitted',
      'dayReservedMist',
      'daySpendMist',
      'trackedSenders',
    ]);
    expect(l.dayReservedMist).toBe('120000000'); // 4 x 0.03 SUI
    expect(l.dayAdmitted).toBe(4);
    expect(l.dailyBudgetMist).toBe('15000000000');
  });

  it('keeps daySpendMist tracking dayReservedMist for the EF-Map collector', () => {
    const l = limiterOf(buildHealthPayload(inputs()));
    expect(l.daySpendMist).toBe(l.dayReservedMist);
  });

  it('makes the reservation mechanism derivable from the payload alone', () => {
    // An operator (or a dashboard) can see reserved == admitted x budget
    // without reading the source. That is the whole fix.
    const h = buildHealthPayload(inputs());
    const l = limiterOf(h);
    const config = h.config as Record<string, string>;
    expect(BigInt(l.dayReservedMist as string)).toBe(
      BigInt(l.dayAdmitted as number) * BigInt(config.gasBudgetMist),
    );
  });

  it('reports the gas budget that drives the reservation', () => {
    expect(buildHealthPayload(inputs()).config).toEqual({
      gasBudgetMist: '30000000',
      lowBalanceThresholdMist: '300000000',
    });
  });
});

describe('/health self-care block distinguishes throttling from faults', () => {
  it('carries the refill state fields an alert can key on', () => {
    const selfCare = buildHealthPayload(inputs()).selfCare as {
      refill: Record<string, unknown>;
    };
    expect(selfCare.refill).toMatchObject({
      state: 'idle',
      lastOutcome: null,
      consecutiveHardFailures: 0,
      lastHardFailureAt: null,
      lastHardFailureResult: null,
    });
  });
});
