// ---- Frontier Commerce observability collector ----
//
// One loop, four read-only jobs, all feeding Postgres so the Grafana
// "Frontier Commerce Operator" dashboard (uid frontier-commerce-operator)
// can query everything through one Postgres datasource:
//
//   1. poll   (every POLL_INTERVAL_SECONDS, default 60):
//        - runs the CANONICAL @frontier-commerce/indexer pollOnce() into the
//          SQLite ledger at LEDGER_PATH,
//        - mirrors new raw_events rows into <schema>.raw_events,
//        - updates <schema>.poller_status (freshness / cursor / errors),
//        - snapshots the gas sponsor's /health into <schema>.sponsor_health
//          (only when SPONSOR_HEALTH_URL is set - the station is optional),
//        - enriches payment transactions with their gas payer (tx_gas).
//   2. recon  (every RECON_INTERVAL_SECONDS, default 600):
//        - event-derived expectedTreasury vs on-chain treasury_value /
//          fees_accrued_value (<schema>.treasury_recon),
//        - registry/merchant pause state + product catalog state on-chain
//          (<schema>.chain_status / <schema>.product_status).
//
// ALL merchant-scoped tables are keyed by merchant_id: one deployment can host
// several merchants on the same package/registry (e.g. subscriptions on one,
// in-game consumables on another), and product ids restart at 1 per merchant.
// Every configured merchant is reconciled; nothing is attributed to "the"
// merchant. See MERCHANTS below for how they are discovered.
//
// Truth layering (deliberate): raw_events/payments/entitlements = INDEXED
// truth; treasury_recon.onchain_*, chain_status, product_status = ON-CHAIN
// truth sampled at ts; sponsor_health = RUNTIME health. The dashboard keeps
// these apart so disagreement is visible instead of hidden.
//
// If you already run your own indexer elsewhere, this collector is an
// optional projection for Grafana - the SQLite ledger it maintains is a
// full indexer ledger, but nothing requires it to be your only one
// (re-polling is idempotent; a fresh ledger rebuilds from genesis).
//
// Read-only by construction: no keys, no signing, no chain mutations. The
// only credential is the Postgres password (env/secret store, never in git).

import { readFileSync } from 'node:fs';
import { openLedger, pollOnce, buildMerchantLedgers, expectedTreasury } from '@frontier-commerce/indexer';
import {
  parseDeployment,
  getTreasuryValue,
  getFeesAccruedValue,
  getMerchantSummary,
  getRegistrySummary,
  getProductInfo,
} from '@frontier-commerce/sdk';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { ChannelCredentials } from '@grpc/grpc-js';
import pg from 'pg';

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

/**
 * SUI_GRPC_URL -> `host:port` for @grpc/grpc-js, and the TLS decision.
 *
 * Deliberately duplicated from packages/gas-station/src/server.ts rather than
 * shared: this collector is plain .mjs with no build step and cannot import
 * that package's TypeScript source. Keep the two in step — the fail-safe rule
 * is the load-bearing part: only an explicit http:// or grpc:// scheme selects
 * plaintext, so a typo degrades to a refused connection rather than a silently
 * unencrypted link to a public fullnode.
 */
const isPlaintextGrpcUrl = (raw) => /^(http|grpc):\/\//i.test(String(raw).trim());
function grpcHostFromUrl(raw) {
  const value = String(raw).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return /:\d+$/.test(value) ? value : `${value}:443`;
  }
  const url = new URL(value);
  return `${url.hostname}:${url.port || (isPlaintextGrpcUrl(value) ? '80' : '443')}`;
}

const LEDGER_PATH = env('LEDGER_PATH', '/data/ledger.sqlite');
const DEPLOYMENT_PATH = env('DEPLOYMENT_PATH', '/app/deployment.json');
const SUI_GRAPHQL_URL = env('SUI_GRAPHQL_URL', 'https://graphql.testnet.sui.io/graphql');
const SUI_GRPC_URL = env('SUI_GRPC_URL', 'https://fullnode.testnet.sui.io:443');
const SPONSOR_HEALTH_URL = env('SPONSOR_HEALTH_URL', null); // optional - unset = no gas station
const POLL_INTERVAL_MS = Number(env('POLL_INTERVAL_SECONDS', '60')) * 1000;
const RECON_INTERVAL_MS = Number(env('RECON_INTERVAL_SECONDS', '600')) * 1000;
const GAS_ENRICH_BATCH = Number(env('GAS_ENRICH_BATCH', '20'));

// Postgres schema name (identifier, not a value - validated then inlined).
const S = env('PG_SCHEMA', 'frontier_commerce');
if (!/^[a-z_][a-z0-9_]*$/.test(S)) throw new Error(`PG_SCHEMA must be a plain identifier, got: ${S}`);

