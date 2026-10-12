// Session lifecycle: start, resume, and the brief added to each prompt.

import { COMMANDS } from './commands/index.js'
import { featureBrief } from './lib/brief.js'
import { loadFeature } from './lib/features.js'
import { loadActiveFeatureId } from './lib/focus.js'
import { ASK_TOOL_SPEC } from './lib/session-runner.js'
import { poll, startPolling } from './lib/sessions.js'
import { activeFeatureId } from './lib/state.js'
import { errText } from './lib/util.js'

// Registers the commands and the in-session agents' ask_user tool, restores the
// focused feature, and starts watching Workbench Web.
export async function onSessionStart(io, e, next) {
  // Each registration stands alone: one the engine refuses (a name a
  // built-in already holds) must not take the others down with it.
  for (const command of COMMANDS) {
    try {
      await io.command.register(command)
    } catch (err) {
      io.ui.log('workbench: /' + command.name + ' not registered: ' + errText(err))
    }
  }
  try {
    await io.tool.register(ASK_TOOL_SPEC)
  } catch (err) {
    io.ui.log('workbench: ' + ASK_TOOL_SPEC.name + ' tool not registered: ' + errText(err))
  }
  await loadActiveFeatureId(io)
  startPolling(io)
  await poll(io)
  return next(e)
}

// After /clear, a resume or a fork, the focused feature comes back.
export async function onSessionResume(io, e, next) {
  await loadActiveFeatureId(io)
  return next(e)
}

// Every prompt while a feature is active carries that feature's brief.
export async function onPromptSubmit(io, e, next) {
  const curId = await io.read(activeFeatureId)
  if (!curId) return next(e)
  const feature = await loadFeature(io, curId)
  if (!feature) return next(e)
  const parts = await featureBrief(io, feature)
  return next({ ...e, context: [...(e.context ?? []), ...parts] })
}
