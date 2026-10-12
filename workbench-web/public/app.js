// Workbench Web client. No build step, no dependencies.
'use strict'

const $ = (id) => document.getElementById(id)
const S = {
  features: [],
  sessions: {}, // featureId -> summary from the server
  events: {}, // featureId -> event list
  selected: null, // feature id when a feature is open
  expView: null, // experience id when an experience overview is open ('' = ungrouped never opens)
  experiences: [],
  collapsed: {},
  workflows: [],
  remotes: [],
  remoteSources: [],
  tab: 'features',
  showArchived: false,
}
let R = null // transcript renderer for the selected feature

// ---- server ----------------------------------------------------------------

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': WB.token },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    toast(data.error || 'Request failed (' + r.status + ')')
    throw new Error(data.error || r.status)
  }
  return data
}
const featureApi = (id, action, body) => api('POST', '/api/features/' + encodeURIComponent(id) + '/' + action, body)

function connect() {
  const es = new EventSource('/api/events?token=' + encodeURIComponent(WB.token))
  es.onmessage = (e) => onServer(JSON.parse(e.data))
  es.onerror = async () => {
    $('summary').textContent = 'Reconnecting to the Workbench server…'
    // A restarted server issues a new token; reload to pick it up.
    try {
      const r = await fetch('/api/workflows', { headers: { 'X-Workbench-Token': WB.token } })
      if (r.status === 401) location.reload()
    } catch {}
  }
}

function onServer(msg) {
  switch (msg.type) {
    case 'snapshot':
      S.features = msg.features
      S.experiences = msg.experiences || []
      S.sessions = {}
      S.events = {}
      for (const s of msg.sessions) {
        S.events[s.featureId] = s.events
        delete s.events
        S.sessions[s.featureId] = s
      }
      renderSidebar()
      route()
      break
    case 'features':
      S.features = msg.features
      S.experiences = msg.experiences || S.experiences
      for (const s of msg.sessions) S.sessions[s.featureId] = { ...S.sessions[s.featureId], ...s }
      renderSidebar()
      if (S.selected) {
        renderHeader()
        renderBrief()
      }
      if (S.expView) renderExperience()
      renderNewTarget()
      loadRemotes()
      break
    case 'status': {
      const prev = S.sessions[msg.featureId]
      S.sessions[msg.featureId] = msg
      renderSidebar()
      if (S.expView) renderExperience()
      if (msg.featureId === S.selected) {
        renderHeader()
        R?.syncPending(msg.pending)
        R?.syncWorking(msg.status)
      }
      if (prev && prev.status === 'running' && msg.status === 'ready' && msg.featureId !== S.selected) {
        notify(titleOf(msg.featureId) + ' finished its turn', msg.featureId)
      }
      break
    }
    case 'event': {
      const list = (S.events[msg.featureId] ||= [])
      list.push(msg.event)
      if (msg.featureId === S.selected) R?.apply(msg.event)
      if (msg.event.t === 'ask') {
        const what = msg.event.kind === 'question' ? firstQuestion(msg.event.input) : 'wants to use ' + msg.event.toolName
        notify(titleOf(msg.featureId) + ' needs you: ' + what, msg.featureId, msg.featureId === S.selected && !document.hidden)
      }
      break
    }
    case 'reset':
      S.events[msg.featureId] = msg.events
      if (msg.featureId === S.selected) renderTranscript()
      break
  }
  updateTitle()
}

// ---- helpers -----------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k === 'html') n.innerHTML = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v)
  }
  for (const k of kids.flat()) if (k != null) n.append(k)
  return n
}
const featureOf = (id) => S.features.find((f) => f.id === id)
const titleOf = (id) => featureOf(id)?.title || id
const expOf = (id) => S.experiences.find((e) => e.id === id)
// Which experience a new feature (or pulled issue) lands in: the one on screen.
const targetExperience = () => (S.expView ? S.expView : S.selected ? featureOf(S.selected)?.experience || null : null)
const statusOf = (id) => S.sessions[id]?.status || 'idle'
const STATUS_WORDS = { idle: 'Not started', running: 'Working', 'needs-you': 'Needs you', ready: 'Waiting for you', paused: 'Paused', error: 'Error' }
const firstQuestion = (input) => input?.questions?.[0]?.question || 'a question'
const money = (n) => (n ? '$' + n.toFixed(n < 1 ? 3 : 2) : '')

// Small, safe Markdown: escape first, then add formatting.
function md(src) {
  const blocks = []
  let text = String(src ?? '').replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, (_, code) => {
    blocks.push('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>')
    return '\u0000' + (blocks.length - 1) + '\u0000'
  })
  text = esc(text)
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  const out = []
  let list = null
  const closeList = () => {
    if (list) out.push('</' + list + '>')
    list = null
  }
  for (const line of text.split('\n')) {
    const code = line.match(/^\u0000(\d+)\u0000$/)
    const h = line.match(/^(#{1,3})\s+(.*)/)
    const ul = line.match(/^\s*[-*]\s+(.*)/)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/)
    if (code) {
      closeList()
      out.push(blocks[+code[1]])
    } else if (h) {
      closeList()
      out.push('<h' + (h[1].length + 1) + '>' + inline(h[2]) + '</h' + (h[1].length + 1) + '>')
    } else if (ul || ol) {
      const want = ul ? 'ul' : 'ol'
      if (list !== want) {
        closeList()
        out.push('<' + want + '>')
        list = want
      }
      out.push('<li>' + inline((ul || ol)[1]) + '</li>')
    } else if (!line.trim()) {
      closeList()
    } else {
      closeList()
      out.push('<p>' + inline(line) + '</p>')
    }
  }
  closeList()
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i])
}

