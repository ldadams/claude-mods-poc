// The Workbench pane: reads the state once per draw, then hands it to the view on screen.

import { PANE } from '../lib/constants.js'
import { listExperiences } from '../lib/experiences.js'
import { listFeatures } from '../lib/features.js'
import { waitingFeatureIds } from '../lib/sessions.js'
import { activeFeatureId, pane, serverState, sessions, transcript } from '../lib/state.js'
import { experienceView } from './experience.js'
import { featureView } from './feature.js'
import { homeView } from './home.js'
import { makeKit } from './kit.js'
import { remoteView } from './remote.js'

export async function renderPane(io, e, next) {
  if (e.requestId !== PANE) return next(e)
  const el = io.ui.resolve(e)
  const redraw = () => io.ui.invalidate('ui.render')
  const width = Math.max(40, Math.min(((e.props && e.props.bodyColumns) || 80) - 2, 100))
  const curId = await io.read(activeFeatureId)
  const map = await io.read(sessions)
  const own = pane.view.kind === 'feature' ? map[pane.view.id] : null
  // An in-session agent keeps its own short transcript; Workbench Web's comes from the poll.
  const tx = own && own.runner === 'session' ? { featureId: own.featureId, total: (own.events || []).length, events: own.events || [] } : await io.read(transcript)
  const srv = await io.read(serverState)
  const allFeatures = await listFeatures(io)
  const experiences = await listExperiences(io)
  const expIds = new Set(experiences.map((x) => x.id))
  const groupOf = (f) => (f.experience && expIds.has(f.experience) ? f.experience : null)
  const waiting = waitingFeatureIds(map).filter((id) => allFeatures.some((f) => f.id === id))

  const ctx = { el, redraw, width, curId, map, tx, srv, allFeatures, experiences, groupOf, waiting }
  const kit = makeKit(io, ctx)
  const views = { home: homeView, experience: experienceView, feature: featureView }
  const rows = await (views[pane.view.kind] || remoteView)(io, ctx, kit)
  return el.Box({ flexDirection: 'column', children: rows })
}
