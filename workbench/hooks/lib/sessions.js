// Feature sessions, whichever runner holds them: polling Workbench Web, toasts,
// the status line, and actions, each sent to the runner that owns the feature.

import { POLL_MS, TRANSCRIPT_TAIL } from './constants.js'
import { loadFeature } from './features.js'
import { activeFeatureId, link, pane, serverState, sessions, transcript } from './state.js'
import { hasSession, isBusy, pendingSummary, statusGlyph, statusWord } from './status.js'
import { errText, truncate } from './util.js'
import { runnerFor } from './runner.js'
import { answerSessionAgent, resetSessionAgent, sendToSessionAgent, startSessionAgent } from './session-runner.js'
import { api, findServer, webCall } from './web.js'

// The in-session records, which Workbench Web knows nothing about.
const inSession = (m) => Object.fromEntries(Object.entries(m).filter(([, s]) => s && s.runner === 'session'))

// An action on one feature's session, sent to the runner that owns it; the pane
// catches up straight after. A feature with an in-session agent goes to it;
// otherwise the feature's runner decides where a new session starts.
export async function featureCall(io, featureId, action, body) {
  const own = (await io.read(sessions))[featureId]
  const onSession = own && own.runner === 'session' ? true : (action === 'start' || action === 'message') && (await runnerFor(io, featureId)) === 'session'
  if (onSession) return sessionAction(io, featureId, action, body || {})
  const r = await api(io, 'POST', '/api/features/' + encodeURIComponent(featureId) + '/' + action, body || {})
  link.lastVersion = -1
  await poll(io)
  return r
}

// The same actions, for an agent running inside this session.
async function sessionAction(io, featureId, action, body) {
  const feature = await loadFeature(io, featureId)
  if (!feature) throw new Error('No such feature')
  if (action === 'start') await startSessionAgent(io, feature)
  else if (action === 'message') await sendToSessionAgent(io, feature, body.text)
  else if (action.startsWith('answer/')) {
    const text = body.answers ? Object.values(body.answers).join('\n') : body.allow ? 'yes' : body.message || 'no'
    await answerSessionAgent(io, feature, text)
  } else if (action === 'stop' || action === 'reset') await resetSessionAgent(io, feature)
  else if (action === 'interrupt') await sendToSessionAgent(io, feature, 'Stop what you are doing and end your turn with a one-line status.')
  // runRegistryWorkflow sends a prompt workflow as a message when this is thrown.
  else if (action.startsWith('workflow/')) throw new Error('No such workflow on the in-session runner')
  else if (action === 'mode' || action === 'approve-plan') {
    throw new Error('in-session agents have no ' + (action === 'mode' ? 'permission mode' : 'plan phase') + '; run this feature on Workbench Web for that')
  } else throw new Error('Unknown action ' + action)
  return {}
}

export async function setServerState(io, s) {
  const next = { up: false, browsers: 0, url: '', error: '', decisions: null, ...s }
  const cur = await io.read(serverState)
  if (JSON.stringify(cur) !== JSON.stringify(next)) await io.update(serverState, () => next)
}

// Toasts for what changed since the last poll; the first sight of a session is not news.
export async function announceChanges(io, prev, next) {
  for (const [id, s] of Object.entries(next)) {
    const before = prev[id]
    if (!before) continue
    const asked = (s.pending || []).length > (before.pending || []).length
    if (before.status === s.status && !asked) continue
    const f = await loadFeature(io, id)
    const title = f ? f.title : id
    if (s.status === 'needs-you' && asked) io.ui.toast('? ' + title + ' needs you: ' + pendingSummary((s.pending || []).at(-1)), { timeoutMs: 10000 })
    else if (before.status === 'running' && s.status === 'ready') io.ui.toast('✓ ' + title + ': finished its turn', { timeoutMs: 8000 })
    else if (s.status === 'error') io.ui.toast('✗ ' + title + ': stopped with an error', { timeoutMs: 8000 })
  }
}

// One look at the server: every session's state, and the open feature's transcript.
export async function poll(io) {
  if (link.polling) return
  link.polling = true
  try {
    if (!link.server) link.server = await findServer(io)
    if (!link.server) {
      const cur = await io.read(sessions)
      if (Object.keys(cur).length !== Object.keys(inSession(cur)).length) await io.update(sessions, (m) => inSession(m))
      await setServerState(io, { up: false })
      await refreshStatusLine(io)
      return
    }
    const featureId = pane.view.kind === 'feature' ? pane.view.id : ''
    let state
    try {
      state = await webCall(io, link.server, 'GET', '/api/state?tail=' + TRANSCRIPT_TAIL + (featureId ? '&feature=' + encodeURIComponent(featureId) : ''))
    } catch (err) {
      link.server = null // read the runtime file again next time
      await setServerState(io, { up: false, error: errText(err) })
      return
    }
    if (state.version === link.lastVersion && featureId === link.lastPolledFeature) return
    link.lastVersion = state.version
    link.lastPolledFeature = featureId
    const prev = await io.read(sessions)
    const next = {}
    for (const s of state.sessions || []) next[s.featureId] = { ...s, runner: 'web' }
    await announceChanges(io, prev, next)
    // In-session records win: hooks write them, and the server never sees them.
    await io.update(sessions, (m) => ({ ...next, ...inSession(m) }))
    await io.update(transcript, () => state.transcript || null)
    await setServerState(io, { up: true, browsers: state.browsers || 0, url: 'http://localhost:' + link.server.port + '/', decisions: state.decisions || null })
    await refreshStatusLine(io)
  } finally {
    link.polling = false
  }
}

