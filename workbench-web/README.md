# Workbench Web

Run one Claude session per feature and manage them all from the browser. Features are the same
`.claude/features/*.json` files the Workbench mod uses, so the two work side by side.

## Install and run

Requires Node 20 or later and a working Claude Code login (sessions use it; no API key is needed).

    npm install
    node server.mjs ~/source/mods          # the project whose features you want to work on
    open http://localhost:4477

- The project folder defaults to the current directory. Claude works in that folder, and features
  are read from `<project>/.claude/features/`.
- The port defaults to 4477. Change it with `--port 5000` or `PORT=5000`.
- `npm start` runs `node server.mjs` against the current directory; `npm test` runs the tests.
- The docs site (`../site`) is served read-only at `/docs/`, with no token needed.

Claude sessions use your existing Claude Code login, including your user, project and local
Claude Code settings. The server listens on 127.0.0.1 only, and every
API call needs a per-launch token that only the served page knows. After a server restart the page
reloads itself to pick up the new token.

## What you can do

- **Experiences** group features. Click an experience in the sidebar for its overview: shared context,
  a card per feature with its status, quick-add, and "Start ready features". The shared context is
  added to the brief of every feature in it. Move a feature between experiences from its header.
  Links are shareable within the browser: `#/e/<experience>` and `#/f/<feature>`.
- **Start a feature.** Claude gets a brief built from the title, description, experience, remote
  issue and context items, then works in the project folder.
- **Add context** to a feature before starting it. Each item's result is added to the brief:
  `file` (a path in the project, read when you press Start), `command` (a shell command run in the
  project, 15 s timeout), `url` (fetched), or `note` (plain text). Long results are cut at 20,000
  characters.
- **Approve tools and answer questions** in cards that appear in the transcript. Allow, Deny (with
  an optional reason), or "Always allow" when Claude Code offers a permanent rule for that tool. The sidebar badge,
  the tab title, a toast and (optionally) a desktop notification tell you when a feature needs you.
- **Talk to any feature's session** at any time from the message box. Interrupt or stop it from the
  header. A stopped session resumes, with its memory, the next time you send a message, including
  after a server restart. Reset forgets the session so the next Start begins a fresh conversation.
- **Permission mode** per feature: ask before acting, auto-accept edits, plan only, or auto.
- **Plan first.** Tick "Plan first" on an experience (or set `"planFirst": true` in
  `<project>/.claude/workbench.json` for every feature without an experience setting) and new
  sessions there open in plan mode and plan before changing anything. Claude's plan appears as a
  card: **Approve plan** switches the session back to the mode it had before planning and lets it
  build; **Keep planning** sends it back with your feedback. The header shows the phase
  (Planning, then Building), and any session that enters plan mode, for example through the
  "Plan it" workflow, gets the same Approve plan button.
- **Workflows** from the shared registry run on any feature (see below).
- **Remote** tab lists Jira epics and stories and GitHub issues. Pull one, or a whole epic or
  parent issue, to create a local feature linked to it (see below).

## System notifications

On macOS the server posts to Notification Center when a feature needs you or finishes its turn, so you are told even with no browser open. By default it does this only while no Workbench page is connected, since an open page sends its own browser notifications (press "Enable notifications" once). Start with `--os-notify always` to get them regardless, or `--os-notify off` to stop them; `WORKBENCH_WEB_OS_NOTIFY` does the same.

## Workflows registry

`registry/workflows.json` holds workflows every feature can use. A project can add or override
entries (matched by `id`) in `<project>/.claude/workbench-workflows.json`.

```json
{ "id": "review", "name": "Review changes", "kind": "prompt",
  "description": "Shown as the tooltip.",
  "template": "Review the uncommitted changes for \"{{feature.title}}\"…" }

{ "id": "git-status", "name": "Git status", "kind": "script",
  "command": "git status --short --branch" }
```

- `prompt` sends the filled template to the feature's session. Optional `mode` switches the
  permission mode first (the "Plan it" example uses `plan`).
