/**
 * Policy validation matrix. Transactions are built with the real SDK and
 * serialized to genuine TransactionKind bytes, so these tests exercise the
 * exact parse path production uses - not hand-mocked shapes.
 */
import { Transaction } from '@mysten/sui/transactions';
import { describe, expect, it } from 'vitest';
import { RateLimiter } from './limits.js';
import {
  containsGasCoinReference,
  parsePolicyConfig,
  validateInput,
  validateTransactionKind,
  type PolicyConfig,
} from './policy.js';
import { sponsorTransactionKind, type SponsorDeps } from './sponsor.js';
import { toBase64 } from '@mysten/sui/utils';

const PKG = '0x' + 'ab'.repeat(32);
const OTHER_PKG = '0x' + 'cd'.repeat(32);

const policy: PolicyConfig = {
  apps: [
    {
      name: 'demo-app',
      allowedTargets: [
        `${PKG}::payments::pay`,
        `${PKG}::credits::deposit`,
        `0x2::coin::zero`,
      ],
      maxCommands: 6,
    },
    {
      name: 'other-app',
      allowedTargets: [`${OTHER_PKG}::payments::pay`],
      maxCommands: 4,
    },
  ],
};

async function kindBytes(build: (tx: Transaction) => void): Promise<Uint8Array> {
  const tx = new Transaction();
  build(tx);
  return tx.build({ onlyTransactionKind: true });
}

const OBJ = '0x' + '11'.repeat(32);
// Any syntactically valid object digest (base58, 32 bytes).
const DIGEST = 'J4mYWLXQpXvitCB5DbEfP71ZCUWNRDoqSSQsQwmxLKmo';

describe('validateTransactionKind', () => {
  it('accepts an allowlisted MoveCall', async () => {
    const bytes = await kindBytes((tx) => {
      tx.moveCall({ target: `${PKG}::payments::pay`, arguments: [tx.objectRef({ objectId: OBJ, version: '1', digest: DIGEST })] });
    });
    const verdict = validateTransactionKind(bytes, policy);
    expect(verdict).toMatchObject({ ok: true, appName: 'demo-app' });
  });

  it('accepts split/merge helper commands alongside allowed calls', async () => {
    const bytes = await kindBytes((tx) => {
      const zero = tx.moveCall({ target: `0x2::coin::zero`, typeArguments: [`${PKG}::x::X`] });
      const [part] = tx.splitCoins(zero, [tx.pure.u64(1)]);
      tx.mergeCoins(zero, [part!]);
      tx.moveCall({ target: `${PKG}::payments::pay`, arguments: [zero] });
    });
    expect(validateTransactionKind(bytes, policy).ok).toBe(true);
  });

  it('rejects calls not on any allowlist', async () => {
    const bytes = await kindBytes((tx) => {
      tx.moveCall({ target: `${PKG}::payments::refund`, arguments: [] });
    });
    const verdict = validateTransactionKind(bytes, policy);
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/not covered/);
  });

  it('rejects cross-app target mixing even when each target is allowed somewhere', async () => {
    const bytes = await kindBytes((tx) => {
      tx.moveCall({ target: `${PKG}::payments::pay`, arguments: [] });
      tx.moveCall({ target: `${OTHER_PKG}::payments::pay`, arguments: [] });
    });
    expect(validateTransactionKind(bytes, policy).ok).toBe(false);
  });

  it('rejects TransferObjects (theft primitive)', async () => {
    const bytes = await kindBytes((tx) => {
      tx.moveCall({ target: `${PKG}::payments::pay`, arguments: [] });
      tx.transferObjects([tx.objectRef({ objectId: OBJ, version: '1', digest: DIGEST })], tx.pure.address('0x2'));
    });
    const verdict = validateTransactionKind(bytes, policy);
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/not sponsorable/);
  });

  it('rejects any reference to the sponsor gas coin, even nested', async () => {
    const bytes = await kindBytes((tx) => {
      const [stolen] = tx.splitCoins(tx.gas, [tx.pure.u64(1_000_000)]);
      tx.moveCall({ target: `${PKG}::payments::pay`, arguments: [stolen!] });
    });
    const verdict = validateTransactionKind(bytes, policy);
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/gas coin/i);
  });

  it('rejects transactions with no MoveCall at all', async () => {
    const bytes = await kindBytes((tx) => {
      tx.splitCoins(tx.objectRef({ objectId: OBJ, version: '1', digest: DIGEST }), [tx.pure.u64(1)]);
    });
    expect(validateTransactionKind(bytes, policy).ok).toBe(false);
  });

  it('rejects overlong transactions per app policy', async () => {
    const bytes = await kindBytes((tx) => {
      for (let i = 0; i < 7; i++) {
        tx.moveCall({ target: `${PKG}::payments::pay`, arguments: [] });
      }
    });
    const verdict = validateTransactionKind(bytes, policy);
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/Too many commands/);
  });

  it('rejects garbage bytes (fail closed)', () => {
    expect(validateTransactionKind(new Uint8Array([1, 2, 3]), policy).ok).toBe(false);
  });

  it('rejects FundsWithdrawal inputs even when every command is allowlisted', async () => {
    // The withdrawal input is referenced by an otherwise-valid MoveCall; a
    // commands-only scan sees only { $kind: 'Input' } and would approve it.
    const bytes = await kindBytes((tx) => {
      const w = tx.withdrawal({ amount: 1_000_000n, type: '0x2::sui::SUI' });
      tx.moveCall({ target: `${PKG}::payments::pay`, arguments: [w] });
    });
    const verdict = validateTransactionKind(bytes, policy);
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/Input kind not sponsorable/i);
  });

  it('normalizes package address forms (short vs padded)', async () => {
    const shortPkgPolicy = parsePolicyConfig(
      JSON.stringify({
        apps: [{ name: 'a', allowedTargets: ['0x2::coin::zero'], maxCommands: 3 }],
      }),
    );
    const bytes = await kindBytes((tx) => {
      tx.moveCall({
        target: `0x0000000000000000000000000000000000000000000000000000000000000002::coin::zero`,
        typeArguments: ['0x2::sui::SUI'],
      });
    });
    expect(validateTransactionKind(bytes, shortPkgPolicy).ok).toBe(true);
  });
});

