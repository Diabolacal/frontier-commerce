/**
 * Self-care matrix. The faucet and the fullnode are both injected/faked, so
 * these tests never touch the network - but the GasPool under test is the
 * REAL one, so the "maintenance never races a live sponsorship for the same
 * coin" guarantee is exercised rather than asserted.
 */
import { describe, expect, it, vi } from 'vitest';
import { GasPool } from './gasPool.js';
import {
  classifyFaucet,
  defaultFaucetHost,
  isFaucetNetwork,
  TestnetSelfCare,
  type SelfCareOptions,
} from './selfcare.js';

const SPONSOR = '0x' + '99'.repeat(32);
const DIGEST = 'J4mYWLXQpXvitCB5DbEfP71ZCUWNRDoqSSQsQwmxLKmo';
const GAS_BUDGET = 50_000_000n; // 0.05 SUI

function coin(id: string, balanceMist: bigint) {
  return {
    objectId: '0x' + id.padStart(64, '0'),
    version: '1',
    digest: DIGEST,
    balance: balanceMist.toString(),
  };
}

/** Minimal ClientWithCoreApi stand-in: only what the pool/loop calls. */
function fakeClient(coins: ReturnType<typeof coin>[]) {
  const executeTransaction = vi.fn().mockResolvedValue({
    $kind: 'Transaction',
    Transaction: { digest: 'DIGEST123', status: { success: true, error: null } },
  });
  return {
    executeTransaction,
    client: {
      core: {
        listCoins: vi.fn().mockResolvedValue({ objects: coins, hasNextPage: false, cursor: null }),
        getBalance: vi.fn(),
        executeTransaction,
        waitForTransaction: vi.fn().mockResolvedValue({}),
        // The split PTB has only pure inputs and an explicit gas payment, so
        // a pass-through resolver is enough to let `tx.build()` run offline.
        // (production's resolver fetches the reference gas price; here a
        // fixed price keeps the build fully offline)
        resolveTransactionPlugin:
          () =>
          async (
            data: { gasData: { price?: string | null } },
            _options: unknown,
            next: () => Promise<void>,
          ) => {
            data.gasData.price ??= '1000';
            await next();
          },
      },
    } as never,
  };
}

function opts(over: Partial<SelfCareOptions> = {}): SelfCareOptions {
  return {
    network: 'testnet',
    autoRefill: true,
    refillThresholdMist: 2_000_000_000n,
    // Equal to the threshold = the historical stop-at-threshold behaviour;
    // hysteresis tests override both values explicitly.
    refillTargetMist: 2_000_000_000n,
    faucetHost: 'https://faucet.example',
    refillCooldownMs: 30 * 60_000,
    refillMaxBackoffMs: 6 * 60 * 60_000,
    poolTargetCoins: 0,
    minCoinBalanceMist: GAS_BUDGET,
    splitCoinMist: GAS_BUDGET * 2n,
    splitGasBudgetMist: GAS_BUDGET,
    parentReserveMist: GAS_BUDGET * 2n,
    maxSplitsPerTx: 20,
    intervalMs: 300_000,
    ...over,
  };
}

function build(
  coins: ReturnType<typeof coin>[],
  over: Partial<SelfCareOptions> = {},
  faucet = vi.fn().mockResolvedValue({ ok: true, detail: 'HTTP 200: {"status":"Success"}' }),
  clock = { t: 1_000_000 },
) {
  const { client } = fakeClient(coins);
  const o = opts(over);
  const gasPool = new GasPool(client, SPONSOR, {
    ttlMs: 30_000,
    minCoinBalanceMist: o.minCoinBalanceMist,
  });
  const selfCare = new TestnetSelfCare({
    client,
    keypair: { signTransaction: vi.fn().mockResolvedValue({ signature: 'sig' }) } as never,
    sponsorAddress: SPONSOR,
    gasPool,
    opts: o,
    faucet,
    now: () => clock.t,
    log: () => {},
  });
  return { selfCare, gasPool, client, faucet, clock };
}

