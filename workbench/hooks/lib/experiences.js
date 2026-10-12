// Experiences: named groups of features whose shared context reaches every brief.

import { EXP_DIR } from './constants.js'
import { hasBrief, isArchived, listFeatures, mutateFeature } from './features.js'
import { abs } from './paths.js'
import { startFeatureAgent } from './sessions.js'
import { sessions } from './state.js'
import { hasSession } from './status.js'
import { slugify } from './util.js'

export function experiencePath(id) {
  return EXP_DIR + '/' + id + '.json'
}

export async function loadExperience(io, id) {
  if (!id) return null
  try {
    return JSON.parse(await io.fs.read(await abs(io, experiencePath(id))))
  } catch {
    return null
  }
}

export async function saveExperience(io, exp) {
  exp.updatedAt = new Date().toISOString()
  await io.fs.write(await abs(io, experiencePath(exp.id)), JSON.stringify(exp, null, 2))
}

export async function listExperiences(io) {
  const dir = await abs(io, EXP_DIR)
  if (!(await io.fs.exists(dir))) return []
  const out = []
  for (const entry of await io.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const exp = await loadExperience(io, entry.name.slice(0, -5))
    if (exp && exp.id && exp.title) out.push(exp)
  }
  return out.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.title.localeCompare(b.title))
}

export async function findExperienceByRef(io, ref) {
  if (!ref) return null
  const direct = await loadExperience(io, ref)
  if (direct) return direct
  const needle = ref.toLowerCase()
  const all = await listExperiences(io)
  return all.find((e) => e.title.toLowerCase() === needle) || all.find((e) => e.title.toLowerCase().includes(needle)) || null
}

export async function createExperience(io, title) {
  const all = await listExperiences(io)
  const base = slugify(title)
  let id = base
  let n = 2
  while (all.some((e) => e.id === id)) id = base + '-' + n++
  const now = new Date().toISOString()
  const exp = { id, title, description: '', createdAt: now, updatedAt: now }
  await saveExperience(io, exp)
  return exp
}

export async function deleteExperience(io, exp) {
  // Its features stay; they just become ungrouped.
  for (const f of await listFeatures(io)) {
    if (f.experience === exp.id) await mutateFeature(io, f.id, (x) => delete x.experience)
  }
  await io.process.run(['rm', '-f', await abs(io, experiencePath(exp.id))])
}

// Starts an agent on each ready feature with no agent yet (in one experience,
// or all). Returns how many started and the features skipped for having
// nothing to work from.
export async function startReadyIn(io, expId) {
  const map = await io.read(sessions)
  let started = 0
  const empty = []
  for (const f of await listFeatures(io)) {
    if (expId !== undefined && f.experience !== expId) continue
    if (isArchived(f) || hasSession(map[f.id])) continue
    if (!hasBrief(f)) {
      empty.push(f)
      continue
    }
    await startFeatureAgent(io, f)
    started++
  }
  return { started, empty }
}

// "Nothing started", in words that say what to fix.
export function nothingReadyText(empty) {
  if (!empty.length) return 'nothing to start: every feature already has an agent or is archived'
  const names = empty.slice(0, 3).map((f) => f.title).join(', ') + (empty.length > 3 ? ' +' + (empty.length - 3) : '')
  return 'nothing started: ' + names + (empty.length === 1 ? ' needs' : ' need') + ' a description or context first'
}
