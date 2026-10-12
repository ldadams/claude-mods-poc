// The four judgments, each a few typed questions to a System One provider:
//   assessApproach  should this feature be planned first, or just done?
//   judgeTool       does this tool call break a code standard, or is it plainly safe?
//   reviewPlan      does Claude's plan say how it will be verified, stay in scope, follow the standards?
//   checkTurn       does a turn's summary claim checks that never ran, or leave work unfinished?
// A decision model only picks among options it is given, so every message an agent or a
// person reads is written here, from the standards; the model never writes text.

import { fieldOf } from './standards.mjs'

const clip = (s, n) => {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

// A noul answer as yes / no / unsure, by the configured thresholds.
const verdictOf = (p, t) => (p >= t.yes ? 'yes' : p <= t.no ? 'no' : 'unsure')

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const NEVER_JUDGED = new Set(['AskUserQuestion', 'ExitPlanMode', 'mcp__workbench__ask_user'])

// Commands that run tests or checks, for telling a claimed check from a real one.
const CHECK_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|check|typecheck)\b|\b(pytest|jest|vitest|mocha|go\s+test|cargo\s+test|make\s+(test|check)|tsc|eslint|claude\s+plugin\s+(test|validate))\b/

// ---- approach ---------------------------------------------------------------------

export async function assessApproach(provider, t, { feature, experience }) {
  const state = {
    feature: feature.title,
    description: clip(feature.description || '(none)', 900),
    ...(experience ? { experience: experience.title + (experience.description ? ': ' + clip(experience.description, 300) : '') } : {}),
    context: (feature.context || []).slice(0, 10).map((c) => c.type + ' ' + clip(c.value, 80)),
  }
  const questions = {
    approach: {
      type: 'choice',
      instructions: 'How should a coding agent take on this piece of work?',
      criteria: {
        direct: 'Small and clear: a few lines or a single file, with one obvious way to do it',
        plan: 'Bigger or less clear: several files or modules, design choices to make, or a real risk of building the wrong thing',
      },
    },
    size: { type: 'score', instructions: 'How much of the codebase does this work touch?', criteria: ['a line or two', 'one file', 'one module or area', 'several modules', 'cross-cutting'] },
    clarity: {
      type: 'score',
      instructions: 'How clearly is the goal described?',
      criteria: ['the goal is unclear', 'the goal is clear but details are missing', 'clear, with some acceptance criteria', 'fully specified'],
    },
    contract: { type: 'noul', instructions: 'This work changes a public API, a data format or a database schema.' },
    sensitive: { type: 'noul', instructions: 'This work touches authentication, payments, security or personal data.' },
  }
  const r = await provider.systemOne(state, questions)
  const a = r.answers
  const reasons = []
  if (a.contract.noul >= t.yes) reasons.push('changes an API, data format or schema')
  if (a.sensitive.noul >= t.yes) reasons.push('touches auth, payments, security or personal data')
  if (a.size.score >= 2.5) reasons.push('touches several modules')
  if (a.clarity.score <= 1) reasons.push('the goal is not fully clear')
  const recommended = reasons.length || a.approach.choice === 'plan' ? 'plan' : 'direct'
  if (!reasons.length) reasons.push(recommended === 'plan' ? 'bigger or less clear work' : 'small and clear')
  return {
    recommended,
    confidence: round(a.approach.confidence),
    reasons,
    size: round(a.size.score),
    clarity: round(a.clarity.score),
    model: r.model,
  }
}

// ---- tool calls ---------------------------------------------------------------------

export async function judgeTool(provider, t, standards, { feature, toolName, input = {} }) {
  if (NEVER_JUDGED.has(toolName)) return { decision: 'ask', by: 'skip', reason: 'questions and plans are always yours' }

  // 1. Exact rules: a broken one goes back to Claude, with what to do instead.
  for (const rule of standards.rules) {
    if (!rule.tools.includes(toolName)) continue
    const text = fieldOf(rule.field, input)
    if (rule.re.test(text) && !(rule.unlessRe && rule.unlessRe.test(text))) {
      return { decision: 'deny', by: 'rule', standard: rule.id, confidence: 1, reason: rule.message }
    }
  }

  // 2. Known-safe commands, exactly as listed.
  if (toolName === 'Bash' && standards.safeCommands.has(String(input.command || '').trim())) {
    return { decision: 'allow', by: 'safe-list', confidence: 1, reason: 'a known read-only command' }
  }

  // 3. The model, for edits and commands only.
  const isEdit = EDIT_TOOLS.has(toolName)
  if (!isEdit && toolName !== 'Bash') return { decision: 'ask', by: 'skip', reason: 'not an edit or a command' }
  const kind = isEdit ? 'edit' : 'command'
  const judged = standards.judged.filter((j) => (j.appliesTo || ['edit', 'command', 'plan']).includes(kind))
  const state = isEdit
    ? { feature: feature && feature.title, tool: toolName, file: fieldOf('file_path', input), change: clip(fieldOf('content', input), 1500) }
    : { feature: feature && feature.title, tool: 'Bash', command: clip(input.command, 800), description: clip(input.description, 200) }
  const questions = {}
  judged.forEach((j, i) => {
    questions['std_' + i] = {
      type: 'noul',
      instructions: 'Does this ' + kind + ' break the following standard? ' + j.text,
      criteria: { true: 'It breaks the standard', false: 'It follows the standard' },
    }
  })
  if (!isEdit) {
    questions.risk = {
      type: 'choice',
      instructions: 'What kind of command is this?',
      criteria: {
        read_only: 'It only reads or inspects; it changes nothing',
        local_change: 'It changes files in this project in an ordinary, reversible way',
        destructive: 'It deletes or overwrites data, rewrites git history, or is hard to undo',
        network: 'It sends data off this machine, or downloads and runs code',
        secrets: 'It reads or exposes credentials',
      },
    }
  }
  if (!Object.keys(questions).length) return { decision: 'ask', by: 'skip', reason: 'no judged standards apply' }
  const r = await provider.systemOne(state, questions)
  const checks = judged.map((j, i) => ({ id: j.id, label: j.text, p: round(r.answers['std_' + i].noul), status: passOf(r.answers['std_' + i].noul, t) }))
  const broken = checks.filter((c) => c.status === 'fail').sort((x, y) => y.p - x.p)[0]
  if (broken) {
    return {
      decision: 'deny',
      by: 'model',
      standard: broken.id,
      confidence: broken.p,
      checks,
      reason: 'This looks like it breaks a code standard: "' + broken.label + '" Change course so it follows the standard, or ask the user with AskUserQuestion if it truly must.',
    }
  }
  const risk = r.answers.risk
  if (risk) checks.push({ id: 'risk', label: 'kind of command: ' + risk.choice.replace('_', ' '), p: round(risk.confidence), status: risk.choice === 'read_only' ? 'pass' : 'note' })
  if (risk && risk.choice === 'read_only' && risk.confidence >= t.minConfidence && checks.every((c) => c.status !== 'unsure')) {
    return { decision: 'allow', by: 'model', confidence: round(risk.confidence), checks, reason: 'judged read-only' }
  }
  return { decision: 'ask', by: 'model', checks, reason: risk ? 'judged ' + risk.choice.replace('_', ' ') : 'no standard broken' }
}