describe('parsePolicyConfig', () => {
  it('rejects empty or malformed configs (fail closed)', () => {
    expect(() => parsePolicyConfig('{}')).toThrow();
    expect(() => parsePolicyConfig('{"apps": []}')).toThrow();
    expect(() =>
      parsePolicyConfig('{"apps":[{"name":"x","allowedTargets":["bad"],"maxCommands":3}]}'),
    ).toThrow(/Invalid target/);
    expect(() =>
      parsePolicyConfig(
        `{"apps":[{"name":"x","allowedTargets":["${PKG}::m::f"],"maxCommands":1000}]}`,
      ),
    ).toThrow(/maxCommands/);
  });
});

describe('validateInput', () => {
  it('allows Pure and ordinary object inputs only', () => {
    expect(validateInput({ $kind: 'Pure', Pure: { bytes: 'AA==' } })).toBeNull();
    expect(
      validateInput({ $kind: 'Object', Object: { $kind: 'ImmOrOwnedObject' } }),
    ).toBeNull();
    expect(validateInput({ $kind: 'Object', Object: { $kind: 'SharedObject' } })).toBeNull();
    expect(validateInput({ $kind: 'Object', Object: { $kind: 'Receiving' } })).toBeNull();
  });

  it('rejects withdrawal, unresolved and unknown input kinds (fail closed)', () => {
    expect(validateInput({ $kind: 'FundsWithdrawal', FundsWithdrawal: {} })).toMatch(/not sponsorable/);
    expect(validateInput({ $kind: 'UnresolvedPure', UnresolvedPure: { value: 1 } })).toMatch(/not sponsorable/);
    expect(validateInput({ $kind: 'UnresolvedObject', UnresolvedObject: {} })).toMatch(/not sponsorable/);
    expect(validateInput({ $kind: 'SomeFutureKind' })).toMatch(/not sponsorable/);
    expect(validateInput({ $kind: 'Object', Object: { $kind: 'SomethingNew' } })).toMatch(/not sponsorable/);
    expect(validateInput(null)).toMatch(/Malformed/);
    expect(validateInput('x')).toMatch(/Malformed/);
  });
});

