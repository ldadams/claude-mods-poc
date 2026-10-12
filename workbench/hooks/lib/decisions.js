// Decisions for agents running in this session. Workbench Web judges its own agents'
// tool requests and turn ends; these agents never reach it, so the mod asks it
// (POST /api/decide) for their edits and commands, and when their turns end. Only while
// the server is up with decisions on. In shadow mode a judgment is recorded in the
// agent's transcript; in "on" mode a broken standard is denied back to the agent and an
// unsupported claim gets a follow-up. An allow is never acted on here: Claude Code's own
// permission prompts still decide what runs.

import { link, serverState, sessions } from './state.js'
import { sendToSessionAgent, sessionAgentFeature, updateRecord } from './session-runner.js'
import { loadFeature } from './features.js'
import { firstLine, truncate } from './util.js'
import { webCall } from './web.js'

const JUDGED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'])
const MAX_FOLLOW_UPS = 2

// The decisions model, when it can answer: Workbench Web up with decisions on.
async function decide(io, body) {
  const srv = await io.read(serverState)
  if (!srv.up || !link.server || !srv.decisions || srv.decisions.provider === 'off') return null
  try {
    const r = await webCall(io, link.server, 'POST', '/api/decide', body)
    return r.off || r.error ? null : r
  } catch {
    return null
  }
}

// A tool call's own arguments, without the envelope fields the engine adds.
const ENVELOPE = new Set(['tool', 'tool_use_id', 'agentId'])
function toolInput(e) {
  return Object.fromEntries(Object.entries(e).filter(([k]) => !ENVELOPE.has(k)))
}

// An in-session agent is about to use a tool: remember it for the turn-end check, and
// have an edit or a command judged against the standards.
export async function onAgentToolCall(io, e, next) {
  if (!e.agentId) return next(e)
  const featureId = sessionAgentFeature(await io.read(sessions), e.agentId)
  if (!featureId) return next(e)
  const input = toolInput(e)
  await updateRecord(io, featureId, (rec) => ({ turnTools: [...(rec.turnTools || []), { name: e.tool, input: e.tool === 'Bash' ? { command: input.command } : {} }].slice(-50) }))
  if (!JUDGED_TOOLS.has(e.tool)) return next(e)
  const r = await decide(io, { kind: 'tool', featureId, toolName: e.tool, input })
  if (!r || r.by === 'skip' || r.decision === 'ask') return next(e)
  const act = r.acting && r.decision === 'deny'
  await updateRecord(io, featureId, () => ({}), [
    { t: 'decision', kind: 'tool', toolName: e.tool, verdict: r.decision, by: r.by, standard: r.standard, confidence: r.confidence, reason: r.reason, checks: r.checks, applied: act },
  ])
  if (act) return { deny: 'Code standard (' + r.standard + '): ' + r.reason }
  return next(e)
}

// An in-session agent's turn ended and it is your turn: check its summary against
// what it did. Acting, a claim with nothing behind it gets a follow-up (at most twice
// in a row) instead of a ping.
export async function checkSessionTurn(io, featureId) {
  const rec = (await io.read(sessions))[featureId]
  if (!rec || rec.runner !== 'session' || rec.status !== 'ready') return
  const r = await decide(io, { kind: 'turn', featureId, summary: rec.summary || '', tools: rec.turnTools || [] })
  if (!r || !r.issues || !r.issues.length) return
  const act = r.acting && (rec.followUps || 0) < MAX_FOLLOW_UPS
  const checks = r.issues.map((i) => ({ id: i.id, label: i.id === 'unverified-claim' ? 'claims checks that never ran' : 'leaves work unfinished', p: i.p, status: 'fail' }))
  await updateRecord(io, featureId, () => ({}), [{ t: 'decision', kind: 'turn', verdict: 'follow-up', checks, reason: r.followUp, applied: act }])
  if (!act) return
  const feature = await loadFeature(io, featureId)
  if (!feature) return
  await sendToSessionAgent(io, feature, r.followUp, { t: 'user', text: r.followUp, auto: true })
  await updateRecord(io, featureId, (cur) => ({ followUps: (cur.followUps || 0) + 1 }))
  io.ui.toast('◆ ' + feature.title + ': sent back, ' + truncate(firstLine(r.followUp), 60), { timeoutMs: 6000 })
}
