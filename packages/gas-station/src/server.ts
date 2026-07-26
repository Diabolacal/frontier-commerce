/**
 * Minimal HTTP server around the sponsorship core (node:http, no framework).
 *
 * Endpoints:
 *   POST /sponsor  { txKindB64, sender, timestamp } -> { txB64, sponsorSignature }
 *   GET  /health   -> sponsor address, SUI balance, pool/limiter snapshots
 *
 * Request gauntlet (every check fail-closed, generic client errors):
 *   kill switch -> CORS/origin -> bearer auth (optional) -> body size cap ->
 *   JSON shape -> sender format -> deny list -> timestamp freshness ->
 *   per-IP bucket -> policy validation -> rate limits/daily budget ->
 *   gas reservation -> build + co-sign.
 *
 * Ordering note (security review G2): the sender-keyed limits and the
 *   global daily budget are charged only AFTER policy validation passes,
 *   and refunded when the sponsor itself fails afterwards (pool depleted /
 *   build error - nothing signed). Junk requests therefore cannot drain
 *   the daily budget (the per-sender bucket slot is deliberately NOT
 *   refunded - failed attempts keep counting against the sender). The
 *   cheap per-IP bucket runs BEFORE validation as CPU-exhaustion
 *   protection; behind a reverse proxy set TRUST_PROXY=true or ALL
 *   clients share the proxy's single bucket (see ServerEnv.TRUST_PROXY).
 *
 * Secrets arrive ONLY via environment (SPONSOR_PRIVATE_KEY). The same core
 * (sponsor.ts/policy.ts) can be wrapped by a Cloudflare Worker fetch handler
 * instead of this server; see docs/integration-guide.md.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { GasPool } from './gasPool.js';
import { RateLimiter } from './limits.js';
import { parsePolicyConfig } from './policy.js';
import { defaultFaucetHost, isFaucetNetwork, TestnetSelfCare } from './selfcare.js';
import { sponsorTransactionKind, type SponsorDeps } from './sponsor.js';

const MAX_BODY_BYTES = 128 * 1024;
const MAX_REQUEST_AGE_MS = 60_000;

export interface ServerEnv {
  SPONSOR_ENABLED?: string;
  SPONSOR_PRIVATE_KEY?: string;
  SPONSOR_API_KEY?: string;
  /** gRPC(-web) fullnode endpoint (NOT JSON-RPC — removed from Sui 2026-07-31). */
  SUI_RPC_URL?: string;
  /** Sui network name for the gRPC client (default: testnet). */
  SUI_NETWORK?: string;
  APP_POLICIES?: string;
  GAS_BUDGET_MIST?: string;
  ALLOWED_ORIGINS?: string;
  ALLOWED_ORIGIN_SUFFIXES?: string;
  BLOCKED_SENDERS?: string;
  RATE_PER_SENDER_PER_MINUTE?: string;
  RATE_PER_IP_PER_MINUTE?: string;
  /**
   * Set to exactly "true" ONLY when a trusted reverse proxy terminates
   * client connections: the per-IP limiter then keys on the first
   * X-Forwarded-For hop instead of the socket address. Without this, all
   * proxied traffic shares the proxy's IP - one bucket for everyone, so a
   * single spammer exhausts it and 429s every legitimate user. Never
   * enable on a directly exposed station (the header is client-spoofable).
   */
  TRUST_PROXY?: string;
  DAILY_BUDGET_SUI?: string;
  LOW_BALANCE_THRESHOLD_SUI?: string;
  PORT?: string;
  /**
   * Self-care (see selfcare.ts). Both halves are OPT-IN and off by default.
   * `TESTNET_AUTO_REFILL=true` asks the network faucet when the float runs
   * low; it is inert off a faucet network (never on mainnet).
   * `GAS_POOL_TARGET_COINS>0` keeps that many independently usable gas
   * coins so concurrent sponsorships do not collapse to one in-flight.
   */
  TESTNET_AUTO_REFILL?: string;
  REFILL_THRESHOLD_SUI?: string;
  /**
   * Stop line for a refill campaign (hysteresis): refilling starts when the
   * balance dips below REFILL_THRESHOLD_SUI and keeps going (one faucet
   * request per cooldown window) until it reaches this. Unset = threshold,
   * i.e. the historical stop-at-threshold behaviour.
   */
  REFILL_TARGET_SUI?: string;
  FAUCET_HOST?: string;
  REFILL_COOLDOWN_MINUTES?: string;
  REFILL_MAX_BACKOFF_MINUTES?: string;
  GAS_POOL_TARGET_COINS?: string;
  GAS_POOL_COIN_MIST?: string;
  GAS_POOL_RESERVE_MIST?: string;
  GAS_POOL_MAX_SPLITS_PER_TX?: string;
  SELF_CARE_INTERVAL_SECONDS?: string;
}

