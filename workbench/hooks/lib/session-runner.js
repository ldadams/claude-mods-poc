// The in-session runner: each feature's agent is a background subagent of this
// Claude Code session. The mod observes it through the engine's own events:
// its ask_user tool call (tool.call) and the end of each of its turns
// (turn.complete). Its record lives in the same `sessions` state as Workbench
// Web's, marked runner: 'session', so the pane, status line and toasts treat
// both alike. It lives as long as this session does.

import { ASK_TOOL, ASK_TOOL_FULL, AGENT_TYPE, MAX_SUMMARY_CHARS } from './constants.js'
import { featureBrief } from './brief.js'
import { loadFeature } from './features.js'
import { osNotify } from './notify.js'
import { checkSessionTurn } from './decisions.js'
import { refreshStatusLine } from './sessions.js'
import { sessions } from './state.js'
import { errText, firstLine, truncate } from './util.js'

const MAX_EVENTS = 40

// The tool an in-session agent asks the user through; registered at session start.
export const ASK_TOOL_SPEC = {
  name: ASK_TOOL,
  description:
    'Ask the user a question while working on a Workbench feature. Use it only when blocked on something the user must decide or provide. After calling it, end your turn; you will be resumed with the answer.',
  inputSchema: {
    type: 'object',
    properties: {
      feature: { type: 'string', description: 'The feature id given in your brief.' },
      question: { type: 'string', description: 'One clear question for the user.' },
    },
    required: ['feature', 'question'],
  },
}

function agentRules(feature) {
  return [
    'You are a background agent started from the Workbench to work on this feature end to end.',
    'Rules:',
    '1. If you need a decision, a credential, or anything only the user can provide, call the `' + ASK_TOOL_FULL +
      '` tool with { "feature": "' + feature.id + '", "question": "<ONE clear question>" }, then end your turn immediately with a one-line status. You will be resumed with the answer as your next message.',
    '2. Never ask the user in plain text; only that tool reaches them.',
    '3. When finished, end your turn with a short summary: what changed, where, and anything left to do.',
  ].join('\n')
}

// A waiting ask_user question in the shape Workbench Web uses for its own, so
// the pane's question card answers both.
function questionPending(text) {
  return { id: 'ask', kind: 'question', toolName: 'ask_user', input: { questions: [{ question: text, header: '', options: [], multiSelect: false }] } }
}

// Writes one feature's record, keeping its transcript short; `events` are added to it.
async function patch(io, featureId, fields, events = []) {
  await io.update(sessions, (m) => {
    const cur = m[featureId] && m[featureId].runner === 'session' ? m[featureId] : null
    const base = cur || { featureId, runner: 'session', mode: 'default', cost: 0, phase: null, pending: [], events: [] }
    const next = { ...base, ...fields }
    next.events = [...(base.events || []), ...events].slice(-MAX_EVENTS)
    next.live = next.status === 'running' || next.status === 'needs-you'
    next.sessionId = next.agentId || 'in-session'
    return { ...m, [featureId]: next }
  })
  await refreshStatusLine(io)
}

// Changes a record that already exists (and only an in-session one); `fn` gets the
// current record and returns the fields to change.
export async function updateRecord(io, featureId, fn, events = []) {
  await io.update(sessions, (m) => {
    const cur = m[featureId]
    if (!cur || cur.runner !== 'session') return m
    const next = { ...cur, ...fn(cur) }
    next.events = [...(cur.events || []), ...events].slice(-MAX_EVENTS)
    return { ...m, [featureId]: next }
  })
}

// The feature an in-session agent works on, by its agent id.
export function sessionAgentFeature(map, agentId) {
  return agentFor(map, agentId)
}

// The feature an agent id belongs to; a feature the agent names itself (the
// ask_user tool's `feature`) is accepted when the id is not known yet.
function agentFor(map, agentId, featureHint) {
  for (const [featureId, a] of Object.entries(map)) if (a && a.runner === 'session' && agentId && a.agentId === agentId) return featureId
  if (featureHint && map[featureHint] && map[featureHint].runner === 'session') return featureHint
  return null
}

async function notify(io, title, text) {
  if ((await io.store.get('osNotify')) === false) return
  await osNotify(io, title, text)
}

// Starts a feature's agent as a subagent of this session. A first message, when
// given, follows the brief.
export async function startSessionAgent(io, feature, firstMessage) {
  const prompt = [
    'Feature: "' + feature.title + '" (' + feature.id + ')' + (feature.description ? '\n' + feature.description : ''),
    ...(await featureBrief(io, feature)).slice(1),
    ...(firstMessage ? [firstMessage] : []),
    agentRules(feature),
  ].join('\n\n')
  const r = await io.agent.spawn({ prompt, description: 'feature: ' + feature.title, subagentType: AGENT_TYPE })
  if (r.deny) throw new Error(r.deny)
  // Core sets agentId. A spawn answered above core (a policy plugin, a test's
  // fake) carries none; the agent then identifies itself on its first ask_user.
  await patch(
    io,
    feature.id,
    { agentId: r.agentId || null, status: 'running', startedAt: new Date().toISOString(), turns: 0, pending: [], summary: '', turnTools: [], followUps: 0 },
    [{ t: 'system', text: 'Started as a subagent of this Claude Code session.' }, ...(firstMessage ? [{ t: 'user', text: firstMessage }] : [])],
  )
}