// A check's status from a "breaks the standard" probability.
const passOf = (p, t) => ({ yes: 'fail', no: 'pass', unsure: 'unsure' })[verdictOf(p, t)]

// ---- plans --------------------------------------------------------------------------

export async function reviewPlan(provider, t, standards, { feature, plan }) {
  const judged = standards.judged.filter((j) => (j.appliesTo || []).includes('plan'))
  const state = { feature: feature.title, description: clip(feature.description || '(none)', 400), plan: clip(plan, 1800) }
  const questions = {
    verifies: { type: 'noul', instructions: 'The plan says how the result will be verified: tests to add or run, or checks to perform.' },
    scoped: { type: 'noul', instructions: 'Every step of the plan serves this feature; nothing unrelated is included.' },
  }
  judged.forEach((j, i) => {
    questions['std_' + i] = { type: 'noul', instructions: 'The plan breaks this standard: ' + j.text }
  })
  const r = await provider.systemOne(state, questions)
  const a = r.answers
  const checks = [
    { id: 'verifies', label: 'says how the work will be verified', p: round(a.verifies.noul), status: goodOf(a.verifies.noul, t), fix: "Add how you'll verify the work: which tests you'll add or run, or which checks you'll do." },
    { id: 'scoped', label: 'stays within the feature', p: round(a.scoped.noul), status: goodOf(a.scoped.noul, t), fix: 'Keep the plan to "' + feature.title + '"; drop steps unrelated to it.' },
    ...judged.map((j, i) => ({ id: j.id, label: 'follows: ' + j.text, p: round(1 - a['std_' + i].noul), status: passOf(a['std_' + i].noul, t), fix: 'Make the plan follow this standard: ' + j.text })),
  ]
  const failed = checks.filter((c) => c.status === 'fail')
  return {
    checks: checks.map(({ fix, ...c }) => c),
    revise: failed.length > 0,
    feedback: failed.length ? 'Before this plan is approved, revise it:\n' + failed.map((c) => '- ' + c.fix).join('\n') : '',
  }
}

// A check's status from a "this is good" probability.
const goodOf = (p, t) => ({ yes: 'pass', no: 'fail', unsure: 'unsure' })[verdictOf(p, t)]

// ---- turn ends ------------------------------------------------------------------------

export async function checkTurn(provider, t, { feature, summary, tools = [] }) {
  if (!String(summary || '').trim()) return { issues: [], followUp: '' }
  const ranChecks = tools.some((x) => x.name === 'Bash' && CHECK_COMMAND.test(String((x.input && x.input.command) || '')))
  const state = { feature: feature.title, summary: clip(summary, 1500) }
  const questions = {
    claims_checks: { type: 'noul', instructions: 'The text says tests or checks were run and passed.' },
    unfinished: { type: 'noul', instructions: 'The text says some of the work is not done yet, or leaves TODOs or next steps for the agent itself to do.' },
  }
  const r = await provider.systemOne(state, questions)
  const a = r.answers
  const issues = []
  if (a.claims_checks.noul >= t.yes && !ranChecks) {
    issues.push({ id: 'unverified-claim', p: round(a.claims_checks.noul), fix: 'You said tests or checks passed, but none ran in this turn. Run them now and report the actual result.' })
  }
  if (a.unfinished.noul >= t.yes) {
    issues.push({ id: 'unfinished', p: round(a.unfinished.noul), fix: "Your summary says some of the work isn't done. Finish it, or say exactly what is left and why you stopped." })
  }
  return {
    ranChecks,
    issues: issues.map(({ fix, ...i }) => i),
    followUp: issues.map((i) => i.fix).join('\n'),
  }
}

function round(x) {
  return Math.round(Number(x) * 100) / 100
}
