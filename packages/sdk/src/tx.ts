/**
 * Transaction builders for every commerce flow.
 *
 * Each builder appends commands to a caller-supplied `Transaction` (or
 * creates one) and returns it, so flows compose in a single PTB (e.g. mint
 * mock coins -> pay, or pay -> app-specific call). Builders never sign or
 * submit; sponsorship, signing and execution are the caller's concern -
 * which is exactly what makes them usable from wallets, scripts and the
 * gas-station path alike.
 */
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { exactCoinArg } from './coins.js';
import { CLOCK_OBJECT_ID, type CommerceDeployment } from './config.js';
import { target, type ProductKind } from './ids.js';

export interface PayParams {
  merchantId: string;
  productId: bigint | number;
  quantity?: bigint | number;
  coinType: string;
  /** Exact total = price * quantity, in base units. */
  amount: bigint;
  /** Defaults to the payer (sender). */
  beneficiary?: string;
  externalRef?: string;
  /** Payer address - needed to select coins. */
  payer: string;
}

/** payments::pay - selects coins, splits the exact amount, pays. */
export async function buildPayTx(
  d: CommerceDeployment,
  client: ClientWithCoreApi,
  p: PayParams,
  tx: Transaction = new Transaction(),
): Promise<Transaction> {
  const payment = await exactCoinArg(tx, client, p.payer, p.coinType, p.amount);
  tx.moveCall({
    target: target(d, 'payments', 'pay'),
    typeArguments: [p.coinType],
    arguments: [
      tx.object(d.registryId),
      tx.object(p.merchantId),
      tx.pure.u64(p.productId),
      tx.pure.u64(p.quantity ?? 1),
      payment,
      tx.pure.address(p.beneficiary ?? p.payer),
      tx.pure.option('string', p.externalRef ?? null),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildCreateMerchantTx(
  d: CommerceDeployment,
  name: string,
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'merchant', 'create_merchant'),
    arguments: [tx.pure.string(name)],
  });
  return tx;
}

export interface CreateProductParams {
  merchantId: string;
  operatorCapId: string;
  name: string;
  kind: ProductKind;
  coinType: string;
  price: bigint;
  durationMs?: bigint;
  entitlementKey?: string;
  metadataUri?: string;
}

export function buildCreateProductTx(
  d: CommerceDeployment,
  p: CreateProductParams,
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'catalog', 'create_product'),
    typeArguments: [p.coinType],
    arguments: [
      tx.object(p.merchantId),
      tx.object(p.operatorCapId),
      tx.pure.string(p.name),
      tx.pure.u8(p.kind),
      tx.pure.u64(p.price),
      tx.pure.u64(p.durationMs ?? 0n),
      tx.pure.option('string', p.entitlementKey ?? null),
      tx.pure.string(p.metadataUri ?? ''),
    ],
  });
  return tx;
}

export function buildUpdateProductTx(
  d: CommerceDeployment,
  p: {
    merchantId: string;
    operatorCapId: string;
    productId: bigint | number;
    name: string;
    price: bigint;
    active: boolean;
    metadataUri?: string;
  },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'catalog', 'update_product'),
    arguments: [
      tx.object(p.merchantId),
      tx.object(p.operatorCapId),
      tx.pure.u64(p.productId),
      tx.pure.string(p.name),
      tx.pure.u64(p.price),
      tx.pure.bool(p.active),
      tx.pure.string(p.metadataUri ?? ''),
    ],
  });
  return tx;
}

export function buildRefundTx(
  d: CommerceDeployment,
  p: {
    merchantId: string;
    treasurerCapId: string;
    coinType: string;
    paymentId: bigint | number;
    amount: bigint;
    revokeEntitlement?: boolean;
  },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'payments', 'refund'),
    typeArguments: [p.coinType],
    arguments: [
      tx.object(p.merchantId),
      tx.object(p.treasurerCapId),
      tx.pure.u64(p.paymentId),
      tx.pure.u64(p.amount),
      tx.pure.bool(p.revokeEntitlement ?? false),
    ],
  });
  return tx;
}

// === Entitlements ===

export function buildGrantPermanentTx(
  d: CommerceDeployment,
  p: { merchantId: string; operatorCapId: string; key: string; owner: string },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'entitlements', 'grant_permanent'),
    arguments: [
      tx.object(p.merchantId),
      tx.object(p.operatorCapId),
      tx.pure.string(p.key),
      tx.pure.address(p.owner),
    ],
  });
  return tx;
}

