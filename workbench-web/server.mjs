// Workbench Web: a local server that runs one Claude Agent SDK session per
// Workbench feature and drives them all from a browser.
//
//   node server.mjs [project-dir] [--port 4477]
//
// Features are the same .claude/features/*.json files the Workbench mod uses.
import http from 'node:http'
import fs from 'node:fs/promises'
import { watch, existsSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { autoDecide } from './policy.mjs'
import { createDecisions } from './decisions/index.mjs'
import { createGraphQL } from './graphql.mjs'

// ---- config ----------------------------------------------------------------

const args = process.argv.slice(2)
const portFlag = args.indexOf('--port')
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.PORT || 4477)
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port' && args[i - 1] !== '--os-notify')
const PROJECT = path.resolve(positional[0] || process.cwd())
const FEATURES_DIR = path.join(PROJECT, '.claude', 'features')
const EXP_DIR = path.join(PROJECT, '.claude', 'experiences')
const STATE_FILE = path.join(PROJECT, '.claude', 'workbench-web.local.json')
// Where a running server says how to reach it (port and token), so the Workbench mod's pane
// can drive the same sessions. Readable only by this user; removed on shutdown.
const RUNTIME_FILE = path.join(PROJECT, '.claude', 'workbench-web.runtime.json')
const APP_DIR = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(APP_DIR, 'public')
// A launcher (such as the Workbench plugin's `/workbench web`) can pass its own token so it can
// call the API too; otherwise only the served page knows the random per-launch token.
const ENV_TOKEN = process.env.WORKBENCH_WEB_TOKEN || ''
const TOKEN = ENV_TOKEN.length >= 32 ? ENV_TOKEN : crypto.randomBytes(24).toString('hex')
const MAX_EVENTS = 3000
const MAX_CONTEXT_CHARS = 20000
const MODES = ['default', 'acceptEdits', 'plan', 'auto']
// System notifications from the server: 'auto' only while no browser page is connected (an open
// page sends its own), 'always', or 'off'. --os-notify <mode> or WORKBENCH_WEB_OS_NOTIFY.
const notifyFlag = args.indexOf('--os-notify')
const OS_NOTIFY = (notifyFlag >= 0 ? args[notifyFlag + 1] : process.env.WORKBENCH_WEB_OS_NOTIFY) || 'auto'

// ---- features on disk (same schema as the mod) -------------------------------

function slugify(title) {
  return (
    title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'feature-' + Date.now()
  )
}

async function readFeature(id) {
  try {
    const f = JSON.parse(await fs.readFile(path.join(FEATURES_DIR, id + '.json'), 'utf8'))
    f.context = f.context || []
    f.workflows = f.workflows || []
    return f
  } catch {
    return null
  }
}

async function writeFeature(f) {
  f.updatedAt = new Date().toISOString()
  await fs.mkdir(FEATURES_DIR, { recursive: true })
  await fs.writeFile(path.join(FEATURES_DIR, f.id + '.json'), JSON.stringify(f, null, 2))
}

