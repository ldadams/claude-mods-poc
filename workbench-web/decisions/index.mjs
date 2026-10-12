// Decisions for Workbench Web: a System One model (Laya by default) judging the work
// around each feature's agent, configured in <project>/.claude/workbench.json:
//
//   "decisions": {
//     "provider": "laya" | "http" | "off",    off when absent
//     "mode": "shadow" | "on",                shadow records what it would do and never acts
//     "url": "...", "keyEnv": "...", "model": "...",   for "http" (a Laya server, or Jev)
//     "minConfidence": 0.9, "yes": 0.85, "no": 0.15,   thresholds; tune them in shadow first
//     "timeoutMs": 4000, "maxAutoRevisions": 2, "maxFollowUps": 2
//   }
//
// Every judgment is safe to fail: an error or a timeout means "no judgment", and the
// request goes to the person as it would without decisions.

import fs from 'node:fs/promises'
import path from 'node:path'
import { createProvider } from './providers.mjs'
import { loadStandards } from './standards.mjs'
import * as judge from './judge.mjs'

const DEFAULTS = { provider: 'off', mode: 'shadow', minConfidence: 0.9, yes: 0.85, no: 0.15, timeoutMs: 4000, maxAutoRevisions: 2, maxFollowUps: 2 }

async function readConfig(project) {
  try {
    const all = JSON.parse(await fs.readFile(path.join(project, '.claude', 'workbench.json'), 'utf8'))
    return { ...DEFAULTS, ...(all.decisions || {}) }
  } catch {
    return { ...DEFAULTS }
  }
}

// `provider` can be passed in (tests use a fake); otherwise it is built from the config
// and rebuilt when the provider settings change.
export function createDecisions({ project, provider: given } = {}) {
  let config = { ...DEFAULTS }
  let provider = given || createProvider(config)
  let providerKey = ''

  async function refresh() {
    config = await readConfig(project)
    if (given) {
      if (config.provider === 'off') config.provider = given.name || 'fake'
      return
    }
    const key = JSON.stringify([config.provider, config.url, config.keyEnv, config.model, config.modelDir, config.timeoutMs])
    if (key !== providerKey) {
      providerKey = key
      provider = createProvider(config)
      provider.warm()
    }
  }

  const enabled = () => config.provider !== 'off'
  const thresholds = () => ({ yes: config.yes, no: config.no, minConfidence: config.minConfidence })

  // Runs one judgment; an error comes back as { error } rather than a throw.
  async function run(fn) {
    await refresh()
    if (!enabled()) return { off: true }
    try {
      return await fn()
    } catch (err) {
      return { error: String(err.message || err) }
    }
  }

  return {
    refresh,
    config: () => config,
    enabled,
    acting: () => enabled() && config.mode === 'on',
    status: () => ({ provider: config.provider, mode: config.mode, ...(enabled() ? provider.status() : { ready: false, loading: false, error: '' }) }),
    assessApproach: (args) => run(() => judge.assessApproach(provider, thresholds(), args)),
    judgeTool: (args) => run(async () => judge.judgeTool(provider, thresholds(), await loadStandards(project), args)),
    reviewPlan: (args) => run(async () => judge.reviewPlan(provider, thresholds(), await loadStandards(project), args)),
    checkTurn: (args) => run(() => judge.checkTurn(provider, thresholds(), args)),
    standards: () => loadStandards(project),
  }
}
