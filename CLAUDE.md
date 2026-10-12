# Working in this repo

Three parts. See README.md for what each is and how to run it.

- `workbench/`: a Claude Code mod, with hooks in `hooks/` and tests in `tests/*.test.ts`.
- `workbench-web/`: a Node server (`server.mjs`) with a plain-JS browser UI (`public/`).
- `site/`: static docs. Workbench Web serves them at `/docs/`, but they must also work as plain files.

## Before you say it's done

- Mod: `cd workbench && claude plugin validate . && claude plugin test && npx eslint@9.39.1 hooks`
- Server: `cd workbench-web && npm test`
- Run the checks for the part you changed, and report what actually ran.

## The mod's engine rules

These aren't obvious, and breaking them fails at load time or in tests.

- **`$` stays in `hooks/register.js`.** It is the only file that touches `$`. It wraps each call's
  `$` in `host($)` and hands the rest of the mod an `io` adapter. A new capability gets added to
  `host()` first.
- **Atoms are read where they're declared.** Session atoms live in `register.js`, and other modules
  reach them through `io.read(key)` and `io.update(key, fn)`.
- **Never shadow `next`** in a hook handler.
- **`tsc` doesn't check the hooks' JS** (`checkJs` is off), so ESLint is the safety net for
  undefined names and bad imports.
- A change to a hook, a runner or a decision point also needs updates in three places:
  - `workbench/ARCHITECTURE.md`;
  - the lifecycle diagram and the hooks table in `site/architecture.html`;
  - the version in `.claude-plugin/plugin.json` and in the footers on `site/`.

## Workbench Web

- **Dependencies:** three packages (`claude-agent-sdk`, `@receptron/laya`, `graphql`). Ask before
  adding any. The UI is plain JS with no build step.
- **Server:** it listens on 127.0.0.1 only, and each API call needs the per-launch token from
  `.claude/workbench-web.runtime.json`.
- **REST and GraphQL** share their edit functions in `server.mjs`. When you change one, change the
  other and `graphql.mjs`'s schema.
- **Remote trackers:**
  - each tracker is one file in `remotes/` and one reader in `READERS`;
  - they are mocks: Jira and GitHub Issues;
  - every reader returns the same item shape.
- **Decisions (Laya):** `decisions/`. Exact rules are checked in code, and the model only answers
  typed questions. Code standards live in `.claude/workbench-standards.json`.

## Site

- Plain HTML and CSS: no frameworks, bundlers or script tags. A rule in
  `.claude/workbench-standards.json` enforces this.
- When `styles.css` changes, bump `styles.css?v=` on every page.
- Keep it concise. The READMEs hold the detail.

## Don't commit

`.claude/settings.local.json`, `.claude/workbench-web.local.json`,
`.claude/workbench-web.runtime.json` (all in `.gitignore`), `node_modules/` and debug logs.