export function buildGrantTimedTx(
  d: CommerceDeployment,
  p: { merchantId: string; operatorCapId: string; key: string; owner: string; durationMs: bigint },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'entitlements', 'grant_timed'),
    arguments: [
      tx.object(p.merchantId),
      tx.object(p.operatorCapId),
      tx.pure.string(p.key),
      tx.pure.address(p.owner),
      tx.pure.u64(p.durationMs),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildRevokeEntitlementTx(
  d: CommerceDeployment,
  p: { merchantId: string; operatorCapId: string; key: string; owner: string },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'entitlements', 'revoke'),
    arguments: [
      tx.object(p.merchantId),
      tx.object(p.operatorCapId),
      tx.pure.string(p.key),
      tx.pure.address(p.owner),
    ],
  });
  return tx;
}

// === Credits ===

export async function buildDepositCreditsTx(
  d: CommerceDeployment,
  client: ClientWithCoreApi,
  p: { merchantId: string; coinType: string; amount: bigint; owner: string },
  tx: Transaction = new Transaction(),
): Promise<Transaction> {
  const payment = await exactCoinArg(tx, client, p.owner, p.coinType, p.amount);
  tx.moveCall({
    target: target(d, 'credits', 'deposit'),
    typeArguments: [p.coinType],
    arguments: [tx.object(d.registryId), tx.object(p.merchantId), payment],
  });
  return tx;
}

export function buildChargeCreditsTx(
  d: CommerceDeployment,
  p: {
    merchantId: string;
    operatorCapId: string;
    coinType: string;
    owner: string;
    amount: bigint;
    memo: string;
  },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'credits', 'charge'),
    typeArguments: [p.coinType],
    arguments: [
      tx.object(d.registryId),
      tx.object(p.merchantId),
      tx.object(p.operatorCapId),
      tx.pure.address(p.owner),
      tx.pure.u64(p.amount),
      tx.pure.string(p.memo),
    ],
  });
  return tx;
}

/** Withdraws credits and transfers the coin to the sender. */
export function buildWithdrawCreditsTx(
  d: CommerceDeployment,
  p: { merchantId: string; coinType: string; amount: bigint; owner: string },
  tx: Transaction = new Transaction(),
): Transaction {
  const coin = tx.moveCall({
    target: target(d, 'credits', 'withdraw_credits'),
    typeArguments: [p.coinType],
    arguments: [tx.object(p.merchantId), tx.pure.u64(p.amount)],
  });
  tx.transferObjects([coin], tx.pure.address(p.owner));
  return tx;
}

// === Treasury ===

export function buildWithdrawTx(
  d: CommerceDeployment,
  p: {
    merchantId: string;
    treasurerCapId: string;
    coinType: string;
    amount: bigint;
    to: string;
  },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'treasury', 'withdraw'),
    typeArguments: [p.coinType],
    arguments: [
      tx.object(p.merchantId),
      tx.object(p.treasurerCapId),
      tx.pure.u64(p.amount),
      tx.pure.address(p.to),
    ],
  });
  return tx;
}

export function buildDistributeTx(
  d: CommerceDeployment,
  p: { merchantId: string; treasurerCapId: string; coinType: string },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'treasury', 'distribute'),
    typeArguments: [p.coinType],
    arguments: [tx.object(p.merchantId), tx.object(p.treasurerCapId)],
  });
  return tx;
}

export function buildSweepFeesTx(
  d: CommerceDeployment,
  p: { merchantId: string; protocolTreasurerCapId: string; coinType: string; to: string },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'treasury', 'sweep_fees'),
    typeArguments: [p.coinType],
    arguments: [
      tx.object(p.merchantId),
      tx.object(p.protocolTreasurerCapId),
      tx.pure.address(p.to),
    ],
  });
  return tx;
}

// === Merchant admin ===

export function buildSetPausedTx(
  d: CommerceDeployment,
  p: { merchantId: string; operatorCapId: string; paused: boolean },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'merchant', 'set_paused'),
    arguments: [tx.object(p.merchantId), tx.object(p.operatorCapId), tx.pure.bool(p.paused)],
  });
  return tx;
}

export function buildSetRefundWindowTx(
  d: CommerceDeployment,
  p: { merchantId: string; merchantCapId: string; windowMs: bigint },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'merchant', 'set_refund_window_ms'),
    arguments: [tx.object(p.merchantId), tx.object(p.merchantCapId), tx.pure.u64(p.windowMs)],
  });
  return tx;
}

export function buildSetCreditsEnabledTx(
  d: CommerceDeployment,
  p: { merchantId: string; merchantCapId: string; enabled: boolean },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'merchant', 'set_credits_enabled'),
    arguments: [tx.object(p.merchantId), tx.object(p.merchantCapId), tx.pure.bool(p.enabled)],
  });
  return tx;
}

export function buildSetSplitPolicyTx(
  d: CommerceDeployment,
  p: {
    merchantId: string;
    merchantCapId: string;
    recipients: string[];
    bps: (bigint | number)[];
    enforce: boolean;
  },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'merchant', 'set_split_policy'),
    arguments: [
      tx.object(p.merchantId),
      tx.object(p.merchantCapId),
      tx.pure.vector('address', p.recipients),
      tx.pure.vector('u64', p.bps.map((b) => BigInt(b))),
      tx.pure.bool(p.enforce),
    ],
  });
  return tx;
}