describe('faucet network gating', () => {
  it('recognises only faucet networks', () => {
    expect(isFaucetNetwork('testnet')).toBe(true);
    expect(isFaucetNetwork('devnet')).toBe(true);
    expect(isFaucetNetwork('localnet')).toBe(true);
    expect(isFaucetNetwork('mainnet')).toBe(false);
  });

  it('maps networks to their public faucet hosts', () => {
    expect(defaultFaucetHost('testnet')).toBe('https://faucet.testnet.sui.io');
    expect(defaultFaucetHost('localnet')).toBe('http://127.0.0.1:9123');
  });

  it('is hard-disabled on mainnet even with TESTNET_AUTO_REFILL on', async () => {
    const { selfCare, faucet } = build([coin('1', 1n)], { network: 'mainnet' });
    expect(selfCare.refillArmed).toBe(false);
    expect(selfCare.enabled).toBe(false);
    await selfCare.runOnce();
    expect(faucet).not.toHaveBeenCalled();
  });

  it('is disabled entirely when neither half is configured', () => {
    const { selfCare } = build([coin('1', 1n)], { autoRefill: false, poolTargetCoins: 0 });
    expect(selfCare.enabled).toBe(false);
  });
});

describe('auto-refill', () => {
  it('asks the faucet when the balance is below threshold', async () => {
    const { selfCare, faucet } = build([coin('1', 500_000_000n)]);
    await selfCare.runOnce();
    expect(faucet).toHaveBeenCalledWith('https://faucet.example', SPONSOR);
    const s = selfCare.snapshot();
    expect(s.refill.attempts).toBe(1);
    expect(s.refill.successes).toBe(1);
    expect(s.refill.nextEligibleAt).not.toBeNull();
  });

  it('does nothing when the balance is healthy', async () => {
    const { selfCare, faucet } = build([coin('1', 5_000_000_000n)]);
    await selfCare.runOnce();
    expect(faucet).not.toHaveBeenCalled();
    expect(selfCare.snapshot().refill.attempts).toBe(0);
  });

  it('respects the cooldown after a success', async () => {
    const clock = { t: 1_000_000 };
    const { selfCare, faucet } = build([coin('1', 500_000_000n)], {}, undefined, clock);
    await selfCare.runOnce();
    clock.t += 60_000; // 1 min later, cooldown is 30 min
    await selfCare.runOnce();
    expect(faucet).toHaveBeenCalledTimes(1);
    clock.t += 30 * 60_000;
    await selfCare.runOnce();
    expect(faucet).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially on refusal and never throws', async () => {
    const clock = { t: 1_000_000 };
    const faucet = vi.fn().mockResolvedValue({ ok: false, detail: 'HTTP 429: rate limited' });
    const { selfCare } = build([coin('1', 500_000_000n)], {}, faucet, clock);
    await selfCare.runOnce();
    const first = Date.parse(selfCare.snapshot().refill.nextEligibleAt!);
    expect(first - clock.t).toBe(60 * 60_000); // 30 min * 2^1

    clock.t = first;
    await selfCare.runOnce();
    const second = Date.parse(selfCare.snapshot().refill.nextEligibleAt!);
    expect(second - clock.t).toBe(120 * 60_000); // 30 min * 2^2
    expect(selfCare.snapshot().refill.consecutiveFailures).toBe(2);
    expect(selfCare.snapshot().refill.lastResult).toContain('429');
  });

  it('survives a faucet that throws', async () => {
    const faucet = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const { selfCare } = build([coin('1', 500_000_000n)], {}, faucet);
    await selfCare.runOnce();
    expect(selfCare.snapshot().refill.lastResult).toContain('ECONNRESET');
    expect(selfCare.snapshot().lastError).toBeNull();
  });
});

