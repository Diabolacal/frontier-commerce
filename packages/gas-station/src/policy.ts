/**
 * Transaction-intent validation - the security core of the gas station.
 *
 * Everything here is FAIL-CLOSED: no policy -> reject; unknown command kind
 * -> reject; any reference to the sponsor's gas coin -> reject; targets
 * spanning more than one app policy -> reject. The station only ever signs
 * bytes it built itself from a validated TransactionKind.
 *
 * Threat model notes (inherited from audited prior art + extended):
 * - TransferObjects / Publish / Upgrade / unknown kinds are never
 *   sponsorable: they are the generic theft/abuse primitives.
 * - `GasCoin` references anywhere in arguments would let a user split or
 *   spend the SPONSOR's coin inside their PTB - blocked recursively.
 * - INPUTS are validated too, not just commands: only `Pure` values and
 *   ordinary object references (ImmOrOwned / Shared / Receiving) are
 *   sponsorable. `FundsWithdrawal` inputs (address-balance withdrawal,
 *   including `withdrawFrom: Sponsor`) and any unknown input kind are
 *   rejected - without this, a crafted input could smuggle a sponsor-side
 *   value source past a command-only scan.
 * - MoveCall targets must all belong to ONE configured app policy;
 *   cross-app mixing is rejected to keep per-app reasoning sound.
 * - Policy CANNOT see MoveCall type arguments. Allowlisted generic
 *   functions must validate their own `T` on-chain (the commerce package
 *   does). Never allowlist a generic value-minting function (e.g.
 *   `coin::zero<T>`) in production: it hands out a free "≥1 MoveCall"
 *   anchor for gas-burning no-op transactions.
 */
import { Transaction } from '@mysten/sui/transactions';

export interface AppPolicy {
  /** Stable app identifier for audit logs. */
  name: string;
  /** Fully-qualified allowed targets: "0xpkg::module::function". */
  allowedTargets: string[];
  /** Max commands per PTB for this app. */
  maxCommands: number;
}

export interface PolicyConfig {
  apps: AppPolicy[];
}

export type ValidationResult =
  | { ok: true; appName: string; commandCount: number }
  | { ok: false; reason: string };

const ALLOWED_COMMAND_KINDS = new Set(['MoveCall', 'SplitCoins', 'MergeCoins', 'MakeMoveVec']);

/** Absolute ceiling regardless of per-app config. */
export const MAX_COMMANDS_HARD_CAP = 64;

export function parsePolicyConfig(jsonText: string): PolicyConfig {
  const raw = JSON.parse(jsonText) as unknown;
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as PolicyConfig).apps)) {
    throw new Error('APP_POLICIES must be {"apps": [...]}');
  }
  const apps = (raw as PolicyConfig).apps;
  if (apps.length === 0) throw new Error('APP_POLICIES.apps must not be empty');
  for (const app of apps) {
    if (!app.name || !Array.isArray(app.allowedTargets) || app.allowedTargets.length === 0) {
      throw new Error(`App policy '${app.name ?? '?'}' missing name/allowedTargets`);
    }
    for (const t of app.allowedTargets) {
      if (!/^0x[0-9a-fA-F]+::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
        throw new Error(`Invalid target in policy '${app.name}': ${t}`);
      }
    }
    if (
      !Number.isInteger(app.maxCommands) ||
      app.maxCommands < 1 ||
      app.maxCommands > MAX_COMMANDS_HARD_CAP
    ) {
      throw new Error(
        `App policy '${app.name}' maxCommands must be 1..${MAX_COMMANDS_HARD_CAP}`,
      );
    }
  }
  return { apps };
}

/** Recursively detect `{ $kind: 'GasCoin' }` anywhere in a value. */
export function containsGasCoinReference(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.$kind === 'GasCoin' || 'GasCoin' in obj) return true;
  for (const v of Object.values(obj)) {
    if (containsGasCoinReference(v)) return true;
  }
  return false;
}

/** Input kinds a sponsor will accept. Everything else is rejected. */
const ALLOWED_OBJECT_INPUT_KINDS = new Set(['ImmOrOwnedObject', 'SharedObject', 'Receiving']);