/** Mint an operator cap and transfer it to `to`. */
export function buildMintOperatorCapTx(
  d: CommerceDeployment,
  p: { merchantId: string; merchantCapId: string; to: string },
  tx: Transaction = new Transaction(),
): Transaction {
  const cap = tx.moveCall({
    target: target(d, 'merchant', 'mint_operator_cap'),
    arguments: [tx.object(p.merchantId), tx.object(p.merchantCapId)],
  });
  tx.transferObjects([cap], tx.pure.address(p.to));
  return tx;
}

export function buildMintTreasurerCapTx(
  d: CommerceDeployment,
  p: { merchantId: string; merchantCapId: string; to: string },
  tx: Transaction = new Transaction(),
): Transaction {
  const cap = tx.moveCall({
    target: target(d, 'merchant', 'mint_treasurer_cap'),
    arguments: [tx.object(p.merchantId), tx.object(p.merchantCapId)],
  });
  tx.transferObjects([cap], tx.pure.address(p.to));
  return tx;
}

export function buildRevokeCapTx(
  d: CommerceDeployment,
  p: {
    merchantId: string;
    merchantCapId: string;
    role: 'operator' | 'treasurer';
    capIdToRevoke: string;
  },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(
      d,
      'merchant',
      p.role === 'operator' ? 'revoke_operator_cap' : 'revoke_treasurer_cap',
    ),
    arguments: [
      tx.object(p.merchantId),
      tx.object(p.merchantCapId),
      tx.pure.id(p.capIdToRevoke),
    ],
  });
  return tx;
}

/** Rotate the root cap; the fresh cap is transferred to `to`. */
export function buildRotateRootTx(
  d: CommerceDeployment,
  p: { merchantId: string; merchantCapId: string; to: string },
  tx: Transaction = new Transaction(),
): Transaction {
  const cap = tx.moveCall({
    target: target(d, 'merchant', 'rotate_root'),
    arguments: [tx.object(p.merchantId), tx.object(p.merchantCapId)],
  });
  tx.transferObjects([cap], tx.pure.address(p.to));
  return tx;
}

/** Cancel a pending protocol recovery request (root-holder veto). */
export function buildCancelRecoveryTx(
  d: CommerceDeployment,
  p: { merchantId: string; merchantCapId: string },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'merchant', 'cancel_recovery'),
    arguments: [tx.object(p.merchantId), tx.object(p.merchantCapId)],
  });
  return tx;
}

/** Opt out of protocol recovery (also cancels any pending request). */
export function buildSetRecoveryEnabledTx(
  d: CommerceDeployment,
  p: { merchantId: string; merchantCapId: string; enabled: boolean },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'merchant', 'set_recovery_enabled'),
    arguments: [tx.object(p.merchantId), tx.object(p.merchantCapId), tx.pure.bool(p.enabled)],
  });
  return tx;
}

// === Protocol admin ===

/**
 * Step 1 of timelocked root recovery: open the public 72h challenge window.
 * The merchant sees `RecoveryRequestedEvent` and can cancel/opt out.
 */
export function buildRequestRecoveryTx(
  d: CommerceDeployment,
  p: { merchantId: string; protocolCapId: string },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'merchant', 'protocol_request_recovery'),
    arguments: [tx.object(p.merchantId), tx.object(p.protocolCapId), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

/**
 * Step 2: after the challenge window elapses uncancelled, mint the
 * replacement root cap and transfer it to the merchant's new custody
 * address `to`.
 */
export function buildExecuteRecoveryTx(
  d: CommerceDeployment,
  p: { merchantId: string; protocolCapId: string; to: string },
  tx: Transaction = new Transaction(),
): Transaction {
  const cap = tx.moveCall({
    target: target(d, 'merchant', 'protocol_execute_recovery'),
    arguments: [tx.object(p.merchantId), tx.object(p.protocolCapId), tx.object(CLOCK_OBJECT_ID)],
  });
  tx.transferObjects([cap], tx.pure.address(p.to));
  return tx;
}

export function buildSetProtocolFeeTx(
  d: CommerceDeployment,
  p: { protocolCapId: string; feeBps: bigint | number },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'registry', 'set_protocol_fee_bps'),
    arguments: [tx.object(d.registryId), tx.object(p.protocolCapId), tx.pure.u64(p.feeBps)],
  });
  return tx;
}

export function buildSetProtocolPausedTx(
  d: CommerceDeployment,
  p: { protocolCapId: string; paused: boolean },
  tx: Transaction = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(d, 'registry', 'set_protocol_paused'),
    arguments: [tx.object(d.registryId), tx.object(p.protocolCapId), tx.pure.bool(p.paused)],
  });
  return tx;
}
