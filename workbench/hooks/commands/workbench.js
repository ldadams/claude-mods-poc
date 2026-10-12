// /workbench and /wb: open the pane, or start Workbench Web.

import { PANE } from '../lib/constants.js'
import { findFeatureByRef } from '../lib/features.js'
import { poll } from '../lib/sessions.js'
import { link, pane } from '../lib/state.js'
import { errText } from '../lib/util.js'
import { startWeb } from '../lib/web.js'

// Opens the pane on Home, or on one feature when a ref is given.
export async function openWorkbench(io, args) {
  const ref = (args || '').trim()
  if (ref) {
    const feature = await findFeatureByRef(io, ref)
    if (!feature) return { text: 'No feature matches "' + ref + '".' }
    pane.view = { kind: 'feature', id: feature.id }
  } else {
    pane.view = { kind: 'home' }
  }
  // Fresh state before the first draw, rather than up to a poll period late.
  link.lastVersion = -1
  await poll(io)
  await io.ui.open({ id: PANE, title: 'Workbench', focus: true, closeOnEscape: true })
  io.ui.invalidate('ui.render')
  return {}
}

// /workbench [feature] opens the pane; /workbench web starts the browser view.
export async function workbenchCommand(io, e) {
  if ((e.args || '').trim() === 'web') {
    try {
      const url = await startWeb(io)
      io.ui.invalidate('ui.render')
      return { text: 'Workbench Web is running at ' + url + ' (open it in your browser). It stops when this session ends.' }
    } catch (err) {
      return { text: 'Could not start Workbench Web: ' + errText(err) }
    }
  }
  return openWorkbench(io, e.args)
}
