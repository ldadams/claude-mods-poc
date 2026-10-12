# workbench

A Claude Code mod for working several features at once.

- **Features** are units of work. Each is a JSON file under `.claude/features/`, so a team shares them through git.
- **Experiences** group features. Each has shared context that every feature in it gets in its brief.
- **Context** is what a feature's prompts and agents read: files, shell commands, URLs, notes, and MCP tool calls, configured per feature.
- **Workflows** come from a shared registry every feature can use, plus each feature's own: a `prompt` or `skill` asks Claude, a `script` runs a shell command.
- **Agents** work features in the background, one per feature, as many as you like at once, on one of two **runners**: as subagents inside this Claude Code session, or as sessions in Workbench Web, which the pane and the browser both drive.
- **One observer** watches all of them, whichever runner they are on, and tells you in the status line, a toast and a system notification when one needs an answer or finishes. Reply from the pane, the browser or the command line.
- **Decisions** (optional): a local decision model, Laya, judges the work around each agent: whether a feature should be planned first, whether an edit breaks your code standards, whether a plan says how it will be verified, and whether a turn's claims hold up. Shadow mode shows what it would do before it acts.
- **Remote sources** load features from any MCP server (GitHub, Linear, Jira, your own).

## Try it

```bash
cd workbench && claude --plugin-dir .
```

```
/workbench                                   open the pane
/feature new Checkout redesign
/ctx add file src/checkout/Cart.tsx
/ctx add command git log -5 --oneline
/ctx add note Ship behind the checkout-v2 flag
/ctx add mcp github get_issue {"owner":"acme","repo":"shop","issue_number":123}
/workflow add tests script npm test
/feature start                               an agent starts on the active feature
```

While a feature is active, every prompt you type carries its context. Start a few features and the status line reads `workbench  ? 1 needs your answer · ● 2 running`. Press `/workbench`, pick the feature that needs you, type the answer, Enter. The agent picks up where it stopped.

## Experiences

An experience is a named group of features, stored as `.claude/experiences/<id>.json` (`{ id, title, description }`); a feature joins one with an `experience` field. Its description is shared context: every feature in the experience gets it in its brief, along with the names of its sibling features.

```
/experience new Checkout
/experience describe checkout Ship behind the checkout-v2 flag. Mobile first.
/experience add checkout cart-redesign
/experience start checkout        starts an agent on each feature that has a description or context and no agent yet
/experience list | show <id> | remove <feature> | delete <id>
```

In the pane, Home groups features under their experience. Select an experience's row to open it: its shared context, its features, and a field to add one straight into it. A feature's own view has a picker to move it between experiences.

## Shared workflows

Every feature can run the workflows in the registry: Plan it, Review changes, Write tests, Draft PR description (prompts), and Git status, Run tests (scripts). A project adds or overrides entries by `id` in `.claude/workbench-workflows.json`:

```json
{ "workflows": [
  { "id": "run-tests", "name": "Unit tests", "kind": "script", "command": "make test" },
  { "id": "changelog", "name": "Changelog entry", "kind": "prompt", "template": "Write a CHANGELOG entry for \"{{feature.title}}\"." }
] }
```

A prompt workflow goes to the feature's agent when it has one, resuming it; otherwise it runs in this session with the feature made active. Template variables: `{{feature.title}}`, `{{feature.id}}`, `{{feature.description}}`, `{{remote.url}}`. Run one with `/workflow run <id or name>` or from the feature's view. Workbench Web reads the same file.

## In the browser, and back

