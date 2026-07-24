# AGENTS.md — frontier-commerce

Reusable commerce/payment foundation for Sui applications (built for the
EVE Frontier ecosystem): Move package + TypeScript SDK + gas station +
indexer + demo harness. **Infrastructure, not an application** — consumer
UI lives in consuming apps, never here.

**Canonical rules live in [`.github/copilot-instructions.md`](.github/copilot-instructions.md).**
This file is a shortened mirror; if anything here conflicts, the canonical
file wins. Scoped rules: [`.github/instructions/move.instructions.md`](.github/instructions/move.instructions.md)
(`**/*.move`) and [`.github/instructions/typescript.instructions.md`](.github/instructions/typescript.instructions.md)
(`**/*.ts`).

## Orient yourself

- Facts come from code, tests and runtime evidence first; then
  `docs/decision-log.md` + current docs; `README.md` is a summary.
- Verify Sui APIs against the installed `@mysten/sui` / pinned framework
  and https://docs.sui.io — never model memory.
- Gates: `pnpm move:test` · `pnpm -r build && pnpm -r typecheck` ·
  `pnpm -r test` · full localnet E2E
  (`node --experimental-strip-types examples/demo-consumer/src/run-demo.ts`
  against `sui start --with-faucet --force-regenesis`).

## Hard boundaries

✅ **Always**
- Branch (`feat/ fix/ docs/ chore/ spike/`) for non-trivial work; squash-
  merge PRs; keep `main` known-good; commit `type: Imperative ≤72 chars`.
- Log non-trivial decisions in `docs/decision-log.md` (newest first).
- Preserve dirty trees: inspect, keep unrelated work in place, continue
  safely.
- Localnet is the playground: publish and E2E freely on
  `--force-regenesis` chains.

⚠️ **Ask first / explicit instruction only**
- Testnet publishes or `testnet-smoke.ts` (mutates chain state, spends
  real testnet SUI, rotates IDs) — never a side effect of another task;
  record in your `deployments/<network>.json` descriptor.
- Releases: tag `vX.Y.Z` = all workspace versions = SDK npm version (one
  train; policy in `docs/distribution.md`). npm publishing happens only
  via `.github/workflows/release.yml` (trusted publishing — no tokens).
  Making any package other than the SDK publishable is an operator
  decision.
- Changes to event/stored struct layouts (upgrade compatibility), the
  funds-path Move modules, gas-station `policy.ts`/`sponsor.ts`, or the
  security model's authority separation.
- Merging your own PR.

🚫 **Never**
- Deploy to mainnet, write a mainnet descriptor, or remove the SDK's
  mainnet guard (promotion checklist in `docs/security-model.md` gates
  this, operator-executed).
- Commit secrets or key material; print/echo/derive secret values (report
  status only).
- `git reset --hard`, `git clean`, force-push `main`, or any destructive
  cleanup that could discard human or agent work.
- Hard-code package/registry/coin IDs — `deployments/<network>.json` is
  runtime truth.
- Remove failing tests to make CI pass.
- Add compile-time dependencies on EVE Frontier packages to the Move code
  (currency is configuration), or a frontend to this repo.
- Register MVR names/PackageInfo objects or publish npm packages outside
  the release workflow — the MVR no-registration posture is deliberate
  (`docs/distribution.md`).
