/**
 * Event poller: pulls all `{originalPackageId}::events::*` events forward
 * from a persisted cursor into the SQLite ledger.
 *
 * Transport: Sui GraphQL (`Query.events` with Relay cursor pagination).
 * GraphQL is the ONLY currently-supported transport with an event-query API:
 * JSON-RPC `queryEvents` was removed from Sui nodes at protocol level
 * (2026-07-31), and the gRPC surface in @mysten/sui 2.22 has no event query
 * (its SubscriptionService only streams whole checkpoints). Do NOT
 * reintroduce JSON-RPC here. Endpoints: https://graphql.testnet.sui.io/graphql
 * (testnet), http://127.0.0.1:9125/graphql (localnet `sui start --with-graphql`).
 *
 * Cursor note: the persisted cursor (`cursors` table, key 'events') is the
 * opaque GraphQL `endCursor` string. Legacy JSON-RPC cursors
 * (`{"txDigest":...,"eventSeq":...}`) are detected and discarded — the sweep
 * restarts from genesis, which is safe because `insertRawEvent` is idempotent
 * on (tx_digest, event_seq).
 *
 * The LedgerDb interface is the stable seam; nothing downstream cares how
 * events arrive.
 */
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import {
  parseCommerceEvent,
  shortEventName,
  type CommerceDeployment,
} from '@frontier-commerce/sdk';
import type { LedgerDb } from './db.js';

export interface PollerOptions {
  /** Sui GraphQL endpoint (e.g. https://graphql.testnet.sui.io/graphql). */
  rpcUrl: string;
  deployment: CommerceDeployment;
  db: LedgerDb;
  pageSize?: number;
  /** Network label for the GraphQL client (metadata only; defaults to the deployment's network). */
  network?: string;
  /** Test seam: override the GraphQL query executor. */
  queryFn?: (variables: EventsQueryVariables) => Promise<EventsQueryPage>;
}

export interface PollResult {
  fetched: number;
  inserted: number;
  cursor: string | null;
}

const CURSOR_KEY = 'events';

export interface EventsQueryVariables {
  filter: { type: string };
  first: number;
  after: string | null;
}

export interface EventsQueryNode {
  sequenceNumber: string | number;
  timestamp: string | null;
  contents: { type: string | { repr?: string } | null; json: unknown } | null;
  transaction: { digest: string } | null;
}

export interface EventsQueryPage {
  nodes: EventsQueryNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const EVENTS_QUERY = /* GraphQL */ `
  query CommerceEvents($filter: EventFilter!, $first: Int!, $after: String) {
    events(filter: $filter, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        sequenceNumber
        timestamp
        contents { type { repr } json }
        transaction { digest }
      }
    }
  }
`;

function defaultQueryFn(rpcUrl: string, network: string) {
  const client = new SuiGraphQLClient({ url: rpcUrl, network: network as 'testnet' });
  return async (variables: EventsQueryVariables): Promise<EventsQueryPage> => {
    const res = await client.query({
      query: EVENTS_QUERY,
      variables: variables as unknown as Record<string, unknown>,
    });
    if (res.errors?.length) {
      throw new Error(`GraphQL events query failed: ${res.errors[0]?.message ?? 'unknown'}`);
    }
    const events = (res.data as { events?: EventsQueryPage } | null | undefined)?.events;
    if (!events) throw new Error('GraphQL events query returned no data');
    return events;
  };
}

function eventTypeString(contents: EventsQueryNode['contents']): string {
  const t = contents?.type;
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object' && typeof t.repr === 'string') return t.repr;
  return '';
}

/** True when a persisted cursor is a legacy JSON-RPC `{txDigest,eventSeq}` blob. */
function isLegacyJsonRpcCursor(stored: string): boolean {
  if (!stored.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    return typeof parsed.txDigest === 'string';
  } catch {
    return false;
  }
}

/** One forward sweep from the stored cursor to the current head. */
export async function pollOnce(opts: PollerOptions): Promise<PollResult> {
  const query = opts.queryFn ?? defaultQueryFn(opts.rpcUrl, opts.network ?? opts.deployment.network);
  const stored = opts.db.getCursor(CURSOR_KEY);
  let cursor: string | null = stored && !isLegacyJsonRpcCursor(stored) ? stored : null;

  let fetched = 0;
  let inserted = 0;
  let hasNext = true;
  while (hasNext) {
    const page = await query({
      filter: { type: `${opts.deployment.originalPackageId}::events` },
      // Live Sui GraphQL enforces a max page size of 50.
      first: opts.pageSize ?? 50,
      after: cursor,
    });
    for (const node of page.nodes) {
      fetched += 1;
      const txDigest = node.transaction?.digest ?? '';
      if (!txDigest) continue;
      const eventType = eventTypeString(node.contents);
      const json = (node.contents?.json ?? {}) as Record<string, unknown>;
      const merchantId =
        typeof json.merchant_id === 'string' ? (json.merchant_id as string) : null;
      const timestampMs = node.timestamp ? Date.parse(node.timestamp) : null;
      const fresh = opts.db.insertRawEvent({
        txDigest,
        eventSeq: Number(node.sequenceNumber),
        eventType,
        eventName: shortEventName(eventType),
        merchantId,
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
        json: JSON.stringify(json),
      });
      if (fresh) inserted += 1;
    }
    if (page.pageInfo.endCursor) {
      cursor = page.pageInfo.endCursor;
      opts.db.setCursor(CURSOR_KEY, cursor);
    }
    hasNext = page.pageInfo.hasNextPage && page.nodes.length > 0;
  }
  return { fetched, inserted, cursor };
}

/**
 * Convenience: parse a stored raw event back into the SDK's typed shape
 * (used by reports; kept here so report code has one import).
 */
export function parseStoredEvent(
  deployment: CommerceDeployment,
  row: { event_type: string; json: string; tx_digest: string; timestamp_ms: number | null },
) {
  return parseCommerceEvent(deployment, {
    eventType: row.event_type,
    json: JSON.parse(row.json) as Record<string, unknown>,
    txDigest: row.tx_digest,
    ...(row.timestamp_ms !== null ? { timestampMs: row.timestamp_ms } : {}),
  });
}
