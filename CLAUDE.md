# CLAUDE.md — frontier-commerce

Read [`AGENTS.md`](AGENTS.md) for the working summary. The canonical,
authoritative rule set is
[`.github/copilot-instructions.md`](.github/copilot-instructions.md) — if
anything conflicts, it wins. Scoped Move/TypeScript rules are in
`.github/instructions/`.

Non-negotiables to hold even in a compacted context:

1. **No mainnet.** Don't deploy, don't write mainnet descriptors, don't
   touch the SDK mainnet guard.
2. **Testnet publishes / smoke tests only on explicit operator
   instruction** — they spend real SUI and rotate IDs; record them in
   your `deployments/<network>.json` descriptor.
3. **No destructive git** (`reset --hard`, `clean`, force-push `main`);
   preserve dirty trees; non-trivial work on branches, reviewed via PR.
4. **No secrets in git or output** — status-only reporting.
5. Facts: code/tests/runtime evidence > `docs/decision-log.md` + docs >
   README > model memory. Verify
   Sui APIs against installed packages/docs.sui.io, not memory.
