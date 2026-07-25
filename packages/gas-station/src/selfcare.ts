/**
 * Testnet self-care: keep a long-running gas station funded and CONCURRENT
 * without an operator babysitting it.
 *
 * Two failure modes this fixes, both observed on a live testnet station:
 *
 * 1. **Float runs dry.** The station stops sponsoring when the sponsor
 *    balance drops under the gas budget, and someone has to notice. On a
 *    faucet network that is pure toil: ask the faucet.
 *
 * 2. **Concurrency collapses to one.** `GasPool` pins each in-flight
 *    sponsorship to a DISTINCT coin object, so the real concurrency ceiling
 *    is "number of sponsor coins >= GAS_BUDGET_MIST". A freshly funded
 *    address owns exactly ONE coin, so the second simultaneous request gets
 *    503 "Sponsor gas pool depleted" even though the balance is healthy.
 *    Splitting the float into N coins is the fix, and it needs the sponsor
 *    key - which only ever exists inside this process. Hence a maintenance
 *    loop here rather than an external script: the key never leaves.
 *
 * Posture:
 * - OPT-IN. Both halves are off unless explicitly configured
 *   (`TESTNET_AUTO_REFILL`, `GAS_POOL_TARGET_COINS`).
 * - Faucet refill is HARD-DISABLED off faucet networks. `mainnet` has no
 *   faucet and never will; the guard is a `switch` on the network name, not
 *   a URL check, so a mis-set FAUCET_HOST cannot re-enable it.
 * - Splitting reserves its parent coin THROUGH the same GasPool, so
 *   maintenance and live sponsorships can never pick the same object
 *   (equivocation = the sponsor address is locked for an epoch).
 * - Every attempt is recorded in `snapshot()` for /health: last attempt,
 *   last result, next eligible time. Faucet refusals (rate limit,
 *   datacenter-IP blocks) are normal and must never crash the station.
 *
 * IN-MEMORY, SINGLE-INSTANCE, same posture as limits.ts. Two stations
 * sharing one sponsor address would both try to split; the pool reservation
 * is process-local, so don't do that (documented in the integration guide).
 */
import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import type { GasPool, GasPoolInventory } from './gasPool.js';

/** Networks that have a public faucet. `mainnet` is deliberately absent. */
export const FAUCET_NETWORKS = ['testnet', 'devnet', 'localnet'] as const;
export type FaucetNetwork = (typeof FAUCET_NETWORKS)[number];

export function isFaucetNetwork(network: string): network is FaucetNetwork {
  return (FAUCET_NETWORKS as readonly string[]).includes(network);
}

export function defaultFaucetHost(network: FaucetNetwork): string {
  switch (network) {
    case 'testnet':
      return 'https://faucet.testnet.sui.io';
    case 'devnet':
      return 'https://faucet.devnet.sui.io';
    case 'localnet':
      return 'http://127.0.0.1:9123';
  }
}

export interface SelfCareOptions {
  /** Network name the station is pointed at. Gates the faucet half. */
  network: string;
  /** Ask the faucet when the balance falls below `refillThresholdMist`. */
  autoRefill: boolean;
  refillThresholdMist: bigint;
  /** Faucet base URL; `/v2/gas` is appended. */
  faucetHost: string;
  /** Minimum gap between faucet requests after a SUCCESS. */
  refillCooldownMs: number;
  /** Cap for the exponential backoff applied after faucet refusals. */
  refillMaxBackoffMs: number;
  /** Desired number of independently usable gas coins (0 = maintenance off). */
  poolTargetCoins: number;
  /** A coin must hold at least this to back a sponsorship. */
  minCoinBalanceMist: bigint;
  /** Balance given to each coin the maintenance loop mints. */
  splitCoinMist: bigint;
  /** Gas budget for the split transaction itself. */
  splitGasBudgetMist: bigint;
  /** Never split the parent coin below this remainder. */
  parentReserveMist: bigint;
  /** Cap on coins minted per split transaction (PTB size sanity). */
  maxSplitsPerTx: number;
  /** How often the loop runs. */
  intervalMs: number;
}

export interface SelfCareSnapshot {
  enabled: boolean;
  network: string;
  autoRefill: boolean;
  poolTargetCoins: number;
  lastRunAt: string | null;
  lastError: string | null;
  coins: number | null;
  usableCoins: number | null;
  refill: {
    attempts: number;
    successes: number;
    consecutiveFailures: number;
    lastAttemptAt: string | null;
    lastResult: string | null;
    nextEligibleAt: string | null;
  };
  split: {
    attempts: number;
    coinsCreated: number;
    lastAttemptAt: string | null;
    lastResult: string | null;
  };
}