async function listFeatures() {
  let names = []
  try {
    names = (await fs.readdir(FEATURES_DIR)).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const all = (await Promise.all(names.map((n) => readFeature(n.slice(0, -5))))).filter(Boolean)
  return all.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

// ---- experiences: named groups of features --------------------------------------

async function readExperience(id) {
  try {
    return JSON.parse(await fs.readFile(path.join(EXP_DIR, id + '.json'), 'utf8'))
  } catch {
    return null
  }
}

async function writeExperience(e) {
  e.updatedAt = new Date().toISOString()
  await fs.mkdir(EXP_DIR, { recursive: true })
  await fs.writeFile(path.join(EXP_DIR, e.id + '.json'), JSON.stringify(e, null, 2))
}

async function listExperiences() {
  let names = []
  try {
    names = (await fs.readdir(EXP_DIR)).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const all = (await Promise.all(names.map((n) => readExperience(n.slice(0, -5))))).filter(Boolean)
  return all.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.title.localeCompare(b.title))
}

// Experiences claim remote items by label: an item whose labels include one of the
// experience's `labels` (case-insensitive) is grouped under it in the Remote tab and,
// when pulled without an explicit experience, lands in it.
function cleanLabels(labels) {
  if (typeof labels === 'string') labels = labels.split(',')
  if (!Array.isArray(labels)) return []
  return [...new Set(labels.map((l) => String(l).trim()).filter(Boolean))]
}

function experienceForItem(experiences, item) {
  const mine = new Set((item.labels || []).map((l) => String(l).toLowerCase()))
  if (!mine.size) return null
  const e = experiences.find((x) => (x.labels || []).some((l) => mine.has(String(l).toLowerCase())))
  return e ? e.id : null
}

// ---- per-user state: session ids survive restarts -----------------------------

let saved = {}
async function loadSaved() {
  try {
    saved = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'))
  } catch {
    saved = {}
  }
}
async function persist() {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
  await fs.writeFile(STATE_FILE, JSON.stringify(saved, null, 2))
}

// ---- the feature brief -------------------------------------------------------

function clip(s) {
  s = String(s ?? '')
  return s.length > MAX_CONTEXT_CHARS ? s.slice(0, MAX_CONTEXT_CHARS) + '\n…(truncated)' : s
}

function runCommand(cmd) {
  return new Promise((resolve) => {
    execFile('sh', ['-c', cmd], { cwd: PROJECT, timeout: 15000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve(clip(stdout + (stderr ? '\n[stderr]\n' + stderr : '') + (err ? '\n[exit] ' + (err.code ?? err.message) : '')))
    })
  })
}

async function resolveProvider(p) {
  switch (p.type) {
    case 'note':
      return p.value
    case 'file':
      try {
        return clip(await fs.readFile(path.resolve(PROJECT, p.value), 'utf8'))
      } catch (e) {
        return '(could not read: ' + e.message + ')'
      }
    case 'command':
      return runCommand(p.value)
    case 'url':
      try {
        const r = await fetch(p.value, { signal: AbortSignal.timeout(10000) })
        return clip(await r.text())
      } catch (e) {
        return '(could not fetch: ' + e.message + ')'
      }
    case 'mcp':
      return 'Call the MCP tool ' + (p.server || '?') + '/' + (p.tool || '?') + ' with ' + JSON.stringify(p.args || {}) + ' for this context.'
    default:
      return '(unknown context type ' + p.type + ')'
  }
}

async function buildBrief(f) {
  const parts = ['# Feature: ' + f.title + ' (' + f.id + ')']
  parts.push(f.description?.trim() ? f.description.trim() : '(No description was written for this feature.)')
  const exp = f.experience ? await readExperience(f.experience) : null
  if (exp) {
    const siblings = (await listFeatures()).filter((x) => x.experience === exp.id && x.id !== f.id)
    parts.push(
      '## Experience — ' + exp.title + '\nThis feature is part of the "' + exp.title + '" experience.' +
        (exp.description?.trim() ? '\n\n' + exp.description.trim() : '') +
        (siblings.length ? '\n\nOther features in this experience: ' + siblings.map((x) => '"' + x.title + '"').join(', ') + '.' : ''),
    )
  }
  if (f.remote) parts.push(await remoteBrief(f.remote))
  for (const p of f.context) {
    const label = p.label || p.type + ': ' + p.value
    parts.push('## Context — ' + label + '\n' + (await resolveProvider(p)))
  }
  if (f.workflows.length) {
    parts.push('## Workflows\n' + f.workflows.map((w) => '- ' + w.name + ' (' + w.kind + '): ' + w.target).join('\n'))
  }
  parts.push(
    'Work on this feature in ' + PROJECT + '. A person is watching this session in the Workbench web UI and will answer questions. ' +
      'If the description is missing or the goal is unclear, ask with the AskUserQuestion tool before doing anything else. ' +
      'When you finish a piece of work, end with a short summary of what changed and what is left.',
  )
  return parts.join('\n\n')
}

// ---- workflow registry: shared by every feature ------------------------------

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

// ---- plan first ----------------------------------------------------------------

// Whether a feature's session starts by planning. The feature's own `approach` wins
// ("plan" or "direct"); then its experience's planFirst; then the project default
// ("planFirst" in .claude/workbench.json, which the mod reads too); then, only when
// decisions act, the model's recommendation for this feature.
async function planFirstFor(f, s) {
  if (f.approach === 'plan') return true
  if (f.approach === 'direct') return false
  const exp = f.experience ? await readExperience(f.experience) : null
  if (exp && typeof exp.planFirst === 'boolean') return exp.planFirst
  const config = await readJson(path.join(PROJECT, '.claude', 'workbench.json'), {})
  if (typeof config.planFirst === 'boolean') return config.planFirst
  if (s && (await decisions.refresh(), decisions.acting())) {
    const a = await s.assess()
    return !!(a && a.recommended === 'plan')
  }
  return false
}

// A System One model (Laya by default) judging the work around each agent; off unless
// "decisions" is set in .claude/workbench.json. See decisions/index.mjs.
const decisions = createDecisions({ project: PROJECT })

const PLAN_FIRST_NOTE =
  'Plan first: read the relevant code and propose a step-by-step plan (the files you would touch, the risks, and how we will know it works). ' +
  'Do not change anything yet. When the plan is ready, present it with the ExitPlanMode tool; the user approves it before you build.'
const PLAN_APPROVED = 'The plan is approved. Go ahead and build it, then end with a short summary of what changed and what is left.'

async function loadWorkflows() {
  const base = (await readJson(path.join(APP_DIR, 'registry', 'workflows.json'), { workflows: [] })).workflows || []
  const local = (await readJson(path.join(PROJECT, '.claude', 'workbench-workflows.json'), { workflows: [] })).workflows || []
  const byId = new Map(base.map((w) => [w.id, { ...w, source: 'registry' }]))
  for (const w of local) byId.set(w.id, { ...byId.get(w.id), ...w, source: 'project' })
  return [...byId.values()].filter((w) => w.id && w.name && (w.kind === 'prompt' ? w.template : w.kind === 'script' && w.command))
}

function fillTemplate(t, f) {
  const vars = {
    'feature.title': f.title,
    'feature.id': f.id,
    'feature.description': f.description || '',
    'remote.url': f.remote?.url || '(none)',
  }
  return t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m))
}

// ---- remote trackers (mocked for now) ----------------------------------------------
// Each file in remotes/ is one tracker; its name is the source id and its `kind` picks the
// reader below. Every reader returns the same items: `{ source, id, ref, type, epic, title,
// description, status, labels, url, featureId }`, where `type` is Epic (a group of items) or
// Story (one piece of work) and a story's `epic` is its group's id. To use a real tracker,
// make its reader fetch instead of reading the file.

// How each kind names things, for the browser and the brief.
const TRACKERS = {
  jira: { name: 'Jira', Epic: 'Epic', Story: 'Story', children: 'Stories in this epic' },
  github: { name: 'GitHub', Epic: 'Parent issue', Story: 'Issue', children: 'Sub-issues' },
}

const READERS = {
  // Jira issues by key: epics, and stories whose `epic` is an epic's key.
  jira: (source, data) =>
    (data.items || []).map((it) => ({
      id: String(it.id),
      ref: String(it.id),
      type: it.type === 'Epic' ? 'Epic' : 'Story',
      epic: it.epic ? String(it.epic) : null,
      title: it.title,
      description: it.description || '',
      status: it.status || '',
      labels: it.labels || [],
      url: it.url || (data.browseUrl ? data.browseUrl + it.id : null),
      featureId: slugify(String(it.id)),
    })),
  // GitHub issues as the REST API returns them; an issue with sub-issues is a group.
  github: (source, data) => {
    const issues = data.issues || []
    const parents = new Set(issues.map((i) => i.parent).filter(Boolean).map(String))
    return issues.map((i) => ({
      id: String(i.number),
      ref: (data.repo || '') + '#' + i.number,
      type: parents.has(String(i.number)) ? 'Epic' : 'Story',
      epic: i.parent ? String(i.parent) : null,
      title: i.title,
      description: i.body || '',
      status: i.state || '',
      labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
      url: i.html_url || (data.repo ? 'https://github.com/' + data.repo + '/issues/' + i.number : null),
      featureId: slugify(source + '-' + i.number),
    }))
  },
}

// Features pulled before there were several trackers came from Jira.
const sourceOf = (r) => r.source || 'jira'

async function listTrackers() {
  let names = []
  try {
    names = (await fs.readdir(path.join(APP_DIR, 'remotes'))).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    const data = await readJson(path.join(APP_DIR, 'remotes', n), null)
    if (!data || !READERS[data.kind]) continue
    const source = n.slice(0, -5)
    out.push({ source, kind: data.kind, name: data.name || TRACKERS[data.kind].name, where: data.repo || data.browseUrl || '', data })
  }
  return out
}

async function remoteItems(source) {
  const items = []
  for (const t of await listTrackers()) {
    if (source && t.source !== source) continue
    const words = TRACKERS[t.kind]
    for (const it of READERS[t.kind](t.source, t.data)) items.push({ ...it, source: t.source, kind: t.kind, typeLabel: words[it.type] })
  }
  return items
}

