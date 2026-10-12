# Workbench architecture

This document describes how the workbench mod (v0.6.0) is built: its parts, how state moves between them, and the choices and limits behind them. The README covers how to use it.

## 1. What the mod does

Workbench lets you work several features at once and watch every agent working on them from one place.

| Concept | What it is | Where it lives |
|---|---|---|
| **Feature** | A unit of work: title, description, context, workflows | `.claude/features/<id>.json`, shared through git |
| **Experience** | A named group of features with shared context | `.claude/experiences/<id>.json` |
| **Context provider** | Something a feature's prompts and agents read: `file`, `command`, `url`, `note`, `mcp` | `feature.context[]` |
| **Workflow** | A named action: a shared registry entry or the feature's own `script` / `skill` | registry in `lib/constants.js` and `.claude/workbench-workflows.json`; `feature.workflows[]` |
| **Runner** | Where a feature's agent runs: `session` (a subagent of this Claude Code session) or `web` (a Workbench Web session) | chosen per feature, experience or project |
| **Observer** | What tells you about every agent, on any runner | hooks and a poll timer feeding one session atom |
| **Decisions** | A local Laya model judging approach, tool calls, plans and turn ends against your standards | Workbench Web (`decisions/`); the mod asks it for in-session agents |
| **Remote source** | An MCP server that lists and fetches features | `.claude/workbench.json` |

## 2. Where it sits

```
                       Claude Code (the host)
  you ── /feature, /wb, pane keys ──┐
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ hooks/register.js   the only file that touches $                         │
  │   atoms + host($) adapter  ──►  every hook calls its handler with `io`   │
  └──────┬────────────────┬─────────────────┬───────────────────┬────────────┘
         ▼                ▼                 ▼                   ▼
   lifecycle.js      commands/*.js      pane/*.js            lib/*.js
   start, resume,    one per slash      the Workbench pane   features, experiences,
   prompt brief      command                                 context, workflows,
                                                             runners, observer
         │                                                        │
         │  runner "session"                                      │  runner "web"
         ▼                                                        ▼
  subagents of this session                              Workbench Web (workbench-web/)
  ($.agent.spawn, $.session.send)                        one Agent SDK session per feature
  observed by tool.call / turn.complete                  observed by polling GET /api/state
```

The mod has no build step and no dependencies. All I/O goes through the host: files, processes, HTTP, MCP calls, subagents and the UI.

## 3. Package layout

```
hooks/hooks.json             points the host at ./register.js
hooks/register.js            atoms, the host($) adapter, and on(...) wiring: nothing else
hooks/lifecycle.js           session.start, classic.SessionStart, prompt.submit
hooks/commands/              index.js (the command list) and one handler per command:
                             workbench.js, experience.js, feature.js, ctx.js, workflow.js
hooks/pane/render.js         the ui.render handler: reads state once, picks the view
hooks/pane/kit.js            shared pane vocabulary (rows, cards, keys, top bar, footer)
hooks/pane/home.js, experience.js, remote.js, feature.js
hooks/pane/feature-asks.js   cards for what waits on you: tool permissions, questions, plans
hooks/pane/feature-conversation.js   the transcript and the Message field
hooks/lib/state.js           atom keys, the pane object, the link object
hooks/lib/sessions.js        the observer's shared part: poll, merge, toasts, status line, actions
hooks/lib/session-runner.js  the in-session runner and its two hook handlers
hooks/lib/decisions.js       in-session agents' tool calls and turn ends judged by Workbench Web
hooks/lib/runner.js          which runner a feature uses
hooks/lib/web.js             finding, starting and calling Workbench Web
hooks/lib/status.js          state words, glyphs, theme colors, one-line summaries
hooks/lib/features.js, focus.js, experiences.js, context.js, brief.js, workflows.js,
             mcp.js, remote.js, paths.js, notify.js, util.js, constants.js
types/index.d.ts             the state contract (PluginState.workbench)
tests/*.test.ts              scenarios on claude-code/testing; tests/fake-web.ts fakes the server
```

No file is longer than about 270 lines, and each has one job named in its first comment.

## 4. The one rule: `$` stays in register.js

The engine reads a hooks module statically to learn what it can do. It follows `$` only into functions declared in the same file, and refuses a module that passes `$` across an import. It also requires every atom read or write to name an atom declared in that same file.

So `register.js` is the only file that touches `$`:

- It declares the four atoms.
- `host($)` wraps the `$` of one hook call in an adapter shaped like `$` (`io.fs.read`, `io.ui.toast`, `io.agent.spawn`, …) plus `io.read(key)` and `io.update(key, fn)` for the atoms, by the keys in `lib/state.js`.
- Each hook is one line: `on(event, ($, e, next) => handler(host($), e, next))`.

Every other module takes `io` where it would have taken `$`. `claude plugin validate` still lists every capability the mod uses, each traced through `host`. A side benefit: handlers never hold a `$` from an older call, because each hook call builds its own adapter.

## 5. State