export interface FaucetResult {
  ok: boolean;
  detail: string;
}

/**
 * Default faucet client: the public `/v2/gas` contract used by every Sui
 * faucet. Injectable so tests never touch the network.
 */
export async function requestFaucet(host: string, recipient: string): Promise<FaucetResult> {
  const res = await fetch(`${host.replace(/\/+$/, '')}/v2/gas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ FixedAmountRequest: { recipient } }),
  });
  const text = (await res.text()).slice(0, 300);
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${text}` };
  // The v2 faucet answers 200 with {"status":"Success"} or
  // {"status":{"Failure":{...}}} - a 200 is NOT proof of funding.
  if (/"status"\s*:\s*"Success"/.test(text)) return { ok: true, detail: `HTTP 200: ${text}` };
  return { ok: false, detail: `HTTP ${res.status}: ${text}` };
}

export interface SelfCareDeps {
  client: ClientWithCoreApi;
  keypair: Ed25519Keypair;
  sponsorAddress: string;
  gasPool: GasPool;
  opts: SelfCareOptions;
  /** Override for tests. */
  faucet?: (host: string, recipient: string) => Promise<FaucetResult>;
  /** Override for tests. */
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

export class TestnetSelfCare {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;
  private inventory: GasPoolInventory | null = null;

  private refillAttempts = 0;
  private refillSuccesses = 0;
  private refillFailures = 0; // consecutive
  private refillLastAttemptAt: number | null = null;
  private refillLastResult: string | null = null;
  private refillNextEligibleAt: number | null = null;

  private splitAttempts = 0;
  private splitCoinsCreated = 0;
  private splitLastAttemptAt: number | null = null;
  private splitLastResult: string | null = null;

  private readonly faucet: (host: string, recipient: string) => Promise<FaucetResult>;
  private readonly now: () => number;
  private readonly log: (line: Record<string, unknown>) => void;

  constructor(private readonly deps: SelfCareDeps) {
    this.faucet = deps.faucet ?? requestFaucet;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((line) => console.log(JSON.stringify({ selfCare: line })));
  }

  /** Faucet half is only ever armed on a network that HAS a faucet. */
  get refillArmed(): boolean {
    return this.deps.opts.autoRefill && isFaucetNetwork(this.deps.opts.network);
  }

  get maintenanceArmed(): boolean {
    return this.deps.opts.poolTargetCoins > 0;
  }

  get enabled(): boolean {
    return this.refillArmed || this.maintenanceArmed;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.log({
      started: {
        network: this.deps.opts.network,
        autoRefill: this.refillArmed,
        poolTargetCoins: this.deps.opts.poolTargetCoins,
        intervalMs: this.deps.opts.intervalMs,
      },
    });
    this.timer = setInterval(() => void this.runOnce(), this.deps.opts.intervalMs);
    // Never hold the process open for maintenance.
    this.timer.unref?.();
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One maintenance pass. Never throws: the station must keep serving even
   * when the fullnode or the faucet is unhappy.
   */
  async runOnce(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const inv = await this.deps.gasPool.inventory();
      this.inventory = inv;
      if (this.refillArmed) await this.maybeRefill(inv);
      if (this.maintenanceArmed) await this.maybeSplit(inv);
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.log({ error: this.lastError });
    } finally {
      this.lastRunAt = this.now();
      this.running = false;
    }
  }

  private async maybeRefill(inv: GasPoolInventory): Promise<void> {
    const now = this.now();
    if (inv.totalBalanceMist >= this.deps.opts.refillThresholdMist) return;
    if (this.refillNextEligibleAt !== null && now < this.refillNextEligibleAt) return;

    this.refillAttempts += 1;
    this.refillLastAttemptAt = now;
    let result: FaucetResult;
    try {
      result = await this.faucet(this.deps.opts.faucetHost, this.deps.sponsorAddress);
    } catch (e) {
      result = { ok: false, detail: `request failed: ${(e as Error).message}` };
    }
    this.refillLastResult = result.detail;
    if (result.ok) {
      this.refillSuccesses += 1;
      this.refillFailures = 0;
      this.refillNextEligibleAt = now + this.deps.opts.refillCooldownMs;
    } else {
      // Refusals are expected (rate limits, datacenter-IP blocks). Back off
      // so a hostile faucet cannot turn into a request loop.
      this.refillFailures += 1;
      const backoff = Math.min(
        this.deps.opts.refillCooldownMs * 2 ** Math.min(this.refillFailures, 10),
        this.deps.opts.refillMaxBackoffMs,
      );
      this.refillNextEligibleAt = now + backoff;
    }
    this.log({
      refill: {
        balanceMist: inv.totalBalanceMist.toString(),
        thresholdMist: this.deps.opts.refillThresholdMist.toString(),
        ok: result.ok,
        detail: result.detail,
        nextEligibleAt: new Date(this.refillNextEligibleAt).toISOString(),
      },
    });
  }