function toolArg(name, input = {}) {
  if (Array.isArray(input.questions)) return input.questions.map((q) => q.question).join(' · ')
  if (input.command) return input.command
  if (input.file_path) return input.file_path
  if (input.pattern) return input.pattern + (input.path ? '  in ' + input.path : '')
  if (input.url) return input.url
  if (input.description) return input.description
  if (input.query) return input.query
  const j = JSON.stringify(input)
  return j.length > 120 ? j.slice(0, 120) + '…' : j
}

function toolDetail(name, input = {}) {
  if (name === 'Bash') return input.command
  if (name === 'Edit') return '--- ' + input.file_path + '\n- ' + (input.old_string || '').split('\n').join('\n- ') + '\n+ ' + (input.new_string || '').split('\n').join('\n+ ')
  if (name === 'Write') return input.file_path + '\n\n' + (input.content || '')
  return JSON.stringify(input, null, 2)
}

// A judgment from the decisions model, as one transcript line with its details.
const DECISION_WORDS = { allow: 'allow', deny: 'deny', ask: 'ask you', revise: 'send back', ok: 'looks fine', 'follow-up': 'follow up', error: 'no judgment' }
function decisionLine(ev) {
  const what = ev.kind === 'tool' ? 'Tool ' + (ev.toolName || '') : ev.kind === 'plan' ? 'Plan' : ev.kind === 'turn' ? 'Turn end' : ev.kind
  const verdict = DECISION_WORDS[ev.verdict] || ev.verdict
  const shadow = ev.verdict !== 'error' && !ev.applied && ev.verdict !== 'ask' && ev.verdict !== 'ok'
  const head = el(
    'summary',
    {},
    el('span', { class: 'dname', text: '◆ Laya' }),
    ' ' + what + ' · ',
    el('b', { text: verdict }),
    ev.standard ? ' · ' + ev.standard : '',
    typeof ev.confidence === 'number' ? ' · ' + Math.round(ev.confidence * 100) + '%' : '',
    shadow ? el('span', { class: 'muted', text: ' (shadow: not acted on)' }) : '',
  )
  return el(
    'details',
    { class: 'decision ' + (ev.verdict || '') },
    head,
    ev.reason ? el('div', { class: 'dreason', text: ev.reason }) : '',
    ev.checks?.length ? checkList(ev.checks) : '',
  )
}
function checkList(checks = [], title) {
  const mark = { pass: '✓', fail: '✗', unsure: '?', note: '·' }
  return el(
    'div',
    { class: 'checks' },
    title ? el('div', { class: 'muted', text: title }) : '',
    ...checks.map((c) => el('div', { class: 'check ' + c.status }, (mark[c.status] || '·') + ' ' + c.label, typeof c.p === 'number' ? el('span', { class: 'muted', text: ' ' + Math.round(c.p * 100) + '%' }) : '')),
  )
}

const clipText = (s, n = 6000) => (s.length > n ? s.slice(0, n) + '\n…(' + (s.length - n) + ' more characters)' : s)

// ---- transcript renderer: append-only, so typing in a card is never wiped ------

class Transcript {
  constructor(featureId, root) {
    this.featureId = featureId
    this.root = root
    this.live = null
    this.liveText = ''
    this.tools = new Map()
    this.asks = new Map()
    this.sawUser = false
    this.working = null
  }

  stick(fn) {
    const r = this.root
    const atBottom = r.scrollHeight - r.scrollTop - r.clientHeight < 80
    fn()
    if (atBottom) r.scrollTop = r.scrollHeight
  }

  add(node) {
    if (this.working) this.root.insertBefore(node, this.working)
    else this.root.append(node)
    return node
  }

  endLive() {
    if (this.live) this.live.classList.remove('streaming')
    this.live = null
    this.liveText = ''
  }

  apply(ev) {
    this.stick(() => this.applyOne(ev))
  }