- `script` runs the command in the project folder and shows the output, with a button to send it
  to Claude.
- Template variables: `{{feature.title}}`, `{{feature.id}}`, `{{feature.description}}`, `{{remote.url}}`.

The stubs: Plan it, Review changes, Write tests, Draft PR description, Git status, Run tests.

## Shared with the Workbench pane

The Workbench mod's pane in Claude Code drives the same sessions as the browser. For features on
its `web` runner, start, answer, message, interrupt, stop, reset, change the mode or approve a plan
in either view, and the other sees it.

- When the server starts listening it writes `<project>/.claude/workbench-web.runtime.json` with its
  port, token and process id (readable only by you), and removes it on shutdown. That is how the mod
  finds the server and authenticates; keep it out of git.
- `GET /api/state?feature=<id>&tail=40` returns every session's summary, the recent transcript of one
  feature (long text cut) and a `version` that changes whenever anything does, so a polling client
  can skip unchanged state. The pane polls it about every 1.5 seconds.
- `POST /api/features/<id>/approve-plan` (body `{ "note"? }`) approves the plan of a session that is
  planning: the session returns to the mode it had before planning and builds. A plan Claude
  presented with `ExitPlanMode` is approved by allowing that call.
- Features on the mod's other runner, `session`, run as subagents inside a Claude Code session. They
  never reach this server, so the browser does not show them; the pane shows both.

## GraphQL API

`POST /api/graphql` exposes the same features, experiences, sessions, workflows and remote items
as the REST calls, so the Workbench plugin and other tools can drive Workbench Web. The schema is in
`graphql.mjs` (`typeDefs`), and introspection works with any GraphQL client. Plan phases and
`approve-plan` are REST only for now.

- **Queries:** `project`, `features(status, experience)`, `feature(id)`, `experiences`, `experience(id)`,
  `workflows`, `remoteItems`, `remoteSources`, `needsYou`. A `Feature` links to its `experience` and `session`
  (status, mode, cost, pending requests, last N transcript `events`).
- **Mutations:** create/update features, add/remove context, create/update/delete experiences,
  `startSession`, `sendMessage`, `interruptSession`, `stopSession`, `resetSession`, `setMode`,
  `answerRequest`, `runWorkflow`, `pullRemote`.
- Live updates stay on the SSE stream (`GET /api/events`); there are no subscriptions.
- It needs the same token as every other API call. To call it from outside the page, start the server
  with your own token (32+ characters) in `WORKBENCH_WEB_TOKEN`:

```bash
WORKBENCH_WEB_TOKEN=$(openssl rand -hex 24) node server.mjs ~/source/mods
curl -s localhost:4477/api/graphql -H "x-workbench-token: $WORKBENCH_WEB_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"query":"{ needsYou { featureId pending { toolName input } } }"}'
```

Queries nested more than 8 levels are rejected. Bad queries return HTTP 400; resolver errors
(for example an unknown feature id in a mutation) return 200 with `errors`, as usual for GraphQL.

## Remote

Two remote trackers, both mocked so you can try the flow without credentials. Each file in
`remotes/` is one tracker; its name is the source id and its `kind` picks how it's read:

| Source | File | Groups | Items |
| --- | --- | --- | --- |
| Jira | `remotes/jira.json`: `items` with `id, type (Epic or Story), epic, title, description, status, labels` | epics | stories, whose `epic` names their epic |
| GitHub Issues | `remotes/github.json`: `repo` and `issues` as the REST API returns them (`number, title, body, state, labels, parent`) | issues with sub-issues | issues, whose `parent` names their parent |

To use a real tracker, make its reader in `server.mjs` (`READERS`) fetch instead of reading the file.

The Remote tab has a section per tracker. Each group is shown with its items under it, followed by items that have no group. You can pull either kind:

- **Pull story** or **Pull issue** creates one feature: `wb-101` for a Jira story, `github-42` for a
  GitHub issue. Its brief names the group it belongs to.
- **Pull epic** or **Pull parent issue** creates one feature for the whole group. Its brief lists every
  item in the group with its description, read fresh from the tracker when you press Start.

