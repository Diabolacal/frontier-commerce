/**
 * Poller regression tests for the GraphQL transport (2026-07-24 migration off
 * JSON-RPC). Uses the queryFn seam with a fake GraphQL responder — covers
 * pagination, opaque-cursor persistence, idempotent re-insert, legacy
 * JSON-RPC cursor reset, and payload-shape mapping.
 */
import { describe, expect, it } from 'vitest';
import { openLedger } from './db.js';
import { pollOnce, type EventsQueryNode, type EventsQueryPage, type EventsQueryVariables } from './poller.js';
import type { CommerceDeployment } from '@frontier-commerce/sdk';

const PKG = '0x' + 'ab'.repeat(32);
const DEPLOYMENT: CommerceDeployment = {
  network: 'testnet',
  packageId: PKG,
  originalPackageId: PKG,
  registryId: '0x' + 'cd'.repeat(32),
  coins: {},
};

function node(digest: string, seq: number, name: string, json: Record<string, unknown>): EventsQueryNode {
  return {
    sequenceNumber: String(seq),
    timestamp: '2026-07-24T15:43:00.302Z',
    contents: { type: { repr: `${PKG}::events::${name}` }, json },
    transaction: { digest },
  };
}

function fakeResponder(pages: EventsQueryPage[]): {
  fn: (v: EventsQueryVariables) => Promise<EventsQueryPage>;
  calls: EventsQueryVariables[];
} {
  const calls: EventsQueryVariables[] = [];
  let i = 0;
  return {
    calls,
    fn: async (v) => {
      calls.push(v);
      const page = pages[Math.min(i, pages.length - 1)]!;
      i += 1;
      return page;
    },
  };
}

describe('pollOnce (GraphQL transport)', () => {
  it('sweeps pages forward, inserts rows, persists the opaque cursor', async () => {
    const db = openLedger(':memory:');
    const { fn, calls } = fakeResponder([
      {
        nodes: [
          node('DIGEST_A', 0, 'PaymentEvent', { merchant_id: '0x1', amount: '100' }),
          node('DIGEST_A', 1, 'EntitlementGrantedEvent', { merchant_id: '0x1', key: 'intel' }),
        ],
        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
      },
      {
        nodes: [node('DIGEST_B', 0, 'PaymentEvent', { merchant_id: '0x1', amount: '5' })],
        pageInfo: { hasNextPage: false, endCursor: 'cursor-2' },
      },
    ]);

    const result = await pollOnce({ rpcUrl: 'unused', deployment: DEPLOYMENT, db, queryFn: fn });
    expect(result.fetched).toBe(3);
    expect(result.inserted).toBe(3);
    expect(result.cursor).toBe('cursor-2');
    expect(db.getCursor('events')).toBe('cursor-2');
    // Filter targets the whole events module of the ORIGINAL package.
    expect(calls[0]!.filter.type).toBe(`${PKG}::events`);
    expect(calls[0]!.after).toBeNull();
    expect(calls[1]!.after).toBe('cursor-1');
    db.close();
  });

  it('is idempotent on (tx_digest, event_seq) re-delivery', async () => {
    const db = openLedger(':memory:');
    const page: EventsQueryPage = {
      nodes: [node('DIGEST_A', 0, 'PaymentEvent', { merchant_id: '0x1' })],
      pageInfo: { hasNextPage: false, endCursor: 'c1' },
    };
    await pollOnce({ rpcUrl: 'unused', deployment: DEPLOYMENT, db, queryFn: async () => page });
    const second = await pollOnce({ rpcUrl: 'unused', deployment: DEPLOYMENT, db, queryFn: async () => page });
    expect(second.fetched).toBe(1);
    expect(second.inserted).toBe(0); // INSERT OR IGNORE dedupe
    db.close();
  });

  it('discards a legacy JSON-RPC cursor and restarts from genesis', async () => {
    const db = openLedger(':memory:');
    db.setCursor('events', JSON.stringify({ txDigest: 'OLD', eventSeq: '3' }));
    const { fn, calls } = fakeResponder([
      { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    await pollOnce({ rpcUrl: 'unused', deployment: DEPLOYMENT, db, queryFn: fn });
    expect(calls[0]!.after).toBeNull(); // legacy cursor not sent to GraphQL
    db.close();
  });

  it('maps GraphQL payload shape into the stable raw_events columns', async () => {
    const db = openLedger(':memory:');
    await pollOnce({
      rpcUrl: 'unused',
      deployment: DEPLOYMENT,
      db,
      queryFn: async () => ({
        nodes: [node('DIGEST_X', 2, 'RefundEvent', { merchant_id: '0x9', amount: '7' })],
        pageInfo: { hasNextPage: false, endCursor: 'cx' },
      }),
    });
    const rows = db.db.prepare('SELECT * FROM raw_events').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tx_digest: 'DIGEST_X',
      event_seq: 2,
      event_type: `${PKG}::events::RefundEvent`,
      event_name: 'RefundEvent',
      merchant_id: '0x9',
      timestamp_ms: Date.parse('2026-07-24T15:43:00.302Z'),
    });
    db.close();
  });
});