async function listRemotes() {
  const features = await listFeatures()
  const experiences = await listExperiences()
  const pulled = new Map(features.filter((f) => f.remote).map((f) => [sourceOf(f.remote) + ':' + f.remote.id, f]))
  return (await remoteItems()).map((it) => {
    const f = pulled.get(it.source + ':' + it.id)
    // A pulled item sits with its feature; an unpulled one with the experience whose labels match.
    return { ...it, featureId: f ? f.id : null, experienceId: f ? f.experience || null : experienceForItem(experiences, it) }
  })
}

// The trackers, for the Remote tab's headings.
async function listRemoteSources() {
  return (await listTrackers()).map(({ source, kind, name, where }) => ({ source, kind, name, where }))
}

// What the brief says about the remote item: a group lists its items, an item names its group.
async function remoteBrief(r) {
  const source = sourceOf(r)
  const items = await remoteItems(source)
  const tracker = (await listTrackers()).find((t) => t.source === source)
  const words = TRACKERS[tracker?.kind || 'jira']
  const ref = r.ref || r.id
  const head = 'Tracked in ' + words.name + ' as ' + (words[r.type] || words.Story) + ' ' + ref + ' (' + (r.status || 'unknown status') + ')' + (r.url ? ': ' + r.url : '') +
    (r.labels?.length ? '\nLabels: ' + r.labels.join(', ') : '')
  if (r.type === 'Epic') {
    const children = items.filter((it) => it.epic === r.id)
    if (!children.length) return head
    return head + '\n\n## ' + words.children + '\n' +
      children.map((it) => '### ' + it.ref + ' — ' + it.title + ' (' + it.status + ')\n' + (it.description || '(no description)')).join('\n\n')
  }
  const epic = r.epic && items.find((it) => it.id === r.epic)
  return epic ? head + '\nPart of ' + words.Epic.toLowerCase() + ' ' + epic.ref + ' — ' + epic.title + ': ' + (epic.description || '') : head
}

// `source` may be left out when the id is found in only one tracker.
async function pullRemote(itemId, experience, source) {
  const matches = (await remoteItems(source || undefined)).filter((it) => it.id === String(itemId))
  if (!matches.length) throw new Error('No such remote item: ' + (source ? source + ':' : '') + itemId)
  if (matches.length > 1) throw new Error('Several trackers have ' + itemId + '; name one: ' + matches.map((m) => m.source).join(', '))
  const item = matches[0]
  const now = new Date().toISOString()
  const existing = await readFeature(item.featureId)
  const f = existing || { id: item.featureId, createdAt: now, status: 'active', context: [], workflows: [], description: '' }
  f.title = item.title
  if (!existing) {
    // An explicit experience wins, then the experience its group was pulled into, then matching labels.
    const epicFeature = item.epic ? (await listFeatures()).find((x) => x.remote && sourceOf(x.remote) === item.source && x.remote.id === item.epic) : null
    f.experience = experience || epicFeature?.experience || experienceForItem(await listExperiences(), item) || undefined
  }
  if (!f.description) f.description = item.description || ''
  f.remote = { source: item.source, id: item.id, ref: item.ref, type: item.type, epic: item.epic, url: item.url, status: item.status, labels: item.labels }
  await writeFeature(f)
  return f
}

// ---- edits shared by the REST and GraphQL APIs ------------------------------------

class InputError extends Error {}

async function createFeature({ title, description, experience }) {
  title = String(title || '').trim()
  if (!title) throw new InputError('Title required')
  let id = slugify(title)
  if (await readFeature(id)) id += '-' + Date.now().toString(36)
  const now = new Date().toISOString()
  const f = { id, title, description: String(description || ''), status: 'active', createdAt: now, updatedAt: now, context: [], workflows: [] }
  if (experience && (await readExperience(String(experience)))) f.experience = String(experience)
  await writeFeature(f)
  await announceFeatures()
  return f
}

async function updateFeature(f, body) {
  if (typeof body.title === 'string' && body.title.trim()) f.title = body.title.trim()
  if (typeof body.description === 'string') f.description = body.description
  if (body.status === 'active' || body.status === 'archived') f.status = body.status
  // How to take it on: "plan" first, "direct"ly, or (null/"auto") as recommended.
  if ('approach' in body) {
    if (body.approach === 'plan' || body.approach === 'direct') f.approach = body.approach
    else delete f.approach
  }
  if ('experience' in body) {
    if (!body.experience) delete f.experience
    else if (await readExperience(String(body.experience))) f.experience = String(body.experience)
    else throw new InputError('No such experience')
  }
  await writeFeature(f)
  await announceFeatures()
  return f
}

async function addContext(f, { type, value }) {
  if (!['file', 'command', 'url', 'note'].includes(type) || !String(value || '').trim()) throw new InputError('type and value required')
  f.context.push({ id: 'c' + Date.now().toString(36), type, value: String(value).trim(), label: '' })
  await writeFeature(f)
  await announceFeatures()
  return f
}

async function removeContext(f, contextId) {
  f.context = f.context.filter((c) => c.id !== contextId)
  await writeFeature(f)
  await announceFeatures()
  return f
}

async function createExperience({ title, description, labels }) {
  title = String(title || '').trim()
  if (!title) throw new InputError('Title required')
  let id = slugify(title)
  if (await readExperience(id)) id += '-' + Date.now().toString(36)
  const now = new Date().toISOString()
  const e = { id, title, description: String(description || ''), labels: cleanLabels(labels), createdAt: now, updatedAt: now }
  await writeExperience(e)
  await announceFeatures()
  return e
}

async function updateExperience(e, body) {
  if (typeof body.title === 'string' && body.title.trim()) e.title = body.title.trim()
  if (typeof body.description === 'string') e.description = body.description
  if (body.labels !== undefined) e.labels = cleanLabels(body.labels)
  if (typeof body.planFirst === 'boolean') e.planFirst = body.planFirst
  await writeExperience(e)
  await announceFeatures()
  return e
}

async function deleteExperience(e) {
  // Features are kept; they just become ungrouped.
  for (const f of await listFeatures())
    if (f.experience === e.id) {
      delete f.experience
      await writeFeature(f)
    }
  await fs.rm(path.join(EXP_DIR, e.id + '.json'))
  await announceFeatures()
  return e
}

async function sendMessage(s, text) {
  text = String(text || '').trim()
  if (!text) throw new InputError('Empty message')
  await s.ensureStarted()
  s.send(text)
}