  applyOne(ev) {
    switch (ev.t) {
      case 'delta':
        if (!this.live) this.live = this.add(el('div', { class: 'msg-text streaming' }))
        this.liveText += ev.text
        this.live.innerHTML = md(this.liveText)
        return
      case 'text':
        if (this.live) {
          this.live.innerHTML = md(ev.text)
          this.endLive()
        } else this.add(el('div', { class: 'msg-text', html: md(ev.text) }))
        return
    }
    this.endLive()
    switch (ev.t) {
      case 'user': {
        const isBrief = !this.sawUser && ev.text.startsWith('# Feature:')
        this.sawUser = true
        if (isBrief) this.add(el('details', { class: 'msg-user brief-msg' }, el('summary', { text: 'Brief sent to Claude' }), el('pre', { text: ev.text })))
        else this.add(el('div', { class: 'msg-user', text: ev.text }))
        break
      }
      case 'tool': {
        const state = el('span', { class: 'tstate wait', text: ev.history ? '' : 'running…' })
        const body = el('div', { class: 'tbody' }, el('pre', { text: toolDetail(ev.name, ev.input) }))
        const card = el('details', { class: 'tool' }, el('summary', {}, el('span', { class: 'tname', text: ev.name }), el('span', { class: 'targ', text: toolArg(ev.name, ev.input) }), state), body)
        this.tools.set(ev.id, { card, state, body })
        this.add(card)
        break
      }
      case 'tool_result': {
        const t = this.tools.get(ev.id)
        if (!t) break
        t.state.className = 'tstate ' + (ev.isError ? 'err' : 'ok')
        t.state.textContent = ev.isError ? 'failed' : 'done'
        if (ev.text) t.body.append(el('pre', { text: clipText(ev.text) }))
        break
      }
      case 'ask':
        this.add(this.askCard(ev))
        break
      case 'answered': {
        const a = this.asks.get(ev.id)
        if (a) this.finishAsk(a, ev.text)
        break
      }
      case 'result':
        this.add(
          el('div', {
            class: 'result' + (ev.ok ? '' : ' err'),
            text: (ev.ok ? 'Turn finished' : 'Turn ended: ' + ev.subtype) + ' · ' + ev.turns + ' step' + (ev.turns === 1 ? '' : 's') + (ev.cost ? ' · ' + money(ev.cost) : ''),
          }),
        )
        break
      case 'system':
        this.add(el('div', { class: 'sys', text: ev.text }))
        break
      case 'decision':
        this.add(decisionLine(ev))
        break
      case 'error':
        this.add(el('div', { class: 'errline', text: ev.text }))
        break
      case 'workflow':
        this.add(el('div', { class: 'wf-run' }, '▶ Workflow ', el('b', { text: ev.name }), ev.command ? el('span', { class: 'mono', text: ev.command }) : null))
        break
      case 'workflow_output': {
        const sendBtn = el('button', {
          class: 'btn small ghost',
          type: 'button',
          text: 'Send output to Claude',
          onclick: () => sendMessage('Output of the "' + ev.name + '" workflow:\n\n```\n' + clipText(ev.text, 20000) + '\n```'),
        })
        this.add(el('details', { class: 'tool', open: true }, el('summary', {}, el('span', { class: 'tname', text: ev.name }), el('span', { class: 'targ', text: 'output' })), el('div', { class: 'tbody' }, el('pre', { text: clipText(ev.text) }), sendBtn)))
        break
      }
    }
  }

  askCard(ev) {
    const card = el('div', { class: 'ask' })
    const pending = (S.sessions[this.featureId]?.pending || []).some((p) => p.id === ev.id)
    const answer = (body) => featureApi(this.featureId, 'answer/' + ev.id, body).catch(() => {})

    if (ev.kind === 'question') {
      card.append(el('h3', { text: 'Claude has a question' }))
      const qs = ev.input?.questions || []
      const getters = qs.map((q, qi) => {
        const name = 'q' + ev.id + '-' + qi
        const type = q.multiSelect ? 'checkbox' : 'radio'
        const other = el('input', { placeholder: 'Or type your own answer', 'aria-label': 'Other answer' })
        const opts = (q.options || []).map((o) =>
          el('label', { class: 'opt' }, el('input', { type, name, value: o.label }), el('span', {}, o.label, o.description ? el('small', { text: o.description }) : null)),
        )
        card.append(el('div', { class: 'q' }, el('div', { class: 'qtext', text: q.question }), ...opts, other))
        return () => {
          if (other.value.trim()) return [q.question, other.value.trim()]
          const picked = [...card.querySelectorAll('input[name="' + name + '"]:checked')].map((i) => i.value)
          return [q.question, picked.join(', ')]
        }
      })
      const submit = el('button', {
        class: 'btn',
        type: 'button',
        text: 'Send answer',
        onclick: () => {
          const answers = Object.fromEntries(getters.map((g) => g()))
          if (Object.values(answers).some((a) => !a)) return toast('Answer every question first.')
          answer({ answers })
        },
      })
      card.append(el('div', { class: 'buttons' }, submit))
    } else if (ev.toolName === 'ExitPlanMode') {
      card.classList.add('plan')
      card.append(el('h3', { text: "Claude's plan" }), el('div', { class: 'msg-text', html: md(String(ev.input?.plan || '(no plan text)')) }))
      const feedback = el('input', { placeholder: 'What to change in the plan (for Keep planning)', 'aria-label': 'Plan feedback' })
      card.append(
        el(
          'div',
          { class: 'buttons' },
          el('button', { class: 'btn', type: 'button', text: 'Approve plan', onclick: () => featureApi(this.featureId, 'approve-plan').catch(() => {}) }),
          el('button', { class: 'btn ghost', type: 'button', text: 'Keep planning', onclick: () => answer({ allow: false, message: feedback.value.trim() || 'Keep planning: revise the plan before building.' }) }),
          feedback,
        ),
      )
    } else {
      card.append(el('h3', { text: 'Allow ' + ev.toolName + '?' }), el('pre', { text: clipText(toolDetail(ev.toolName, ev.input), 4000) }))
      const reason = el('input', { placeholder: 'Reason or instructions if you deny (optional)', 'aria-label': 'Deny reason' })
      const canAlways = (S.sessions[this.featureId]?.pending || []).find((p) => p.id === ev.id)?.canAlways
      card.append(
        el(
          'div',
          { class: 'buttons' },
          el('button', { class: 'btn', type: 'button', text: 'Allow', onclick: () => answer({ allow: true }) }),
          canAlways ? el('button', { class: 'btn ghost', type: 'button', text: 'Always allow', onclick: () => answer({ allow: true, always: true }) }) : null,
          el('button', { class: 'btn ghost danger', type: 'button', text: 'Deny', onclick: () => answer({ allow: false, message: reason.value.trim() }) }),
          reason,
        ),
      )
    }
    const a = { id: ev.id, card }
    this.asks.set(ev.id, a)
    if (!pending) this.finishAsk(a, null)
    return card
  }

  finishAsk(a, text) {
    if (a.done) {
      if (text) a.note.textContent = text
      return
    }
    a.done = true
    a.card.classList.add('done')
    a.card.querySelectorAll('button, input').forEach((n) => (n.disabled = true))
    a.note = el('div', { class: 'muted', text: text || 'No longer waiting.' })
    a.card.append(a.note)
  }