describe('throttling vs genuine faults', () => {
  const refuse = (detail: string, outcome?: 'rateLimited' | 'hard') =>
    vi.fn().mockResolvedValue({ ok: false, detail, ...(outcome ? { outcome } : {}) });

  describe('classifyFaucet', () => {
    it('honours an explicit outcome', () => {
      expect(classifyFaucet({ ok: false, detail: 'anything', outcome: 'rateLimited' })).toBe(
        'rateLimited',
      );
      expect(classifyFaucet({ ok: true, detail: 'ok', outcome: 'ok' })).toBe('ok');
    });

    it('reads throttling out of the detail string when none is given', () => {
      // The live station's exact wording, plus the shapes other faucets use.
      for (const d of [
        'HTTP 429: Too Many Requests! Wait for 5s',
        'HTTP 429: rate limited',
        'HTTP 200: {"status":{"Failure":{"rate_limit":"exceeded"}}}',
        'too many requests',
      ]) {
        expect(classifyFaucet({ ok: false, detail: d })).toBe('rateLimited');
      }
    });

    it('treats anything else as a genuine fault', () => {
      for (const d of [
        'HTTP 500: internal error',
        'request failed: ECONNRESET',
        'HTTP 403: Forbidden',
      ]) {
        expect(classifyFaucet({ ok: false, detail: d })).toBe('hard');
      }
    });
  });

  it('a throttled station reports rate-limited, never failing', async () => {
    const clock = { t: 1_000_000 };
    const faucet = refuse('HTTP 429: Too Many Requests! Wait for 5s');
    const { selfCare } = build([coin('1', 500_000_000n)], {}, faucet, clock);
    // Five windows of throttling — the state the live station sat in.
    for (let i = 0; i < 5; i++) {
      await selfCare.runOnce();
      clock.t = Date.parse(selfCare.snapshot().refill.nextEligibleAt!);
    }
    const r = selfCare.snapshot().refill;
    expect(r.state).toBe('rate-limited');
    expect(r.lastOutcome).toBe('rateLimited');
    expect(r.consecutiveHardFailures).toBe(0);
    expect(r.lastHardFailureAt).toBeNull();
    // The blunt counter still counts every refusal — semantics unchanged.
    expect(r.consecutiveFailures).toBe(5);
  });

  it('a genuine fault is visible and counted separately', async () => {
    const faucet = refuse('HTTP 500: internal error');
    const { selfCare, clock } = build([coin('1', 500_000_000n)], {}, faucet);
    await selfCare.runOnce();
    const r = selfCare.snapshot().refill;
    expect(r.state).toBe('failing');
    expect(r.lastOutcome).toBe('hard');
    expect(r.consecutiveHardFailures).toBe(1);
    expect(Date.parse(r.lastHardFailureAt!)).toBe(clock.t);
    expect(r.lastHardFailureResult).toContain('500');
  });

  it('a transport error is a fault, not throttling', async () => {
    const faucet = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const { selfCare } = build([coin('1', 500_000_000n)], {}, faucet);
    await selfCare.runOnce();
    expect(selfCare.snapshot().refill.state).toBe('failing');
    expect(selfCare.snapshot().refill.consecutiveHardFailures).toBe(1);
  });

  it('later throttling clears the fault streak but keeps the last fault', async () => {
    // Throttling proves the faucet is reachable and behaving, so "currently
    // failing" must clear — while the forensic record of the fault survives.
    const clock = { t: 1_000_000 };
    const faucet = refuse('HTTP 500: internal error');
    const { selfCare } = build([coin('1', 500_000_000n)], {}, faucet, clock);
    await selfCare.runOnce();
    const faultAt = selfCare.snapshot().refill.lastHardFailureAt;
    expect(faultAt).not.toBeNull();

    faucet.mockResolvedValue({ ok: false, detail: 'HTTP 429: Too Many Requests! Wait for 5s' });
    clock.t = Date.parse(selfCare.snapshot().refill.nextEligibleAt!);
    await selfCare.runOnce();

    const r = selfCare.snapshot().refill;
    expect(r.state).toBe('rate-limited');
    expect(r.consecutiveHardFailures).toBe(0);
    expect(r.lastHardFailureAt).toBe(faultAt);
    expect(r.lastHardFailureResult).toContain('500');
  });

  it('a success clears both streaks and reports ok', async () => {
    const clock = { t: 1_000_000 };
    const faucet = refuse('HTTP 500: internal error');
    const { selfCare } = build([coin('1', 500_000_000n)], {}, faucet, clock);
    await selfCare.runOnce();
    expect(selfCare.snapshot().refill.state).toBe('failing');

    faucet.mockResolvedValue({ ok: true, detail: 'HTTP 200: {"status":"Success"}' });
    clock.t = Date.parse(selfCare.snapshot().refill.nextEligibleAt!);
    await selfCare.runOnce();

    const r = selfCare.snapshot().refill;
    expect(r.state).toBe('ok');
    expect(r.consecutiveFailures).toBe(0);
    expect(r.consecutiveHardFailures).toBe(0);
  });

  it('throttling and faults back off identically', async () => {
    // The split is a REPORTING distinction; both still mean "not now".
    const clock = { t: 1_000_000 };
    const throttled = build([coin('1', 500_000_000n)], {}, refuse('HTTP 429: slow down'), {
      ...clock,
    });
    const faulted = build([coin('1', 500_000_000n)], {}, refuse('HTTP 500: boom'), { ...clock });
    await throttled.selfCare.runOnce();
    await faulted.selfCare.runOnce();
    expect(throttled.selfCare.snapshot().refill.nextEligibleAt).toBe(
      faulted.selfCare.snapshot().refill.nextEligibleAt,
    );
  });

  it('state is idle before the first attempt', () => {
    const { selfCare } = build([coin('1', 5_000_000_000n)]);
    const r = selfCare.snapshot().refill;
    expect(r.state).toBe('idle');
    expect(r.lastOutcome).toBeNull();
  });

  it('snapshot with the new fields still serialises cleanly', async () => {
    const { selfCare } = build([coin('1', 500_000_000n)], {}, refuse('HTTP 429: slow down'));
    await selfCare.runOnce();
    expect(() => JSON.stringify(selfCare.snapshot())).not.toThrow();
  });
});