// Sends the agent a message, which resumes it.
export async function sendToSessionAgent(io, feature, text, event) {
  const a = (await io.read(sessions))[feature.id]
  if (!a || a.runner !== 'session') return startSessionAgent(io, feature, text)
  if (!a.agentId) throw new Error('the agent for "' + feature.title + '" has not reported in yet; its id is unknown')
  const r = await io.session.send({ to: { agentId: a.agentId }, text })
  if (!r.isDelivered) throw new Error(r.reason || 'not delivered')
  // A message from the user resets the follow-up count; one Workbench sent on its own does not.
  await patch(
    io,
    feature.id,
    { status: 'running', pending: [], resumedAt: new Date().toISOString(), turnTools: [], ...(event && event.auto ? {} : { followUps: 0 }) },
    [event || { t: 'user', text }],
  )
}

// Answers the agent's waiting question.
export async function answerSessionAgent(io, feature, text) {
  await sendToSessionAgent(io, feature, text, { t: 'answered', text })
  io.ui.toast('↩ ' + feature.title + ': answer sent, agent resumed')
}

// Forgets a feature's agent so it can start again. The host cannot stop a
// subagent, so a busy one is asked to end its turn; what it does after that
// matches no record and is ignored.
export async function resetSessionAgent(io, feature) {
  const a = (await io.read(sessions))[feature.id]
  if (!a || a.runner !== 'session') return
  if ((a.status === 'running' || a.status === 'needs-you') && a.agentId) {
    await io.session
      .send({ to: { agentId: a.agentId }, text: 'Stop working on this feature now: the user stopped this agent from the Workbench. End your turn with one line on where you stopped.' })
      .catch(() => {})
  }
  await io.update(sessions, (m) => {
    const copy = { ...m }
    delete copy[feature.id]
    return copy
  })
  await refreshStatusLine(io)
}

// The observer, part 1: an in-session agent asks through ask_user. It always
// answers: a throw here would reach the agent as "no tool.call hook answered".
export async function onAskUser(io, e) {
  const refused = { deny: ASK_TOOL_FULL + ' only works inside a Workbench feature agent (see /feature start).' }
  try {
    if (!e.agentId) return refused
    const map = await io.read(sessions)
    let featureId = agentFor(map, e.agentId, e.feature)
    // An agent this session does not know (started before a reload) is adopted
    // when it names a feature that exists.
    if (!featureId && e.feature && (await loadFeature(io, String(e.feature)))) featureId = String(e.feature)
    if (!featureId) return refused
    const question = String(e.question || '').trim() || '(no question given)'
    const known = map[featureId] && map[featureId].runner === 'session' ? map[featureId] : null
    await patch(
      io,
      featureId,
      {
        agentId: (known && known.agentId) || e.agentId,
        startedAt: (known && known.startedAt) || new Date().toISOString(),
        status: 'needs-you',
        pending: [questionPending(question)],
      },
      [{ t: 'ask', kind: 'question', toolName: 'ask_user', input: questionPending(question).input }],
    )
    const feature = await loadFeature(io, featureId)
    const title = feature ? feature.title : featureId
    io.ui.toast('? ' + title + ' needs you: ' + firstLine(question), { timeoutMs: 10000 })
    await notify(io, 'Workbench: ' + title + ' needs you', firstLine(question))
    return { result: 'Your question was delivered to the user. End your turn now with a one-line status; you will be resumed with their answer.' }
  } catch (err) {
    io.ui.log('workbench: ask_user failed: ' + errText(err))
    return { result: 'Workbench could not deliver the question (' + errText(err) + '). Write the question as your final message instead.' }
  }
}

// The observer, part 2: an in-session agent's turn ends.
export async function onTurnComplete(io, e, next) {
  if (!e.agentId) return next(e)
  const map = await io.read(sessions)
  const featureId = agentFor(map, e.agentId)
  if (!featureId) return next(e)
  const a = map[featureId]
  if (a.status === 'needs-you') {
    // It paused to wait for the answer; nothing else changes.
    await patch(io, featureId, { turns: (a.turns || 0) + 1 })
    return next(e)
  }
  const ok = e.reason === 'answer'
  const summary = truncate(e.answer || (ok ? '' : 'ended: ' + e.reason), MAX_SUMMARY_CHARS)
  await patch(
    io,
    featureId,
    { status: ok ? 'ready' : 'error', finishedAt: new Date().toISOString(), summary, turns: (a.turns || 0) + 1 },
    [...(summary ? [{ t: 'text', text: summary }] : []), { t: 'result', ok, subtype: ok ? 'success' : e.reason }],
  )
  const feature = await loadFeature(io, featureId)
  const title = feature ? feature.title : featureId
  io.ui.toast((ok ? '✓ ' + title + ': finished its turn' : '✗ ' + title + ': ' + e.reason), { timeoutMs: 8000 })
  await notify(io, 'Workbench: ' + title + (ok ? ' is done' : ' failed'), firstLine(e.answer) || (ok ? 'Finished.' : 'Ended: ' + e.reason))
  if (ok) await checkSessionTurn(io, featureId).catch((err) => io.ui.log('workbench: turn check failed: ' + errText(err)))
  return next(e)
}