// ---- browser connections ------------------------------------------------------

const clients = new Set()

// macOS Notification Center via osascript; the text goes in as argv, never into the script.
function osNotify(title, text) {
  if (process.platform !== 'darwin' || OS_NOTIFY === 'off') return
  if (OS_NOTIFY !== 'always' && clients.size > 0) return
  const script = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', '-e', 'end run']
  execFile('osascript', [...script, title, String(text || '').slice(0, 200)], () => {})
}
async function osNotifyFeature(featureId, what, detail) {
  const f = await readFeature(featureId)
  osNotify('Workbench: ' + (f ? f.title : featureId) + ' ' + what, detail)
}
// Bumped on every change any client could see, so a polling client (the mod) can tell
// "nothing new" from a version number alone.
let stateVersion = 0
function broadcast(msg) {
  stateVersion++
  const data = 'data: ' + JSON.stringify(msg) + '\n\n'
  for (const res of clients) res.write(data)
}

// ---- one Claude session per feature --------------------------------------------

class Inbox {
  items = []
  waiters = []
  closed = false
  push(v) {
    const w = this.waiters.shift()
    if (w) w({ value: v, done: false })
    else this.items.push(v)
  }
  close() {
    this.closed = true
    for (const w of this.waiters) w({ value: undefined, done: true })
    this.waiters = []
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((r) => this.waiters.push(r))
      },
    }
  }
}

function toolResultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (b.type === 'text' ? b.text : '[' + b.type + ']')).join('\n')
  return ''
}

class FeatureSession {
  constructor(featureId) {
    this.featureId = featureId
    this.sessionId = saved[featureId]?.sessionId || null
    this.mode = saved[featureId]?.mode || 'default'
    this.status = this.sessionId ? 'paused' : 'idle' // idle | running | needs-you | ready | paused | error
    this.events = []
    this.pending = new Map()
    this.q = null
    this.inbox = null
    this.cost = saved[featureId]?.cost || 0
    // 'planning' while in plan mode, 'building' once the plan is approved; null before either.
    this.phase = saved[featureId]?.phase || null
    // The mode to return to when a plan is approved.
    this.buildMode = saved[featureId]?.buildMode || 'default'
    // Decisions: what this turn did (for the turn-end check), how many times a plan was
    // sent back or a follow-up sent on its own, and the approach recommendation.
    this.turnTools = []
    this.turnText = ''
    this.autoRevisions = 0
    this.followUps = 0
    this.assessment = null
    this.assessing = null
    this.historyLoaded = false
  }

  summary() {
    return {
      featureId: this.featureId,
      status: this.status,
      live: !!this.q,
      sessionId: this.sessionId,
      mode: this.mode,
      cost: this.cost,
      historyLoaded: this.historyLoaded,
      phase: this.phase,
      buildMode: this.buildMode,
      assessment: this.assessment,
      pending: [...this.pending.values()].map((p) => p.view),
    }
  }

  setStatus(s) {
    if (this.status === 'running' && s === 'ready') osNotifyFeature(this.featureId, 'finished its turn', 'Open Workbench to review it.')
    this.status = s
    broadcast({ type: 'status', ...this.summary() })
  }

  emit(ev) {
    ev.at = Date.now()
    this.events.push(ev)
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    broadcast({ type: 'event', featureId: this.featureId, event: ev })
    if (ev.t === 'ask') {
      const q = ev.kind === 'question' ? ev.input?.questions?.[0]?.question : null
      osNotifyFeature(this.featureId, 'needs you', q || 'Wants to use ' + ev.toolName)
    }
  }

  async loadHistory() {
    if (this.historyLoaded || !this.sessionId) return
    this.historyLoaded = true
    try {
      const msgs = await getSessionMessages(this.sessionId, { dir: PROJECT })
      const evs = []
      for (const m of msgs) {
        if (m.parent_tool_use_id) continue
        const content = m.message?.content
        if (m.type === 'user') {
          if (typeof content === 'string') evs.push({ t: 'user', text: content })
          else if (Array.isArray(content))
            for (const b of content) {
              if (b.type === 'text') evs.push({ t: 'user', text: b.text })
              if (b.type === 'tool_result') evs.push({ t: 'tool_result', id: b.tool_use_id, text: toolResultText(b.content), isError: !!b.is_error })
            }
        } else if (m.type === 'assistant' && Array.isArray(content)) {
          for (const b of content) {
            if (b.type === 'text' && b.text.trim()) evs.push({ t: 'text', text: b.text })
            if (b.type === 'tool_use') evs.push({ t: 'tool', id: b.id, name: b.name, input: b.input })
          }
        }
      }
      if (evs.length) {
        evs[0].history = true
        for (const e of evs) e.history = true
        this.events = [...evs, { t: 'system', text: 'Earlier conversation loaded. Send a message to resume.', history: true }, ...this.events]
        broadcast({ type: 'reset', featureId: this.featureId, events: this.events })
      }
    } catch (e) {
      this.emit({ t: 'system', text: 'Could not load earlier conversation: ' + e.message })
    }
  }