describe('auto-refill hysteresis (REFILL_TARGET_SUI)', () => {
  const band = { refillThresholdMist: 5_000_000_000n, refillTargetMist: 10_000_000_000n };
  // GasPool.inventory(maxAgeMs=0) still serves its cache when two reads land
  // in the SAME millisecond (now - at <= 0). Real ticks are minutes apart,
  // but vitest ticks are sub-millisecond, so yield a beat after mutating the
  // fake chain state or the second tick reads the stale inventory.
  const tick = () => new Promise((r) => setTimeout(r, 2));

  it('back-compat: with target == threshold it stops as soon as balance >= threshold', async () => {
    const clock = { t: 1_000_000 };
    const { selfCare, faucet, client } = build([coin('1', 500_000_000n)], {}, undefined, clock);
    await selfCare.runOnce();
    expect(faucet).toHaveBeenCalledTimes(1);
    // Balance jumps above the (== target) threshold; a later eligible tick is silent.
    client.core.listCoins.mockResolvedValue({
      objects: [coin('1', 2_500_000_000n)],
      hasNextPage: false,
      cursor: null,
    });
    await tick();
    clock.t += 31 * 60_000;
    await selfCare.runOnce();
    expect(faucet).toHaveBeenCalledTimes(1);
    expect(selfCare.snapshot().refill.active).toBe(false);
  });

  it('tops up across cooldown windows until the target, then stops', async () => {
    const clock = { t: 1_000_000 };
    const { selfCare, faucet, client } = build([coin('1', 4_000_000_000n)], band, undefined, clock);
    // 4 SUI < 5 threshold -> arms on the first tick. Simulate +1 SUI per
    // successful grant; run 8 eligible windows (more than the 6 needed).
    let balance = 4_000_000_000n;
    for (let window = 0; window < 8; window++) {
      const callsBefore = faucet.mock.calls.length;
      await selfCare.runOnce();
      if (faucet.mock.calls.length > callsBefore) {
        balance += 1_000_000_000n; // this window's grant landed
        client.core.listCoins.mockResolvedValue({
          objects: [coin('1', balance)],
          hasNextPage: false,
          cursor: null,
        });
      }
      await tick();
      clock.t += 31 * 60_000;
    }
    // 4 -> 10 needs 6 grants; the tick that sees >= 10 disarms silently.
    expect(faucet).toHaveBeenCalledTimes(6);
    await selfCare.runOnce();
    expect(faucet).toHaveBeenCalledTimes(6);
    const s = selfCare.snapshot();
    expect(s.refill.active).toBe(false);
    expect(s.refill.thresholdMist).toBe('5000000000');
    expect(s.refill.targetMist).toBe('10000000000');
  });

  it('hysteresis: does not start inside the band (restart with 7 SUI)', async () => {
    const { selfCare, faucet } = build([coin('1', 7_000_000_000n)], band);
    await selfCare.runOnce();
    expect(faucet).not.toHaveBeenCalled();
    expect(selfCare.snapshot().refill.active).toBe(false);
  });

  it('stays armed inside the band once a campaign has started', async () => {
    const clock = { t: 1_000_000 };
    const { selfCare, faucet, client } = build([coin('1', 4_000_000_000n)], band, undefined, clock);
    await selfCare.runOnce(); // arms + first request at 4 SUI
    client.core.listCoins.mockResolvedValue({
      objects: [coin('1', 7_000_000_000n)],
      hasNextPage: false,
      cursor: null,
    });
    await tick();
    clock.t += 31 * 60_000;
    await selfCare.runOnce(); // 7 SUI is inside the band -> still armed
    expect(faucet).toHaveBeenCalledTimes(2);
    expect(selfCare.snapshot().refill.active).toBe(true);
  });

  it('one request per cooldown window while armed', async () => {
    const clock = { t: 1_000_000 };
    const { selfCare, faucet } = build([coin('1', 4_000_000_000n)], band, undefined, clock);
    await selfCare.runOnce();
    clock.t += 60_000; // 1 min later, cooldown is 30 min
    await selfCare.runOnce();
    expect(faucet).toHaveBeenCalledTimes(1);
  });

  it('backoff on refusal is preserved while armed', async () => {
    const clock = { t: 1_000_000 };
    const faucet = vi.fn().mockResolvedValue({ ok: false, detail: 'HTTP 429: rate limited' });
    const { selfCare } = build([coin('1', 4_000_000_000n)], band, faucet, clock);
    await selfCare.runOnce();
    const first = Date.parse(selfCare.snapshot().refill.nextEligibleAt!);
    expect(first - clock.t).toBe(60 * 60_000); // 30 min * 2^1
    expect(selfCare.snapshot().refill.active).toBe(true);
  });

  it('snapshot serializes cleanly (no bigints) and exposes the band', async () => {
    const { selfCare } = build([coin('1', 4_000_000_000n)], band);
    await selfCare.runOnce();
    const s = selfCare.snapshot();
    expect(() => JSON.stringify(s)).not.toThrow();
    expect(typeof s.refill.thresholdMist).toBe('string');
    expect(typeof s.refill.targetMist).toBe('string');
    expect(typeof s.refill.active).toBe('boolean');
  });

  it('a target below the threshold collapses to threshold semantics', async () => {
    const { selfCare, faucet } = build(
      [coin('1', 4_000_000_000n)],
      { refillThresholdMist: 5_000_000_000n, refillTargetMist: 1_000_000_000n },
    );
    await selfCare.runOnce();
    expect(faucet).toHaveBeenCalledTimes(1);
    expect(selfCare.snapshot().refill.targetMist).toBe('5000000000');
  });
});

