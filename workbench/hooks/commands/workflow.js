// /workflow: run shared registry workflows, or manage the active feature's own.

import { openWorkbench } from './workbench.js'
import { WORKFLOW_KINDS } from '../lib/constants.js'
import { loadFeature, mutateFeature } from '../lib/features.js'
import { activeFeatureId } from '../lib/state.js'
import { errText, newId, splitFirst } from '../lib/util.js'
import { loadRegistry, runRegistryWorkflow, runWorkflow } from '../lib/workflows.js'

export async function workflowCommand(io, e) {
  const [sub, rest] = splitFirst(e.args)
  const curId = await io.read(activeFeatureId)
  if (sub === '' || sub === 'show') return openWorkbench(io, curId || '')
  const feature = await loadFeature(io, curId)
  if (!feature) return { text: 'No active feature. Run /feature new <title> or /feature switch <id> first.' }
  switch (sub) {
    case 'add': {
      const [name, kindAndTarget] = splitFirst(rest)
      const [kind, target] = splitFirst(kindAndTarget)
      if (!name || !WORKFLOW_KINDS.includes(kind) || !target) {
        return { text: 'Usage: /workflow add <name> <skill|script> <target>' }
      }
      await mutateFeature(io, feature.id, (f) => f.workflows.push({ id: newId('w'), name, kind, target, description: '' }))
      io.ui.invalidate('ui.render')
      return { text: 'Added ' + kind + ' workflow "' + name + '" to "' + feature.title + '".' }
    }
    case 'remove': {
      let removed = false
      await mutateFeature(io, feature.id, (f) => {
        const before = f.workflows.length
        f.workflows = f.workflows.filter((w) => w.name !== rest)
        removed = f.workflows.length !== before
      })
      if (!removed) return { text: 'No workflow named "' + rest + '".' }
      io.ui.invalidate('ui.render')
      return { text: 'Removed workflow "' + rest + '".' }
    }
    case 'run': {
      const workflow = feature.workflows.find((w) => w.name === rest)
      if (workflow) return runWorkflow(io, feature, workflow)
      const registry = await loadRegistry(io)
      const needle = rest.toLowerCase()
      const shared = registry.find((w) => w.id === rest) || registry.find((w) => w.name.toLowerCase() === needle)
      if (!shared) return { text: 'No workflow named "' + rest + '". Run /workflow list to see what\'s available.' }
      try {
        return await runRegistryWorkflow(io, feature, shared)
      } catch (err) {
        return { text: 'Could not run "' + shared.name + '": ' + errText(err) }
      }
    }
    case 'list': {
      const registry = await loadRegistry(io)
      const lines = ['Shared (every feature):']
      for (const w of registry) lines.push('  ' + w.id + '  ' + w.name + ' [' + w.kind + ']' + (w.source === 'project' ? ' (project)' : '') + ' — ' + (w.description || ''))
      lines.push('"' + feature.title + '" only:')
      if (feature.workflows.length === 0) lines.push('  none yet')
      for (const w of feature.workflows) lines.push('  ' + w.name + ' [' + w.kind + '] -> ' + w.target)
      lines.push('Run one with /workflow run <id or name>.')
      return { text: lines.join('\n') }
    }
    default:
      return { text: 'Usage: /workflow [run <id|name>|list|add <name> <kind> <target>|remove <name>]' }
  }
}