describe('sponsorTransactionKind ordering (G2)', () => {
  const mockDeps = (policyConfig: PolicyConfig): SponsorDeps & { reserved: number[] } => {
    const state = { reserved: [] as number[] };
    return {
      client: {} as SponsorDeps['client'],
      keypair: {} as SponsorDeps['keypair'],
      sponsorAddress: '0x' + 'ee'.repeat(32),
      gasPool: {
        reserve: async () => {
          state.reserved.push(1);
          return null; // depleted -> 503 after admission
        },
        release: () => {},
      } as unknown as SponsorDeps['gasPool'],
      policy: policyConfig,
      gasBudgetMist: 50_000_000n,
      reserved: state.reserved,
    };
  };

  it('never calls admit for policy-rejected transactions', async () => {
    const deps = mockDeps(policy);
    const bytes = await kindBytes((tx) => {
      tx.moveCall({ target: `${PKG}::payments::refund`, arguments: [] });
    });
    let admitCalls = 0;
    const outcome = await sponsorTransactionKind(deps, toBase64(bytes), '0xabc', () => {
      admitCalls += 1;
      return null;
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as { status: number }).status).toBe(403);
    expect(admitCalls).toBe(0);
    expect(deps.reserved.length).toBe(0);
  });

  it('admit rejection returns 429 before any gas is reserved', async () => {
    const deps = mockDeps(policy);
    const bytes = await kindBytes((tx) => {
      tx.moveCall({ target: `${PKG}::payments::pay`, arguments: [] });
    });
    const outcome = await sponsorTransactionKind(
      deps,
      toBase64(bytes),
      '0xabc',
      () => 'Rate limit exceeded for this sender',
    );
    expect(outcome.ok).toBe(false);
    expect((outcome as { status: number }).status).toBe(429);
    expect(deps.reserved.length).toBe(0);
  });

  it('admits validated transactions, then reports depletion as 503', async () => {
    const deps = mockDeps(policy);
    const bytes = await kindBytes((tx) => {
      tx.moveCall({ target: `${PKG}::payments::pay`, arguments: [] });
    });
    let admitCalls = 0;
    const outcome = await sponsorTransactionKind(deps, toBase64(bytes), '0xabc', () => {
      admitCalls += 1;
      return null;
    });
    expect(admitCalls).toBe(1);
    expect(deps.reserved.length).toBe(1);
    expect(outcome.ok).toBe(false);
    expect((outcome as { status: number }).status).toBe(503);
  });
});

describe('containsGasCoinReference', () => {
  it('detects deeply nested GasCoin markers', () => {
    expect(containsGasCoinReference({ a: [{ b: { $kind: 'GasCoin' } }] })).toBe(true);
    expect(containsGasCoinReference({ a: [{ b: { $kind: 'Input' } }] })).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('enforces per-sender window and daily budget', () => {
    const rl = new RateLimiter({
      perSenderPerWindow: 2,
      windowMs: 60_000,
      dailyBudgetMist: 250n,
    });
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(rl.tryAdmit('0xa', 100n, t0)).toBeNull();
    expect(rl.tryAdmit('0xa', 100n, t0 + 1)).toBeNull();
    expect(rl.tryAdmit('0xa', 1n, t0 + 2)).toMatch(/Rate limit/);
    // Different sender still admitted until the daily budget runs out.
    expect(rl.tryAdmit('0xb', 50n, t0 + 3)).toBeNull();
    expect(rl.tryAdmit('0xc', 50n, t0 + 4)).toMatch(/budget/);
    // Window rolls over for sender a.
    expect(rl.tryAdmit('0xa', 0n, t0 + 61_000)).toBeNull();
    // Next UTC day resets the budget.
    expect(rl.tryAdmit('0xd', 100n, t0 + 24 * 3600_000)).toBeNull();
  });

  it('refund returns the daily budget but NOT the sender bucket slot', () => {
    const rl = new RateLimiter({
      perSenderPerWindow: 1,
      windowMs: 60_000,
      dailyBudgetMist: 100n,
    });
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(rl.tryAdmit('0xa', 100n, t0)).toBeNull();
    // Budget exhausted and sender bucket full...
    expect(rl.tryAdmit('0xb', 100n, t0 + 1)).toMatch(/budget/);
    expect(rl.tryAdmit('0xa', 0n, t0 + 2)).toMatch(/Rate limit/);
    // ...refund restores the budget for OTHER senders...
    rl.refund('0xa', 100n, t0 + 3);
    expect(rl.snapshot().dayReservedMist).toBe(0n);
    expect(rl.tryAdmit('0xb', 100n, t0 + 4)).toBeNull();
    // ...but the failing sender's rate limit still counts the attempt, so
    // repeated build-failure spam cannot bypass the per-sender bucket.
    expect(rl.tryAdmit('0xa', 0n, t0 + 5)).toMatch(/Rate limit/);
  });

  it('refund clamps at zero and never manufactures allowance', () => {
    const rl = new RateLimiter({
      perSenderPerWindow: 2,
      windowMs: 60_000,
      dailyBudgetMist: 100n,
    });
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    // Stray refund with no prior admission.
    rl.refund('0xa', 100n, t0);
    expect(rl.snapshot().dayReservedMist).toBe(0n);
    expect(rl.tryAdmit('0xa', 100n, t0 + 1)).toBeNull();
    expect(rl.tryAdmit('0xb', 100n, t0 + 2)).toMatch(/budget/);
  });
});
