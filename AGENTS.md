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

## The repo estate (sibling repositories)

The operator runs one product family across a fixed set of local repos. When a prompt says "my
other repos", "check the other repositories", or names a sibling product, these are the paths.
Cross-repo reads are always fine; cross-repo edits are fine when the task calls for them — commit
them in that repo, following its own `AGENTS.md`. This block is maintained as an identical copy in
every listed repo's `AGENTS.md`; if you change it, update all copies.

| Repo | Path | What it is |
|---|---|---|
| EF-Map | `C:\EF-Map-main` | Flagship map app (ef-map.com) + Cloudflare Worker. The hub: owns the shared Hetzner VPS estate (`docs/dev/vps-services.md`), the discovery estate describing every sibling product (features.html, landing pages, llms.txt), and the game-client extraction tooling (`tools/client-diff/`, `tools/game-data-extractor/`) that RootFit data refreshes depend on. |
| ef-map-overlay | `C:\ef-map-overlay` | Native Windows helper + DX12 in-game overlay for EF-Map. |
| CivilizationControl | `C:\dev\CivilizationControl` | Tribe governance app + Open Market, served at ef-map.com/civ-control/ via EF-Map's reverse proxy. Shares the VPS (Sui indexer/enrichment). Vendors world-contracts. |
| RootFit | `C:\dev\rootfit` | Ship-fitting planner at ef-map.com/fit/ (same reverse-proxy pattern). Its module/dogma data is extracted with EF-Map-repo tooling — "run our client diff" happens in `C:\EF-Map-main`. |
| frontier-commerce | `C:\dev\frontier-commerce` | Open-source Sui commerce/payment platform (Move + SDK + gas station + indexer). Infrastructure, not an app. |
| frontier-commerce-internal | `C:\dev\frontier-commerce-internal` | Private ops repo for the operator's frontier-commerce deployments (EF-Map Intelligence): deployment state, custody, ops scripts. |
| sui-playground | `C:\dev\sui-playground` | Sui/chain experiments + vendored upstream reference submodules (`vendor/world-contracts`, `vendor/evevault`, `vendor/builder-scaffold`, `vendor/builder-documentation`) — the place to fetch and inspect upstream contract branches. |
| ssu-open-shared-withdraw | `C:\dev\ssu-open-shared-withdraw` | SSU shared-shelf dApp: Move extension package (`move/ssu_open_claim`) built directly against the world package, plus a React app. Heaviest direct world-contracts consumer. |

Cross-cutting facts:

- The Hetzner VPS (`ssh ef-map-vps`) is shared: EF-Map owns it, CivilizationControl legitimately
  edits parts of it. Read `C:\EF-Map-main\docs\dev\vps-services.md` before diagnosing anything there.
- Agent memory is per-repo. For cross-cutting issues (VPS, Sui chain/RPC, Cloudflare), check both
  shared decision logs: `C:\EF-Map-main\docs\decision-log.md` and
  `C:\dev\CivilizationControl\docs\decision-log.md`.
- EVE Frontier's upstream `world-contracts` is vendored as a read-only submodule in sui-playground
  and CivilizationControl. A v1 rewrite is in progress on its `dev` branch (modular
  core/character/inventory packages replacing the v0 monolith, MVR deploys, new access control) —
  expect breaking changes for every chain consumer when it ships.