interface AuditEntry {
  at: string;
  event: 'approved' | 'rejected' | 'error' | 'depleted';
  sender?: string;
  app?: string;
  reason?: string;
}

/**
 * In-memory lifetime counters over the audit stream, surfaced on /health so
 * an operator dashboard can chart approval/rejection/error rates without
 * scraping stdout. Same single-instance posture as RateLimiter: counters
 * reset on restart, which consumers detect via `startedAt` changing.
 */
const auditCounts = { approved: 0, rejected: 0, depleted: 0, error: 0 };
const startedAt = new Date().toISOString();

function audit(entry: AuditEntry): void {
  auditCounts[entry.event] += 1;
  console.log(JSON.stringify({ audit: entry }));
}

function json(res: ServerResponse, status: number, body: unknown, cors: string | null): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(cors ? { 'access-control-allow-origin': cors } : {}),
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function originAllowed(origin: string | undefined, env: ServerEnv): string | null {
  if (!origin) return null; // non-browser callers: no CORS header needed
  const exact = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (exact.includes(origin)) return origin;
  const suffixes = (env.ALLOWED_ORIGIN_SUFFIXES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:' && suffixes.some((s) => url.hostname.endsWith(s))) {
      return origin;
    }
  } catch {
    return null;
  }
  return null;
}