const deploymentJson = JSON.parse(readFileSync(DEPLOYMENT_PATH, 'utf8'));
const deployment = parseDeployment(JSON.stringify(deploymentJson));

// ------------------------------------------------------------- merchants ----
// Every object under `evidence` that carries a `merchantId` string is a
// merchant of this deployment: `evidence.merchant` (the shape
// examples/demo-consumer/src/deploy-testnet.ts writes) plus any further
// merchants an operator script records alongside it. Its `products` map (slug
// -> { productId, entitlementKey, coinType }) drives per-product sampling, so
// products are always read under the merchant that owns them.
function discoverMerchants(json) {
  const found = new Map();
  for (const [key, val] of Object.entries(json.evidence ?? {})) {
    if (!val || typeof val !== 'object' || typeof val.merchantId !== 'string') continue;
    found.set(val.merchantId, {
      merchantId: val.merchantId,
      key,
      name: typeof val.merchantName === 'string' ? val.merchantName : null,
      products: val.products ?? {},
    });
  }
  return found;
}

const descriptorMerchants = discoverMerchants(deploymentJson);
// MERCHANT_IDS (comma-separated) or legacy MERCHANT_ID override discovery;
// descriptor metadata is still used for any id that matches.
const configuredIds = env('MERCHANT_IDS', env('MERCHANT_ID', ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MERCHANTS = (configuredIds.length ? configuredIds : [...descriptorMerchants.keys()]).map(
  (id) => descriptorMerchants.get(id) ?? { merchantId: id, key: null, name: null, products: {} },
);
if (MERCHANTS.length === 0) {
  throw new Error(
    'No merchants configured: set MERCHANT_IDS (comma-separated) or record evidence.<name>.merchantId in the deployment descriptor',
  );
}

const ledger = openLedger(LEDGER_PATH);
// NATIVE gRPC over HTTP/2, not gRPC-web — SuiGrpcClient's default transport is
// GrpcWebFetchTransport, and on 2026-07-28 the Sui testnet/devnet fullnodes
// stopped serving gRPC-web as part of the JSON-RPC shutdown. Every registry and
// merchant read failed with `unexpected response content type: application/json`
// and the treasury reconciliation dashboard went to "no data". Same fix, and
// same reason, as the gas station.
const grpc = new SuiGrpcClient({
  transport: new GrpcTransport({
    host: grpcHostFromUrl(SUI_GRPC_URL),
    channelCredentials: isPlaintextGrpcUrl(SUI_GRPC_URL)
      ? ChannelCredentials.createInsecure()
      : ChannelCredentials.createSsl(),
  }),
  network: deployment.network,
});
const pool = new pg.Pool({
  host: env('PGHOST', 'postgres'),
  port: Number(env('PGPORT', '5432')),
  database: env('PGDATABASE', 'postgres'),
  user: env('PGUSER', 'postgres'),
  password: process.env.PGPASSWORD,
  max: 3,
});

const log = (msg, extra) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...(extra ?? {}) }));

