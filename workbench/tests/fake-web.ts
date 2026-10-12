import type { On } from 'claude-code'

// A Workbench Web in memory, answering the mod's $.http.fetch calls the way the
// real server does (same routes, token, statuses), plus helpers that play the
// agent's part: ask a question, ask for a tool, say something, finish a turn.

export const WEB_PORT = 4477
export const WEB_TOKEN = 't'.repeat(48)
const RUNTIME = '.claude/workbench-web.runtime.json'

type Pending = { id: string; kind: 'tool' | 'question'; toolName: string; input: any; canAlways?: boolean }
type Session = {
  featureId: string
  status: 'idle' | 'running' | 'needs-you' | 'ready' | 'paused' | 'error'
  live: boolean
  sessionId: string | null
  mode: string
  cost: number
  historyLoaded: boolean
  pending: Pending[]
  phase: 'planning' | 'building' | null
  buildMode: string
  assessment?: any
}

export type FakeWeb = ReturnType<typeof fakeWeb>

export function fakeWeb(on: On, files: Record<string, string>, opts: { running?: boolean } = {}) {
  const sessions: Record<string, Session> = {}
  const events: Record<string, any[]> = {}
  const calls: { method: string; path: string; body: any }[] = []
  // Decisions: off unless a test turns them on, with scripted judgments by kind.
  const decisions: { provider: string; mode: string; judge: Record<string, (body: any) => any> } = { provider: 'off', mode: 'shadow', judge: {} }
  let version = 0
  let nextId = 1
  let browsers = 0

  const featureIds = () =>
    Object.keys(files)
      .filter((p) => p.startsWith('.claude/features/') && p.endsWith('.json'))
      .map((p) => p.slice('.claude/features/'.length, -'.json'.length))
  const session = (id: string): Session =>
    (sessions[id] ||= { featureId: id, status: 'idle', live: false, sessionId: null, mode: 'default', cost: 0, historyLoaded: false, pending: [], phase: null, buildMode: 'default' })
  const bump = () => version++
  const setMode = (s: Session, mode: string) => {
    if (mode === 'plan' && s.phase !== 'planning') {
      if (s.mode !== 'plan') s.buildMode = s.mode
      s.phase = 'planning'
    } else if (mode !== 'plan' && s.phase === 'planning') s.phase = 'building'
    s.mode = mode
    bump()
  }
  const planFirstFor = (id: string) => {
    const f = JSON.parse(files['.claude/features/' + id + '.json'] ?? '{}')
    const exp = f.experience ? JSON.parse(files['.claude/experiences/' + f.experience + '.json'] ?? '{}') : {}
    if (typeof exp.planFirst === 'boolean') return exp.planFirst
    return JSON.parse(files['.claude/workbench.json'] ?? '{}').planFirst === true
  }
  const emit = (id: string, ev: any) => {
    ;(events[id] ||= []).push(ev)
    bump()
  }
  const begin = (id: string) => {
    const s = session(id)
    if (!s.sessionId) {
      s.sessionId = 'session-' + id
      const f = JSON.parse(files['.claude/features/' + id + '.json'] ?? '{}')
      const planFirst = planFirstFor(id)
      if (planFirst) setMode(s, 'plan')
      emit(id, { t: 'user', text: '# Feature: ' + f.title + ' (' + id + ')' + (planFirst ? '\n\nPlan first: …' : '') })
    }
    s.live = true
    s.status = 'running'
  }

  const web = {
    calls,
    sessions,
    events,
    decisions,
    /** Turns decisions on, in shadow or "on" mode, with scripted judgments per kind. */
    setDecisions(mode: 'shadow' | 'on', judge: Record<string, (body: any) => any>) {
      decisions.provider = 'laya'
      decisions.mode = mode
      decisions.judge = judge
      bump()
    },
    /** A plan review arriving for a waiting plan. */
    reviewPlan(id: string, pendingId: string, review: any) {
      const p: any = session(id).pending.find((x) => x.id === pendingId)
      p.review = review
      emit(id, { t: 'decision', kind: 'plan', verdict: review.revise ? 'revise' : 'ok', checks: review.checks, applied: false })
    },
    up() {
      files[RUNTIME] = JSON.stringify({ port: WEB_PORT, token: WEB_TOKEN, pid: 1 })
    },
    down() {
      delete files[RUNTIME]
    },
    setBrowsers(n: number) {
      browsers = n
      bump()
    },
    /** The agent asks a question (AskUserQuestion). */
    askQuestion(id: string, question: string, options: string[] = [], extra: any = {}) {
      const p: Pending = { id: 'p' + nextId++, kind: 'question', toolName: 'AskUserQuestion', input: { questions: [{ question, header: 'Q', options: options.map((label) => ({ label, description: '' })), multiSelect: false, ...extra }] } }
      const s = session(id)
      s.pending.push(p)
      s.status = 'needs-you'
      emit(id, { t: 'ask', id: p.id, kind: p.kind, toolName: p.toolName, input: p.input })
      return p.id
    },
    /** The agent presents its plan (ExitPlanMode). */
    presentPlan(id: string, plan: string) {
      return web.askTool(id, 'ExitPlanMode', { plan }, false)
    },
    /** The agent wants a tool the policy did not allow. */
    askTool(id: string, toolName: string, input: any, canAlways = true) {
      const p: Pending = { id: 'p' + nextId++, kind: 'tool', toolName, input, canAlways }
      const s = session(id)
      s.pending.push(p)
      s.status = 'needs-you'
      emit(id, { t: 'ask', id: p.id, kind: p.kind, toolName, input })
      return p.id
    },
    say(id: string, text: string) {
      emit(id, { t: 'text', text })
    },
    tool(id: string, name: string, input: any, result: string) {
      emit(id, { t: 'tool', id: 'tu' + nextId, name, input })
      emit(id, { t: 'tool_result', id: 'tu' + nextId++, text: result, isError: false })
    },
    finish(id: string, cost = 0.05) {
      const s = session(id)
      s.cost += cost
      s.status = s.pending.length ? 'needs-you' : 'ready'
      emit(id, { t: 'result', ok: true, subtype: 'success', turns: 1, cost })
    },
  }
  if (opts.running !== false) web.up()

  const reply = (status: number, body: any) => ({ value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(body) } }) as never

  on('http.fetch', async (_$, e) => {
    const url = new URL(e.url)
    if (url.port !== String(WEB_PORT) || !(WEB_PORT && files[RUNTIME])) throw new Error('ECONNREFUSED ' + e.url)
    const init = e.init || {}
    const method = init.method || 'GET'
    if ((init.headers || {})['X-Workbench-Token'] !== WEB_TOKEN) return reply(401, { error: 'Missing or wrong token' })
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path: url.pathname, body })

    if (method === 'GET' && url.pathname === '/api/state') {
      const ids = featureIds()
      const fid = url.searchParams.get('feature')
      const tail = Number(url.searchParams.get('tail')) || 40
      let transcript = null
      if (fid && ids.includes(fid)) {
        session(fid).historyLoaded = true
        const shown = events[fid] || []
        transcript = { featureId: fid, total: shown.length, events: shown.slice(-tail) }
      }
      return reply(200, { version, project: '/project', browsers, decisions: { provider: decisions.provider, mode: decisions.mode, ready: true }, sessions: ids.map((id) => ({ ...session(id) })), transcript })
    }

    if (method === 'POST' && url.pathname === '/api/decide') {
      const judge = decisions.judge[body.kind]
      if (decisions.provider === 'off' || !judge) return reply(200, { off: true })
      return reply(200, { ...judge(body), mode: decisions.mode, acting: decisions.mode === 'on' })
    }

    const m = url.pathname.match(/^\/api\/features\/([a-z0-9._-]+)\/([a-z-]+)(?:\/([A-Za-z0-9-]+))?$/)
    if (!m || method !== 'POST') return reply(404, { error: 'Not found' })
    const id = m[1] as string
    const action = m[2] as string
    const arg = m[3]
    if (!featureIds().includes(id)) return reply(404, { error: 'No such feature' })
    const s = session(id)
    switch (action) {
      case 'start':
        if (s.sessionId || s.live) return reply(409, { error: 'This feature already has a session; send a message to resume it' })
        begin(id)
        break
      case 'message':
        begin(id)
        emit(id, { t: 'user', text: body.text })
        break
      case 'answer': {
        const p = s.pending.find((x) => x.id === arg)
        if (!p) return reply(409, { error: 'That request is no longer waiting' })
        s.pending = s.pending.filter((x) => x.id !== arg)
        emit(id, { t: 'answered', id: arg, text: p.kind === 'question' ? JSON.stringify(body.answers) : body.allow ? (body.always ? 'Allowed (always)' : 'Allowed') : 'Denied' + (body.message ? ': ' + body.message : '') })
        s.status = s.pending.length ? 'needs-you' : 'running'
        break
      }
      case 'interrupt':
        emit(id, { t: 'system', text: 'Interrupted.' })
        break
      case 'stop':
        s.live = false
        s.pending = []
        s.status = s.sessionId ? 'paused' : 'idle'
        emit(id, { t: 'system', text: 'Session stopped. Send a message to resume it.' })
        break
      case 'reset':
        sessions[id] = { ...session(id), status: 'idle', live: false, sessionId: null, cost: 0, pending: [], phase: null, mode: s.mode === 'plan' ? s.buildMode : s.mode }
        events[id] = []
        bump()
        break
      case 'mode':
        setMode(s, body.mode)
        break
      case 'assess':
        s.assessment = decisions.judge.approach ? decisions.judge.approach({ featureId: id }) : null
        bump()
        break
      case 'approve-plan': {
        if (s.phase !== 'planning') return reply(409, { error: 'There is no plan waiting for approval' })
        const exit = s.pending.find((x) => x.toolName === 'ExitPlanMode')
        setMode(s, s.buildMode !== 'plan' ? s.buildMode : 'default')
        if (exit) {
          s.pending = s.pending.filter((x) => x.id !== exit.id)
          emit(id, { t: 'answered', id: exit.id, text: 'Allowed' })
        } else emit(id, { t: 'user', text: 'The plan is approved. Go ahead and build it.' + (body.note ? '\n\n' + body.note : '') })
        if (exit && body.note) emit(id, { t: 'user', text: body.note })
        s.status = s.pending.length ? 'needs-you' : 'running'
        break
      }
      case 'workflow':
        if (!['plan', 'review', 'tests', 'pr-description'].includes(arg ?? '')) return reply(404, { error: 'No such workflow' })
        begin(id)
        emit(id, { t: 'workflow', name: arg, kind: 'prompt' })
        break
      default:
        return reply(404, { error: 'Not found' })
    }
    return reply(200, { ...session(id) })
  })

  return web
}
