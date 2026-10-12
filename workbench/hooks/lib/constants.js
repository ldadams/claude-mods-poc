// Names, paths and limits shared across the mod, and the built-in workflow registry.

export const PANE = 'workbench'

export const FEATURES_DIR = '.claude/features'

export const EXP_DIR = '.claude/experiences'

export const CONFIG_PATH = '.claude/workbench.json'

export const WORKFLOWS_PATH = '.claude/workbench-workflows.json'

export const DEFAULT_WEB_PORT = 4477

export const CONTEXT_TYPES = ['file', 'command', 'url', 'note', 'mcp']

export const WORKFLOW_KINDS = ['skill', 'script']

export const MAX_PROVIDER_CHARS = 3000

export const REMOTE_TTL_MS = 60 * 1000

// The shared workflow registry: available to every feature. A project adds or
// overrides entries (by id) in .claude/workbench-workflows.json; Workbench Web
// reads the same file. `prompt` workflows go to the feature's agent (or the
// main session); `script` workflows run in the project root.
export const DEFAULT_WORKFLOWS = [
  {
    id: 'plan',
    name: 'Plan it',
    kind: 'prompt',
    description: 'Read the code and propose a step-by-step plan before changing anything.',
    template:
      'Before changing anything, read the relevant code and propose a step-by-step plan for "{{feature.title}}". List the files you would touch, the risks, and how we will know it works.',
  },
  {
    id: 'review',
    name: 'Review changes',
    kind: 'prompt',
    description: 'Review the uncommitted changes for bugs.',
    template:
      'Review the uncommitted changes in this project for "{{feature.title}}". Look for correctness bugs first, then anything confusing or untested. Report findings most severe first with file:line. Do not fix anything yet.',
  },
  {
    id: 'tests',
    name: 'Write tests',
    kind: 'prompt',
    description: "Add tests covering this feature's behavior and run them.",
    template:
      'Write tests that cover the behavior added for "{{feature.title}}". Follow the project\'s existing test setup, run them, and report the results.',
  },
  {
    id: 'pr-description',
    name: 'Draft PR description',
    kind: 'prompt',
    description: 'Summarize the work so far as a pull request description.',
    template:
      'Draft a pull request description for "{{feature.title}}" from the changes so far: what changed, why, how it was tested. Link {{remote.url}} if set. Markdown only; do not create the PR.',
  },
  { id: 'git-status', name: 'Git status', kind: 'script', description: 'Working tree status and recent commits.', command: 'git status --short --branch 2>&1 && echo && git log --oneline -5 2>&1' },
  { id: 'run-tests', name: 'Run tests', kind: 'script', description: 'Run npm test if the project has one.', command: "if [ -f package.json ]; then npm test --if-present 2>&1; else echo 'No package.json in this project.'; fi" },
]

export const RUNTIME_PATH = '.claude/workbench-web.runtime.json'

export const POLL_MS = 1500

export const TRANSCRIPT_TAIL = 40

export const MODES = [
  { value: 'default', label: 'ask before acting' },
  { value: 'acceptEdits', label: 'accept edits' },
  { value: 'plan', label: 'plan only' },
  { value: 'auto', label: 'auto' },
]

// The runners an agent can run on: a subagent of this session, or a Workbench Web session.
export const RUNNERS = ['session', 'web']

// The tool an in-session agent asks the user through, as agents see it.
export const ASK_TOOL = 'ask_user'

export const ASK_TOOL_FULL = 'mcp__workbench__' + ASK_TOOL

export const AGENT_TYPE = 'general-purpose'

export const MAX_SUMMARY_CHARS = 600