Agents on the `web` runner (the default; see [Runners and the observer](#runners-and-the-observer)) run in Workbench Web (`workbench-web/`), a local server that holds one Agent SDK session per feature. The pane and the browser are two views of those sessions:

- Start a feature in the pane, approve its tool calls in the browser, send a follow-up from the pane. It is one conversation with one transcript, and it keeps going when you close either view.
- The pane polls the server about every 1.5s for each feature's state (working, needs you, your turn, paused, error), what is waiting on you, and the open feature's last 40 transcript entries. The browser gets the same over a live event stream.
- Starting an agent from the pane starts the server first if it is not running. `/workbench web` (or `w` on Home) does that by hand and shows the link. A Feature view's "open in browser" link goes straight to that feature.
- The server writes `.claude/workbench-web.runtime.json` (its port and token, readable only by you) so the mod can find it. It is in `.gitignore`.
- Sessions resume after a server restart from their saved session id. A session started by the server stops when the Claude Code session that started it ends; one you started yourself (`node server.mjs <project>`) keeps running.

By default the mod looks for `workbench-web/` in the project root on port 4477; set `"web": { "dir": "<path>", "port": 4477 }` in `.claude/workbench.json` to change that.

## The pane

`/workbench` (or `/wb`) opens one pane with three views.

Every view has the same top bar: where you are on the left; on the right, how many features need you, are working, wait on your turn or failed, and whether Workbench Web is up (`web ✓`, with how many browsers have it open, or `web off`). Colors come from your Claude Code theme, so the pane matches light and dark themes. `n` jumps to the next feature waiting on your answer, oldest question first, from any view.

- **Home** lists every feature, grouped by experience, with its session state: `?` needs you, `●` working, `✓` your turn, `‖` paused, `✗` error, `○` not started, and where a started agent runs (`· in session` or `· web`). Features that need you float to the top, and one with nothing for an agent to work from is marked *needs a description*. `1` to `9` opens a row, `r` opens remote sources, `s` starts an agent on every ready feature and names any it skipped. A text field creates a new feature.
- **Experience** shows one experience: its shared context, its features, a field to add one, `s` to start the ready ones, `r` to choose where their agents run, and `p` to turn plan first on or off.
- **Feature** shows one feature and its session: a card for each thing waiting on you (a tool to allow, always allow (`y`, `l`) or deny (`d`, or with a reason), or Claude's question with its options on `1`–`9` and a field for your own answer), the conversation (your messages, Claude's replies as Markdown, tool calls and their first result line; `m` for more), the permission mode (Workbench Web only), a Message field for the next message, then its description, context providers and workflows. `b` back, `s` start, `r` choose the runner and `o` the approach (before it starts; Laya's suggestion shows under the title), `p` approve the plan, `i` interrupt, `x` stop (resume by sending a message), reset conversation, `u` focus prompts on this feature, `a` archive. Stop, reset and delete ask for a second press.
- **Remote** lists what each configured source has, with a load button per item.

A feature is ready to start when it has a description or at least one context provider. The status line shows the focused feature (`▸ Title`) whenever one is set, so you can see that your prompts carry its context.

Esc closes the pane. The commands below do the same things without it.

## Commands

```
/workbench [feature|web]
/experience [new <title>|list|show <id>|describe <id> <text>|runner <id> session|web|default|planfirst <id> on|off|add <experience> <feature>|remove <feature>|start <id>|delete <id>]
/feature   [new <title>|switch <id>|start [id]|describe [id] <text>|runner [id] session|web|approve [id] [note]|answer <id> <text>|say <id> <text>
            |interrupt [id]|stop [id]|reset [id]|status|notify [on|off|test]|list
            |remote [source]|pull <source>:<id>|archive <id>|delete <id>]
/ctx       [add <file|command|url|note> <value>|add mcp <server> <tool> [json args]|remove <id>|list]
/workflow  [run <id|name>|list|add <name> <skill|script> <target>|remove <name>]
```

`command` providers and `script` workflows run through `sh -c`, so quoting and pipes work.

## Runners and the observer

Each feature's agent runs on a **runner**:

| Runner | Where the agent runs | How the observer hears about it | Lives as long as |
|---|---|---|---|
| `session` | A background subagent of this Claude Code session | Events: the `tool.call` hook sees its `ask_user` question, the `turn.complete` hook sees its turn end | This Claude Code session |
| `web` | A session in Workbench Web, a local server | A timer: the pane polls the server every 1.5s | The server |

A feature names its runner (`r` in its view before it starts, or `/feature runner [id] session|web`); otherwise its experience does (`r` in the Experience view, or `/experience runner <id> session|web|default`); otherwise `"runner"` in `.claude/workbench.json`; otherwise `web`.

**The observer** is the mod's hooks plus one piece of state. Both inputs (the in-session hooks and the poll) write each feature's record into the same session atom, marked with its runner, and everything you see is drawn from that: Home lists every agent with a `· in session` or `· web` tag, the status line counts across both, `n` jumps to whichever is waiting, and toasts and notifications fire the same way. Actions go back to the runner that owns the feature.

What differs: in-session agents ask through the mod's `ask_user` tool and have no permission mode, plan phase or browser view (their tool permissions go through Claude Code's own prompts). Workbench Web sessions have all three, keep going when this session ends, and can later run somewhere other than this machine.

## How agents work

`/feature start` (or `s`) asks Workbench Web to start the feature's session. Its first message is the brief: title, description, experience and its shared context, the remote item if any, every context provider resolved at that moment, and the workflows. Claude works in the project folder with your Claude Code settings and the session's permission mode.

When Claude wants a tool your settings and the server's policy don't already allow, or asks a question (`AskUserQuestion`), the session is **needs you** and the request waits in both the pane and the browser. Answering in either one clears it in both. When a turn ends, the session is **your turn** until you send the next message. `/feature answer <id> <text>` answers from the command line: the text goes to a waiting question, `yes` allows a waiting tool, `no` denies it, and anything else denies it with that text as the reason.

`prompt` workflows (and a feature's own `skill` workflows) are sent to the feature's session, so both views see them run. `script` workflows run in this session and show their output in the pane.

Session state lives in the server, never in the feature files.

### Plan first

An experience can make its features plan before they build: `p` in the Experience view, or `/experience planfirst <id> on|off`. For features in no experience, `"planFirst": true` in `.claude/workbench.json` sets the project default. A plan-first session opens in plan mode, so Claude reads the code and proposes a plan without changing anything.

When Claude presents the plan, it shows as a card in the pane and the browser. `p` (or `/feature approve [id] [note]`) approves it: the session switches back to the mode it had before planning and builds. Typing in the card's field sends the plan back with your feedback instead. The Feature view shows the phase, *planning* then *building*. Any session that enters plan mode, for example through the Plan it workflow, can be approved the same way.

### Decisions with Laya

When Workbench Web has decisions on (`"decisions": { "provider": "laya", "mode": "shadow" }` in `.claude/workbench.json`), a local Laya model judges the work at four points: the approach for a feature that hasn't started, tool calls against your code standards (`.claude/workbench-standards.json`), Claude's plans, and turn ends. Each judgment shows in the conversation as a `◆ Laya` line; in shadow mode none of them act.

For agents in this session, the mod brings the same judgments: a `tool.call` hook sends their edits and commands to Workbench Web (`POST /api/decide`), and their turn ends are checked the same way. In `"on"` mode the mod denies a call that breaks a standard and sends a follow-up for an unsupported claim; it never approves a tool, which stays with Claude Code's own prompts. Without Workbench Web running, these agents go unjudged.

A feature's approach is yours to set with `o` or `/feature approach [id] auto|plan|direct`; `auto` follows the suggestion when decisions act, otherwise the experience or project setting. The full guide is `site/laya.html`.

### System notifications

On macOS, Workbench Web posts to Notification Center when a session needs you or finishes its turn, while no browser page has it open (an open page sends its own). `/feature notify off` turns that off the next time this session starts the server, `/feature notify on` back on, and `/feature notify test` sends one now. If nothing appears, allow notifications for Script Editor in System Settings > Notifications.

## Remote sources

Name the MCP servers that hold your features in `.claude/workbench.json`:

```json
{
  "sources": {
    "github": {
      "server": "github",
      "list": { "tool": "list_issues", "args": { "owner": "acme", "repo": "shop", "state": "open" } },
      "get":  { "tool": "get_issue", "args": { "owner": "acme", "repo": "shop", "issue_number": "{id}" } },
      "fields": { "id": "number", "title": "title", "description": "body", "status": "state", "url": "html_url" }
    },
    "linear": {
      "server": "linear",
      "list": { "tool": "list_issues", "args": { "assignee": "me" }, "itemsPath": "issues" },
      "get":  { "tool": "get_issue", "args": { "id": "{id}" } },
      "fields": { "id": "identifier", "title": "title", "description": "description", "status": "state.name", "url": "url" }
    }
  }
}
```

- `server` is the server's name as `/mcp` lists it; the mod calls it with your existing connection.
- `list.tool` returns the features; `itemsPath` is where the array sits in its result (blank when the result is the array).
- `get` is optional. It fetches one item, with `{id}` in `args` replaced by the remote id (`itemPath` if the item is nested). Without it, items are looked up in the list.
- `fields` maps dotted paths in each item to `id`, `title`, `description`, `status`, `url`.

`/feature remote` lists what each source has. `/feature pull github:123` (or just `123` with one source) creates `.claude/features/github-123.json`, a local overlay that holds that feature's context and workflows. Pulling again refreshes the title and status and keeps them. While it is active, each prompt and each agent brief carries the item's live title, status, URL and description (cached 60s).

## Changes in 0.6.0

- Two runners behind one observer: a feature's agent runs as a subagent of this session (observed through the `tool.call` and `turn.complete` hooks) or on Workbench Web (observed by polling), set per feature, per experience or for the project. The pane, status line, `n` and notifications cover both, with a runner tag per row.
- Decisions with Laya (Workbench Web): approach suggestions, tool calls checked against `.claude/workbench-standards.json`, plan reviews and turn-end checks, shown as `◆ Laya` lines and acting only in `"on"` mode. The mod brings them to in-session agents through a `tool.call` hook and `POST /api/decide`, and adds `o` and `/feature approach`.
- Plan first, per experience or as a project default: sessions open in plan mode, Claude's plan shows as a card, and approving it (`p`, `/feature approve`) switches back to your mode and builds. The phase (planning, building) shows in the Feature view and the browser.
- hooks/ is split into single-responsibility modules: `register.js` holds the host adapter and the hook wiring, with `lifecycle.js`, `commands/`, `pane/` and `lib/` beside it. Only `register.js` touches `$`; everything else gets an `io` adapter, because the engine follows `$` within one file only.
- Fixed: toggling an option on a multi-select question in the pane threw.

## Changes in 0.5.0

- Agents run in Workbench Web, and the pane is a second front end for the same sessions: start, answer, message, interrupt, stop, reset and set the permission mode from either, and see the same transcript in both.
- The Feature view shows waiting tool permissions and questions as cards, the conversation, and a Message field.
- New commands: `/feature say`, `/feature interrupt`, `/feature stop`. `/feature answer` handles questions and tool permissions.
- Removed: the mod's own subagents and its `ask_user` tool. Pane agents started with 0.4.0 keep running in the session that started them, but nothing in this version tracks them.

## Changes in 0.4.0

- Describe a feature from its view or with `/feature describe`. A feature with a description or any context is ready to start, and "start" names the features it skipped and why.
- `x` (or `/feature reset`) stops a busy agent, after a confirming press, or clears a finished one, so the feature can start again.
- `n` jumps to the next feature waiting on you. Deleting a feature or an experience takes two presses.
- The status line shows the focused feature even when no agents are running.
- Look and feel: theme colors, a top bar with breadcrumbs and counts, cards for questions and agent summaries, Markdown summaries, aligned rows, section dividers, and a Get started card on an empty Home.

## Changes in 0.3.0

- Experiences, the shared workflow registry, and `/workbench web`.
- Feature, experience and config files are read and written under the session's project root, so a shell `cd` no longer scatters feature files into subfolders.
- `ask_user` always answers. An agent the session doesn't know, for example one started before a reload, is adopted when it names a feature that exists. An unexpected error comes back to the agent as a message instead of "no tool.call hook answered".
- Archive sets `status: "archived"`, the same value Workbench Web uses. Older `done` features still count as archived.

## Data model

`.claude/features/<id>.json`:

```json
{
  "id": "checkout-redesign",
  "title": "Checkout redesign",
  "description": "",
  "status": "active",
  "experience": "checkout",
  "createdAt": "...",
  "updatedAt": "...",
  "context": [
    { "id": "c1", "type": "file", "value": "src/checkout/Cart.tsx", "label": "" },
    { "id": "c2", "type": "mcp", "value": "github get_issue {\"issue_number\":123}", "server": "github", "tool": "get_issue", "args": { "issue_number": 123 }, "label": "" }
  ],
  "workflows": [
    { "id": "w1", "name": "tests", "kind": "script", "target": "npm test", "description": "" }
  ],
  "remote": { "source": "github", "id": "123", "url": "https://...", "status": "open" }
}
```

`remote` is present only on features pulled from a remote source. `runner` (`"session"` or `"web"`) is present only when the feature chooses its own runner.

`.claude/experiences/<id>.json` holds `{ id, title, description }`, plus `runner` and `planFirst` when the experience sets them. `.claude/workbench.json` holds the remote sources, and the project defaults `"runner"` and `"planFirst"`.

Which feature a session is focused on, and each agent's state, are never written to these files. In-session agents live in the Claude Code session; Workbench Web keeps its sessions in `.claude/workbench-web.local.json` (per user, gitignored).

## How the code is laid out

`hooks/register.js` holds the host adapter and wires each hook to its handler; everything else is in `lifecycle.js`, `commands/`, `pane/` and `lib/`. [ARCHITECTURE.md](ARCHITECTURE.md) explains the layout, the observer and why only `register.js` touches `$`.

## Checking it

```bash
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .
```

`validate` reads the hooks module the way the engine will, and the tests run against the engine's test kit with Workbench Web faked. `tsc` checks the tests and types only: the hooks are plain JS and the shared tsconfig does not set `checkJs`.

Tested against Claude Code v2.1.288.