  /** How many coins one split transaction should mint, given the parent. */
  planSplit(parentBalanceMist: bigint, usableCoins: number): number {
    const need = this.deps.opts.poolTargetCoins - usableCoins;
    if (need <= 0) return 0;
    const spendable =
      parentBalanceMist - this.deps.opts.splitGasBudgetMist - this.deps.opts.parentReserveMist;
    if (spendable <= 0n) return 0;
    const affordable = Number(spendable / this.deps.opts.splitCoinMist);
    return Math.max(0, Math.min(need, affordable, this.deps.opts.maxSplitsPerTx));
  }

  private async maybeSplit(inv: GasPoolInventory): Promise<void> {
    if (inv.usableCoins >= this.deps.opts.poolTargetCoins) return;
    const { opts } = this.deps;

    // The parent must cover its own gas, at least one new coin, and the
    // reserve we promised to leave behind.
    const minParent = opts.splitGasBudgetMist + opts.splitCoinMist + opts.parentReserveMist;
    // Hold the parent for a full on-chain round trip, well past the
    // sponsorship TTL, so nothing else touches it mid-flight.
    const parent = await this.deps.gasPool.reserveLargest(minParent, 120_000);
    if (!parent) {
      this.splitLastResult = 'no coin large enough to split';
      return;
    }

    const count = this.planSplit(parent.balanceMist, inv.usableCoins);
    if (count <= 0) {
      this.deps.gasPool.release(parent.objectId);
      this.splitLastResult = 'insufficient balance to split';
      return;
    }

    this.splitAttempts += 1;
    this.splitLastAttemptAt = this.now();
    try {
      const tx = new Transaction();
      tx.setSender(this.deps.sponsorAddress);
      tx.setGasOwner(this.deps.sponsorAddress);
      tx.setGasPayment([
        { objectId: parent.objectId, version: parent.version, digest: parent.digest },
      ]);
      tx.setGasBudget(opts.splitGasBudgetMist);
      // Splitting off `tx.gas` uses the parent coin itself as the source;
      // the remainder (minus actual gas) stays in the parent object.
      const amounts = Array.from({ length: count }, () => tx.pure.u64(opts.splitCoinMist));
      const results = tx.splitCoins(tx.gas, amounts);
      tx.transferObjects(
        amounts.map((_, i) => results[i]!),
        tx.pure.address(this.deps.sponsorAddress),
      );
      const bytes = await tx.build({ client: this.deps.client });
      const { signature } = await this.deps.keypair.signTransaction(bytes);
      const res = await this.deps.client.core.executeTransaction({
        transaction: bytes,
        signatures: [signature],
      });
      if (res.$kind === 'FailedTransaction') {
        this.splitLastResult = `split failed: ${res.FailedTransaction.digest}`;
      } else {
        const digest = res.Transaction.digest;
        await this.deps.client.core.waitForTransaction({ digest }).catch(() => undefined);
        this.splitCoinsCreated += count;
        this.splitLastResult = `minted ${count} coin(s), digest ${digest}`;
      }
    } catch (e) {
      this.splitLastResult = `split error: ${(e as Error).message}`;
    } finally {
      this.deps.gasPool.release(parent.objectId);
    }
    this.log({
      split: {
        requested: count,
        usableCoinsBefore: inv.usableCoins,
        targetCoins: opts.poolTargetCoins,
        result: this.splitLastResult,
      },
    });
  }

  snapshot(): SelfCareSnapshot {
    const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());
    return {
      enabled: this.enabled,
      network: this.deps.opts.network,
      autoRefill: this.refillArmed,
      poolTargetCoins: this.deps.opts.poolTargetCoins,
      lastRunAt: iso(this.lastRunAt),
      lastError: this.lastError,
      coins: this.inventory?.totalCoins ?? null,
      usableCoins: this.inventory?.usableCoins ?? null,
      refill: {
        attempts: this.refillAttempts,
        successes: this.refillSuccesses,
        consecutiveFailures: this.refillFailures,
        lastAttemptAt: iso(this.refillLastAttemptAt),
        lastResult: this.refillLastResult,
        nextEligibleAt: iso(this.refillNextEligibleAt),
      },
      split: {
        attempts: this.splitAttempts,
        coinsCreated: this.splitCoinsCreated,
        lastAttemptAt: iso(this.splitLastAttemptAt),
        lastResult: this.splitLastResult,
      },
    };
  }
}