// ---------------------------------------------------------------- schema ----
const DDL = `
CREATE SCHEMA IF NOT EXISTS ${S};

-- Migration to per-merchant keys. chain_status and product_status used to be
-- single-merchant snapshots (chain_status pinned to id = 1, product_status
-- keyed by product_id alone - which COLLIDES as soon as a second merchant
-- exists, because product ids restart at 1 per merchant). Both tables are
-- caches of on-chain state, fully re-derived on the next recon cycle, so the
-- old rows are moved aside rather than rewritten: nothing is deleted, no
-- merchant attribution has to be guessed, and the *_pre_multimerchant tables
-- can be dropped by hand once you have looked at them.
DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = '${S}' AND table_name = 'chain_status')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = '${S}' AND table_name = 'chain_status'
                AND column_name = 'merchant_id') THEN
    RAISE NOTICE 'migrating ${S}.chain_status to one row per merchant';
    ALTER TABLE ${S}.chain_status RENAME TO chain_status_pre_multimerchant;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = '${S}' AND table_name = 'product_status')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = '${S}' AND table_name = 'product_status'
                AND column_name = 'merchant_id') THEN
    RAISE NOTICE 'migrating ${S}.product_status to (merchant_id, product_id)';
    ALTER TABLE ${S}.product_status RENAME TO product_status_pre_multimerchant;
  END IF;
END
$mig$;

CREATE TABLE IF NOT EXISTS ${S}.raw_events (
  tx_digest    text   NOT NULL,
  event_seq    bigint NOT NULL,
  event_type   text   NOT NULL,
  event_name   text   NOT NULL,
  merchant_id  text,
  timestamp_ms bigint,
  json         jsonb  NOT NULL,
  PRIMARY KEY (tx_digest, event_seq)
);
CREATE INDEX IF NOT EXISTS idx_fc_raw_events_name ON ${S}.raw_events(event_name);
CREATE INDEX IF NOT EXISTS idx_fc_raw_events_ts   ON ${S}.raw_events(timestamp_ms);

CREATE TABLE IF NOT EXISTS ${S}.poller_status (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_poll_at       timestamptz,
  last_success_at    timestamptz,
  last_error         text,
  last_error_at      timestamptz,
  consecutive_errors int DEFAULT 0,
  last_fetched       int,
  last_inserted      int,
  cursor             text,
  total_events       bigint
);

CREATE TABLE IF NOT EXISTS ${S}.sponsor_health (
  ts                         timestamptz PRIMARY KEY DEFAULT now(),
  ok                         boolean NOT NULL,
  http_status                int,
  sponsor_address            text,
  balance_mist               numeric,
  low_balance                boolean,
  pool_reserved              int,
  -- Deprecated: never was "spend". See day_reserved_mist below, and the
  -- ALTER blocks after this table. Kept so pre-existing panels keep drawing.
  day_spend_mist             numeric,
  daily_budget_mist          numeric,
  tracked_senders            int,
  approved                   bigint,
  rejected                   bigint,
  depleted                   bigint,
  errors                     bigint,
  station_started_at         timestamptz,
  gas_budget_mist            numeric,
  low_balance_threshold_mist numeric,
  error                      text
);
CREATE INDEX IF NOT EXISTS idx_fc_sponsor_health_ts ON ${S}.sponsor_health(ts);
-- The station RESERVES a worst-case gas budget per sponsorship and never
-- learns the real cost (it co-signs; the client executes). day_spend_mist was
-- always that reservation, and a dashboard plotting it as "spent today"
-- overstated a real 0.3 SUI day as 5.9 SUI. day_reserved_mist is the same
-- number under its true name; day_admitted is the sponsorship count behind it,
-- so reserved == admitted * gas_budget_mist is checkable in SQL. For ACTUAL
-- spend join tx_gas, which carries on-chain gas from receipts.
ALTER TABLE ${S}.sponsor_health ADD COLUMN IF NOT EXISTS day_reserved_mist numeric;
ALTER TABLE ${S}.sponsor_health ADD COLUMN IF NOT EXISTS day_admitted int;
-- Faucet self-care. refill_state is 'idle' | 'ok' | 'rate-limited' | 'failing';
-- alert on 'failing' or refill_hard_failures > 0, NOT on the blunt refusal
-- counter — a healthy station sits throttled for hours at a time.
ALTER TABLE ${S}.sponsor_health ADD COLUMN IF NOT EXISTS refill_state text;
ALTER TABLE ${S}.sponsor_health ADD COLUMN IF NOT EXISTS refill_hard_failures int;
ALTER TABLE ${S}.sponsor_health ADD COLUMN IF NOT EXISTS refill_last_hard_failure_at timestamptz;

CREATE TABLE IF NOT EXISTS ${S}.treasury_recon (
  ts                   timestamptz NOT NULL DEFAULT now(),
  merchant_id          text NOT NULL,
  currency             text NOT NULL,
  expected_mist        numeric NOT NULL,
  onchain_mist         numeric,
  fees_accrued_mist    numeric,
  delta                numeric,
  ok                   boolean,
  unattributed_refunds numeric,
  payment_count        int,
  refund_count         int,
  grants               int,
  revocations          int,
  error                text,
  PRIMARY KEY (ts, merchant_id, currency)
);

-- One row per merchant. The registry_* columns are deployment-global (one
-- registry read per cycle, stamped onto every row) so a single join answers
-- "is intake paused for this merchant?" without a second lookup.
CREATE TABLE IF NOT EXISTS ${S}.chain_status (
  merchant_id     text PRIMARY KEY,
  merchant_key    text,
  ts              timestamptz,
  registry_paused boolean,
  registry_fee_bps int,
  merchant_paused boolean,
  merchant_name   text,
  credits_enabled boolean,
  enforce_split   boolean,
  next_payment_id bigint,
  next_product_id bigint,
  error           text
);

CREATE TABLE IF NOT EXISTS ${S}.product_status (
  merchant_id     text NOT NULL,
  product_id      bigint NOT NULL,
  slug            text,
  active          boolean,
  kind            int,
  price_raw       numeric,
  duration_ms     numeric,
  entitlement_key text,
  coin_type       text,
  coin_symbol     text,
  coin_decimals   int,
  updated_at      timestamptz,
  error           text,
  PRIMARY KEY (merchant_id, product_id)
);

CREATE TABLE IF NOT EXISTS ${S}.deployment_info (
  id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  network             text,
  chain_id            text,
  package_id          text,
  original_package_id text,
  registry_id         text,
  publish_digest      text,
  merchant_id         text,
  sponsor_address     text,
  coins               jsonb,
  updated_at          timestamptz
);
-- Every configured merchant: [{ merchant_id, key, name }]. merchant_id above
-- stays the FIRST configured merchant so existing single-merchant queries keep
-- working; multi-merchant panels read chain_status instead.
ALTER TABLE ${S}.deployment_info ADD COLUMN IF NOT EXISTS merchants jsonb;

CREATE TABLE IF NOT EXISTS ${S}.tx_gas (
  tx_digest  text PRIMARY KEY,
  sender     text,
  gas_owner  text,
  sponsored  boolean,
  status     text,
  fetched_at timestamptz DEFAULT now(),
  error      text
);

CREATE TABLE IF NOT EXISTS ${S}.collector_runs (
  ts     timestamptz DEFAULT now(),
  kind   text,
  ok     boolean,
  detail text
);
CREATE INDEX IF NOT EXISTS idx_fc_collector_runs_ts ON ${S}.collector_runs(ts);

-- Views: keep Grafana SQL trivial and centralise json extraction quirks
-- (TypeName renders as {"name":"<no-0x-hex>::mod::T"} or a bare string).
CREATE OR REPLACE VIEW ${S}.payments AS
SELECT
  to_timestamp(e.timestamp_ms / 1000.0)              AS paid_at,
  e.tx_digest,
  e.merchant_id,
  (e.json->>'payment_id')::numeric                   AS payment_id,
  (e.json->>'product_id')::numeric                   AS product_id,
  e.json->>'payer'                                   AS payer,
  e.json->>'beneficiary'                             AS beneficiary,
  CASE WHEN cur.c LIKE '0x%' THEN cur.c ELSE '0x' || cur.c END AS currency,
  (e.json->>'amount')::numeric                       AS amount_raw,
  (e.json->>'fee')::numeric                          AS fee_raw,
  (e.json->>'quantity')::numeric                     AS quantity,
  e.json->>'external_ref'                            AS external_ref,
  g.gas_owner,
  g.sponsored,
  g.status                                           AS tx_status
FROM ${S}.raw_events e
CROSS JOIN LATERAL (SELECT COALESCE(e.json->'currency'->>'name', e.json->>'currency', 'unknown') AS c) cur
LEFT JOIN ${S}.tx_gas g ON g.tx_digest = e.tx_digest
WHERE e.event_name = 'PaymentEvent';

CREATE OR REPLACE VIEW ${S}.entitlement_events AS
SELECT
  to_timestamp(e.timestamp_ms / 1000.0)   AS at,
  e.tx_digest,
  e.merchant_id,
  e.event_name,
  e.json->>'owner'                        AS owner,
  e.json->>'key'                          AS key,
  (e.json->>'expires_at_ms')::numeric     AS expires_at_ms,
  CASE WHEN (e.json->>'expires_at_ms') IS NOT NULL
       THEN to_timestamp((e.json->>'expires_at_ms')::numeric / 1000.0) END AS expires_at,
  (e.json->>'source_payment_id')::numeric AS source_payment_id,
  (e.json->>'by_refund')::boolean         AS by_refund
FROM ${S}.raw_events e
WHERE e.event_name IN ('EntitlementGrantedEvent', 'EntitlementRevokedEvent');

-- Latest grant/revoke per (owner, key). Subscription grants carry the NEW
-- absolute expiry (extend-from-max), so the newest event decides status.
-- INDEXED truth: on-chain double-check remains entitlements::is_entitled.
CREATE OR REPLACE VIEW ${S}.entitlement_status AS
WITH ranked AS (
  SELECT *,
         row_number() OVER (
           PARTITION BY lower(json->>'owner'), json->>'key'
           ORDER BY timestamp_ms DESC, event_seq DESC
         ) AS rn
  FROM ${S}.raw_events
  WHERE event_name IN ('EntitlementGrantedEvent', 'EntitlementRevokedEvent')
)
SELECT
  json->>'owner'                       AS owner,
  json->>'key'                         AS key,
  event_name                           AS last_event,
  to_timestamp(timestamp_ms / 1000.0)  AS last_event_at,
  tx_digest                            AS last_tx_digest,
  (json->>'expires_at_ms')::numeric    AS expires_at_ms,
  CASE WHEN (json->>'expires_at_ms') IS NOT NULL
       THEN to_timestamp((json->>'expires_at_ms')::numeric / 1000.0) END AS expires_at,
  (event_name = 'EntitlementGrantedEvent'
    AND ((json->>'expires_at_ms') IS NULL
         OR (json->>'expires_at_ms')::numeric > extract(epoch FROM now()) * 1000)) AS active
FROM ranked
WHERE rn = 1;

CREATE OR REPLACE VIEW ${S}.refunds AS
SELECT
  to_timestamp(e.timestamp_ms / 1000.0) AS at,
  e.tx_digest,
  e.merchant_id,
  (e.json->>'payment_id')::numeric      AS payment_id,
  (e.json->>'amount')::numeric          AS amount_raw,
  e.json->>'to'                         AS refunded_to,
  (e.json->>'entitlement_revoked')::boolean AS entitlement_revoked
FROM ${S}.raw_events e
WHERE e.event_name = 'RefundEvent';

-- Payments with the labels every revenue question needs: which merchant, which
-- product (slug), and which app the purchase came from. Attribution rules:
--   merchant_name / product_slug  <- on-chain catalog sample (NULL until the
--     first recon cycle has seen that merchant, or for a merchant no longer
--     configured - the payment is still shown, never dropped by the join);
--   ref_prefix                    <- the APP-DEFINED external_ref namespace,
--     i.e. everything before the first ':' ("game-a:<run>:<n>" -> "game-a").
--     external_ref is opaque to the chain, so this is a convention, not a
--     guarantee: refs without ':' are reported whole and NULL/'' as '(none)'.
-- One product can serve several apps (the same consumable bought by two
-- games), which is exactly why product and ref_prefix are separate columns.
DROP VIEW IF EXISTS ${S}.payments_labeled;
CREATE VIEW ${S}.payments_labeled AS
SELECT
  p.*,
  c.merchant_name,
  ps.slug            AS product_slug,
  ps.entitlement_key AS product_entitlement_key,
  ps.coin_symbol,
  CASE
    WHEN p.external_ref IS NULL OR p.external_ref = ''  THEN '(none)'
    WHEN strpos(p.external_ref, ':') > 0 THEN split_part(p.external_ref, ':', 1)
    ELSE p.external_ref
  END AS ref_prefix
FROM ${S}.payments p
LEFT JOIN ${S}.chain_status c    ON c.merchant_id = p.merchant_id
LEFT JOIN ${S}.product_status ps ON ps.merchant_id = p.merchant_id
                                AND ps.product_id = p.product_id;
`;