  ensureLive() {
    if (this.q) return
    this.inbox = new Inbox()
    this.queued = 0 // messages sent whose turn has not produced a result yet
    this.announced = false
    this.qTotal = 0
    this.resumed = !!this.sessionId
    const feature = this.featureId
    this.q = query({
      prompt: this.inbox,
      options: {
        cwd: PROJECT,
        resume: this.sessionId || undefined,
        permissionMode: this.mode,
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: 'You are working on the Workbench feature "' + feature + '". The user talks to you through a web UI that renders Markdown.',
        },
        canUseTool: (toolName, input, opts) => this.canUseTool(toolName, input, opts),
      },
    })
    this.pump(this.q)
  }

  async pump(q) {
    let failed = null
    try {
      for await (const m of q) this.handle(m)
    } catch (e) {
      failed = e
    }
    if (this.q !== q) return // replaced or stopped on purpose
    this.q = null
    this.inbox = null
    this.rejectPending('Session ended')
    if (failed) {
      this.emit({ t: 'error', text: String(failed.message || failed) })
      this.setStatus('error')
    } else {
      this.setStatus(this.sessionId ? 'paused' : 'idle')
    }
  }

  handle(m) {
    if (m.session_id && m.session_id !== this.sessionId) {
      this.sessionId = m.session_id
      saved[this.featureId] = { ...saved[this.featureId], sessionId: m.session_id, mode: this.mode }
      persist()
      broadcast({ type: 'status', ...this.summary() })
    }
    // Work can start without a message from us (a background task finishing
    // starts a turn of its own), so any activity means the session is working.
    const activity = m.type === 'assistant' || m.type === 'stream_event' || (m.type === 'user' && !!m.parent_tool_use_id)
    if (activity && this.status !== 'running' && this.pending.size === 0) this.setStatus('running')
    if (m.parent_tool_use_id) {
      // Subagent traffic: show only that it is working.
      if (m.type === 'assistant') this.emit({ t: 'sub', parent: m.parent_tool_use_id })
      return
    }
    switch (m.type) {
      case 'stream_event': {
        const ev = m.event
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') this.emit({ t: 'delta', text: ev.delta.text })
        break
      }
      case 'assistant':
        for (const b of m.message.content || []) {
          if (b.type === 'text' && b.text.trim()) {
            this.emit({ t: 'text', text: b.text })
            this.turnText = b.text
          }
          if (b.type === 'tool_use') {
            this.emit({ t: 'tool', id: b.id, name: b.name, input: b.input })
            this.turnTools.push({ name: b.name, input: b.input })
          }
        }
        if (m.error) this.emit({ t: 'error', text: 'API error: ' + m.error })
        break
      case 'user': {
        const content = m.message?.content
        if (Array.isArray(content))
          for (const b of content)
            if (b.type === 'tool_result') this.emit({ t: 'tool_result', id: b.tool_use_id, text: toolResultText(b.content), isError: !!b.is_error })
        break
      }
      case 'result':
      {
        // total_cost_usd is a running total for this query() call. On resume it may or
        // may not carry the earlier spend, so take deltas within the live query and,
        // on its first result, treat a total at or above what we saved as carried over.
        const total = m.total_cost_usd || 0
        let turnCost
        if (this.qTotal === 0 && this.resumed && this.cost > 0 && total >= this.cost) turnCost = total - this.cost
        else turnCost = Math.max(0, total - this.qTotal)
        this.qTotal = Math.max(this.qTotal, total)
        this.cost += turnCost
        saved[this.featureId] = { ...saved[this.featureId], cost: this.cost }
        persist()
        this.emit({ t: 'result', ok: m.subtype === 'success' && !m.is_error, subtype: m.subtype, turns: m.num_turns, cost: turnCost })
      }
        // A message sent while this turn ran is its own turn and still to come.
        this.queued = Math.max(0, (this.queued || 0) - 1)
        this.setStatus(this.pending.size ? 'needs-you' : this.queued ? 'running' : 'ready')
        if (m.subtype === 'success' && this.status === 'ready') this.afterTurn().catch(() => {})
        break
      case 'system':
        if (m.subtype === 'init' && !this.announced) (this.announced = true), this.emit({ t: 'system', text: 'Session ' + (m.session_id || '').slice(0, 8) + ' · ' + (m.model || '') + ' · ' + m.cwd })
        break
    }
  }

  async canUseTool(toolName, input, { signal, suggestions }) {
    const auto = await autoDecide({ featureId: this.featureId, toolName, input })
    if (auto) return auto
    const judged = await this.judgeTool(toolName, input)
    if (judged) return judged
    const id = crypto.randomUUID()
    const kind = toolName === 'AskUserQuestion' ? 'question' : 'tool'
    return new Promise((resolve) => {
      const view = { id, kind, toolName, input, canAlways: !!suggestions?.length }
      this.pending.set(id, { view, resolve, input, suggestions })
      signal?.addEventListener('abort', () => {
        if (this.pending.delete(id)) {
          resolve({ behavior: 'deny', message: 'Cancelled' })
          // With nothing left to answer it no longer needs you.
          if (this.pending.size === 0 && this.status === 'needs-you') this.setStatus(this.q ? 'running' : this.sessionId ? 'paused' : 'idle')
          else broadcast({ type: 'status', ...this.summary() })
        }
      })
      this.setStatus('needs-you') // status (with the pending entry) first, so the card renders as open
      this.emit({ t: 'ask', id, kind, toolName, input })
      if (toolName === 'ExitPlanMode') this.reviewPlan(id).catch(() => {})
    })
  }

  // ---- decisions: a System One model judging the work around this agent ------------
  // In shadow mode every judgment is recorded in the transcript and nothing acts on it;
  // in "on" mode it acts. An error or a timeout is recorded and changes nothing.

  async decisionFeature() {
    return (await readFeature(this.featureId)) || { id: this.featureId, title: this.featureId }
  }

  // A tool request that would otherwise reach the user: a broken code standard goes
  // back to Claude with what to do instead; a plainly read-only command goes ahead.
  async judgeTool(toolName, input) {
    const r = await decisions.judgeTool({ feature: await this.decisionFeature(), toolName, input })
    if (r.off || r.by === 'skip') return null
    if (r.error) {
      this.emit({ t: 'decision', kind: 'tool', toolName, verdict: 'error', reason: r.error, applied: false })
      return null
    }
    const act = decisions.acting() && r.decision !== 'ask'
    this.emit({ t: 'decision', kind: 'tool', toolName, verdict: r.decision, by: r.by, standard: r.standard, confidence: r.confidence, reason: r.reason, checks: r.checks, applied: act })
    if (!act) return null
    return r.decision === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Code standard (' + r.standard + '): ' + r.reason }
  }

  // Claude presented a plan: check it before the user reads it. Its checks go on the
  // plan card; acting, a plan that fails them goes back with what to fix (at most
  // maxAutoRevisions times, then the user decides).
  async reviewPlan(id) {
    const p = this.pending.get(id)
    if (!p) return
    const r = await decisions.reviewPlan({ feature: await this.decisionFeature(), plan: String(p.input?.plan || '') })
    if (r.off) return
    if (r.error) {
      this.emit({ t: 'decision', kind: 'plan', verdict: 'error', reason: r.error, applied: false })
      return
    }
    p.view.review = { checks: r.checks, revise: r.revise }
    const act = decisions.acting() && r.revise && this.autoRevisions < decisions.config().maxAutoRevisions && this.pending.has(id)
    this.emit({ t: 'decision', kind: 'plan', verdict: r.revise ? 'revise' : 'ok', checks: r.checks, reason: r.feedback, applied: act })
    if (act) {
      this.autoRevisions++
      this.answer(id, { allow: false, message: r.feedback })
    } else broadcast({ type: 'status', ...this.summary() })
  }

  // A turn ended with the agent waiting for the user: check its summary against what it
  // did. Acting, a claim with nothing behind it gets a follow-up instead of a ping (at
  // most maxFollowUps in a row). Planning turns are left alone.
  async afterTurn() {
    if (this.phase === 'planning' || this.mode === 'plan') return
    const r = await decisions.checkTurn({ feature: await this.decisionFeature(), summary: this.turnText, tools: this.turnTools })
    if (r.off) return
    if (r.error) {
      this.emit({ t: 'decision', kind: 'turn', verdict: 'error', reason: r.error, applied: false })
      return
    }
    if (!r.issues.length) return
    const act = decisions.acting() && this.followUps < decisions.config().maxFollowUps && this.status === 'ready'
    const checks = r.issues.map((i) => ({ id: i.id, label: i.id === 'unverified-claim' ? 'claims checks that never ran' : 'leaves work unfinished', p: i.p, status: 'fail' }))
    this.emit({ t: 'decision', kind: 'turn', verdict: 'follow-up', checks, reason: r.followUp, applied: act })
    if (act) {
      this.followUps++
      this.send(r.followUp, { auto: true })
    }
  }

  // Should this feature be planned first or just done? Cached until the feature changes.
  async assess(force) {
    const f = await readFeature(this.featureId)
    if (!f) return null
    const stamp = f.updatedAt || ''
    if (!force && this.assessment && this.assessment.stamp === stamp) return this.assessment
    if (this.assessing) return this.assessing
    this.assessing = (async () => {
      const exp = f.experience ? await readExperience(f.experience) : null
      const r = await decisions.assessApproach({ feature: f, experience: exp })
      if (r.off) return null
      this.assessment = r.error ? { error: r.error, stamp } : { ...r, stamp }
      broadcast({ type: 'status', ...this.summary() })
      return this.assessment
    })().finally(() => {
      this.assessing = null
    })
    return this.assessing
  }

  answer(id, body) {
    const p = this.pending.get(id)
    if (!p) throw new Error('That request is no longer waiting')
    this.pending.delete(id)
    let result
    if (p.view.kind === 'question') {
      result = { behavior: 'allow', updatedInput: { ...p.input, answers: body.answers || {} } }
      this.emit({ t: 'answered', id, text: Object.entries(body.answers || {}).map(([q, a]) => q + ' → ' + a).join('\n') })
    } else if (body.allow) {
      result = { behavior: 'allow', updatedInput: p.input }
      if (body.always && p.suggestions?.length) result.updatedPermissions = p.suggestions
      this.emit({ t: 'answered', id, text: body.always ? 'Allowed (always)' : 'Allowed' })
    } else {
      result = { behavior: 'deny', message: body.message || 'The user denied this.' }
      this.emit({ t: 'answered', id, text: 'Denied' + (body.message ? ': ' + body.message : '') })
    }
    p.resolve(result)
    // Allowing ExitPlanMode any other way than approvePlan still ends the planning phase.
    if (p.view.toolName === 'ExitPlanMode' && result.behavior === 'allow' && this.mode === 'plan') {
      this.setMode(this.buildMode && this.buildMode !== 'plan' ? this.buildMode : 'default').catch(() => {})
    }
    this.setStatus(this.pending.size ? 'needs-you' : 'running')
  }

  rejectPending(reason) {
    for (const [, p] of this.pending) p.resolve({ behavior: 'deny', message: reason })
    this.pending.clear()
  }

  // `auto` marks a message the server sent on its own (a decisions follow-up); one from
  // the user resets the follow-up count.
  send(text, { auto = false } = {}) {
    this.ensureLive()
    if (!auto) this.followUps = 0
    this.turnTools = []
    this.turnText = ''
    this.emit({ t: 'user', text, ...(auto ? { auto: true } : {}) })
    this.queued = (this.queued || 0) + 1
    this.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
    this.setStatus('running')
  }

  async start() {
    if (this.q) throw new Error('Already running')
    if (!(await this.ensureStarted())) throw new Error('This feature already has a session; send a message to resume it')
  }

  // A feature's first message is always its brief, however the session begins.
  async ensureStarted() {
    if (this.sessionId || this.q) return false
    const f = await readFeature(this.featureId)
    if (!f) throw new Error('No such feature')
    const planFirst = await planFirstFor(f, this)
    // Plan mode is set before the session opens, so its first turn already plans.
    if (planFirst && this.mode !== 'plan') await this.setMode('plan')
    const brief = await buildBrief(f)
    this.send(planFirst ? brief + '\n\n' + PLAN_FIRST_NOTE : brief)
    return true
  }

  // Approves the plan: the session goes back to the mode it had before planning and
  // builds. A plan Claude presented with ExitPlanMode is approved by allowing that call;
  // otherwise the approval goes as a message.
  async approvePlan(note) {
    if (this.phase !== 'planning') throw new Error('There is no plan waiting for approval')
    this.autoRevisions = 0
    const exit = [...this.pending.values()].find((p) => p.view.toolName === 'ExitPlanMode')
    await this.setMode(this.buildMode && this.buildMode !== 'plan' ? this.buildMode : 'default')
    const text = PLAN_APPROVED + (String(note || '').trim() ? '\n\n' + String(note).trim() : '')
    if (exit) {
      this.answer(exit.view.id, { allow: true })
      if (String(note || '').trim()) this.send(String(note).trim())
    } else {
      await sendMessage(this, text)
    }
  }

  async runWorkflow(wf) {
    const f = await readFeature(this.featureId)
    if (!f) throw new Error('No such feature')
    if (wf.kind === 'prompt') {
      if (wf.mode && wf.mode !== this.mode) {
        await this.setMode(wf.mode)
        this.emit({ t: 'system', text: 'Mode switched to "' + wf.mode + '" for the ' + wf.name + ' workflow.' })
      }
      await this.ensureStarted()
      this.emit({ t: 'workflow', name: wf.name, kind: 'prompt' })
      this.send(fillTemplate(wf.template, f))
      return
    }
    this.emit({ t: 'workflow', name: wf.name, kind: 'script', command: wf.command })
    const output = await runCommand(wf.command)
    this.emit({ t: 'workflow_output', name: wf.name, text: output || '(no output)' })
  }

  async interrupt() {
    if (!this.q) return
    await this.q.interrupt()
    this.emit({ t: 'system', text: 'Interrupted.' })
  }

  stop() {
    const q = this.q
    this.q = null
    this.inbox?.close()
    this.inbox = null
    this.rejectPending('Session stopped')
    try {
      q?.close()
    } catch {}
    this.emit({ t: 'system', text: 'Session stopped. Send a message to resume it.' })
    this.setStatus(this.sessionId ? 'paused' : 'idle')
  }

  async setMode(mode) {
    if (!MODES.includes(mode)) throw new Error('Unknown mode')
    // Entering plan mode starts a planning phase and remembers the mode to build in;
    // leaving it (an approval, or picking another mode) moves on to building.
    if (mode === 'plan' && this.phase !== 'planning') {
      if (this.mode !== 'plan') this.buildMode = this.mode
      this.phase = 'planning'
    } else if (mode !== 'plan' && this.phase === 'planning') {
      this.phase = 'building'
    }
    this.mode = mode
    saved[this.featureId] = { ...saved[this.featureId], mode, phase: this.phase, buildMode: this.buildMode }
    await persist()
    if (this.q) await this.q.setPermissionMode(mode)
    broadcast({ type: 'status', ...this.summary() })
  }

  reset() {
    this.stop()
    this.sessionId = null
    this.cost = 0
    this.phase = null
    if (this.mode === 'plan') this.mode = this.buildMode || 'default'
    this.events = []
    this.historyLoaded = false
    delete saved[this.featureId]
    persist()
    broadcast({ type: 'reset', featureId: this.featureId, events: [] })
    this.setStatus('idle')
  }
}

