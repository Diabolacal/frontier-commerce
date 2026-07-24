/**
 * Sponsorship core: validate -> reserve gas -> build -> co-sign.
 *
 * Budget strategy: every sponsored transaction gets the configured budget
 * CAP as its gas budget, and the reserved coin must hold at least that cap.
 * Predictable worst-case exposure per sponsorship (cap x rate limits), no
 * estimation round trip, and no "wallet dipped below the fixed budget so
 * everything 500s" failure mode: coins below the cap are simply not
 * eligible and /health reports the pool as depleted.
 */
import type { ClientWithCoreApi } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import type { GasPool } from './gasPool.js';
import type { PolicyConfig } from './policy.js';
import { validateTransactionKind } from './policy.js';

export interface SponsorDeps {
  client: ClientWithCoreApi;
  keypair: Ed25519Keypair;
  sponsorAddress: string;
  gasPool: GasPool;
  policy: PolicyConfig;
  gasBudgetMist: bigint;
}

export type SponsorOutcome =
  | { ok: true; txB64: string; sponsorSignature: string; appName: string }
  | { ok: false; status: number; reason: string };

/**
 * `admit` is called AFTER policy validation succeeds and BEFORE any gas is
 * reserved or budget consumed downstream. Returning a reason rejects with
 * 429. This ordering is deliberate (security review G2): rate/budget
 * accounting must never be charged for requests that fail validation,
 * otherwise well-formed junk from rotating unauthenticated senders can
 * drain the global daily budget and lock out legitimate users.
 */
export async function sponsorTransactionKind(
  deps: SponsorDeps,
  txKindB64: string,
  sender: string,
  admit?: () => string | null,
): Promise<SponsorOutcome> {
  let kindBytes: Uint8Array;
  try {
    kindBytes = fromBase64(txKindB64);
  } catch {
    return { ok: false, status: 400, reason: 'txKindB64 is not valid base64' };
  }

  const verdict = validateTransactionKind(kindBytes, deps.policy);
  if (!verdict.ok) {
    return { ok: false, status: 403, reason: verdict.reason };
  }

  if (admit) {
    const limited = admit();
    if (limited) {
      return { ok: false, status: 429, reason: limited };
    }
  }

  const gasCoin = await deps.gasPool.reserve();
  if (!gasCoin) {
    return { ok: false, status: 503, reason: 'Sponsor gas pool depleted' };
  }
  if (gasCoin.balanceMist < deps.gasBudgetMist) {
    deps.gasPool.release(gasCoin.objectId);
    return { ok: false, status: 503, reason: 'No sponsor coin covers the gas budget' };
  }

  try {
    const tx = Transaction.fromKind(kindBytes);
    tx.setSender(sender);
    tx.setGasOwner(deps.sponsorAddress);
    tx.setGasPayment([
      { objectId: gasCoin.objectId, version: gasCoin.version, digest: gasCoin.digest },
    ]);
    tx.setGasBudget(deps.gasBudgetMist);
    const txBytes = await tx.build({ client: deps.client });
    const { signature } = await deps.keypair.signTransaction(txBytes);
    return {
      ok: true,
      txB64: toBase64(txBytes),
      sponsorSignature: signature,
      appName: verdict.appName,
    };
  } catch (e) {
    // Building failed -> the coin was not consumed; free it immediately.
    deps.gasPool.release(gasCoin.objectId);
    return { ok: false, status: 500, reason: `Failed to build/sign: ${(e as Error).message}` };
  }
}