// ------------------------------------------------------------------ jobs ----
async function runDDL() {
  await pool.query(DDL);
  const c = deploymentJson;
  await pool.query(
    `INSERT INTO ${S}.deployment_info
       (id, network, chain_id, package_id, original_package_id, registry_id,
        publish_digest, merchant_id, sponsor_address, coins, merchants, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (id) DO UPDATE SET
       network = EXCLUDED.network, chain_id = EXCLUDED.chain_id,
       package_id = EXCLUDED.package_id, original_package_id = EXCLUDED.original_package_id,
       registry_id = EXCLUDED.registry_id, publish_digest = EXCLUDED.publish_digest,
       merchant_id = EXCLUDED.merchant_id, sponsor_address = EXCLUDED.sponsor_address,
       coins = EXCLUDED.coins, merchants = EXCLUDED.merchants, updated_at = now()`,
    [
      c.network, c.chainId ?? null, c.packageId, c.originalPackageId, c.registryId,
      c.publishDigest ?? null, MERCHANTS[0].merchantId, env('SPONSOR_ADDRESS', null),
      JSON.stringify(c.coins ?? {}),
      JSON.stringify(
        MERCHANTS.map((m) => ({ merchant_id: m.merchantId, key: m.key, name: m.name })),
      ),
    ],
  );
}

