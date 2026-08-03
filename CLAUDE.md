@AGENTS.md

# Claude Code notes

- Claude Code does not auto-load `.github/copilot-instructions.md` (the canonical rule set that
  wins over the imported summary above) or the scoped `.github/instructions/*.instructions.md`
  files. Read the canonical file before non-trivial work, and the scoped file for the language
  you are touching (`move.instructions.md` for `**/*.move`, `typescript.instructions.md` for `**/*.ts`).
- `.claude/` is gitignored in this public repo, so `.claude/settings.json` (destructive-git deny
  rules) is local-only and is not shared with contributors.
