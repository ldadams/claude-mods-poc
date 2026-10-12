// Features on disk: one JSON file each under .claude/features/, shared through git.

import { FEATURES_DIR } from './constants.js'
import { abs } from './paths.js'
import { resetSessionAgent } from './session-runner.js'
import { remoteItemCache, sessions } from './state.js'
import { hasSession } from './status.js'
import { slugify } from './util.js'
import { api } from './web.js'

export const isArchived = (f) => f.status === 'archived' || f.status === 'done'

export function featurePath(id) {
  return FEATURES_DIR + '/' + id + '.json'
}

export async function loadFeature(io, id) {
  if (!id) return null
  try {
    const feature = JSON.parse(await io.fs.read(await abs(io, featurePath(id))))
    feature.context = feature.context || []
    feature.workflows = feature.workflows || []
    return feature
  } catch {
    return null
  }
}

export async function saveFeature(io, feature) {
  feature.updatedAt = new Date().toISOString()
  // fs.write creates the directory as needed.
  await io.fs.write(await abs(io, featurePath(feature.id)), JSON.stringify(feature, null, 2))
}

export async function listFeatures(io) {
  const dir = await abs(io, FEATURES_DIR)
  if (!(await io.fs.exists(dir))) return []
  const entries = await io.fs.list(dir)
  const features = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const feature = await loadFeature(io, entry.name.slice(0, -5))
    if (feature) features.push(feature)
  }
  features.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  return features
}

export async function findFeatureByRef(io, ref) {
  if (!ref) return null
  const direct = await loadFeature(io, ref)
  if (direct) return direct
  const all = await listFeatures(io)
  const needle = ref.toLowerCase()
  return (
    all.find((f) => f.id.toLowerCase() === needle) ||
    all.find((f) => (f.title || '').toLowerCase().includes(needle)) ||
    null
  )
}

export async function createFeature(io, title, experienceId) {
  const all = await listFeatures(io)
  const base = slugify(title)
  let id = base
  let n = 2
  while (all.some((f) => f.id === id)) id = base + '-' + n++
  const now = new Date().toISOString()
  const feature = {
    id,
    title,
    description: '',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    context: [],
    workflows: [],
  }
  if (experienceId) feature.experience = experienceId
  await saveFeature(io, feature)
  return feature
}

export async function deleteFeature(io, feature) {
  // No $.fs.remove on this build; rm by argv (no shell).
  await io.process.run(['rm', '-f', await abs(io, featurePath(feature.id))])
  remoteItemCache.delete(feature.id)
  // End its session too, so no agent works on a feature that is gone.
  const own = (await io.read(sessions))[feature.id]
  if (own && own.runner === 'session') await resetSessionAgent(io, feature)
  else if (hasSession(own)) await api(io, 'POST', '/api/features/' + encodeURIComponent(feature.id) + '/reset', {}).catch(() => {})
  await io.update(sessions, (a) => {
    const next = { ...a }
    delete next[feature.id]
    return next
  })
}

// Loads the feature fresh before a mutation so a pane closure never writes a
// stale copy over an edit made from the command line in between.
export async function mutateFeature(io, id, fn) {
  const feature = await loadFeature(io, id)
  if (!feature) throw new Error('feature "' + id + '" no longer exists')
  await fn(feature)
  await saveFeature(io, feature)
  return feature
}

// Ready to start: active, has something to work from (a description or
// context), no agent running or waiting.
export function hasBrief(f) {
  return !!(f.description || '').trim() || (f.context || []).length > 0
}

export function isReady(f, a) {
  return !isArchived(f) && hasBrief(f) && !hasSession(a)
}