let lastMirroredRowid = 0;

async function mirrorLedgerToPostgres() {
  let mirrored = 0;
  for (;;) {
    const rows = ledger.db
      .prepare(
        `SELECT rowid, tx_digest, event_seq, event_type, event_name, merchant_id, timestamp_ms, json
         FROM raw_events WHERE rowid > ? ORDER BY rowid LIMIT 500`,
      )
      .all(lastMirroredRowid);
    if (rows.length === 0) return mirrored;
    for (const r of rows) {
      await pool.query(
        `INSERT INTO ${S}.raw_events
           (tx_digest, event_seq, event_type, event_name, merchant_id, timestamp_ms, json)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (tx_digest, event_seq) DO NOTHING`,
        [r.tx_digest, r.event_seq, r.event_type, r.event_name, r.merchant_id, r.timestamp_ms, r.json],
      );
      lastMirroredRowid = Number(r.rowid);
      mirrored += 1;
    }
  }
}

async function pollJob() {
  const startedAt = new Date();
  try {
    const res = await pollOnce({ rpcUrl: SUI_GRAPHQL_URL, deployment, db: ledger });
    const mirrored = await mirrorLedgerToPostgres();
    const total = ledger.db.prepare('SELECT COUNT(*) AS n FROM raw_events').get().n;
    await pool.query(
      `INSERT INTO ${S}.poller_status
         (id, last_poll_at, last_success_at, consecutive_errors, last_fetched, last_inserted, cursor, total_events)
       VALUES (1, $1, $1, 0, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         last_poll_at = $1, last_success_at = $1, consecutive_errors = 0,
         last_fetched = $2, last_inserted = $3, cursor = $4, total_events = $5`,
      [startedAt, res.fetched, res.inserted, res.cursor, total],
    );
    if (res.inserted > 0) log('poll: new events', { inserted: res.inserted, mirrored, total: Number(total) });
    return true;
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 500);
    await pool.query(
      `INSERT INTO ${S}.poller_status (id, last_poll_at, last_error, last_error_at, consecutive_errors)
       VALUES (1, $1, $2, $1, 1)
       ON CONFLICT (id) DO UPDATE SET
         last_poll_at = $1, last_error = $2, last_error_at = $1,
         consecutive_errors = ${S}.poller_status.consecutive_errors + 1`,
      [startedAt, msg],
    ).catch(() => {});
    await pool.query(
      `INSERT INTO ${S}.collector_runs (kind, ok, detail) VALUES ('poll', false, $1)`,
      [msg],
    ).catch(() => {});
    log('poll: ERROR', { error: msg });
    return false;
  }
}