A pulled feature goes to the experience you're looking at. If you aren't looking at one, an item
goes to the experience its group was pulled into. Failing both, it goes to the experience whose
**Remote labels** match its labels. Labels work the same for both trackers. Each unpulled item
shows its target as `→ Experience`, and a pulled item shows "Open feature".

The feature's `remote` field records the source, id, ref (`WB-101`, `example/workbench#42`), type, group,
URL, status and labels. `POST /api/remotes/pull` takes `{ source, id }`; `source` can be left out
when only one tracker has that id. `GET /api/remotes/sources` lists the trackers.

## Where state lives

| What | Where | Shared through git? |
| --- | --- | --- |
| Features | `<project>/.claude/features/<id>.json` | yes |
| Experiences | `<project>/.claude/experiences/<id>.json` (features point to one with `experience`) | yes |
| Project workflows | `<project>/.claude/workbench-workflows.json` | yes |
| Code standards for decisions | `<project>/.claude/workbench-standards.json` | yes |
| Decisions settings, remote and project defaults | `<project>/.claude/workbench.json` | yes |
| Session id, mode, cost, plan phase per feature | `<project>/.claude/workbench-web.local.json` | no, add it to `.gitignore` |
| How to reach the running server (port, token) | `<project>/.claude/workbench-web.runtime.json`, while it runs | no, add it to `.gitignore` |
| Conversations | Claude Code's own session transcripts | no |

## Decisions (Laya)

A local decision model, Laya (`@receptron/laya`, run in this process), can judge the work around
each feature's agent. It answers typed questions in one fast pass and never writes text: every
message Claude or you read is written in `decisions/judge.mjs` from your standards. Off unless
configured in `<project>/.claude/workbench.json`:

```json
{ "decisions": { "provider": "laya", "mode": "shadow" } }
```

| Judgment | When | Acting ("on" mode) |
| --- | --- | --- |
| Approach | an unstarted feature is opened (`POST /api/features/<id>/assess`) | a feature with no approach of its own starts in plan mode when planning is recommended |
| Tool calls | `canUseTool`, after `policy.mjs` | a broken standard is denied back to Claude with what to do instead; a command judged read-only with high confidence runs |
| Plans | Claude presents a plan (`ExitPlanMode`) | checks shown on the plan card; a failing plan goes back to Claude, at most `maxAutoRevisions` times |
| Turn ends | a turn ends waiting for you | an unsupported claim ("tests pass" with no test run) or unfinished work gets a follow-up, at most `maxFollowUps` in a row |

- **Shadow first.** `"mode": "shadow"` records every judgment in the transcript as a `decision`
  event and acts on none; `"on"` acts. Questions and plan approval are never decided for you, and an
  error or a timeout (`timeoutMs`, default 4000) means no judgment.
- **Standards.** Exact rules and judged sentences, built in (`decisions/standards.mjs`) plus the
  project's `.claude/workbench-standards.json`, shared through git.
- **Model.** The first start downloads about 1.7 GB of weights to `~/.cache/receptron-laya`; the
  loaded model uses about 2 GB of memory. `"provider": "http"` with a `url` uses any server speaking
  `POST /v1/systemone` instead: a Laya server, or TypeSafe's Jev (`"keyEnv"` names the environment
  variable holding the key, and `"model": "jev-latest"`).
- **For other runners.** `POST /api/decide` returns one judgment without acting on it; the Workbench
  mod uses it for agents running inside a Claude Code session.
- **Your own policy** in `policy.mjs` (`autoDecide`) runs before any judgment. Always return `null`
  there for `AskUserQuestion` and `ExitPlanMode`.

The full guide, with settings and the standards file's fields, is `site/laya.html`.

## Safety notes

- Context items of type `command` run on your machine when you press Start, and feature files are
  shared through git. Read commands you didn't write before starting a teammate's feature.
- "Auto-accept edits" and "Auto" let Claude change files without asking. "Ask before acting" is the
  default for every feature.
