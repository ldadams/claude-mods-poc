// The judgments, against a scripted System One provider: run with `npm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createDecisions } from '../decisions/index.mjs'

// A provider that answers each question by its key from `script`, recording calls.
// Unscripted questions get a neutral answer.
function fakeProvider(script = {}) {
  const calls = []
  return {
    name: 'fake',
    calls,
    status: () => ({ ready: true, loading: false, error: '' }),
    warm: () => {},
    async systemOne(state, questions) {
      calls.push({ state, questions })
      const answers = {}
      for (const [k, q] of Object.entries(questions)) {
        const s = typeof script[k] === 'function' ? script[k](state, q) : script[k]
        if (q.type === 'noul') answers[k] = { type: 'noul', noul: s ?? 0.5 }
        else if (q.type === 'choice') answers[k] = { type: 'choice', choice: s?.choice ?? Object.keys(q.criteria)[0], confidence: s?.confidence ?? 0.5, probabilities: {} }
        else answers[k] = { type: 'score', score: s ?? 1, confidence: 0.5, probabilities: {}, legend: {} }
      }
      return { model: 'fake-1', answers, usage: { input_tokens: 1, output_tokens: 0 } }
    },
  }
}

async function project(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-decisions-'))
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true })
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, '.claude', name), JSON.stringify(body))
  return dir
}

const feature = { id: 'cart', title: 'Cart redesign', description: 'Rework the cart page', context: [] }

test('exact rules deny first, with what to do instead, and never call the model', async () => {
  const provider = fakeProvider()
  const d = createDecisions({ project: await project(), provider })
  const push = await d.judgeTool({ feature, toolName: 'Bash', input: { command: 'git push --force origin main' } })
  assert.equal(push.decision, 'deny')
  assert.equal(push.standard, 'no-force-push')
  assert.match(push.reason, /Push a new commit instead/)
  const secret = await d.judgeTool({ feature, toolName: 'Write', input: { file_path: 'a.js', content: 'const k = "AKIAABCDEFGHIJKLMNOP"' } })
  assert.equal(secret.standard, 'no-secrets')
  assert.equal(provider.calls.length, 0)
})

test('a project adds its own rules and safe commands; a bad regex is dropped, not fatal', async () => {
  const dir = await project({
    'workbench-standards.json': {
      rules: [
        { id: 'site-plain-html', tools: ['Write', 'Edit'], field: 'file_path', match: '(^|/)site/', unless: '\\.(html|css|md)$', message: 'site/ is plain HTML and CSS.' },
        { id: 'broken', tools: ['Bash'], field: 'command', match: '(', message: 'x' },
      ],
      safeCommands: ['make lint'],
    },
  })
  const provider = fakeProvider()
  const d = createDecisions({ project: dir, provider })
  assert.equal((await d.judgeTool({ feature, toolName: 'Write', input: { file_path: 'site/app.jsx', content: '' } })).standard, 'site-plain-html')
  assert.notEqual((await d.judgeTool({ feature, toolName: 'Write', input: { file_path: 'site/index.html', content: 'x' } })).standard, 'site-plain-html')
  assert.equal((await d.judgeTool({ feature, toolName: 'Bash', input: { command: 'make lint' } })).decision, 'allow')
  assert.match((await d.standards()).problems[0], /broken/)
})

test('the model denies an edit only when confident it breaks a judged standard, naming it', async () => {
  const dir = await project({ 'workbench-standards.json': { judged: [{ id: 'no-new-deps', text: 'Do not add packages.', appliesTo: ['edit'] }] } })
  const sure = createDecisions({ project: dir, provider: fakeProvider({ std_0: 0.05, std_1: 0.95 }) })
  const r = await sure.judgeTool({ feature, toolName: 'Edit', input: { file_path: 'package.json', new_string: '"left-pad": "1.0.0"' } })
  assert.equal(r.decision, 'deny')
  assert.equal(r.standard, 'no-new-deps')
  assert.match(r.reason, /Do not add packages/)
  const unsure = createDecisions({ project: dir, provider: fakeProvider({ std_0: 0.05, std_1: 0.6 }) })
  assert.equal((await unsure.judgeTool({ feature, toolName: 'Edit', input: { file_path: 'package.json', new_string: 'x' } })).decision, 'ask')
})