describe('gas-coin pool maintenance', () => {
  const poolOpts = { autoRefill: false, poolTargetCoins: 10 };

  it('plans a split bounded by need, affordability and PTB cap', () => {
    const { selfCare } = build([coin('1', 10_000_000_000n)], poolOpts);
    // need = 10 - 1 = 9, plenty of balance -> 9
    expect(selfCare.planSplit(10_000_000_000n, 1)).toBe(9);
    // already at target -> 0
    expect(selfCare.planSplit(10_000_000_000n, 10)).toBe(0);
    // 1.47 SUI parent: (1.47 - 0.05 gas - 0.1 reserve) / 0.1 = 13 -> capped by need 9
    expect(selfCare.planSplit(1_472_782_412n, 1)).toBe(9);
    // barely enough for one coin
    expect(selfCare.planSplit(GAS_BUDGET + GAS_BUDGET * 2n + GAS_BUDGET * 2n, 1)).toBe(1);
    // not enough for any
    expect(selfCare.planSplit(GAS_BUDGET, 1)).toBe(0);
  });

  it('honours maxSplitsPerTx', () => {
    const { selfCare } = build([coin('1', 100_000_000_000n)], {
      ...poolOpts,
      poolTargetCoins: 50,
      maxSplitsPerTx: 5,
    });
    expect(selfCare.planSplit(100_000_000_000n, 0)).toBe(5);
  });

  it('executes a split and releases the parent coin afterwards', async () => {
    const { selfCare, client, gasPool } = build([coin('1', 2_000_000_000n)], poolOpts);
    await selfCare.runOnce();
    expect((client as never as { core: { executeTransaction: ReturnType<typeof vi.fn> } }).core
      .executeTransaction).toHaveBeenCalledTimes(1);
    const s = selfCare.snapshot();
    expect(s.split.attempts).toBe(1);
    expect(s.split.coinsCreated).toBe(9);
    expect(s.split.lastResult).toContain('DIGEST123');
    // Parent released: a sponsorship can immediately reserve again.
    expect(gasPool.snapshot().reserved).toBe(0);
  });

  it('re-reads the inventory after a split so /health shows the new pool', async () => {
    const { selfCare, client } = build([coin('1', 2_000_000_000n)], poolOpts);
    const listCoins = (client as never as { core: { listCoins: ReturnType<typeof vi.fn> } }).core
      .listCoins;
    // After the split the chain returns the parent plus 9 fresh coins.
    listCoins.mockResolvedValue({
      objects: [
        coin('1', 1_100_000_000n),
        ...Array.from({ length: 9 }, (_, i) => coin(String(i + 2), 100_000_000n)),
      ],
      hasNextPage: false,
      cursor: null,
    });
    await selfCare.runOnce();
    expect(selfCare.snapshot().coins).toBe(10);
    expect(selfCare.snapshot().usableCoins).toBe(10);
  });

  it('does nothing when the pool already meets the target', async () => {
    const coins = Array.from({ length: 12 }, (_, i) => coin(String(i + 1), 100_000_000n));
    const { selfCare, client } = build(coins, poolOpts);
    await selfCare.runOnce();
    expect((client as never as { core: { executeTransaction: ReturnType<typeof vi.fn> } }).core
      .executeTransaction).not.toHaveBeenCalled();
    expect(selfCare.snapshot().usableCoins).toBe(12);
  });

  it('reports insufficient balance instead of throwing', async () => {
    const { selfCare } = build([coin('1', 60_000_000n)], poolOpts);
    await selfCare.runOnce();
    expect(selfCare.snapshot().split.lastResult).toBe('no coin large enough to split');
  });

  it('never takes a coin a live sponsorship already reserved', async () => {
    const { selfCare, gasPool } = build(
      [coin('1', 2_000_000_000n), coin('2', 100_000_000n)],
      poolOpts,
    );
    // Simulate the fat coin being in-flight for a sponsorship.
    const held = await gasPool.reserveLargest(1n);
    expect(held?.balanceMist).toBe(2_000_000_000n);
    await selfCare.runOnce();
    // Only the small coin is left and it cannot fund a split.
    expect(selfCare.snapshot().split.attempts).toBe(0);
    expect(selfCare.snapshot().split.lastResult).toBe('no coin large enough to split');
  });

  it('records an execution failure without crashing the loop', async () => {
    const { selfCare, client } = build([coin('1', 2_000_000_000n)], poolOpts);
    (
      client as never as { core: { executeTransaction: ReturnType<typeof vi.fn> } }
    ).core.executeTransaction.mockRejectedValueOnce(new Error('InsufficientGas'));
    await selfCare.runOnce();
    expect(selfCare.snapshot().split.lastResult).toContain('InsufficientGas');
    expect(selfCare.snapshot().lastError).toBeNull();
  });
});