const sessions = new Map()
function sessionFor(id) {
  let s = sessions.get(id)
  if (!s) {
    s = new FeatureSession(id)
    sessions.set(id, s)
  }
  return s
}

// ---- watch the features folder so mod-created features appear live -----------

let featureTimer = null
async function announceFeatures() {
  const features = await listFeatures()
  for (const f of features) sessionFor(f.id)
  broadcast({ type: 'features', features, experiences: await listExperiences(), sessions: features.map((f) => sessionFor(f.id).summary()) })
}
function watchDir(dir) {
  try {
    watch(dir, () => {
      clearTimeout(featureTimer)
      featureTimer = setTimeout(announceFeatures, 150)
    })
  } catch {
    setTimeout(() => watchDir(dir), 2000) // folder not created yet
  }
}
function watchFeatures() {
  watchDir(FEATURES_DIR)
  watchDir(EXP_DIR)
}

// ---- HTTP ------------------------------------------------------------------------

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(type === 'application/json' ? JSON.stringify(body) : body)
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 1e6) throw new Error('Body too large')
  }
  return raw ? JSON.parse(raw) : {}
}

// A transcript event made small enough to poll: long text and tool payloads are cut.
function clipEvent(ev) {
  const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s)
  const out = { ...ev }
  if ('text' in out) out.text = clip(out.text, 4000)
  if (out.input && typeof out.input === 'object') {
    const small = {}
    for (const [k, v] of Object.entries(out.input)) small[k] = typeof v === 'string' ? clip(v, 1500) : v
    out.input = small
  }
  return out
}

