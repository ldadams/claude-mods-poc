// The server's decisions wiring, end to end: the real server.mjs on a temporary
// project, its "http" provider pointed at a fake System One server. No Claude sessions.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')
let fake, child, dir, base, token
const seen = []

// Answers like Laya would: noul questions from a table by instruction, choices by key.
function answer(questions) {
  const answers = {}
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === 'noul') answers[k] = { type: 'noul', noul: /changes a public API/.test(q.instructions) ? 0.95 : 0.05 }
    else if (q.type === 'choice') answers[k] = { type: 'choice', choice: k === 'risk' ? 'read_only' : 'direct', confidence: 0.97, probabilities: {} }
    else answers[k] = { type: 'score', score: 1, confidence: 0.6, probabilities: {}, legend: {} }
  }
  return { model: 'fake-laya', answers, usage: { input_tokens: 1, output_tokens: 0 } }
}

before(async () => {
  fake = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw)
      seen.push({ url: req.url, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(answer(body.questions)))
    })
  })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-server-'))
  await fs.mkdir(path.join(dir, '.claude', 'features'), { recursive: true })
  await fs.writeFile(
    path.join(dir, '.claude', 'workbench.json'),
    JSON.stringify({ decisions: { provider: 'http', url: 'http://127.0.0.1:' + fake.address().port, mode: 'shadow' } }),
  )
  await fs.writeFile(
    path.join(dir, '.claude', 'features', 'orders.json'),
    JSON.stringify({ id: 'orders', title: 'Orders API v2', description: 'Rename fields in the orders API', status: 'active', context: [], workflows: [] }),
  )
  // Pulled before there were several trackers: no remote.source, so it came from Jira.
  await fs.writeFile(
    path.join(dir, '.claude', 'features', 'wb-110.json'),
    JSON.stringify({ id: 'wb-110', title: 'Landing site polish', status: 'active', context: [], workflows: [], remote: { id: 'WB-110', type: 'Epic' } }),
  )
  const port = 4600 + Math.floor(Math.random() * 300)
  child = spawn(process.execPath, [SERVER, dir, '--port', String(port), '--os-notify', 'off'], { stdio: 'ignore' })
  const runtime = path.join(dir, '.claude', 'workbench-web.runtime.json')
  for (let i = 0; i < 50; i++) {
    try {
      const info = JSON.parse(await fs.readFile(runtime, 'utf8'))
      base = 'http://127.0.0.1:' + info.port
      token = info.token
      break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  assert.ok(base, 'the server wrote its runtime file')
})

after(() => {
  child && child.kill('SIGTERM')
  fake && fake.close()
})

const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'X-Workbench-Token': token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, data: await r.json() }
}

test('/api/state reports the decisions provider and mode', async () => {
  const { data } = await call('GET', '/api/state')
  assert.equal(data.decisions.provider, 'http')
  assert.equal(data.decisions.mode, 'shadow')
})

test('/api/decide judges a tool call: exact rules without the model, the model otherwise', async () => {
  const before = seen.length
  const push = await call('POST', '/api/decide', { kind: 'tool', featureId: 'orders', toolName: 'Bash', input: { command: 'git push -f' } })
  assert.equal(push.data.decision, 'deny')
  assert.equal(push.data.standard, 'no-force-push')
  assert.equal(push.data.acting, false)
  assert.equal(seen.length, before)
  const cat = await call('POST', '/api/decide', { kind: 'tool', featureId: 'orders', toolName: 'Bash', input: { command: 'cat README.md' } })
  assert.equal(cat.data.decision, 'allow')
  assert.equal(seen.at(-1).url, '/v1/systemone')
  assert.equal(seen.at(-1).body.state.command, 'cat README.md')
})

test('assess recommends planning an API change, and the summary carries it', async () => {
  const { data } = await call('POST', '/api/features/orders/assess')
  assert.equal(data.assessment.recommended, 'plan')
  assert.ok(data.assessment.reasons.includes('changes an API, data format or schema'))
})

