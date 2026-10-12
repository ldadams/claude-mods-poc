// /experience: group features into experiences with shared context.

import { PANE } from '../lib/constants.js'
import { createExperience, deleteExperience, findExperienceByRef, listExperiences, nothingReadyText, saveExperience, startReadyIn } from '../lib/experiences.js'
import { findFeatureByRef, listFeatures, mutateFeature } from '../lib/features.js'
import { activeFeatureId, pane, sessions } from '../lib/state.js'
import { statusGlyph, statusWord } from '../lib/status.js'
import { errText, splitFirst } from '../lib/util.js'

export async function experienceCommand(io, e) {
  const [sub, rest] = splitFirst(e.args)
  const usage = 'Usage: /experience [new <title>|list|show <id>|describe <id> <text>|runner <id> session|web|default|planfirst <id> on|off|add <experience> <feature>|remove <feature>|start <id>|delete <id>]'
  switch (sub) {
    case 'new': {
      if (!rest) return { text: 'Usage: /experience new <title>' }
      const exp = await createExperience(io, rest)
      pane.view = { kind: 'experience', id: exp.id }
      io.ui.invalidate('ui.render')
      return { text: 'Created experience "' + exp.title + '" (' + exp.id + '). Add features with /experience add ' + exp.id + ' <feature>.' }
    }
    case '':
    case 'list': {
      const exps = await listExperiences(io)
      if (!exps.length) return { text: 'No experiences yet. Create one with /experience new <title>.' }
      const feats = await listFeatures(io)
      const map = await io.read(sessions)
      const lines = []
      for (const x of exps) {
        const mine = feats.filter((f) => f.experience === x.id)
        lines.push(x.title + ' (' + x.id + ') · ' + mine.length + ' feature' + (mine.length === 1 ? '' : 's'))
        for (const f of mine) lines.push('    ' + statusGlyph(map[f.id]) + ' ' + f.title + ' (' + f.id + ') ' + statusWord(map[f.id]))
      }
      const loose = feats.filter((f) => !f.experience || !exps.some((x) => x.id === f.experience))
      if (loose.length) lines.push('Ungrouped · ' + loose.map((f) => f.id).join(', '))
      return { text: lines.join('\n') }
    }
    case 'show': {
      const exp = await findExperienceByRef(io, rest)
      if (!exp) return { text: 'No experience matches "' + rest + '".' }
      pane.view = { kind: 'experience', id: exp.id }
      await io.ui.open({ id: PANE, title: 'Workbench', focus: true, closeOnEscape: true })
      io.ui.invalidate('ui.render')
      return {}
    }
    case 'describe': {
      const [ref, text] = splitFirst(rest)
      const exp = await findExperienceByRef(io, ref)
      if (!exp) return { text: 'No experience matches "' + ref + '".' }
      exp.description = text
      await saveExperience(io, exp)
      io.ui.invalidate('ui.render')
      return { text: 'Updated the shared context of "' + exp.title + '". Every feature in it gets it in its brief.' }
    }
    case 'runner': {
      // /experience runner <id> session|web|default: where its features' agents run.
      const [ref, value] = splitFirst(rest)
      const exp = await findExperienceByRef(io, ref)
      if (!exp || !['session', 'web', 'default'].includes(value)) return { text: 'Usage: /experience runner <id> session|web|default' }
      if (value === 'default') delete exp.runner
      else exp.runner = value
      await saveExperience(io, exp)
      io.ui.invalidate('ui.render')
      return { text: 'Features in "' + exp.title + '" run their agents ' + (value === 'session' ? 'inside this Claude Code session' : value === 'web' ? 'on Workbench Web' : 'where the project says') + ', unless a feature says otherwise.' }
    }
    case 'planfirst':
    case 'plan-first': {
      // /experience planfirst <id> on|off: new sessions here start by planning.
      const [ref, onOff] = splitFirst(rest)
      const exp = await findExperienceByRef(io, ref)
      if (!exp || !['on', 'off'].includes(onOff)) return { text: 'Usage: /experience planfirst <id> on|off' }
      exp.planFirst = onOff === 'on'
      await saveExperience(io, exp)
      io.ui.invalidate('ui.render')
      return {
        text: exp.planFirst
          ? 'New sessions in "' + exp.title + '" start by planning; approve the plan (p, or /feature approve) to build.'
          : 'New sessions in "' + exp.title + '" start building straight away.',
      }
    }
    case 'add': {
      const [ref, featureRef] = splitFirst(rest)
      const exp = await findExperienceByRef(io, ref)
      if (!exp) return { text: 'No experience matches "' + ref + '".' }
      const feature = await findFeatureByRef(io, featureRef || (await io.read(activeFeatureId)) || '')
      if (!feature) return { text: 'No feature matches "' + featureRef + '".' }
      await mutateFeature(io, feature.id, (f) => {
        f.experience = exp.id
      })
      io.ui.invalidate('ui.render')
      return { text: 'Moved "' + feature.title + '" into "' + exp.title + '".' }
    }
    case 'remove': {
      const feature = await findFeatureByRef(io, rest || (await io.read(activeFeatureId)) || '')
      if (!feature) return { text: 'No feature matches "' + rest + '".' }
      await mutateFeature(io, feature.id, (f) => delete f.experience)
      io.ui.invalidate('ui.render')
      return { text: '"' + feature.title + '" is no longer in an experience.' }
    }
    case 'start': {
      const exp = await findExperienceByRef(io, rest)
      if (!exp) return { text: 'No experience matches "' + rest + '".' }
      try {
        const { started: n, empty } = await startReadyIn(io, exp.id)
        return { text: n ? 'Started ' + n + ' agent' + (n === 1 ? '' : 's') + ' in "' + exp.title + '".' : 'In "' + exp.title + '", ' + nothingReadyText(empty) + '.' }
      } catch (err) {
        return { text: 'Could not start: ' + errText(err) }
      }
    }
    case 'delete': {
      const exp = await findExperienceByRef(io, rest)
      if (!exp) return { text: 'No experience matches "' + rest + '".' }
      await deleteExperience(io, exp)
      if (pane.view.kind === 'experience' && pane.view.id === exp.id) pane.view = { kind: 'home' }
      io.ui.invalidate('ui.render')
      return { text: 'Deleted experience "' + exp.title + '". Its features are kept, ungrouped.' }
    }
    default:
      return { text: usage }
  }
}