| Tier | Holds | Mechanism | Lifetime | Shared? |
|---|---|---|---|---|
| Disk | Features, experiences, remote and project config | `io.fs` on `.claude/` | Permanent, in git | With the team |
| Plugin store | Last focused feature, `osNotify` | `io.store` | Across sessions | No |
| Session atoms | `activeFeatureId`, `sessions`, `transcript`, `serverState` | declared in `register.js`; `io.read` / `io.update` | This session; survive a hot reload | No |
| Module objects | `pane` (view, picks, armed button, …) and `link` (server, poll timer, last version) in `lib/state.js` | plain objects | Until a reload | No |

Writing an atom redraws every pane that read it, so nothing calls "refresh": the observer writes state, and the pane follows. Module state is kept in two exported objects because ES modules cannot reassign an imported `let`.

Feature files hold only shared, long-lived data. Agent state is never written to them, so a commit never carries one person's run status.

## 6. The observer

The observer is not one hook. It is two inputs, one piece of state, and the views drawn from it.

```
 inputs                                   state                    outputs
 tool.call (ask_user)   ─┐                                         pane (ui.render reads atoms)
 turn.complete          ─┼─ runner "session" ─┐                    status line
                         │                    ├─► sessions atom ──► toasts
 $.clock.every(1500)    ─┴─ runner "web" ─────┘   (one record per  macOS notifications
   → GET /api/state                                feature, tagged
                                                   with its runner)
```

- **In-session agents push.** The engine raises `tool.call` when an agent calls the mod's `ask_user` tool, and `turn.complete` when its turn ends. `lib/session-runner.js` turns each into a record update, a toast and, unless turned off, a notification.
- **Workbench Web is polled.** `$.http.fetch` resolves only once a whole response is read, so the mod cannot hold the server's event stream open. A 1.5 s timer started at `session.start` calls `/api/state`, skips the work when the server's version number has not moved, and diffs the result against the last one to raise toasts (`announceChanges`).
- **One record shape.** Both write `{ featureId, runner, status, live, sessionId, mode, cost, phase, pending[] }`. Status is one of `idle`, `running`, `needs-you`, `ready`, `paused`, `error`, and `pending` lists tool permissions, questions and plans in Workbench Web's shape. An in-session agent's `ask_user` question is stored as a question in that shape, so the same card answers both.
- **Merging.** A poll rewrites the web records and keeps every `session` record (`{ ...web, ...inSession(current) }`, inside the atom update so a hook write in between is never lost).

Everything the user sees reads that atom: Home's rows and runner tags, the counts in the top bar and status line, `n` (the next feature waiting), and the Feature view.

## 7. Runners

`runnerFor(feature)` takes the feature's `runner`, else its experience's, else `"runner"` in `.claude/workbench.json`, else `web`. Once an agent exists, its record decides: actions go to the runner that holds it. `featureCall` in `lib/sessions.js` is the one dispatch point.

### Session runner (`lib/session-runner.js`)

- **Start:** `io.agent.spawn` a `general-purpose` subagent whose prompt is the brief plus three rules: ask only through `mcp__workbench__ask_user` (registered at `session.start` with `io.tool.register`), then end the turn; never ask in plain text; finish with a summary.
- **Ask:** the `tool.call` hook matches the call's `agentId` to a record (or adopts the agent when it names a known feature), marks it `needs-you`, and tells the agent to end its turn. The agent holds nothing open while it waits.
- **Answer, message, interrupt:** `io.session.send` to the agent, which starts its next turn.
- **Finish:** `turn.complete` marks it `ready` (or `error`) and keeps the last message as the summary and in a short transcript (the record's `events`, at most 40).
- **Stop or reset:** the host cannot kill a subagent, so a busy one is asked to stop and its record is dropped; anything it does later matches nothing.
- **Limits:** no permission mode, plan phase or browser view; its own tool permissions go through Claude Code's prompts; it ends with this Claude Code session.

### Web runner (`lib/web.js`, `workbench-web/`)

- **Finding the server:** Workbench Web writes `.claude/workbench-web.runtime.json` (port and token, mode 0600) when it starts listening. The mod reads it, calls `127.0.0.1` with the token, and on a 401 or no answer reads it once more, so a restarted server is picked up. If no server runs, the first action that needs one starts it (`startWeb`) and waits for the file.
- **Calls:** `$.http.fetch` first; when the host refuses loopback, `curl -K -` with the config (token included) on stdin, so the token never appears in `ps`.
- **Actions:** `POST /api/features/<id>/start | message | answer/<pending> | interrupt | stop | reset | mode | approve-plan | workflow/<id>`.
- **Plan first and phases:** the server opens a plan-first feature's session in plan mode. Entering plan mode by any route records the mode to return to and sets `phase: 'planning'`; approving (`approve-plan`, or allowing Claude's `ExitPlanMode`) switches back and sets `'building'`.
- **Lifetime:** sessions resume from their saved ids after a server restart; a turn in progress is lost. A server the mod started stops with that Claude Code session.

## 8. Decisions