/** Client key for the per-IP bucket. See ServerEnv.TRUST_PROXY. */
function clientIpKey(req: IncomingMessage, env: ServerEnv): string {
  if (env.TRUST_PROXY === 'true') {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse a decimal-SUI env var into MIST. */
function suiToMist(raw: string | undefined, fallbackSui: number): bigint {
  const n = Number(raw ?? fallbackSui);
  return BigInt(Math.round((Number.isFinite(n) ? n : fallbackSui) * 1e9));
}

export function buildDeps(
  env: ServerEnv,
): SponsorDeps & { limiter: RateLimiter; ipLimiter: RateLimiter; selfCare: TestnetSelfCare } {
  if (env.SPONSOR_ENABLED !== 'true') {
    throw new Error('SPONSOR_ENABLED must be exactly "true" (kill switch is fail-closed)');
  }
  if (!env.SPONSOR_PRIVATE_KEY) throw new Error('SPONSOR_PRIVATE_KEY is required');
  if (!env.APP_POLICIES) throw new Error('APP_POLICIES is required (fail-closed)');
  const policy = parsePolicyConfig(env.APP_POLICIES);
  const { secretKey } = decodeSuiPrivateKey(env.SPONSOR_PRIVATE_KEY);
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  const sponsorAddress = keypair.getPublicKey().toSuiAddress();
  // gRPC(-web) fullnode endpoint. JSON-RPC was removed from Sui nodes at
  // protocol level (2026-07-31); SUI_RPC_URL must be a gRPC endpoint such as
  // https://fullnode.testnet.sui.io:443. Every downstream call already goes
  // through client.core.* (ClientWithCoreApi), so only construction changes.
  const network = env.SUI_NETWORK ?? 'testnet';
  const client = new SuiGrpcClient({
    baseUrl: env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443',
    network: network as 'testnet' | 'devnet' | 'localnet',
  });
  const gasBudgetMist = BigInt(env.GAS_BUDGET_MIST ?? '50000000'); // 0.05 SUI
  const gasPool = new GasPool(client, sponsorAddress, {
    ttlMs: 30_000,
    minCoinBalanceMist: gasBudgetMist,
  });
  const limiter = new RateLimiter({
    perSenderPerWindow: Number(env.RATE_PER_SENDER_PER_MINUTE ?? '6'),
    windowMs: 60_000,
    dailyBudgetMist: BigInt(Math.round(Number(env.DAILY_BUDGET_SUI ?? '5') * 1e9)),
  });
  // Pre-validation flood control keyed on the client socket address; charges
  // nothing against the daily budget (budgetMist 0).
  const ipLimiter = new RateLimiter({
    perSenderPerWindow: Number(env.RATE_PER_IP_PER_MINUTE ?? '30'),
    windowMs: 60_000,
    dailyBudgetMist: 1n << 62n,
  });
  const refillThresholdMist = suiToMist(env.REFILL_THRESHOLD_SUI, 2);
  const refillTargetMist = env.REFILL_TARGET_SUI
    ? suiToMist(env.REFILL_TARGET_SUI, 0)
    : refillThresholdMist;
  const selfCare = new TestnetSelfCare({
    client,
    keypair,
    sponsorAddress,
    gasPool,
    opts: {
      network,
      autoRefill: env.TESTNET_AUTO_REFILL === 'true',
      refillThresholdMist,
      refillTargetMist,
      faucetHost:
        env.FAUCET_HOST ??
        (isFaucetNetwork(network) ? defaultFaucetHost(network) : ''),
      refillCooldownMs: Number(env.REFILL_COOLDOWN_MINUTES ?? '30') * 60_000,
      refillMaxBackoffMs: Number(env.REFILL_MAX_BACKOFF_MINUTES ?? '360') * 60_000,
      poolTargetCoins: Number(env.GAS_POOL_TARGET_COINS ?? '0'),
      minCoinBalanceMist: gasBudgetMist,
      splitCoinMist: BigInt(env.GAS_POOL_COIN_MIST ?? (gasBudgetMist * 2n).toString()),
      splitGasBudgetMist: gasBudgetMist,
      parentReserveMist: BigInt(env.GAS_POOL_RESERVE_MIST ?? (gasBudgetMist * 2n).toString()),
      maxSplitsPerTx: Number(env.GAS_POOL_MAX_SPLITS_PER_TX ?? '20'),
      intervalMs: Number(env.SELF_CARE_INTERVAL_SECONDS ?? '300') * 1000,
    },
  });
  return {
    client,
    keypair,
    sponsorAddress,
    gasPool,
    policy,
    gasBudgetMist,
    limiter,
    ipLimiter,
    selfCare,
  };
}

export function startServer(env: ServerEnv = process.env as ServerEnv): ReturnType<
  typeof createServer
> {
  const deps = buildDeps(env);
  const blocked = new Set(
    (env.BLOCKED_SENDERS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cors = originAllowed(req.headers.origin, env);
    if (req.headers.origin && !cors) {
      json(res, 403, { error: 'Origin not allowed' }, null);
      return;
    }
    if (req.method === 'OPTIONS') {
      json(res, 204, {}, cors);
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      try {
        const { balance } = await deps.client.core.getBalance({
          owner: deps.sponsorAddress,
        });
        const balanceMist = BigInt(balance.balance);
        const low =
          balanceMist < BigInt(Math.round(Number(env.LOW_BALANCE_THRESHOLD_SUI ?? '2') * 1e9));
        // Coin COUNT is the real concurrency ceiling (one distinct coin per
        // in-flight sponsorship), so it belongs next to the balance. Cached
        // for 30 s so a frequently polled /health costs no extra RPC.
        const inventory = await deps.gasPool.inventory(30_000).catch(() => null);
        json(
          res,
          200,
          {
            sponsorAddress: deps.sponsorAddress,
            balanceMist: balanceMist.toString(),
            lowBalance: low,
            pool: {
              ...deps.gasPool.snapshot(),
              coins: inventory?.totalCoins ?? null,
              usableCoins: inventory?.usableCoins ?? null,
              largestCoinMist: inventory?.largestCoinMist.toString() ?? null,
            },
            selfCare: deps.selfCare.snapshot(),
            limiter: {
              daySpendMist: deps.limiter.snapshot().daySpendMist.toString(),
              trackedSenders: deps.limiter.snapshot().trackedSenders,
              dailyBudgetMist: deps.limiter.snapshot().dailyBudgetMist.toString(),
            },
            stats: { ...auditCounts, startedAt },
            config: {
              gasBudgetMist: deps.gasBudgetMist.toString(),
              lowBalanceThresholdMist: BigInt(
                Math.round(Number(env.LOW_BALANCE_THRESHOLD_SUI ?? '2') * 1e9),
              ).toString(),
            },
          },
          cors,
        );
      } catch (e) {
        audit({ at: new Date().toISOString(), event: 'error', reason: (e as Error).message });
        json(res, 500, { error: 'health check failed' }, cors);
      }
      return;
    }

    if (req.method !== 'POST' || req.url !== '/sponsor') {
      json(res, 404, { error: 'Not found' }, cors);
      return;
    }

    if (env.SPONSOR_API_KEY) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${env.SPONSOR_API_KEY}`) {
        json(res, 401, { error: 'Unauthorized' }, cors);
        return;
      }
    }

    const bodyText = await readBody(req);
    if (bodyText === null) {
      json(res, 413, { error: 'Body too large' }, cors);
      return;
    }
    let body: { txKindB64?: unknown; sender?: unknown; timestamp?: unknown };
    try {
      body = JSON.parse(bodyText) as typeof body;
    } catch {
      json(res, 400, { error: 'Invalid JSON' }, cors);
      return;
    }
    const { txKindB64, sender, timestamp } = body;
    if (typeof txKindB64 !== 'string' || typeof sender !== 'string') {
      json(res, 400, { error: 'txKindB64 and sender are required' }, cors);
      return;
    }
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(sender)) {
      json(res, 400, { error: 'Invalid sender' }, cors);
      return;
    }
    if (blocked.has(sender.toLowerCase())) {
      audit({ at: new Date().toISOString(), event: 'rejected', sender, reason: 'deny-list' });
      json(res, 403, { error: 'Sender not allowed' }, cors);
      return;
    }
    if (typeof timestamp !== 'number' || Math.abs(Date.now() - timestamp) > MAX_REQUEST_AGE_MS) {
      json(res, 400, { error: 'Stale or missing timestamp' }, cors);
      return;
    }

    // Cheap pre-validation flood control (never charges budget).
    const ip = clientIpKey(req, env);
    const ipLimited = deps.ipLimiter.tryAdmit(ip, 0n);
    if (ipLimited) {
      audit({ at: new Date().toISOString(), event: 'rejected', sender, reason: 'ip-rate-limit' });
      json(res, 429, { error: 'Rate limit exceeded' }, cors);
      return;
    }

    // Sender/budget accounting is charged inside the sponsor core, strictly
    // AFTER policy validation (G2) - and returned if the sponsor itself
    // fails afterwards without signing anything.
    let admitted = false;
    const admit = (): string | null => {
      const limited = deps.limiter.tryAdmit(sender, deps.gasBudgetMist);
      if (!limited) admitted = true;
      return limited;
    };

    try {
      const outcome = await sponsorTransactionKind(deps, txKindB64, sender, admit);
      if (!outcome.ok) {
        if (admitted && outcome.status >= 500) {
          deps.limiter.refund(sender, deps.gasBudgetMist);
        }
        audit({
          at: new Date().toISOString(),
          event: outcome.status === 503 ? 'depleted' : 'rejected',
          sender,
          reason: outcome.reason,
        });
        json(res, outcome.status, { error: outcome.reason }, cors);
        return;
      }
      audit({
        at: new Date().toISOString(),
        event: 'approved',
        sender,
        app: outcome.appName,
      });
      json(res, 200, { txB64: outcome.txB64, sponsorSignature: outcome.sponsorSignature }, cors);
    } catch (e) {
      if (admitted) {
        deps.limiter.refund(sender, deps.gasBudgetMist);
      }
      audit({ at: new Date().toISOString(), event: 'error', sender, reason: (e as Error).message });
      json(res, 500, { error: 'Internal error' }, cors);
    }
  }

  // Maintenance loop (faucet refill / gas-coin pool). No-op unless opted in;
  // stopped with the server so tests and shutdowns leave no timer behind.
  deps.selfCare.start();
  server.on('close', () => deps.selfCare.stop());

  const port = Number(env.PORT ?? '8787');
  server.listen(port, () => {
    console.log(
      JSON.stringify({
        started: { port, sponsorAddress: deps.sponsorAddress },
      }),
    );
  });
  return server;
}

// Direct execution: `node dist/server.js`
if (process.argv[1] && /server\.(js|ts)$/.test(process.argv[1])) {
  startServer();
}