async function sponsorHealthJob() {
  if (!SPONSOR_HEALTH_URL) return; // no gas station configured - nothing to snapshot
  let row = { ok: false, http_status: null, error: null, body: null };
  try {
    const ctrl = AbortSignal.timeout(10_000);
    const res = await fetch(SPONSOR_HEALTH_URL, { signal: ctrl });
    row.http_status = res.status;
    if (res.ok) {
      row.body = await res.json();
      row.ok = true;
    } else {
      row.error = `http ${res.status}`;
    }
  } catch (e) {
    row.error = String(e?.message ?? e).slice(0, 300);
  }
  const b = row.body ?? {};
  // Prefer the honest field; fall back to the deprecated alias so this
  // collector keeps working against a station older than the rename.
  const reserved = b.limiter?.dayReservedMist ?? b.limiter?.daySpendMist ?? null;
  const refill = b.selfCare?.refill ?? {};
  await pool.query(
    `INSERT INTO ${S}.sponsor_health
       (ts, ok, http_status, sponsor_address, balance_mist, low_balance, pool_reserved,
        day_spend_mist, daily_budget_mist, tracked_senders,
        approved, rejected, depleted, errors, station_started_at,
        gas_budget_mist, low_balance_threshold_mist, error,
        day_reserved_mist, day_admitted,
        refill_state, refill_hard_failures, refill_last_hard_failure_at)
     VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
             $18, $19, $20, $21, $22)`,
    [
      row.ok, row.http_status, b.sponsorAddress ?? null, b.balanceMist ?? null,
      b.lowBalance ?? null, b.pool?.reserved ?? null,
      // day_spend_mist keeps receiving the reservation so existing panels stay
      // continuous across this upgrade; it is deprecated, not repurposed.
      reserved, b.limiter?.dailyBudgetMist ?? null,
      b.limiter?.trackedSenders ?? null,
      b.stats?.approved ?? null, b.stats?.rejected ?? null, b.stats?.depleted ?? null,
      b.stats?.error ?? null, b.stats?.startedAt ?? null,
      b.config?.gasBudgetMist ?? null, b.config?.lowBalanceThresholdMist ?? null, row.error,
      reserved, b.limiter?.dayAdmitted ?? null,
      refill.state ?? null, refill.consecutiveHardFailures ?? null,
      refill.lastHardFailureAt ?? null,
    ],
  );
  if (!row.ok) log('sponsor health: DOWN', { status: row.http_status, error: row.error });
}