export function startPolling(io) {
  if (link.pollTimer) link.pollTimer.cancel()
  link.pollTimer = io.clock.every(POLL_MS, () => {
    poll(io).catch((err) => io.ui.log('workbench: poll failed: ' + errText(err), { to: 'debug' }))
  })
}

export async function refreshStatusLine(io) {
  const all = Object.values(await io.read(sessions))
  const running = all.filter((a) => a.status === 'running').length
  const help = all.filter((a) => a.status === 'needs-you').length
  // The focused feature shows even with no agents, so it is never a surprise
  // that prompts carry its context.
  const curId = await io.read(activeFeatureId)
  const focused = curId ? await loadFeature(io, curId) : null
  if (!running && !help && !focused) return io.ui.status(undefined)
  const bits = []
  if (help) bits.push('? ' + help + ' need' + (help === 1 ? 's' : '') + ' your answer')
  if (running) bits.push('● ' + running + ' running')
  if (focused) bits.push('▸ ' + truncate(focused.title, 32))
  io.ui.status('workbench  ' + bits.join(' · ') + (help ? '  (/wb, then n)' : ''))
}

// The features waiting on you, in feature order.
export function waitingFeatureIds(map) {
  return Object.entries(map)
    .filter(([, a]) => a && a.status === 'needs-you')
    .map(([id]) => id)
}

export async function startFeatureAgent(io, feature) {
  const a = (await io.read(sessions))[feature.id]
  if (isBusy(a)) throw new Error('"' + feature.title + '" is already ' + statusWord(a))
  if (hasSession(a)) throw new Error('"' + feature.title + '" already has a conversation; send it a message, or reset it to start over')
  await featureCall(io, feature.id, 'start')
  io.ui.toast('▶ ' + feature.title + ': agent started')
}

// Approves the plan of a session that is planning: it switches back to the mode it
// had before and builds (Workbench Web allows a waiting ExitPlanMode, or says so).
export async function approvePlan(io, feature, note) {
  await featureCall(io, feature.id, 'approve-plan', note ? { note } : {})
  io.ui.toast('▶ ' + feature.title + ': plan approved, building')
}

export async function answerPending(io, feature, pendingId, body) {
  await featureCall(io, feature.id, 'answer/' + encodeURIComponent(pendingId), body)
}

// A free-text reply: it answers the first waiting question, or allows or denies
// the waiting tool (anything but yes/no is the reason for a deny), or else is
// the next message to the session.
export async function replyToFeature(io, feature, text) {
  const a = (await io.read(sessions))[feature.id]
  const p = a && (a.pending || [])[0]
  if (p && p.kind === 'question') {
    const qs = (p.input && p.input.questions) || []
    return answerPending(io, feature, p.id, { answers: Object.fromEntries(qs.map((q) => [q.question, text])) })
  }
  if (p) {
    const t = text.trim()
    if (/^(y|yes|allow|ok)$/i.test(t)) return answerPending(io, feature, p.id, { allow: true })
    return answerPending(io, feature, p.id, { allow: false, message: /^(n|no|deny)$/i.test(t) ? '' : t })
  }
  return featureCall(io, feature.id, 'message', { text })
}

export async function agentStatusReport(io) {
  const map = await io.read(sessions)
  const srv = await io.read(serverState)
  const ids = Object.keys(map).filter((id) => hasSession(map[id]))
  if (ids.length === 0) {
    return srv.up ? 'No feature has an agent yet. Start one with /feature start.' : 'No agents. In-session agents start right away; Workbench Web (not running) starts with the first agent that needs it.'
  }
  const lines = []
  for (const id of ids) {
    const a = map[id]
    const f = await loadFeature(io, id)
    let line = statusGlyph(a) + ' ' + (f ? f.title : id) + ' (' + id + '): ' + statusWord(a) + (a.runner === 'session' ? ' · in session' : ' · Workbench Web')
    if (a.cost) line += ' · $' + a.cost.toFixed(2)
    for (const p of a.pending || []) line += '\n    ? ' + pendingSummary(p)
    if ((a.pending || []).length) line += '\n    answer with /feature answer ' + id + ' <text>, or in the pane or browser'
    lines.push(line)
  }
  return lines.join('\n')
}
