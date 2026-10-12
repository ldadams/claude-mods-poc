// /ctx: the active feature's context providers.

import { openWorkbench } from './workbench.js'
import { describeProvider, parseContextSpec } from '../lib/context.js'
import { loadFeature, mutateFeature } from '../lib/features.js'
import { activeFeatureId } from '../lib/state.js'
import { newId, splitFirst } from '../lib/util.js'

export async function ctxCommand(io, e) {
  const [sub, rest] = splitFirst(e.args)
  const curId = await io.read(activeFeatureId)
  if (sub === '' || sub === 'show') return openWorkbench(io, curId || '')
  const feature = await loadFeature(io, curId)
  if (!feature) return { text: 'No active feature. Run /feature new <title> or /feature switch <id> first.' }
  switch (sub) {
    case 'add': {
      const spec = parseContextSpec(rest)
      if (!spec) {
        return { text: 'Usage: /ctx add <file|command|url|note> <value>\n       /ctx add mcp <server> <tool> [json args]' }
      }
      await mutateFeature(io, feature.id, (f) => f.context.push({ id: newId('c'), label: '', ...spec }))
      io.ui.invalidate('ui.render')
      return { text: 'Added ' + spec.type + ' context "' + spec.value + '" to "' + feature.title + '".' }
    }
    case 'remove': {
      let removed = false
      await mutateFeature(io, feature.id, (f) => {
        const before = f.context.length
        f.context = f.context.filter((c) => c.id !== rest)
        removed = f.context.length !== before
      })
      if (!removed) return { text: 'No context provider with id "' + rest + '".' }
      io.ui.invalidate('ui.render')
      return { text: 'Removed context provider "' + rest + '".' }
    }
    case 'list': {
      if (feature.context.length === 0) return { text: '"' + feature.title + '" has no context providers yet.' }
      return { text: feature.context.map((c) => c.id + ': ' + describeProvider(c)).join('\n') }
    }
    default:
      return { text: 'Usage: /ctx [add <type> <value>|remove <id>|list]' }
  }
}