describe('GasPool inventory + concurrency ceiling', () => {
  it('counts usable coins - the real concurrency ceiling', async () => {
    const { client } = fakeClient([
      coin('1', 1_000_000_000n),
      coin('2', 60_000_000n),
      coin('3', 10_000_000n), // dust, below the gas budget
    ]);
    const pool = new GasPool(client, SPONSOR, {
      ttlMs: 30_000,
      minCoinBalanceMist: GAS_BUDGET,
    });
    const inv = await pool.inventory();
    expect(inv.totalCoins).toBe(3);
    expect(inv.usableCoins).toBe(2);
    expect(inv.totalBalanceMist).toBe(1_070_000_000n);
    expect(inv.largestCoinMist).toBe(1_000_000_000n);
  });

  it('a single-coin float admits exactly one concurrent sponsorship', async () => {
    const { client } = fakeClient([coin('1', 1_472_782_412n)]);
    const pool = new GasPool(client, SPONSOR, {
      ttlMs: 30_000,
      minCoinBalanceMist: GAS_BUDGET,
    });
    expect(await pool.reserve()).not.toBeNull();
    expect(await pool.reserve()).toBeNull(); // -> 503 "gas pool depleted"
  });

  it('reports reservations expiring, not a stuck in-flight count', async () => {
    const { client } = fakeClient([coin('1', 1_000_000_000n)]);
    const pool = new GasPool(client, SPONSOR, {
      ttlMs: 30_000,
      minCoinBalanceMist: GAS_BUDGET,
    });
    const t = 1_000_000;
    expect(await pool.reserve(t)).not.toBeNull();
    expect(pool.snapshot(t + 1_000).reserved).toBe(1);
    expect(pool.snapshot(t + 31_000).reserved).toBe(0);
  });

  it('a split float admits many concurrent sponsorships', async () => {
    const { client } = fakeClient(
      Array.from({ length: 10 }, (_, i) => coin(String(i + 1), 100_000_000n)),
    );
    const pool = new GasPool(client, SPONSOR, {
      ttlMs: 30_000,
      minCoinBalanceMist: GAS_BUDGET,
    });
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const c = await pool.reserve();
      expect(c).not.toBeNull();
      ids.add(c!.objectId);
    }
    expect(ids.size).toBe(10); // all distinct
    expect(await pool.reserve()).toBeNull();
  });
});
