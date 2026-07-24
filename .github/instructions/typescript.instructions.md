---
applyTo: "**/*.ts"
---

# TypeScript rules — sdk / gas-station / indexer / demo-consumer

Repo-wide rules live in `.github/copilot-instructions.md` and always
apply. **There is no frontend here**: no React, no Tailwind, no component
conventions — this is Node 22 library/service code. Do not import frontend
patterns from sibling repos.

## Runtime + typing baseline

- Node **>=22.12** is required (`node:sqlite` in the indexer; the demo runs
  via `node --experimental-strip-types`). Zero native dependencies — keep
  it that way.
- `tsconfig.base.json` is maximally strict (`strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `isolatedModules`). **Never weaken these flags.**
- No `any` — use `unknown` + narrowing. No `as` casts except narrowing
  from `unknown` after a runtime check (the tolerant event parsers are the
  pattern). No non-null `!` where a check is feasible.
- ESM only (`"type": "module"`), NodeNext resolution, explicit `.js`
  extensions on relative imports.

## Package boundaries (load-bearing — do not blur)

| Package | Is | Is NOT |
|---|---|---|
| `packages/sdk` | Pure client library: deployment config, PTB builders, queries, tolerant event parsing, sponsorship client | Never holds keys, signs, stores state, or performs side effects beyond RPC reads |
| `packages/gas-station` | The ONLY component with a key (expendable sponsor float). Portable core (`policy`/`sponsor`/`limits`/`gasPool`) + `node:http` shell (`server.ts`) | Never imports commerce business logic; framework-free — keep the core Worker-portable |
| `packages/indexer` | Cursor-persistent poller → SQLite cache → reports. Rebuildable from chain at any time | Never an authority; never feeds auth/ownership decisions |
| `examples/demo-consumer` | Proof harness (localnet E2E + testnet smoke) | Not a shipped artifact; still no secrets in source |

- Cross-package imports flow one way: gas-station/indexer/demo may use the
  SDK; the SDK depends on nothing in this workspace.
- **Transport policy (2026-07-24, post-JSON-RPC-removal):** chain reads and
  writes go through `client.core.*` (transport-agnostic) on a
  **`SuiGrpcClient`** for testnet/mainnet-facing code; event querying goes
  through **`SuiGraphQLClient`** (`Query.events` — the ONLY supported event
  transport; the gRPC surface has no event query). `SuiJsonRpcClient` is
  allowed ONLY for localnet tooling (`sui start` still serves it). Do NOT
  reintroduce JSON-RPC in testnet paths — those nodes/providers are gone.

## Sui SDK hallucination guard (verify, don't remember)

Pinned: `@mysten/sui` **^2.22**. Model training data is full of dead APIs.
Banned legacy imports — self-correct immediately if generated:

| Banned (hallucination) | Use instead |
|---|---|
| `@mysten/sui.js` (any path) | `@mysten/sui/*` subpaths |
| `SuiClient`, `JsonRpcProvider` | `SuiGrpcClient` from `@mysten/sui/grpc` (reads/writes; typed `ClientWithCoreApi`), `SuiGraphQLClient` from `@mysten/sui/graphql` (event queries). `SuiJsonRpcClient` localnet-only. |
| `TransactionBlock` | `Transaction` from `@mysten/sui/transactions` |
| `signAndExecuteTransactionBlock` | `signAndExecuteTransaction` / `client.core.executeTransaction` |

When touching SDK call sites, verify shapes against the **installed**
package in `node_modules/@mysten/sui` (types are the truth) and
https://docs.sui.io — e.g. the gas-station input-validation work found the
`FundsWithdrawal` CallArg variant by reading the installed schema, not by
trusting memory. First-party fullnodes dropped JSON-RPC (2026-07-31);
never assume a transport.

## Security-sensitive code rules

- Gas-station validation (`policy.ts`) is **fail-closed**: unknown command
  kinds, unknown input kinds, unparseable bytes → reject. Any allowlist
  you extend must stay fail-closed; policy tests are built from **real BCS
  bytes** via the actual SDK (`tx.build({ onlyTransactionKind: true })`),
  never hand-mocked shapes — keep that discipline.
- Rate/budget accounting is charged only after policy validation; keep the
  admit-callback ordering in `sponsor.ts` (see security review G2 in the
  decision log) when refactoring.
- Event parsing must tolerate BOTH current and legacy on-chain shapes
  (deployed packages keep emitting old structs): optional fields, coercion
  helpers (`asU64`/`asTypeName`/`asOption`), never straight casts of RPC
  JSON.
- Deployment descriptors (`deployments/<network>.json`) are the only
  source of package/registry/coin IDs. Never hard-code an ID in source or
  tests (test-local fake IDs like `0xab...` are fine).

## Tests

- Vitest, colocated `*.test.ts`. `pnpm -r test` must pass in every
  package — CI runs it; a package whose test script fails with "no test
  files" breaks CI (the indexer once did).
- Test behavior at the public surface; adversarial cases (rejection paths,
  clamps, legacy shapes) are the house style.

## File discipline

- Same numbers as the canonical file: plan for <400 lines, justify >500,
  grep before adding helpers, no generic filenames. Documented exception:
  `packages/sdk/src/tx.ts` (~538 — flat catalog of independent builders;
  split only if builder families gain shared logic).
