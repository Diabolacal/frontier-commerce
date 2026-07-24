/**
 * Chain plumbing for the demo: keypairs, faucet funding, package publishing
 * (CLI build -> SDK publish), execution helpers and created-object lookup.
 *
 * Transports (2026-07-24): everything below runs on the transport-agnostic
 * `client.core.*` API. TESTNET clients must be gRPC (`testnetClient()`) —
 * JSON-RPC was removed from Sui nodes at protocol level 2026-07-31. Localnet
 * fullnodes still serve JSON-RPC, so `localnetClient()` deliberately keeps it
 * (no extra services needed for `sui start`).
 */
import { execFileSync } from 'node:child_process';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

export type Client = ClientWithCoreApi;

export function localnetClient(): Client {
  return new SuiJsonRpcClient({ url: 'http://127.0.0.1:9000', network: 'localnet' });
}

/** gRPC(-web) testnet client — the only supported testnet transport. */
export function testnetClient(url = process.env.TESTNET_GRPC_URL ?? 'https://fullnode.testnet.sui.io:443'): Client {
  return new SuiGrpcClient({ network: 'testnet', baseUrl: url });
}

/** Sui GraphQL endpoint for event queries (indexer polling). */
export function testnetGraphqlUrl(): string {
  return process.env.TESTNET_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';
}

/**
 * 8-hex-char chain id (e.g. testnet '4c78adac'). The core API returns the
 * base58 genesis checkpoint digest; the classic chain id is its first 4
 * bytes, hex-encoded (JSON-RPC's sui_getChainIdentifier returned this form
 * directly).
 */
export async function chainIdHex(client: Client): Promise<string> {
  const { chainIdentifier } = await client.core.getChainIdentifier();
  if (/^[0-9a-f]{8}$/.test(chainIdentifier)) return chainIdentifier;
  const { fromBase58 } = await import('@mysten/sui/utils');
  const bytes = fromBase58(chainIdentifier);
  return Array.from(bytes.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function faucetFund(address: string, faucetUrl = 'http://127.0.0.1:9123'): Promise<void> {
  const res = await fetch(`${faucetUrl}/gas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
  });
  if (!res.ok) throw new Error(`Faucet failed: ${res.status} ${await res.text()}`);
}

export interface BuiltPackage {
  modules: string[];
  dependencies: string[];
}

/** Build a Move package via the sui CLI and return base64 bytecode. */
export function buildMovePackage(path: string): BuiltPackage {
  const out = execFileSync(
    'sui',
    ['move', 'build', '--dump-bytecode-as-base64', '--path', path],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  // The CLI prints build progress to stderr and the JSON to stdout.
  const parsed = JSON.parse(out) as { modules: string[]; dependencies: string[] };
  return { modules: parsed.modules, dependencies: parsed.dependencies };
}

export interface ExecResult {
  digest: string;
  createdByType: Map<string, string[]>; // type -> object ids
  /** Package objects written by this tx (outputState PackageWrite) — set on publishes. */
  publishedPackageIds: string[];
  events: Array<{ eventType: string; json: Record<string, unknown> | null }>;
}

/** Sign, execute, wait, and index created objects by their full type. */
export async function exec(
  client: Client,
  keypair: Ed25519Keypair,
  tx: Transaction,
): Promise<ExecResult> {
  tx.setSenderIfNotSet(keypair.getPublicKey().toSuiAddress());
  const bytes = await tx.build({ client });
  const { signature } = await keypair.signTransaction(bytes);
  const res = await client.core.executeTransaction({
    transaction: bytes,
    signatures: [signature],
    include: { effects: true, events: true, objectTypes: true },
  });
  if (res.$kind === 'FailedTransaction') {
    const eff = res.FailedTransaction.effects;
    throw new Error(`Transaction failed: ${JSON.stringify(eff?.status ?? 'unknown')}`);
  }
  const t = res.Transaction;
  await client.core.waitForTransaction({ digest: t.digest });

  const createdByType = new Map<string, string[]>();
  const publishedPackageIds: string[] = [];
  const objectTypes = t.objectTypes ?? {};
  for (const ch of t.effects?.changedObjects ?? []) {
    if (ch.idOperation === 'Created') {
      // 'PackageWrite' output state marks a published package on BOTH the
      // JSON-RPC and gRPC core parsers (JSON-RPC omits packages from
      // objectTypes, so the type map alone cannot identify them).
      if (ch.outputState === 'PackageWrite') {
        publishedPackageIds.push(ch.objectId);
        continue;
      }
      const type = (objectTypes as Record<string, string>)[ch.objectId];
      if (type) {
        const list = createdByType.get(type) ?? [];
        list.push(ch.objectId);
        createdByType.set(type, list);
      }
    }
  }
  const events = (t.events ?? []).map((e) => ({ eventType: e.eventType, json: e.json }));
  return { digest: t.digest, createdByType, publishedPackageIds, events };
}

export function oneCreated(result: ExecResult, typeSuffix: string): string {
  for (const [type, ids] of result.createdByType) {
    if (type.endsWith(typeSuffix) && ids.length === 1) return ids[0]!;
  }
  throw new Error(
    `Expected exactly one created object of type *${typeSuffix}; got: ${[...result.createdByType.keys()].join(', ')}`,
  );
}

export interface PublishedPackage {
  packageId: string;
  digest: string;
  result: ExecResult;
}

export async function publishPackage(
  client: Client,
  keypair: Ed25519Keypair,
  movePath: string,
): Promise<PublishedPackage> {
  const built = buildMovePackage(movePath);
  const tx = new Transaction();
  const upgradeCap = tx.publish({ modules: built.modules, dependencies: built.dependencies });
  tx.transferObjects([upgradeCap], tx.pure.address(keypair.getPublicKey().toSuiAddress()));
  const result = await exec(client, keypair, tx);
  // Authoritative package id via the transport-agnostic core API: the changed
  // object with outputState 'PackageWrite' (replaces the JSON-RPC-only
  // getTransactionBlock({ showObjectChanges }) lookup; verified live on gRPC
  // and against the JSON-RPC parser source).
  if (result.publishedPackageIds.length !== 1) {
    throw new Error(
      `Expected exactly one published package, got: ${result.publishedPackageIds.join(', ') || 'none'}`,
    );
  }
  return { packageId: result.publishedPackageIds[0]!, digest: result.digest, result };
}

export async function suiBalance(client: Client, address: string): Promise<bigint> {
  const { balance } = await client.core.getBalance({ owner: address });
  return BigInt(balance.balance);
}

export async function coinBalance(
  client: Client,
  address: string,
  coinType: string,
): Promise<bigint> {
  const { balance } = await client.core.getBalance({ owner: address, coinType });
  return BigInt(balance.balance);
}