async function gasEnrichJob() {
  const { rows } = await pool.query(
    `SELECT DISTINCT e.tx_digest FROM ${S}.raw_events e
     LEFT JOIN ${S}.tx_gas g ON g.tx_digest = e.tx_digest
     WHERE e.event_name = 'PaymentEvent' AND g.tx_digest IS NULL
     LIMIT $1`,
    [GAS_ENRICH_BATCH],
  );
  for (const { tx_digest } of rows) {
    try {
      const res = await grpc.core.getTransaction({
        digest: tx_digest,
        include: { transaction: true },
      });
      const t = res.Transaction ?? res.FailedTransaction;
      const sender = t?.transaction?.sender ?? null;
      const gasOwner = t?.transaction?.gasData?.owner ?? null;
      const sponsored =
        sender && gasOwner ? gasOwner.toLowerCase() !== sender.toLowerCase() : null;
      await pool.query(
        `INSERT INTO ${S}.tx_gas (tx_digest, sender, gas_owner, sponsored, status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tx_digest) DO UPDATE SET
           sender = EXCLUDED.sender, gas_owner = EXCLUDED.gas_owner,
           sponsored = EXCLUDED.sponsored, status = EXCLUDED.status, fetched_at = now(), error = NULL`,
        [tx_digest, sender, gasOwner, sponsored, t?.status?.success === false ? 'failed' : 'success'],
      );
    } catch (e) {
      const msg = String(e?.message ?? e).slice(0, 300);
      // Record the failure so it is visible; leave retry to the next cycle
      // only when the row still doesn't exist.
      await pool.query(
        `INSERT INTO ${S}.tx_gas (tx_digest, error) VALUES ($1, $2)
         ON CONFLICT (tx_digest) DO NOTHING`,
        [tx_digest, msg],
      ).catch(() => {});
      log('gas enrich: ERROR', { tx_digest, error: msg });
    }
  }
}

async function reconJob() {
  const ts = new Date();
  // Event-derived accounting from the canonical ledger, per merchant.
  const ledgers = buildMerchantLedgers(ledger);

  // Registry state is deployment-global: read once per cycle, then stamped
  // onto every merchant's chain_status row.
  let reg = null;
  let regError = null;
  try {
    reg = await getRegistrySummary(grpc, deployment);
  } catch (e) {
    regError = String(e?.message ?? e).slice(0, 300);
    log('recon: registry ERROR', { error: regError });
  }

  // One merchant failing (RPC hiccup, deleted object) must not hide the rest.
  for (const merchant of MERCHANTS) {
    await reconMerchant(ts, merchant, ledgers.get(merchant.merchantId), reg, regError).catch((e) => {
      const msg = String(e?.message ?? e).slice(0, 300);
      log('recon: merchant FAILED', { merchant: merchant.merchantId, error: msg });
      return pool
        .query(`INSERT INTO ${S}.collector_runs (kind, ok, detail) VALUES ('recon', false, $1)`, [
          `${merchant.merchantId}: ${msg}`,
        ])
        .catch(() => {});
    });
  }
}

