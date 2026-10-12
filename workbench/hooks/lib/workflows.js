// Workflows: the shared registry plus each feature's own scripts and skills.

import { DEFAULT_WORKFLOWS, WORKFLOWS_PATH } from './constants.js'
import { abs, projectRoot } from './paths.js'
import { featureCall } from './sessions.js'
import { pane } from './state.js'
import { errText, truncate } from './util.js'

export async function runWorkflow(io, feature, workflow) {
  if (workflow.kind === 'script') {
    const r = await io.process.run(['sh', '-c', workflow.target], { cwd: (await projectRoot(io)) || undefined })
    const out = truncate(r.stdout + (r.stderr ? '\n' + r.stderr : ''), 3000)
    return { text: 'Ran workflow "' + workflow.name + '" (script): exit ' + r.exitCode + '\n' + out }
  }
  if (workflow.kind === 'skill') {
    const text =
      'Use the "' + workflow.target + '" skill to carry out the "' + workflow.name + '" workflow for this feature.' +
      (workflow.description ? ' ' + workflow.description : '')
    await featureCall(io, feature.id, 'message', { text })
    return { text: 'Sent workflow "' + workflow.name + '" to the agent on "' + feature.title + '".' }
  }
  return { text: 'Unknown workflow kind "' + workflow.kind + '" for "' + workflow.name + '".' }
}

export async function loadRegistry(io) {
  const byId = new Map(DEFAULT_WORKFLOWS.map((w) => [w.id, { ...w, source: 'built-in' }]))
  try {
    const path = await abs(io, WORKFLOWS_PATH)
    if (await io.fs.exists(path)) {
      const local = JSON.parse(await io.fs.read(path)).workflows || []
      for (const w of local) if (w && w.id) byId.set(w.id, { ...byId.get(w.id), ...w, source: 'project' })
    }
  } catch (err) {
    io.ui.log('workbench: could not read ' + WORKFLOWS_PATH + ': ' + errText(err))
  }
  return [...byId.values()].filter((w) => w.name && (w.kind === 'prompt' ? w.template : w.kind === 'script' && w.command))
}

export function fillTemplate(template, feature) {
  const vars = {
    'feature.title': feature.title,
    'feature.id': feature.id,
    'feature.description': feature.description || '',
    'remote.url': (feature.remote && feature.remote.url) || '(none)',
  }
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m))
}

// A prompt workflow goes to the feature's session in Workbench Web (starting it
// with the brief when it has none), so both UIs see it run.
export async function runRegistryWorkflow(io, feature, wf) {
  if (wf.kind === 'script') {
    const r = await io.process.run(['sh', '-c', wf.command], { cwd: (await projectRoot(io)) || undefined, timeoutMs: 120000 })
    const text = truncate((r.stdout || '') + (r.stderr ? '\n' + r.stderr : ''), 3000) || '(no output)'
    pane.lastOutput = { featureId: feature.id, name: wf.name, text, exitCode: r.exitCode }
    return { text: wf.name + ' (exit ' + r.exitCode + ')\n' + text }
  }
  try {
    await featureCall(io, feature.id, 'workflow/' + encodeURIComponent(wf.id))
  } catch (err) {
    // A project workflow the server does not know: send its text as a message.
    if (!/No such workflow/.test(errText(err))) throw err
    await featureCall(io, feature.id, 'message', { text: fillTemplate(wf.template, feature) })
  }
  return { text: 'Sent "' + wf.name + '" to the agent on "' + feature.title + '".' }
}