Workbench Web holds the decisions (`workbench-web/decisions/`): a System One provider (Laya in-process, or any `POST /v1/systemone` server), the standards (built in, plus the project's `.claude/workbench-standards.json`), and four judgments: approach, tool call, plan review, turn end. A judgment is a few typed questions; the model only picks answers, and every message is written from the standards. Each one is recorded in the transcript as a `decision` event, and acts only in `"on"` mode.

The mod takes part for agents that never reach the server's permission flow:

- `tool.call` (any tool, `lib/decisions.js`): for an in-session agent's call, note it in the record's `turnTools`, then send an edit or a command to `POST /api/decide`. A deny in `"on"` mode returns `{ deny }` with the standard; anything else calls `next(e)`. It never approves.
- `turn.complete` (`lib/session-runner.js`): after the agent's turn ends with it waiting for you, `checkSessionTurn` sends its summary and `turnTools`; in `"on"` mode an issue becomes a follow-up through `$.session.send`, at most twice in a row.
- The pane reads the server's approach `assessment` from the session record and the decisions status from `/api/state`; `o` writes the feature's own `approach`.

Judgments need the server: without it, in-session agents go unjudged, and nothing else changes.

## 9. Commands, the brief and workflows

- Each `commands/*.js` exports one handler that parses with `splitFirst` and returns `{ text }` or opens the pane.
- `lib/brief.js` builds the brief: header, experience and siblings, the live remote item, every context provider resolved at that moment, and the workflows. `prompt.submit` adds it to every prompt while a feature is focused, and the session runner uses it as an agent's first message. Workbench Web builds its own brief with the same parts.
- A prompt workflow goes to the feature's session: by id on Workbench Web, or as its text otherwise. Script workflows run here and show their output in the pane.

## 10. Testing

- `tests/` runs on `claude-code/testing`, against the engine. Each test stands for the engine beneath the mod: in-memory files, faked `process.run`, `agent.spawn`, `session.send` and `turn.complete`.
- `tests/fake-web.ts` is an in-memory Workbench Web behind `http.fetch`, with the same routes, token check and statuses, plus helpers that play the agent (ask a question, ask for a tool, present a plan, finish a turn).
- `mock.clock` drives the poll timer, so a test can advance time and see the observer react.
- `tests/fake-web.ts` also scripts decisions: their status, `/api/decide` answers by kind, and plan reviews.
- Covered: context in prompts; decisions for in-session agents (denied when on, recorded in shadow, a turn follow-up) and in the pane (plan checks, the approach suggestion and key); both runners, alone and side by side under one observer; questions, tool permissions, multi-select questions and plans answered from the pane and the command line; plan first; stop, reset and confirmations; experiences, workflows and remote sources.
- Checks: `claude plugin validate .`, `claude plugin test .`, and `npx -p typescript tsc -p .` (tests and types only: the hooks are plain JS and `checkJs` is off, so a linter such as ESLint's `no-undef` is the check for the hooks themselves).

## 11. Known limits and risks

| # | Area | Issue | Direction |
|---|---|---|---|
| 1 | Security | Feature files come through git, and `command` providers and `script` workflows run `sh -c` from them: a teammate's feature runs commands on your machine on every prompt while it is focused. | Confirm on first run, or trust by hash when someone else last changed the file. |
| 2 | Security | Any process running as you can read the runtime file's token and drive Workbench Web agents. | Keychain or a per-client token; keep the server on 127.0.0.1. |
| 3 | Two writers | The mod and Workbench Web both rewrite feature and experience files; the last write wins. | Make the server the only writer and reject stale `updatedAt`. |
| 4 | Duplication | The brief, the workflow registry and the plan-first lookup exist in both the mod and the server, and already differ (context limits, the Plan it workflow's mode). | Let the runner own them; the mod asks it. |
| 5 | Lifetime | In-session agents end with this Claude Code session; a server the mod started does too. | Run Workbench Web on its own for long work. |
| 6 | Polling | The pane is up to 1.5 s behind Workbench Web and sees the last 40 transcript entries, cut. | Fine locally; remote runners want streaming. |
| 7 | Stop | The host cannot stop a subagent; a stopped in-session agent may finish its current step. | None in the mod. |
| 8 | Checking | `tsc` does not check the hooks. | Turn on `checkJs` or add a linter to the checks. |
| 9 | Decisions | Laya reads about 512 tokens of each state, so large edits are judged from their start; the shipped checkpoints are over-confident. | Shadow mode first, thresholds tuned on your own calls; rules for anything exact. |

## 12. Extending

- **A new runner** (a container, a cloud agent): add its name to `RUNNERS`, give `featureCall` a branch for its actions, and feed the observer by writing records with that `runner` into the `sessions` atom from a hook or the poll. The pane needs no change beyond its label in `runnerLabel`.
- **A new context type:** add it to `CONTEXT_TYPES`, parse it in `parseContextSpec`, resolve it in `resolveProvider`, and give it a placeholder in the Feature view.
- **A new workflow kind:** add it to `WORKFLOW_KINDS` and a branch to `runWorkflow`.
- **A new hook:** add one `on(...)` line to `register.js` calling a handler with `host($)`, and anything new it needs from `$` to the adapter.
- **A new remote tracker:** config only (`.claude/workbench.json`).
