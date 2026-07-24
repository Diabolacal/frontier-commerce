/**
 * One-off: fund a testnet gas-sponsor address with a small SUI float from
 * the operator keystore. Usage:
 *   DEPLOYER_ADDRESS=0x... SPONSOR_ADDRESS=0x... AMOUNT_MIST=1500000000 \
 *     node --experimental-strip-types examples/demo-consumer/src/fund-sponsor.ts
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { testnetClient } from './chain.ts';

const target = process.env.DEPLOYER_ADDRESS;
const sponsor = process.env.SPONSOR_ADDRESS;
const amount = BigInt(process.env.AMOUNT_MIST ?? '1500000000');
if (!target || !sponsor) throw new Error('DEPLOYER_ADDRESS and SPONSOR_ADDRESS required');

const path = process.env.SUI_KEYSTORE_PATH ?? join(homedir(), '.sui', 'sui_config', 'sui.keystore');
const entries = JSON.parse(readFileSync(path, 'utf8')) as string[];
let kp: Ed25519Keypair | null = null;
for (const b64 of entries) {
  const bytes = Buffer.from(b64, 'base64');
  if (bytes[0] !== 0x00) continue;
  const candidate = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
  if (candidate.getPublicKey().toSuiAddress() === target.toLowerCase()) { kp = candidate; break; }
}
if (!kp) throw new Error('key not found in keystore');

const client = testnetClient(); // gRPC — JSON-RPC is gone from testnet
const tx = new Transaction();
const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
tx.transferObjects([coin], tx.pure.address(sponsor));
tx.setSender(target);
const bytes = await tx.build({ client });
const { signature } = await kp.signTransaction(bytes);
const res = await client.core.executeTransaction({ transaction: bytes, signatures: [signature], include: { effects: true } });
if (res.$kind === 'FailedTransaction') throw new Error('transfer failed: ' + JSON.stringify(res.FailedTransaction.effects?.status));
await client.core.waitForTransaction({ digest: res.Transaction.digest });
console.log('funded', sponsor, 'amount', amount.toString(), 'digest', res.Transaction.digest);
const { balance } = await client.core.getBalance({ owner: sponsor });
console.log('sponsor SUI balance now:', Number(balance.balance) / 1e9);
