// The feature this session is focused on: its brief rides along with every prompt.

import { refreshStatusLine } from './sessions.js'
import { activeFeatureId } from './state.js'

export async function loadActiveFeatureId(io) {
  const saved = (await io.store.get('lastActiveFeatureId')) || null
  await io.update(activeFeatureId, () => saved || null)
}

export async function setActiveFeature(io, id) {
  await io.update(activeFeatureId, () => id)
  await io.store.set('lastActiveFeatureId', id || '')
  await refreshStatusLine(io)
}
