// Code standards: exact rules checked in code, and judged sentences a decision model
// checks. The built-in set is general; a project adds its own (or replaces one by id)
// in <project>/.claude/workbench-standards.json, shared through git.
//
// {
//   "rules":   [{ "id", "tools": ["Write", "Edit"], "field": "file_path" | "command" | "content",
//                 "match": "<regex>", "unless": "<regex>", "message": "what to do instead" }],
//   "judged":  [{ "id", "text", "appliesTo": ["edit", "command", "plan"] }],
//   "safeCommands": ["git status", "npm test", ...]   exact commands always allowed
// }

import fs from 'node:fs/promises'
import path from 'node:path'

const BUILT_IN = {
  rules: [
    {
      id: 'deps-need-signoff',
      tools: ['Bash'],
      field: 'command',
      match: '\\bnpm\\s+(i|install|add)\\b(?=[^&|;\\n]*\\s[^-\\s&|;])',
      message: 'New dependencies need sign-off. Ask the user with AskUserQuestion before installing.',
    },
    {
      id: 'no-secrets',
      tools: ['Write', 'Edit', 'MultiEdit'],
      field: 'content',
      match: 'sk-ant-[\\w-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36}',
      message: 'Never write secrets to files. Read them from an environment variable instead.',
    },
    {
      id: 'no-force-push',
      tools: ['Bash'],
      field: 'command',
      match: '\\bgit\\s+push\\b[^&|;\\n]*\\s(-f\\b|--force)',
      message: 'Force-pushing is not allowed. Push a new commit instead.',
    },
    {
      id: 'no-skip-hooks',
      tools: ['Bash'],
      field: 'command',
      match: '\\s--no-verify\\b',
      message: 'Commit hooks must run. Remove --no-verify and fix what the hook reports.',
    },
  ],
  judged: [
    { id: 'no-credentials', text: 'No credentials, tokens or private keys in files, in any format.', appliesTo: ['edit'] },
  ],
  safeCommands: ['git status', 'git status --short', 'git diff', 'git diff --stat', 'git log --oneline -5', 'git branch', 'ls', 'pwd', 'npm test'],
}

const byId = (base, extra) => {
  const out = new Map(base.map((x) => [x.id, x]))
  for (const x of extra || []) if (x && x.id) out.set(x.id, { ...out.get(x.id), ...x })
  return [...out.values()]
}

// The built-in standards merged with the project's, rules compiled. A rule whose regex
// does not compile is dropped and reported, so one typo never stops every check.
export async function loadStandards(project) {
  let local = {}
  try {
    local = JSON.parse(await fs.readFile(path.join(project, '.claude', 'workbench-standards.json'), 'utf8'))
  } catch {
    local = {}
  }
  const problems = []
  const rules = byId(BUILT_IN.rules, local.rules).flatMap((r) => {
    try {
      return [{ ...r, re: new RegExp(r.match), unlessRe: r.unless ? new RegExp(r.unless) : null }]
    } catch (err) {
      problems.push('rule ' + r.id + ': ' + err.message)
      return []
    }
  })
  return {
    rules,
    judged: byId(BUILT_IN.judged, local.judged).filter((j) => j.text),
    safeCommands: new Set([...BUILT_IN.safeCommands, ...(local.safeCommands || [])].map((c) => c.trim())),
    problems,
  }
}

// The text a rule looks at in a tool request.
export function fieldOf(field, input = {}) {
  if (field === 'file_path') return String(input.file_path || input.notebook_path || '')
  if (field === 'command') return String(input.command || '')
  if (field === 'content') {
    if (Array.isArray(input.edits)) return input.edits.map((e) => e.new_string || '').join('\n')
    return String(input.content ?? input.new_string ?? input.new_source ?? '')
  }
  return ''
}