async function reconMerchant(ts, merchant, ml, reg, regError) {
  const merchantId = merchant.merchantId;
  const currencies = new Set();
  for (const coin of Object.values(deployment.coins)) currencies.add(coin.coinType);
  if (ml) for (const c of ml.byCurrency.keys()) currencies.add(c);

  for (const currency of currencies) {
    const expected = ml ? expectedTreasury(ml, currency) : 0n;
    let onchain = null;
    let fees = null;
    let error = null;
    try {
      onchain = await getTreasuryValue(grpc, deployment, { merchantId, coinType: currency });
      fees = await getFeesAccruedValue(grpc, deployment, { merchantId, coinType: currency });
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 300);
    }
    const delta = onchain === null ? null : (onchain - expected).toString();
    await pool.query(
      `INSERT INTO ${S}.treasury_recon
         (ts, merchant_id, currency, expected_mist, onchain_mist, fees_accrued_mist, delta, ok,
          unattributed_refunds, payment_count, refund_count, grants, revocations, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (ts, merchant_id, currency) DO NOTHING`,
      [
        ts, merchantId, currency, expected.toString(),
        onchain === null ? null : onchain.toString(),
        fees === null ? null : fees.toString(),
        delta, onchain === null ? null : onchain === expected,
        (ml?.unattributedRefunds ?? 0n).toString(),
        ml?.paymentCount ?? 0, ml?.refundCount ?? 0,
        ml?.entitlementGrants ?? 0, ml?.entitlementRevocations ?? 0,
        error,
      ],
    );
    if (onchain !== null && onchain !== expected) {
      log('recon: MISMATCH', {
        merchant: merchantId, currency,
        expected: expected.toString(), onchain: onchain.toString(),
      });
    }
  }

  // On-chain registry/merchant/product state (the "what is production using" row).
  try {
    const mer = await getMerchantSummary(grpc, merchantId);
    await pool.query(
      `INSERT INTO ${S}.chain_status
         (merchant_id, merchant_key, ts, registry_paused, registry_fee_bps, merchant_paused,
          merchant_name, credits_enabled, enforce_split, next_payment_id, next_product_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (merchant_id) DO UPDATE SET
         merchant_key = EXCLUDED.merchant_key, ts = EXCLUDED.ts,
         registry_paused = EXCLUDED.registry_paused, registry_fee_bps = EXCLUDED.registry_fee_bps,
         merchant_paused = EXCLUDED.merchant_paused, merchant_name = EXCLUDED.merchant_name,
         credits_enabled = EXCLUDED.credits_enabled, enforce_split = EXCLUDED.enforce_split,
         next_payment_id = EXCLUDED.next_payment_id, next_product_id = EXCLUDED.next_product_id,
         error = EXCLUDED.error`,
      [
        merchantId, merchant.key, ts,
        reg?.paused ?? null, reg === null ? null : Number(reg.feeBps),
        mer.paused, mer.name, mer.creditsEnabled, mer.enforceSplit,
        Number(mer.nextPaymentId), Number(mer.nextProductId), regError,
      ],
    );
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 300);
    await pool.query(
      `INSERT INTO ${S}.chain_status (merchant_id, merchant_key, ts, merchant_name, error)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (merchant_id) DO UPDATE SET ts = EXCLUDED.ts, error = EXCLUDED.error`,
      [merchantId, merchant.key, ts, merchant.name, msg],
    ).catch(() => {});
    log('recon: chain status ERROR', { merchant: merchantId, error: msg });
  }

  const products = merchant.products ?? {};
  for (const [slug, p] of Object.entries(products)) {
    let info = null;
    let error = null;
    try {
      info = await getProductInfo(grpc, deployment, { merchantId, productId: p.productId });
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 300);
    }
    const coin = Object.values(deployment.coins).find((c) => c.coinType === p.coinType);
    await pool.query(
      `INSERT INTO ${S}.product_status
         (merchant_id, product_id, slug, active, kind, price_raw, duration_ms, entitlement_key,
          coin_type, coin_symbol, coin_decimals, updated_at, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12)
       ON CONFLICT (merchant_id, product_id) DO UPDATE SET
         slug = EXCLUDED.slug, active = EXCLUDED.active, kind = EXCLUDED.kind,
         price_raw = EXCLUDED.price_raw, duration_ms = EXCLUDED.duration_ms,
         entitlement_key = EXCLUDED.entitlement_key, coin_type = EXCLUDED.coin_type,
         coin_symbol = EXCLUDED.coin_symbol, coin_decimals = EXCLUDED.coin_decimals,
         updated_at = now(), error = EXCLUDED.error`,
      [
        merchantId, p.productId, slug,
        info?.active ?? null, info === null ? null : Number(info.kind),
        info === null ? null : info.price.toString(),
        info === null ? null : info.durationMs.toString(),
        p.entitlementKey ?? null, p.coinType ?? null,
        coin?.symbol ?? null, coin?.decimals ?? null, error,
      ],
    );
  }
}

// Retention: bounded history, generous windows.
async function retentionJob() {
  await pool.query(`DELETE FROM ${S}.sponsor_health WHERE ts < now() - interval '90 days'`);
  await pool.query(`DELETE FROM ${S}.collector_runs WHERE ts < now() - interval '30 days'`);
  await pool.query(`DELETE FROM ${S}.treasury_recon WHERE ts < now() - interval '180 days'`);
}

// ------------------------------------------------------------------ main ----
async function main() {
  await runDDL();
  log('collector started', {
    network: deployment.network,
    package: deployment.originalPackageId,
    merchants: MERCHANTS.map((m) => ({
      merchantId: m.merchantId,
      key: m.key,
      products: Object.keys(m.products).length,
    })),
    ledger: LEDGER_PATH,
    sponsorHealth: SPONSOR_HEALTH_URL ?? '(disabled)',
  });

  let lastRecon = 0;
  // First cycle immediately (initial genesis sweep may take several pages).
  for (;;) {
    const cycleStart = Date.now();
    await pollJob();
    await sponsorHealthJob().catch((e) => log('sponsor health job failed', { error: String(e?.message ?? e) }));
    await gasEnrichJob().catch((e) => log('gas enrich job failed', { error: String(e?.message ?? e) }));
    if (Date.now() - lastRecon >= RECON_INTERVAL_MS) {
      lastRecon = Date.now();
      await reconJob().catch((e) => log('recon job failed', { error: String(e?.message ?? e) }));
      await retentionJob().catch(() => {});
    }
    const elapsed = Date.now() - cycleStart;
    await new Promise((r) => setTimeout(r, Math.max(5_000, POLL_INTERVAL_MS - elapsed)));
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
