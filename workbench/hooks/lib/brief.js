// The feature brief: the one place that decides what Claude sees about a feature.

import { resolveProvider } from './context.js'
import { loadExperience } from './experiences.js'
import { listFeatures } from './features.js'
import { liveRemoteSection } from './remote.js'

export async function featureBrief(io, feature) {
  const parts = [
    'Active feature: "' + feature.title + '" (' + feature.id + ', status: ' + feature.status + ')' +
      (feature.description ? ' — ' + feature.description : ''),
  ]
  if (feature.experience) {
    const exp = await loadExperience(io, feature.experience)
    if (exp) {
      const siblings = (await listFeatures(io)).filter((f) => f.experience === exp.id && f.id !== feature.id)
      parts.push(
        '[experience ' + exp.title + '] This feature is part of the "' + exp.title + '" experience.' +
          ((exp.description || '').trim() ? '\n' + exp.description.trim() : '') +
          (siblings.length ? '\nOther features in it: ' + siblings.map((f) => '"' + f.title + '"').join(', ') + '.' : ''),
      )
    }
  }
  if (feature.remote) parts.push(await liveRemoteSection(io, feature))
  for (const p of feature.context) parts.push(await resolveProvider(io, p))
  if (feature.workflows.length > 0) {
    parts.push(
      'Workflows defined for this feature: ' +
        feature.workflows.map((w) => w.name + ' [' + w.kind + '] -> ' + w.target).join('; '),
    )
  }
  return parts
}
