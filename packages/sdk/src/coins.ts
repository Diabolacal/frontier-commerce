/**
 * Coin selection for exact-amount payments.
 *
 * The Move layer requires payment coins to equal the price exactly, so the
 * PTB must (a) find owned coins covering the amount, (b) merge if the
 * largest single coin is insufficient (fragmented wallets are common - this
 * exact failure shipped a real bug in prior art), and (c) split the exact
 * amount off. Gas-coin note: for SUI payments the primary coin must never
 * be the gas coin; we exclude nothing here because commerce currencies are
 * non-SUI (EVE etc.); paying in SUI itself is supported via tx.gas splits
 * by the caller if ever needed.
 */
import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';

/** Max coins merged in one PTB; beyond this the wallet needs consolidation. */
export const MAX_MERGE_COINS = 20;

export interface OwnedCoin {
  objectId: string;
  version: string;
  digest: string;
  balance: bigint;
}

/** List all owned coins of `coinType` (paginates to exhaustion). */
export async function listAllCoins(
  client: ClientWithCoreApi,
  owner: string,
  coinType: string,
): Promise<OwnedCoin[]> {
  const out: OwnedCoin[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.core.listCoins({
      owner,
      coinType,
      ...(cursor ? { cursor } : {}),
    });
    for (const c of page.objects) {
      out.push({
        objectId: c.objectId,
        version: c.version,
        digest: c.digest,
        balance: BigInt(c.balance),
      });
    }
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor);
  return out;
}

/**
 * Add commands to `tx` that produce a coin argument of exactly `amount` of
 * `coinType` from `owner`'s balance. Returns the argument to pass as the
 * `payment` parameter. Zero-amount requests produce a zero coin.
 */
export async function exactCoinArg(
  tx: Transaction,
  client: ClientWithCoreApi,
  owner: string,
  coinType: string,
  amount: bigint,
): Promise<TransactionObjectArgument> {
  if (amount === 0n) {
    return tx.moveCall({
      target: '0x2::coin::zero',
      typeArguments: [coinType],
    });
  }
  const coins = await listAllCoins(client, owner, coinType);
  coins.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  const total = coins.reduce((s, c) => s + c.balance, 0n);
  if (total < amount) {
    throw new Error(
      `Insufficient ${coinType}: need ${amount}, have ${total} across ${coins.length} coins`,
    );
  }

  // Prefer a single sufficient coin; otherwise merge the largest coins until
  // the primary covers the amount.
  const first = coins[0]!;
  const primary = tx.objectRef({
    objectId: first.objectId,
    version: first.version,
    digest: first.digest,
  });
  if (first.balance < amount) {
    const toMerge: TransactionObjectArgument[] = [];
    let covered = first.balance;
    for (const c of coins.slice(1)) {
      if (covered >= amount) break;
      if (toMerge.length >= MAX_MERGE_COINS) {
        throw new Error(
          `Wallet too fragmented: ${coins.length} coins and the top ${
            MAX_MERGE_COINS + 1
          } do not cover ${amount}. Consolidate coins first.`,
        );
      }
      toMerge.push(tx.objectRef({ objectId: c.objectId, version: c.version, digest: c.digest }));
      covered += c.balance;
    }
    tx.mergeCoins(primary, toMerge);
  }
  const [exact] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
  return exact!;
}