  syncPending(pending = []) {
    const ids = new Set(pending.map((p) => p.id))
    for (const a of this.asks.values()) if (!a.done && !ids.has(a.id)) this.finishAsk(a, null)
    // A plan's review arrives after its card: show its checks above the buttons.
    for (const p of pending) {
      const a = this.asks.get(p.id)
      if (a && !a.done && p.review && !a.review) {
        a.review = checkList(p.review.checks, p.review.revise ? 'Laya: some checks failed' : 'Laya: checks passed')
        a.card.insertBefore(a.review, a.card.querySelector('.buttons'))
      }
    }
  }

  syncWorking(status) {
    if (status === 'running' && !this.working) {
      this.stick(() => (this.working = this.root.appendChild(el('div', { class: 'working', text: 'Claude is working…' }))))
    } else if (status !== 'running' && this.working) {
      this.working.remove()
      this.working = null
    }
  }
}

// ---- sidebar ------------------------------------------------------------------

function sortedFeatures() {
  const rank = { 'needs-you': 0, running: 1, error: 2, ready: 3, paused: 4, idle: 5 }
  return S.features
    .filter((f) => S.showArchived || (f.status !== 'archived' && f.status !== 'done'))
    .slice()
    .sort((a, b) => rank[statusOf(a.id)] - rank[statusOf(b.id)] || (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

function featureButton(f) {
  const s = S.sessions[f.id] || {}
  const st = statusOf(f.id)
  const n = s.pending?.length || 0
  const sub = [STATUS_WORDS[st], f.remote ? f.remote.ref || f.remote.id : null, money(s.cost)].filter(Boolean).join(' · ')
  return el(
    'button',
    { class: 'feature-item' + (f.id === S.selected ? ' active' : '') + (f.status === 'archived' || f.status === 'done' ? ' archived' : ''), type: 'button', onclick: () => go('f', f.id) },
    el('span', { class: 'dot ' + st, title: STATUS_WORDS[st] }),
    el('span', { class: 'name', text: f.title }),
    n ? el('span', { class: 'badge', text: String(n) }) : el('span'),
    el('span', { class: 'sub', text: sub }),
  )
}

function groupStats(features) {
  const needs = features.reduce((a, f) => a + (S.sessions[f.id]?.pending?.length || 0), 0)
  const running = features.filter((f) => statusOf(f.id) === 'running').length
  return { needs, running }
}

function renderSidebar() {
  const list = $('featureList')
  const feats = sortedFeatures()
  const groups = S.experiences.map((e) => ({ id: e.id, title: e.title, features: feats.filter((f) => f.experience === e.id) }))
  const known = new Set(S.experiences.map((e) => e.id))
  const loose = feats.filter((f) => !f.experience || !known.has(f.experience))
  const nodes = []
  for (const g of groups) {
    const { needs, running } = groupStats(g.features)
    const collapsed = !!S.collapsed[g.id]
    const chev = el('span', {
      class: 'chev',
      text: '▾',
      role: 'button',
      'aria-label': collapsed ? 'Expand' : 'Collapse',
      onclick: (e) => {
        e.stopPropagation()
        S.collapsed[g.id] = !S.collapsed[g.id]
        saveCollapsed()
        renderSidebar()
      },
    })
    nodes.push(
      el(
        'div',
        { class: 'group' + (collapsed ? ' collapsed' : '') },
        el(
          'button',
          { class: 'group-head' + (S.expView === g.id ? ' active' : ''), type: 'button', onclick: () => go('e', g.id), title: 'Open the ' + g.title + ' experience' },
          chev,
          el('span', { class: 'gname', text: g.title }),
          needs ? el('span', { class: 'badge', text: String(needs) }) : running ? el('span', { class: 'dot running' }) : el('span'),
          el('span', { class: 'count', text: String(g.features.length) }),
        ),
        el('div', { class: 'group-items' }, ...g.features.map(featureButton)),
      ),
    )
  }
  if (loose.length) {
    const head = S.experiences.length
      ? el('div', { class: 'group-head ungrouped' }, el('span'), el('span', { class: 'gname', text: 'Ungrouped' }), el('span'), el('span', { class: 'count', text: String(loose.length) }))
      : null
    nodes.push(el('div', { class: 'group' }, head, el('div', { class: S.experiences.length ? 'group-items' : '' }, ...loose.map(featureButton))))
  }
  list.replaceChildren(...nodes)
  if (!feats.length && !S.experiences.length) list.append(el('p', { class: 'muted', style: 'padding:8px', text: 'No features yet. Add one above, or pull one from Remote.' }))
  const all = Object.values(S.sessions)
  const needs = all.filter((s) => s.status === 'needs-you').length
  const running = all.filter((s) => s.status === 'running').length
  $('summary').textContent = needs || running ? [needs ? needs + ' need' + (needs === 1 ? 's' : '') + ' you' : null, running ? running + ' working' : null].filter(Boolean).join(' · ') : S.features.length + ' feature' + (S.features.length === 1 ? '' : 's')
}

function saveCollapsed() {
  try {
    localStorage.setItem('wb.collapsed', JSON.stringify(S.collapsed))
  } catch {}
}

function renderNewTarget() {
  const e = expOf(targetExperience())
  $('newTarget').textContent = e ? 'Adds to ' + e.title : ''
}

function updateTitle() {
  const needs = Object.values(S.sessions).filter((s) => s.status === 'needs-you').length
  document.title = (needs ? '(' + needs + ') ' : '') + 'Workbench'
}

async function loadRemotes() {
  try {
    ;[S.remotes, S.remoteSources] = await Promise.all([api('GET', '/api/remotes'), api('GET', '/api/remotes/sources')])
  } catch {
    S.remotes = []
    S.remoteSources = []
  }
  renderRemotes()
}

function renderRemotes() {
  const box = $('remoteList')
  const itemRow = (it) =>
    el(
      'div',
      { class: 'remote-item' + (it.type === 'Epic' ? ' epic' : '') },
      el('span', { class: 'rid' }, el('span', { class: 'rtype ' + it.type.toLowerCase(), text: it.typeLabel }), ' ', it.url ? el('a', { href: it.url, target: '_blank', rel: 'noopener', text: it.ref }) : it.ref),
      el('span', { class: 'rtitle', text: it.title }),
      el(
        'span',
        { class: 'rmeta' },
        el('span', { text: it.status }),
        ...it.labels.map((l) => el('span', { class: 'label', text: l })),
        it.experienceId ? el('span', { text: '→ ' + (expOf(it.experienceId)?.title || it.experienceId) }) : '',
      ),
      it.featureId
        ? el('button', { class: 'btn small ghost', type: 'button', text: 'Open feature', onclick: () => (setTab('features'), go('f', it.featureId)) })
        : el('button', {
            class: 'btn small',
            type: 'button',
            text: 'Pull ' + it.typeLabel.toLowerCase(),
            title: it.type === 'Epic' ? 'One feature for the whole ' + it.typeLabel.toLowerCase() + '; its brief lists everything under it.' : undefined,
            onclick: async () => {
              const f = await api('POST', '/api/remotes/pull', { source: it.source, id: it.id, experience: targetExperience() || null })
              setTab('features')
              go('f', f.id)
              toast('Pulled ' + it.ref + ' "' + f.title + '"' + (f.experience ? ' into "' + (expOf(f.experience)?.title || f.experience) + '"' : '') + '. Check the brief, then press Start.')
            },
          }),
    )
  // One section per tracker: each group (epic, parent issue) with its items under it,
  // then items in no group.
  const tracker = (src) => {
    const items = S.remotes.filter((it) => it.source === src.source)
    const epics = items.filter((it) => it.type === 'Epic')
    const known = new Set(epics.map((e) => e.id))
    const loose = items.filter((it) => it.type !== 'Epic' && !known.has(it.epic))
    const noGroup = src.kind === 'github' ? 'No parent issue' : 'No epic'
    return el(
      'section',
      { class: 'remote-source' },
      el('h4', {}, src.name, src.where ? el('span', { class: 'muted', text: ' · ' + src.where.replace(/^https?:\/\//, '').replace(/\/browse\/?$/, '') }) : ''),
      ...epics.map((e) =>
        el('section', { class: 'remote-epic' }, itemRow(e), el('div', { class: 'remote-stories' }, ...items.filter((it) => it.epic === e.id).map(itemRow))),
      ),
      ...(loose.length ? [el('section', { class: 'remote-epic' }, el('h5', { text: noGroup }), el('div', { class: 'remote-stories' }, ...loose.map(itemRow)))] : []),
      ...(items.length ? [] : [el('p', { class: 'muted', text: 'Nothing in ' + src.name + '.' })]),
    )
  }
  box.replaceChildren(...(S.remoteSources || []).map(tracker))
  if (!(S.remoteSources || []).length) box.append(el('p', { class: 'muted', text: 'No remote trackers. Add one to workbench-web/remotes/.' }))
}

// "Jira Story", "GitHub Issue": the tracker's name and what it calls the item.
function remoteName(r) {
  const src = (S.remoteSources || []).find((x) => x.source === (r.source || 'jira'))
  const github = src?.kind === 'github'
  return (src?.name || 'Jira') + ' ' + (r.type === 'Epic' ? (github ? 'parent issue' : 'epic') : github ? 'issue' : 'story')
}

function setTab(tab) {
  S.tab = tab
  $('tabFeatures').classList.toggle('active', tab === 'features')
  $('tabRemote').classList.toggle('active', tab === 'remote')
  $('tabFeatures').setAttribute('aria-selected', tab === 'features')
  $('tabRemote').setAttribute('aria-selected', tab === 'remote')
  $('featureList').classList.toggle('hidden', tab !== 'features')
  $('remoteList').classList.toggle('hidden', tab !== 'remote')
  if (tab === 'remote') loadRemotes()
}

// ---- selected feature -------------------------------------------------------------

// Navigation lives in the URL hash (#/f/<feature>, #/e/<experience>) so back/forward work.
function go(kind, id) {
  const hash = '#/' + kind + '/' + encodeURIComponent(id)
  if (location.hash === hash) route()
  else location.hash = hash
}

function route() {
  const m = location.hash.match(/^#\/(f|e)\/(.+)$/)
  const kind = m?.[1]
  const id = m ? decodeURIComponent(m[2]) : null
  if (kind === 'f' && featureOf(id)) return select(id)
  if (kind === 'e' && expOf(id)) return openExperience(id)
  let last = null
  try {
    last = localStorage.getItem('wb.last')
  } catch {}
  const lm = last?.match(/^(f|e):(.+)$/)
  if (lm && (lm[1] === 'f' ? featureOf(lm[2]) : expOf(lm[2]))) return go(lm[1], lm[2])
  const first = sortedFeatures()[0]
  if (first) return go('f', first.id)
  showEmpty()
}

function remember(kind, id) {
  try {
    localStorage.setItem('wb.last', kind + ':' + id)
  } catch {}
}

function showEmpty() {
  S.selected = null
  S.expView = null
  $('empty').classList.remove('hidden')
  $('feature').classList.add('hidden')
  $('experience').classList.add('hidden')
  renderSidebar()
  renderNewTarget()
}

function select(id) {
  const changed = S.selected !== id
  S.selected = id
  S.expView = null
  remember('f', id)
  $('sidebar').classList.remove('open')
  $('empty').classList.add('hidden')
  $('experience').classList.add('hidden')
  $('feature').classList.remove('hidden')
  renderSidebar()
  renderHeader()
  renderBrief()
  renderWorkflows()
  renderNewTarget()
  if (changed || !R) renderTranscript()
  const s = S.sessions[id]
  if (s?.sessionId && !s.historyLoaded) featureApi(id, 'history').catch(() => {})
  if (!s?.sessionId && !s?.live && !s?.assessment) featureApi(id, 'assess').catch(() => {})
  if (changed) $('msgInput').focus()
}

function openExperience(id) {
  S.selected = null
  S.expView = id
  R = null
  remember('e', id)
  if (S.collapsed[id]) {
    delete S.collapsed[id]
    saveCollapsed()
  }
  $('sidebar').classList.remove('open')
  $('empty').classList.add('hidden')
  $('feature').classList.add('hidden')
  $('experience').classList.remove('hidden')
  renderSidebar()
  renderExperience()
  renderNewTarget()
}

function readyToStart(f) {
  const s = S.sessions[f.id] || {}
  return f.status !== 'archived' && f.status !== 'done' && !s.sessionId && !s.live && !!f.description?.trim()
}

function renderExperience() {
  const e = expOf(S.expView)
  if (!e) return route()
  const feats = sortedFeatures().filter((f) => f.experience === e.id)
  if (document.activeElement !== $('expTitle')) $('expTitle').value = e.title
  if (document.activeElement !== $('expDesc')) $('expDesc').value = e.description || ''
  if (document.activeElement !== $('expLabels')) $('expLabels').value = (e.labels || []).join(', ')
  $('expPlanFirst').checked = e.planFirst === true
  const { needs, running } = groupStats(feats)
  const done = feats.filter((f) => statusOf(f.id) === 'ready').length
  $('expMeta').replaceChildren(
    el('span', { class: 'muted', text: feats.length + ' feature' + (feats.length === 1 ? '' : 's') }),
    needs ? el('span', { class: 'pill needs-you', text: needs + ' need' + (needs === 1 ? 's' : '') + ' you' }) : '',
    running ? el('span', { class: 'pill running', text: running + ' working' }) : '',
    done ? el('span', { class: 'pill ready', text: done + ' waiting for you' }) : '',
  )
  const ready = feats.filter(readyToStart)
  $('expStartAll').disabled = !ready.length
  $('expStartAll').textContent = ready.length ? 'Start ' + ready.length + ' ready feature' + (ready.length === 1 ? '' : 's') : 'Nothing ready to start'
  $('expStartAll').title = 'Starts every feature in this experience that has a description and no session yet.'
  $('expGrid').replaceChildren(
    ...feats.map((f) => {
      const s = S.sessions[f.id] || {}
      const st = statusOf(f.id)
      const n = s.pending?.length || 0
      return el(
        'button',
        { class: 'exp-card' + (n ? ' needs' : ''), type: 'button', onclick: () => go('f', f.id) },
        el('span', { class: 'top' }, el('span', { class: 'dot ' + st }), el('span', { text: f.title }), n ? el('span', { class: 'badge', text: String(n) }) : ''),
        el('span', { class: 'desc', text: f.description?.trim() || 'No description yet.' }),
        el('span', { class: 'foot' }, STATUS_WORDS[st], f.remote ? ' · ' + (f.remote.ref || f.remote.id) : '', s.cost ? ' · ' + money(s.cost) : ''),
      )
    }),
  )
  if (!feats.length) $('expGrid').append(el('p', { class: 'muted', text: 'No features here yet. Add one below, or move an existing feature in from its header.' }))
}

function renderHeader() {
  const f = featureOf(S.selected)
  if (!f) return
  const s = S.sessions[f.id] || {}
  const st = statusOf(f.id)
  if (document.activeElement !== $('titleInput')) $('titleInput').value = f.title
  const exp = expOf(f.experience)
  $('crumbLink').textContent = exp ? exp.title + ' ›' : ''
  $('crumbLink').href = exp ? '#/e/' + encodeURIComponent(exp.id) : '#'
  $('crumbLink').classList.toggle('hidden', !exp)
  $('expSelect').replaceChildren(
    el('option', { value: '', text: exp ? 'Move to…' : 'Add to experience…' }),
    ...S.experiences.filter((e) => e.id !== f.experience).map((e) => el('option', { value: e.id, text: e.title })),
    exp ? el('option', { value: '__none', text: 'Remove from ' + exp.title }) : null,
  )
  $('expSelect').value = ''
  $('expSelect').classList.toggle('hidden', !S.experiences.length)
  $('statusPill').className = 'pill ' + st
  $('statusPill').textContent = STATUS_WORDS[st]
  $('costLabel').textContent = s.cost ? money(s.cost) + ' spent' : ''
  $('sessionLabel').textContent = s.sessionId ? 'session ' + s.sessionId.slice(0, 8) : ''
  $('modeSelect').value = s.mode || 'default'
  $('startBtn').classList.toggle('hidden', !!s.sessionId || !!s.live)
  $('phasePill').className = 'pill phase ' + (s.phase || '') + (s.phase ? '' : ' hidden')
  $('phasePill').textContent = s.phase === 'planning' ? 'Planning' : s.phase === 'building' ? 'Building' : ''
  $('approvePlanBtn').classList.toggle('hidden', s.phase !== 'planning')
  // How to take it on, before it starts: the feature's own choice, and Laya's suggestion.
  const fresh = !s.sessionId && !s.live
  $('approachBox').classList.toggle('hidden', !fresh)
  if (fresh) {
    if (document.activeElement !== $('approachSelect')) $('approachSelect').value = f.approach || 'auto'
    const a = s.assessment
    $('approachHint').textContent = !a
      ? ''
      : a.error
        ? 'Laya: no suggestion (' + a.error + ')'
        : 'Laya suggests ' + (a.recommended === 'plan' ? 'planning first' : 'just doing it') + ' (' + Math.round(a.confidence * 100) + '%): ' + a.reasons.join(', ')
  }
  $('interruptBtn').disabled = st !== 'running' && st !== 'needs-you'
  $('stopBtn').disabled = !s.live
  $('archiveBtn').textContent = f.status === 'archived' || f.status === 'done' ? 'Unarchive' : 'Archive'
}

function renderBrief() {
  const f = featureOf(S.selected)
  if (!f) return
  if (document.activeElement !== $('descInput')) $('descInput').value = f.description || ''
  const hint = []
  if (!f.description?.trim()) hint.push('no description yet')
  if (f.context.length) hint.push(f.context.length + ' context item' + (f.context.length === 1 ? '' : 's'))
  $('briefHint').replaceChildren(hint.join(' · '), f.remote ? el('span', { class: 'remote-chip' }, ' · ', el('a', { href: f.remote.url, target: '_blank', rel: 'noopener', text: remoteName(f.remote) + ' ' + (f.remote.ref || f.remote.id) }), ' (' + f.remote.status + ')') : '')
  if (!f.description?.trim() && !S.sessions[f.id]?.sessionId) $('brief').open = true
  $('ctxList').replaceChildren(
    ...f.context.map((c) =>
      el(
        'li',
        {},
        el('span', { class: 'type', text: c.type }),
        el('span', { class: 'val', text: c.value, title: c.value }),
        el('button', { type: 'button', 'aria-label': 'Remove', text: '✕', onclick: () => featureApi(f.id, 'context-remove', { id: c.id }) }),
      ),
    ),
  )
}

function renderWorkflows() {
  const bar = $('workflowBar')
  bar.replaceChildren(
    ...S.workflows.map((w) =>
      el(
        'button',
        {
          class: 'wf',
          type: 'button',
          title: w.description + (w.kind === 'script' ? '\n\n$ ' + w.command : ''),
          onclick: () => featureApi(S.selected, 'workflow/' + w.id).catch(() => {}),
        },
        el('span', { class: 'k', text: w.kind === 'script' ? 'run' : 'ask' }),
        w.name,
      ),
    ),
  )
  bar.classList.toggle('hidden', !S.workflows.length)
}

function renderTranscript() {
  const root = $('transcript')
  root.replaceChildren()
  R = new Transcript(S.selected, root)
  for (const ev of S.events[S.selected] || []) R.applyOne(ev)
  R.syncWorking(statusOf(S.selected))
  if (!root.children.length) {
    const f = featureOf(S.selected)
    root.append(
      el('div', { class: 'sys', text: f?.description?.trim() ? 'Press Start, or just send a message. Claude gets the brief first.' : 'Write a description in the brief so Claude knows what done looks like, then press Start.' }),
    )
  }
  root.scrollTop = root.scrollHeight
}

async function sendMessage(text) {
  if (!S.selected || !text.trim()) return
  await featureApi(S.selected, 'message', { text })
}

// ---- notifications -----------------------------------------------------------------

function toast(text, featureId) {
  const t = el('div', { class: 'toast', text, onclick: () => (featureId && go('f', featureId), t.remove()) })
  $('toasts').append(t)
  setTimeout(() => t.remove(), 7000)
}

function notify(text, featureId, quiet) {
  if (quiet) return
  toast(text, featureId)
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification('Workbench', { body: text, tag: featureId })
    n.onclick = () => {
      window.focus()
      go('f', featureId)
      n.close()
    }
  }
}

// ---- wiring ----------------------------------------------------------------------------

$('project').textContent = WB.project
$('project').title = WB.project

$('newFeature').addEventListener('submit', async (e) => {
  e.preventDefault()
  const title = $('newTitle').value.trim()
  if (!title) return
  const f = await api('POST', '/api/features', { title, experience: targetExperience() })
  $('newTitle').value = ''
  go('f', f.id)
  $('descInput').focus()
})

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault()
  const text = $('msgInput').value
  if (!text.trim()) return
  $('msgInput').value = ''
  autosize()
  await sendMessage(text).catch(() => ($('msgInput').value = text))
})
$('msgInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $('composer').requestSubmit()
  }
})
function autosize() {
  const t = $('msgInput')
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, 200) + 'px'
}
$('msgInput').addEventListener('input', autosize)

$('titleInput').addEventListener('change', () => {
  const title = $('titleInput').value.trim()
  if (title) api('PATCH', '/api/features/' + S.selected, { title })
})
$('titleInput').addEventListener('keydown', (e) => e.key === 'Enter' && $('titleInput').blur())
$('saveDesc').addEventListener('click', async () => {
  await api('PATCH', '/api/features/' + S.selected, { description: $('descInput').value })
  toast('Description saved.')
})
$('ctxAdd').addEventListener('submit', async (e) => {
  e.preventDefault()
  const value = $('ctxValue').value.trim()
  if (!value) return
  await featureApi(S.selected, 'context', { type: $('ctxType').value, value })
  $('ctxValue').value = ''
})

$('startBtn').addEventListener('click', () => featureApi(S.selected, 'start').catch(() => {}))
$('interruptBtn').addEventListener('click', () => featureApi(S.selected, 'interrupt').catch(() => {}))
$('stopBtn').addEventListener('click', () => featureApi(S.selected, 'stop').catch(() => {}))
$('modeSelect').addEventListener('change', () => featureApi(S.selected, 'mode', { mode: $('modeSelect').value }).catch(() => {}))
$('archiveBtn').addEventListener('click', () => {
  const f = featureOf(S.selected)
  $('archiveBtn').closest('details').open = false
  api('PATCH', '/api/features/' + f.id, { status: f.status === 'archived' || f.status === 'done' ? 'active' : 'archived' })
})
$('resetBtn').addEventListener('click', () => {
  $('resetBtn').closest('details').open = false
  if (confirm('Forget this feature\'s Claude session? The conversation stays on disk, but this feature will start fresh.')) featureApi(S.selected, 'reset').catch(() => {})
})

$('tabFeatures').addEventListener('click', () => setTab('features'))
$('tabRemote').addEventListener('click', () => setTab('remote'))
$('showArchived').addEventListener('change', (e) => {
  S.showArchived = e.target.checked
  renderSidebar()
})
document.querySelectorAll('[data-menu]').forEach((b) => b.addEventListener('click', () => $('sidebar').classList.toggle('open')))

// experiences
$('newExp').addEventListener('submit', async (e) => {
  e.preventDefault()
  const title = $('newExpTitle').value.trim()
  if (!title) return
  const exp = await api('POST', '/api/experiences', { title })
  $('newExpTitle').value = ''
  S.experiences = [...S.experiences.filter((x) => x.id !== exp.id), exp]
  go('e', exp.id)
  $('expDesc').focus()
})
$('expTitle').addEventListener('change', () => {
  const title = $('expTitle').value.trim()
  if (title) api('PATCH', '/api/experiences/' + S.expView, { title })
})
$('expTitle').addEventListener('keydown', (e) => e.key === 'Enter' && $('expTitle').blur())
$('expLabels').addEventListener('change', async () => {
  const exp = await api('PATCH', '/api/experiences/' + S.expView, { labels: $('expLabels').value })
  S.experiences = S.experiences.map((x) => (x.id === exp.id ? exp : x))
  $('expLabels').value = (exp.labels || []).join(', ')
  toast(exp.labels?.length ? 'Remote issues labelled ' + exp.labels.join(', ') + ' now group here.' : 'Remote labels cleared.')
})
$('expPlanFirst').addEventListener('change', async () => {
  const planFirst = $('expPlanFirst').checked
  const exp = await api('PATCH', '/api/experiences/' + S.expView, { planFirst })
  S.experiences = S.experiences.map((x) => (x.id === exp.id ? exp : x))
  toast(planFirst ? 'New sessions here start by planning; approve the plan to build.' : 'New sessions here start building straight away.')
})
$('approachSelect').addEventListener('change', () =>
  api('PATCH', '/api/features/' + encodeURIComponent(S.selected), { approach: $('approachSelect').value }).catch(() => {}),
)
$('approvePlanBtn').addEventListener('click', () => featureApi(S.selected, 'approve-plan').catch(() => {}))
$('expLabels').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), $('expLabels').blur()))
$('expSave').addEventListener('click', async () => {
  await api('PATCH', '/api/experiences/' + S.expView, { description: $('expDesc').value })
  toast('Saved. New briefs in this experience will include it.')
})
$('expAdd').addEventListener('submit', async (e) => {
  e.preventDefault()
  const title = $('expAddTitle').value.trim()
  if (!title) return
  await api('POST', '/api/features', { title, experience: S.expView })
  $('expAddTitle').value = ''
})
$('expStartAll').addEventListener('click', async () => {
  const ready = sortedFeatures().filter((f) => f.experience === S.expView && readyToStart(f))
  for (const f of ready) await featureApi(f.id, 'start').catch(() => {})
  toast('Started ' + ready.length + ' feature' + (ready.length === 1 ? '' : 's') + '.')
})
$('expDelete').addEventListener('click', async () => {
  $('expDelete').closest('details').open = false
  const e = expOf(S.expView)
  if (!e || !confirm('Delete the "' + e.title + '" experience? Its features are kept and become ungrouped.')) return
  await api('DELETE', '/api/experiences/' + e.id)
  S.experiences = S.experiences.filter((x) => x.id !== e.id)
  location.hash = ''
  route()
})
$('expSelect').addEventListener('change', async () => {
  const v = $('expSelect').value
  if (!v) return
  await api('PATCH', '/api/features/' + S.selected, { experience: v === '__none' ? null : v })
})

window.addEventListener('hashchange', route)
try {
  S.collapsed = JSON.parse(localStorage.getItem('wb.collapsed') || '{}')
} catch {}

const notifyBtn = $('notifyBtn')
if (!('Notification' in window) || Notification.permission !== 'default') notifyBtn.classList.add('hidden')
notifyBtn.addEventListener('click', async () => {
  await Notification.requestPermission()
  notifyBtn.classList.add('hidden')
})

// Alt+Up / Alt+Down moves between features.
document.addEventListener('keydown', (e) => {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
  const list = sortedFeatures()
  const i = list.findIndex((f) => f.id === S.selected)
  const next = list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]
  if (next) {
    e.preventDefault()
    go('f', next.id)
  }
})

api('GET', '/api/workflows')
  .then((w) => {
    S.workflows = w
    if (S.selected) renderWorkflows()
  })
  .catch(() => {})
loadRemotes()
connect()
