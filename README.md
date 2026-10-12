# Workbench

Work on several features at once with Claude Code: one agent per feature, and one place that tells
you when any of them needs you.

| Folder | What it is |
| --- | --- |
| `workbench/` | The Claude Code mod: the Workbench pane, `/feature`, `/experience`, `/ctx`, `/workflow`. |
| `workbench-web/` | Workbench Web: a local Node server that runs a Claude session per feature, driven from the browser or the pane. |
| `site/` | The docs site, plain HTML and CSS. Workbench Web serves it at `/docs/`. |

## Quick start

Needs Node 20+ and Claude Code, logged in. No API key.

```sh
./setup.sh                            # checks both, installs workbench-web's packages
node workbench-web/server.mjs .       # Workbench Web → http://localhost:4477, docs at /docs/
claude --plugin-dir ./workbench       # in a second terminal, then: /workbench
```

Both work on the features in this folder's `.claude/features/`. Point them at another project by
running them from there instead: `node ~/source/mods/workbench-web/server.mjs .` and
`claude --plugin-dir ~/source/mods/workbench`.

Things to try:
- In the browser, open the **Remote** tab and pull a Jira story or a GitHub issue. Both trackers
  are mocks, so you need no credentials. Then press **Start**.
- In Claude Code, run `/feature new Fix the footer` and then `/feature start`. Press `n` to jump
  to whichever agent needs you.

Docs are at http://localhost:4477/docs/ while the server runs. `site/` is plain static files, so it
can also be hosted on its own or opened with `cd site && python3 -m http.server 8000`.

## Optional: Laya decisions

A local model judges each agent's work:
- whether a feature should be planned first;
- whether an edit breaks your standards (`.claude/workbench-standards.json`);
- whether a plan says how it will be verified;
- whether a turn's claims hold up.

It runs on your machine with no key, but it's **off by default** because its weights are about
1.6 GB and too big to ship in the repo. To switch it on:

```sh
./setup.sh --laya                     # downloads the weights once, sets provider to "laya"
```

Then restart Workbench Web. Or edit `.claude/workbench.json` yourself: set `"provider": "laya"` and
the weights download the first time the server starts.

- **Shadow mode is the default.** Judgments show as `◆ Laya` lines and nothing acts. Set
  `"mode": "on"` once its calls match yours.
- **Its accuracy on code is rough so far.** It's good at spotting destructive commands, unfinished
  work and unverified "tests pass" claims, but weak at naming which standard an edit broke.
- **To switch it off,** set `"provider": "off"`.

See `site/architecture.html#laya` and `workbench-web/README.md`.

## Checks

```sh
cd workbench && claude plugin validate . && claude plugin test   # the mod: 30 tests
cd workbench && npx eslint@9.39.1 hooks                          # the mod's JS (tsc doesn't check it)
cd workbench-web && npm test                                     # the server: 18 tests
```

## Where to read more

- `workbench/README.md`: commands, the pane, context and workflows. `workbench/ARCHITECTURE.md`: how the mod is built.
- `workbench-web/README.md`: the browser UI, the API (REST and GraphQL), the remote trackers, decisions.
- `site/`: the same story, with diagrams.
