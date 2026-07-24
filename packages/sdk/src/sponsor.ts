/**
 * Client half of the sponsorship (gas-station) flow.
 *
 * Sui-native dual-signature sponsorship: the user's wallet only ever signs
 * a FULLY-BUILT transaction whose gas is owned by the sponsor; the sponsor
 * only ever signs bytes it built itself from the user's TransactionKind
 * after policy validation. Neither party signs blind.
 *
 * Flow (the dual-signature pattern proven in earlier EVE Frontier community
 * sponsor deployments):
 *  1. buildTransactionKindBytes(tx, client)      - commands only, no gas
 *  2. requestSponsorship(url, { txKindB64, sender }) -> { txB64, sponsorSignature }
 *  3. wallet signs Transaction.from(txB64)        -> userSignature
 *  4. executeSponsored(client, txB64, [userSignature, sponsorSignature])
 */
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, toBase64 } from '@mysten/sui/utils';

export interface SponsorshipRequest {
  txKindB64: string;
  sender: string;
  /** Milliseconds since epoch; the station enforces freshness. */
  timestamp: number;
}

export interface SponsorshipResponse {
  txB64: string;
  sponsorSignature: string;
}

export interface SponsorClientOptions {
  url: string;
  /** Optional bearer token (soft abuse throttle - NOT a durable secret). */
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/** Serialize a Transaction's commands (no gas/sender data) to base64. */
export async function buildTransactionKindBytes(
  tx: Transaction,
  client: ClientWithCoreApi,
): Promise<string> {
  const bytes = await tx.build({ client, onlyTransactionKind: true });
  return toBase64(bytes);
}

export class SponsorServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly kind: 'rejected' | 'depleted' | 'unavailable',
  ) {
    super(message);
    this.name = 'SponsorServiceError';
  }
}

/** POST the transaction kind to the gas station for sponsorship. */
export async function requestSponsorship(
  opts: SponsorClientOptions,
  txKindB64: string,
  sender: string,
): Promise<SponsorshipResponse> {
  const fetchFn = opts.fetchImpl ?? fetch;
  // Path-preserving join: stations may live under a reverse-proxy path
  // prefix (e.g. https://host/commerce-sponsor). `new URL('/sponsor',
  // base)` would strip such prefixes.
  const res = await fetchFn(`${opts.url.replace(/\/+$/, '')}/sponsor`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify({
      txKindB64,
      sender,
      timestamp: Date.now(),
    } satisfies SponsorshipRequest),
  });
  if (!res.ok) {
    const kind = res.status === 503 ? 'depleted' : res.status >= 500 ? 'unavailable' : 'rejected';
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      // opaque body - keep generic
    }
    throw new SponsorServiceError(
      `Sponsorship ${kind} (${res.status})${detail ? `: ${detail}` : ''}`,
      res.status,
      kind,
    );
  }
  return (await res.json()) as SponsorshipResponse;
}

/** Execute a sponsored transaction with dual signatures. */
export async function executeSponsored(
  client: ClientWithCoreApi,
  txB64: string,
  signatures: string[],
): Promise<{ digest: string }> {
  const result = await client.core.executeTransaction({
    transaction: fromBase64(txB64),
    signatures,
  });
  if (result.$kind === 'FailedTransaction') {
    throw new Error(
      `Sponsored transaction failed on-chain (digest ${result.FailedTransaction.digest})`,
    );
  }
  return { digest: result.Transaction.digest };
}

/** Reconstruct the sponsored transaction for wallet signing. */
export function sponsoredTransactionFromB64(txB64: string): Transaction {
  return Transaction.from(fromBase64(txB64));
}