const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' }
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
}

// The docs site (../site, plain HTML and CSS) at /docs/, read-only and without the token. It
// stays a folder of static files so it can also be hosted on its own.
const SITE_DIR = path.join(APP_DIR, '..', 'site')
const DOC_TYPES = new Set(['.html', '.css', '.svg', '.png', '.jpg'])

async function serveDoc(res, p) {
  const rel = decodeURIComponent(p.slice('/docs/'.length)) || 'index.html'
  const file = path.resolve(SITE_DIR, rel)
  if (!file.startsWith(SITE_DIR + path.sep) || !DOC_TYPES.has(path.extname(file))) return send(res, 404, { error: 'Not found' })
  try {
    return send(res, 200, await fs.readFile(file), TYPES[path.extname(file)])
  } catch {
    return send(res, 404, { error: 'Not found' })
  }
}

async function route(req, res) {
  // Only answer requests addressed to this machine (blocks DNS rebinding).
  const host = (req.headers.host || '').split(':')[0]
  if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'Bad host' })

  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  if (req.method === 'GET' && STATIC[p]) {
    const file = STATIC[p]
    let body = await fs.readFile(path.join(PUBLIC_DIR, file), 'utf8')
    if (file === 'index.html') body = body.replace('__TOKEN__', TOKEN).replace('__PROJECT__', PROJECT.replace(/[<&>"]/g, ''))
    return send(res, 200, body, TYPES[path.extname(file)])
  }

  if (req.method === 'GET' && p === '/docs') {
    res.writeHead(301, { Location: '/docs/' })
    return res.end()
  }
  if (req.method === 'GET' && p.startsWith('/docs/')) return serveDoc(res, p)

  if (!p.startsWith('/api/')) return send(res, 404, { error: 'Not found' })
  // Every API call needs the per-launch token, which only the served page knows.
  const token = req.headers['x-workbench-token'] || url.searchParams.get('token')
  if (token !== TOKEN) return send(res, 401, { error: 'Missing or wrong token' })

  if (req.method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    const features = await listFeatures()
    for (const f of features) sessionFor(f.id)
    res.write(
      'data: ' +
        JSON.stringify({
          type: 'snapshot',
          project: PROJECT,
          features,
          experiences: await listExperiences(),
          sessions: features.map((f) => ({ ...sessionFor(f.id).summary(), events: sessionFor(f.id).events })),
        }) +
        '\n\n',
    )
    clients.add(res)
    const ping = setInterval(() => res.write(': ping\n\n'), 25000)
    req.on('close', () => {
      clearInterval(ping)
      clients.delete(res)
    })
    return
  }

  // A polling client's view (the Workbench mod's pane): every session's summary, plus the
  // recent transcript of one feature. `version` changes whenever anything does.
  if (req.method === 'GET' && p === '/api/state') {
    const features = await listFeatures()
    const featureId = url.searchParams.get('feature')
    const tail = Math.min(200, Math.max(1, Number(url.searchParams.get('tail')) || 40))
    let transcript = null
    if (featureId && features.some((f) => f.id === featureId)) {
      const s = sessionFor(featureId)
      await s.loadHistory()
      const shown = s.events.filter((ev) => ev.t !== 'delta' && ev.t !== 'sub')
      transcript = { featureId, total: shown.length, events: shown.slice(-tail).map(clipEvent) }
    }
    await decisions.refresh()
    // A feature on screen that has not started gets its approach assessed (in the
    // background; the answer arrives with a later poll).
    if (featureId && decisions.enabled()) {
      const s = sessionFor(featureId)
      if (!s.sessionId && !s.q && !s.assessment) s.assess().catch(() => {})
    }
    return send(res, 200, {
      version: stateVersion,
      project: PROJECT,
      browsers: clients.size,
      decisions: decisions.status(),
      sessions: features.map((f) => sessionFor(f.id).summary()),
      transcript,
    })
  }

  const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : {}

  if (req.method === 'GET' && p === '/api/workflows') return send(res, 200, await loadWorkflows())
  if (req.method === 'GET' && p === '/api/remotes') return send(res, 200, await listRemotes())
  if (req.method === 'GET' && p === '/api/remotes/sources') return send(res, 200, await listRemoteSources())
  if (req.method === 'POST' && p === '/api/remotes/pull') {
    try {
      const f = await pullRemote(String(body.id || ''), body.experience === undefined ? undefined : body.experience || null, body.source ? String(body.source) : undefined)
      await announceFeatures()
      return send(res, 200, f)
    } catch (e) {
      return send(res, 404, { error: e.message })
    }
  }

  // One judgment, without acting on it: the Workbench mod uses this for agents that run
  // in a Claude Code session, which never reach this server's canUseTool.
  if (req.method === 'POST' && p === '/api/decide') {
    const f = body.featureId ? await readFeature(String(body.featureId)) : null
    const feature = f || { id: String(body.featureId || ''), title: String(body.featureId || 'a feature') }
    let r
    if (body.kind === 'tool') r = await decisions.judgeTool({ feature, toolName: String(body.toolName || ''), input: body.input || {} })
    else if (body.kind === 'turn') r = await decisions.checkTurn({ feature, summary: String(body.summary || ''), tools: Array.isArray(body.tools) ? body.tools : [] })
    else if (body.kind === 'approach') r = await decisions.assessApproach({ feature, experience: f && f.experience ? await readExperience(f.experience) : null })
    else return send(res, 400, { error: 'kind must be tool, turn or approach' })
    return send(res, 200, { ...r, mode: decisions.config().mode, acting: decisions.acting() })
  }

  if (req.method === 'POST' && p === '/api/graphql') {
    const { status, result } = await graphqlApi.execute(body)
    return send(res, status, result)
  }

  try {
    if (req.method === 'POST' && p === '/api/features') return send(res, 200, await createFeature(body))
    if (req.method === 'POST' && p === '/api/experiences') return send(res, 200, await createExperience(body))
  } catch (e) {
    if (e instanceof InputError) return send(res, 400, { error: e.message })
    throw e
  }
  const em = p.match(/^\/api\/experiences\/([a-z0-9._-]+)$/)
  if (em && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const e = await readExperience(em[1])
    if (!e) return send(res, 404, { error: 'No such experience' })
    return send(res, 200, req.method === 'DELETE' ? await deleteExperience(e) : await updateExperience(e, body))
  }

  const m = p.match(/^\/api\/features\/([a-z0-9._-]+)(?:\/([a-z-]+))?(?:\/([a-zA-Z0-9-]+))?$/)
  if (!m) return send(res, 404, { error: 'Not found' })
  const [, id, action, arg] = m
  const f = await readFeature(id)
  if (!f) return send(res, 404, { error: 'No such feature' })
  const s = sessionFor(id)

  try {
    if (req.method === 'PATCH' && !action) return send(res, 200, await updateFeature(f, body))
    if (req.method === 'POST' && action === 'context') return send(res, 200, await addContext(f, body))
    if (req.method === 'POST' && action === 'context-remove') return send(res, 200, await removeContext(f, body.id))
  } catch (e) {
    if (e instanceof InputError) return send(res, 400, { error: e.message })
    throw e
  }
  if (req.method === 'POST' && action === 'history') {
    await s.loadHistory()
    return send(res, 200, { ok: true })
  }

  try {
    if (req.method === 'POST' && action === 'start') await s.start()
    else if (req.method === 'POST' && action === 'message') {
      if (!String(body.text || '').trim()) return send(res, 400, { error: 'Empty message' })
      await sendMessage(s, body.text)
    } else if (req.method === 'POST' && action === 'interrupt') await s.interrupt()
    else if (req.method === 'POST' && action === 'stop') s.stop()
    else if (req.method === 'POST' && action === 'reset') s.reset()
    else if (req.method === 'POST' && action === 'mode') await s.setMode(body.mode)
    else if (req.method === 'POST' && action === 'approve-plan') await s.approvePlan(body.note)
    else if (req.method === 'POST' && action === 'assess') await s.assess(true)
    else if (req.method === 'POST' && action === 'answer' && arg) s.answer(arg, body)
    else if (req.method === 'POST' && action === 'workflow' && arg) {
      const wf = (await loadWorkflows()).find((w) => w.id === arg)
      if (!wf) return send(res, 404, { error: 'No such workflow' })
      await s.runWorkflow(wf)
    }
    else return send(res, 404, { error: 'Not found' })
  } catch (e) {
    return send(res, 409, { error: e.message })
  }
  return send(res, 200, s.summary())
}

// ---- GraphQL: one endpoint over the same features, experiences and sessions ---------

const graphqlApi = createGraphQL({
  project: PROJECT,
  modes: MODES,
  listFeatures,
  readFeature,
  listExperiences,
  readExperience,
  sessionFor,
  loadWorkflows,
  listRemotes,
  listRemoteSources,
  pullRemote: async (id, experience, source) => {
    const f = await pullRemote(id, experience, source)
    await announceFeatures()
    return f
  },
  createFeature,
  updateFeature,
  addContext,
  removeContext,
  createExperience,
  updateExperience,
  deleteExperience,
  sendMessage,
})

// ---- boot --------------------------------------------------------------------------

await loadSaved()
// Starts loading the decision model now (Laya's first load downloads its weights), so
// the first judgment does not wait for it.
await decisions.refresh()
if (!existsSync(FEATURES_DIR)) await fs.mkdir(FEATURES_DIR, { recursive: true })
watchFeatures()

http
  .createServer((req, res) =>
    route(req, res).catch((e) => {
      console.error(e)
      if (!res.headersSent) send(res, 500, { error: e.message })
    }),
  )
  .listen(PORT, '127.0.0.1', async () => {
    console.log('Workbench Web for ' + PROJECT)
    console.log('Open http://localhost:' + PORT)
    try {
      const info = { port: PORT, token: TOKEN, pid: process.pid, startedAt: new Date().toISOString() }
      await fs.writeFile(RUNTIME_FILE, JSON.stringify(info, null, 2), { mode: 0o600 })
      await fs.chmod(RUNTIME_FILE, 0o600)
    } catch (e) {
      console.error('Could not write ' + RUNTIME_FILE + ': ' + e.message)
    }
  })

function shutdown() {
  for (const s of sessions.values()) if (s.q) s.stop()
  // Remove the runtime file only if it is still ours (a newer server may have replaced it).
  try {
    const info = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8'))
    if (info.pid === process.pid) unlinkSync(RUNTIME_FILE)
  } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
