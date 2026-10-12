// Which runner a feature's agent runs on: "session" (a subagent inside this
// Claude Code session, observed through hooks) or "web" (a Workbench Web
// session, observed by polling). The feature says, else its experience, else
// the project ("runner" in .claude/workbench.json); "web" when nobody does.

import { RUNNERS } from './constants.js'
import { loadExperience } from './experiences.js'
import { loadFeature } from './features.js'
import { loadConfig } from './mcp.js'

export async function runnerFor(io, featureOrId) {
  const feature = typeof featureOrId === 'string' ? await loadFeature(io, featureOrId) : featureOrId
  if (feature && RUNNERS.includes(feature.runner)) return feature.runner
  const exp = feature && feature.experience ? await loadExperience(io, feature.experience) : null
  if (exp && RUNNERS.includes(exp.runner)) return exp.runner
  const config = await loadConfig(io)
  return RUNNERS.includes(config.runner) ? config.runner : 'web'
}

export function runnerLabel(runner) {
  return runner === 'session' ? 'in session' : 'Workbench Web'
}