/**
 * Fail-closed validation of a single transaction input (CallArg).
 * Returns a rejection reason, or null when the input is sponsorable.
 */
export function validateInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'Malformed transaction input';
  const kind = (input as { $kind?: unknown }).$kind;
  if (kind === 'Pure') return null;
  if (kind === 'Object') {
    const obj = (input as { Object?: { $kind?: unknown } }).Object;
    const objKind = obj?.$kind;
    if (typeof objKind === 'string' && ALLOWED_OBJECT_INPUT_KINDS.has(objKind)) return null;
    return `Object input kind not sponsorable: ${String(objKind ?? 'unknown')}`;
  }
  // Explicitly covers FundsWithdrawal (address-balance withdrawal, incl.
  // withdrawFrom: Sponsor), Unresolved* leftovers, and anything a future
  // SDK/protocol version adds.
  return `Input kind not sponsorable: ${typeof kind === 'string' ? kind : 'unknown'}`;
}

function normalizeAddress(addr: string): string {
  const stripped = addr.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return `0x${stripped}`;
}

function normalizeTarget(pkg: string, module: string, fn: string): string {
  return `${normalizeAddress(pkg)}::${module}::${fn}`;
}

/**
 * Validate raw TransactionKind bytes against the policy set.
 * Parsing failures are validation failures (fail closed).
 */
export function validateTransactionKind(
  txKindBytes: Uint8Array,
  config: PolicyConfig,
): ValidationResult {
  let commands: Array<Record<string, unknown>>;
  let inputs: unknown[];
  try {
    const tx = Transaction.fromKind(txKindBytes);
    const data = tx.getData();
    commands = data.commands as unknown as Array<Record<string, unknown>>;
    inputs = data.inputs as unknown[];
  } catch (e) {
    return { ok: false, reason: `Unparseable transaction kind: ${(e as Error).message}` };
  }
  if (!Array.isArray(commands) || commands.length === 0) {
    return { ok: false, reason: 'Transaction has no commands' };
  }
  if (commands.length > MAX_COMMANDS_HARD_CAP) {
    return { ok: false, reason: `Too many commands (${commands.length})` };
  }
  if (!Array.isArray(inputs)) {
    return { ok: false, reason: 'Transaction inputs are not a list' };
  }
  for (const input of inputs) {
    const rejection = validateInput(input);
    if (rejection) return { ok: false, reason: rejection };
  }

  const moveCallTargets: string[] = [];
  for (const cmd of commands) {
    const kind = cmd.$kind as string | undefined;
    if (!kind || !ALLOWED_COMMAND_KINDS.has(kind)) {
      return { ok: false, reason: `Command kind not sponsorable: ${kind ?? 'unknown'}` };
    }
    if (containsGasCoinReference(cmd)) {
      return { ok: false, reason: 'Transaction references the sponsor gas coin' };
    }
    if (kind === 'MoveCall') {
      const mc = cmd.MoveCall as
        | { package: string; module: string; function: string }
        | undefined;
      if (!mc?.package || !mc.module || !mc.function) {
        return { ok: false, reason: 'Malformed MoveCall command' };
      }
      moveCallTargets.push(normalizeTarget(mc.package, mc.module, mc.function));
    }
  }
  if (moveCallTargets.length === 0) {
    return { ok: false, reason: 'Transaction contains no MoveCall (nothing to sponsor)' };
  }

  // Find the single app policy that covers EVERY MoveCall target.
  for (const app of config.apps) {
    const allowed = new Set(app.allowedTargets.map((t) => {
      const [pkg, module, fn] = t.split('::');
      return normalizeTarget(pkg!, module!, fn!);
    }));
    if (moveCallTargets.every((t) => allowed.has(t))) {
      if (commands.length > app.maxCommands) {
        return {
          ok: false,
          reason: `Too many commands for app '${app.name}' (${commands.length} > ${app.maxCommands})`,
        };
      }
      return { ok: true, appName: app.name, commandCount: commands.length };
    }
  }
  return { ok: false, reason: 'MoveCall targets not covered by any single app policy' };
}