test("a feature's own approach is stored, and cleared with auto", async () => {
  await call('PATCH', '/api/features/orders', { approach: 'direct' })
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, '.claude', 'features', 'orders.json'), 'utf8')).approach, 'direct')
  await call('PATCH', '/api/features/orders', { approach: 'auto' })
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, '.claude', 'features', 'orders.json'), 'utf8')).approach, undefined)
})

test('a bad kind is refused', async () => {
  assert.equal((await call('POST', '/api/decide', { kind: 'nope' })).status, 400)
})

test('the remote trackers are Jira and GitHub, each in its own vocabulary', async () => {
  const { data: sources } = await call('GET', '/api/remotes/sources')
  assert.deepEqual(sources.map((x) => x.kind).sort(), ['github', 'jira'])
  const { data: items } = await call('GET', '/api/remotes')
  const parent = items.find((it) => it.source === 'github' && it.id === '41')
  assert.equal(parent.type, 'Epic')
  assert.equal(parent.typeLabel, 'Parent issue')
  assert.equal(parent.ref, 'example/workbench#41')
  const sub = items.find((it) => it.source === 'github' && it.id === '42')
  assert.equal(sub.epic, '41')
  assert.equal(sub.typeLabel, 'Issue')
  assert.equal(sub.url, 'https://github.com/example/workbench/issues/42')
  assert.equal(items.find((it) => it.id === 'WB-101').typeLabel, 'Story')
  // A feature pulled before trackers had names still counts as pulled from Jira.
  assert.equal(items.find((it) => it.id === 'WB-110').featureId, 'wb-110')
})

test('pulling a GitHub issue makes a feature that records its tracker', async () => {
  const { status, data: f } = await call('POST', '/api/remotes/pull', { source: 'github', id: '42' })
  assert.equal(status, 200)
  assert.equal(f.id, 'github-42')
  assert.equal(f.title, 'Show the needs-you count in the browser tab title')
  assert.deepEqual([f.remote.source, f.remote.ref, f.remote.epic], ['github', 'example/workbench#42', '41'])
  // An id only one tracker has needs no source.
  const { data: story } = await call('POST', '/api/remotes/pull', { id: 'WB-102' })
  assert.equal(story.remote.source, 'jira')
  const { status: missing } = await call('POST', '/api/remotes/pull', { source: 'github', id: 'WB-102' })
  assert.equal(missing, 404)
})

test('GraphQL lists remote items by tracker and pulls by source', async () => {
  const q = async (query) => (await call('POST', '/api/graphql', { query })).data
  const r = await q('{ remoteSources { source name } remoteItems(source: "github", type: Epic) { ref typeLabel stories { ref } } }')
  assert.ifError(r.errors)
  assert.deepEqual(r.data.remoteItems, [{ ref: 'example/workbench#41', typeLabel: 'Parent issue', stories: [{ ref: 'example/workbench#42' }, { ref: 'example/workbench#43' }] }])
  const m = await q('mutation { pullRemote(source: "github", id: "47") { id remote { source ref } } }')
  assert.ifError(m.errors)
  assert.deepEqual(m.data.pullRemote, { id: 'github-47', remote: { source: 'github', ref: 'example/workbench#47' } })
})

test('the docs site is served at /docs/ without the token, and nothing outside it', async () => {
  const get = (p) => fetch(base + p, { redirect: 'manual' })
  const index = await get('/docs/')
  assert.equal(index.status, 200)
  assert.match(index.headers.get('content-type'), /text\/html/)
  assert.match(await index.text(), /Workbench/)
  assert.equal((await get('/docs/styles.css')).status, 200)
  assert.equal((await get('/docs')).headers.get('location'), '/docs/')
  assert.equal((await get('/docs/README.md')).status, 404)
  assert.equal((await get('/docs/..%2Fworkbench-web%2Fserver.mjs')).status, 404)
  assert.equal((await get('/docs/..%2F.claude%2Fworkbench.json')).status, 404)
})