test('a command is allowed only when judged read-only with high confidence', async () => {
  const dir = await project()
  const ro = createDecisions({ project: dir, provider: fakeProvider({ risk: { choice: 'read_only', confidence: 0.95 } }) })
  assert.equal((await ro.judgeTool({ feature, toolName: 'Bash', input: { command: 'cat README.md' } })).decision, 'allow')
  const weak = createDecisions({ project: dir, provider: fakeProvider({ risk: { choice: 'read_only', confidence: 0.7 } }) })
  assert.equal((await weak.judgeTool({ feature, toolName: 'Bash', input: { command: 'cat README.md' } })).decision, 'ask')
  const rm = createDecisions({ project: dir, provider: fakeProvider({ risk: { choice: 'destructive', confidence: 0.99 } }) })
  const r = await rm.judgeTool({ feature, toolName: 'Bash', input: { command: 'rm -rf build' } })
  assert.equal(r.decision, 'ask')
  assert.match(r.reason, /destructive/)
})

test('questions and plans are never judged, and errors mean no judgment', async () => {
  const provider = fakeProvider()
  const d = createDecisions({ project: await project(), provider })
  for (const toolName of ['AskUserQuestion', 'ExitPlanMode', 'mcp__workbench__ask_user']) {
    assert.equal((await d.judgeTool({ feature, toolName, input: {} })).decision, 'ask')
  }
  assert.equal(provider.calls.length, 0)
  const failing = createDecisions({ project: await project(), provider: { ...fakeProvider(), systemOne: async () => { throw new Error('model down') } } })
  assert.deepEqual(await failing.judgeTool({ feature, toolName: 'Bash', input: { command: 'cat x' } }), { error: 'model down' })
})

test('approach: risky or unclear work is planned first, with the reasons', async () => {
  const dir = await project()
  const small = createDecisions({ project: dir, provider: fakeProvider({ approach: { choice: 'direct', confidence: 0.8 }, size: 0.4, clarity: 2.6, contract: 0.05, sensitive: 0.02 }) })
  const a = await small.assessApproach({ feature })
  assert.equal(a.recommended, 'direct')
  assert.deepEqual(a.reasons, ['small and clear'])
  const schema = createDecisions({ project: dir, provider: fakeProvider({ approach: { choice: 'direct', confidence: 0.6 }, size: 1, clarity: 2.5, contract: 0.93, sensitive: 0.1 }) })
  const b = await schema.assessApproach({ feature })
  assert.equal(b.recommended, 'plan')
  assert.deepEqual(b.reasons, ['changes an API, data format or schema'])
})

test('plan review: failed checks become feedback the agent can act on', async () => {
  const dir = await project({ 'workbench-standards.json': { judged: [{ id: 'plain-site', text: 'site/ stays plain HTML and CSS.', appliesTo: ['plan'] }] } })
  const d = createDecisions({ project: dir, provider: fakeProvider({ verifies: 0.05, scoped: 0.95, std_0: 0.9 }) })
  const r = await d.reviewPlan({ feature, plan: '1. Add React to site/\n2. Ship it' })
  assert.equal(r.revise, true)
  // Only standards that apply to plans are asked about (no-credentials applies to edits).
  assert.deepEqual(r.checks.map((c) => [c.id, c.status]), [['verifies', 'fail'], ['scoped', 'pass'], ['plain-site', 'fail']])
  assert.match(r.feedback, /how you'll verify the work/)
  assert.match(r.feedback, /site\/ stays plain HTML and CSS/)
})

test('turn end: a claimed check that never ran gets a follow-up; one that ran does not', async () => {
  const dir = await project()
  const claims = fakeProvider({ claims_checks: 0.95, unfinished: 0.05 })
  const d = createDecisions({ project: dir, provider: claims })
  const unrun = await d.checkTurn({ feature, summary: 'Done. All tests pass.', tools: [{ name: 'Edit', input: {} }] })
  assert.deepEqual(unrun.issues.map((i) => i.id), ['unverified-claim'])
  assert.match(unrun.followUp, /none ran in this turn/)
  const ran = await d.checkTurn({ feature, summary: 'Done. All tests pass.', tools: [{ name: 'Bash', input: { command: 'npm test' } }] })
  assert.deepEqual(ran.issues, [])
  assert.equal(ran.ranChecks, true)
})

test('off by default: no provider configured means no judgments at all', async () => {
  const d = createDecisions({ project: await project() })
  assert.deepEqual(await d.judgeTool({ feature, toolName: 'Bash', input: { command: 'rm -rf /' } }), { off: true })
  assert.equal(d.status().provider, 'off')
})
