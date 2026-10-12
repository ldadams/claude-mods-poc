// /feature: create, describe, start, answer and manage features and their sessions.

import { openWorkbench } from './workbench.js'
import { CONFIG_PATH, RUNNERS } from '../lib/constants.js'
import { createFeature, deleteFeature, findFeatureByRef, listFeatures, loadFeature, mutateFeature } from '../lib/features.js'
import { setActiveFeature } from '../lib/focus.js'
import { loadConfig } from '../lib/mcp.js'
import { osNotify } from '../lib/notify.js'
import { listRemote, pullRemote, resolveRemoteRef } from '../lib/remote.js'
import { agentStatusReport, approvePlan, featureCall, poll, replyToFeature, startFeatureAgent } from '../lib/sessions.js'
import { activeFeatureId, link, pane, serverState, sessions } from '../lib/state.js'
import { statusGlyph, statusWord } from '../lib/status.js'
import { errText, splitFirst } from '../lib/util.js'

export async function featureCommand(io, e) {
  const [sub, rest] = splitFirst(e.args)
  switch (sub) {
    case '':
    case 'show':
      return openWorkbench(io, '')
    case 'new': {
      if (!rest) return { text: 'Usage: /feature new <title>' }
      const feature = await createFeature(io, rest)
      await setActiveFeature(io, feature.id)
      pane.view = { kind: 'feature', id: feature.id }
      io.ui.invalidate('ui.render')
      return { text: 'Created feature "' + rest + '" (' + feature.id + ') and made it active.' }
    }
    case 'switch':
    case 'use': {
      const feature = await findFeatureByRef(io, rest)
      if (!feature) return { text: 'No feature matches "' + rest + '". Run /feature list to see what exists.' }
      await setActiveFeature(io, feature.id)
      return { text: 'Switched to feature "' + feature.title + '" (' + feature.id + ').' }
    }
    case 'start': {
      const id = rest || (await io.read(activeFeatureId))
      const feature = await findFeatureByRef(io, id)
      if (!feature) return { text: rest ? 'No feature matches "' + rest + '".' : 'No active feature. /feature start <id>.' }
      try {
        await startFeatureAgent(io, feature)
        const srv = await io.read(serverState)
        return { text: 'Started an agent on "' + feature.title + '" (' + feature.id + ') in Workbench Web. Follow it in /workbench or at ' + srv.url + '#/f/' + feature.id + '.' }
      } catch (err) {
        return { text: 'Could not start: ' + errText(err) }
      }
    }
    case 'runner': {
      // /feature runner [id] session|web: where this feature's next agent runs.
      const [first, second] = splitFirst(rest)
      const value = second || first
      const feature = second ? await findFeatureByRef(io, first) : await loadFeature(io, (await io.read(activeFeatureId)) || '')
      if (!feature || !RUNNERS.includes(value)) return { text: 'Usage: /feature runner [id] session|web' }
      await mutateFeature(io, feature.id, (f) => {
        f.runner = value
      })
      io.ui.invalidate('ui.render')
      return { text: '"' + feature.title + '" runs its next agent ' + (value === 'session' ? 'inside this Claude Code session.' : 'on Workbench Web.') }
    }
    case 'approach': {
      // /feature approach [id] auto|plan|direct: plan first, just do it, or as recommended.
      const [first, second] = splitFirst(rest)
      const value = second || first
      const feature = second ? await findFeatureByRef(io, first) : await loadFeature(io, (await io.read(activeFeatureId)) || '')
      if (!feature || !['auto', 'plan', 'direct'].includes(value)) return { text: 'Usage: /feature approach [id] auto|plan|direct' }
      await mutateFeature(io, feature.id, (f) => {
        if (value === 'auto') delete f.approach
        else f.approach = value
      })
      io.ui.invalidate('ui.render')
      const said = { auto: 'as recommended (Laya, when decisions are on; otherwise the experience or project setting)', plan: 'planning first', direct: 'just doing it' }[value]
      return { text: '"' + feature.title + '" starts ' + said + '.' }
    }
    case 'approve': {
      // /feature approve [id] [note]: approve the plan of a session that is planning.
      const [ref, note] = splitFirst(rest)
      let feature = ref ? await findFeatureByRef(io, ref) : null
      let extra = note
      if (!feature) {
        feature = await loadFeature(io, (await io.read(activeFeatureId)) || '')
        extra = rest
      }
      if (!feature) return { text: 'Usage: /feature approve [id] [note for the build]' }
      try {
        await approvePlan(io, feature, extra)
        return { text: 'Approved the plan for "' + feature.title + '"; it is building.' }
      } catch (err) {
        return { text: 'Could not approve: ' + errText(err) }
      }
    }
    case 'answer': {
      const [ref, text] = splitFirst(rest)
      if (!ref || !text) return { text: 'Usage: /feature answer <id> <your answer>  (yes/no for a tool; anything else to a tool denies it with that reason)' }
      const feature = await findFeatureByRef(io, ref)
      if (!feature) return { text: 'No feature matches "' + ref + '".' }
      try {
        await replyToFeature(io, feature, text)
        return { text: 'Sent to "' + feature.title + '".' }
      } catch (err) {
        return { text: 'Could not answer: ' + errText(err) }
      }
    }
    case 'describe': {
      // /feature describe <id> <text>, or /feature describe <text> for the active one.
      const [ref, text] = splitFirst(rest)
      let feature = ref && text ? await findFeatureByRef(io, ref) : null
      let description = text
      if (!feature) {
        feature = await loadFeature(io, (await io.read(activeFeatureId)) || '')
        description = rest
      }
      if (!feature || !description) return { text: 'Usage: /feature describe [id] <what the agent should do>' }
      await mutateFeature(io, feature.id, (f) => {
        f.description = description
      })
      io.ui.invalidate('ui.render')
      return { text: 'Described "' + feature.title + '". Start its agent with /feature start ' + feature.id + '.' }
    }
    case 'say':
    case 'message': {
      // /feature say <id> <text>: the next message to that feature's session.
      const [ref, text] = splitFirst(rest)
      const feature = await findFeatureByRef(io, ref)
      if (!feature || !text) return { text: 'Usage: /feature say <id> <message>' }
      try {
        await featureCall(io, feature.id, 'message', { text })
        return { text: 'Sent to "' + feature.title + '".' }
      } catch (err) {
        return { text: 'Could not send: ' + errText(err) }
      }
    }
    case 'stop':
    case 'interrupt':
    case 'reset': {
      const feature = await findFeatureByRef(io, rest || (await io.read(activeFeatureId)) || '')
      if (!feature) return { text: rest ? 'No feature matches "' + rest + '".' : 'No active feature. /feature ' + sub + ' <id>.' }
      try {
        await featureCall(io, feature.id, sub)
        const done = { stop: 'Stopped the session; send a message to resume it.', interrupt: 'Interrupted the current turn.', reset: 'Reset: the conversation is forgotten and the next start begins fresh.' }[sub]
        return { text: '"' + feature.title + '": ' + done }
      } catch (err) {
        return { text: 'Could not ' + sub + ': ' + errText(err) }
      }
    }
    case 'notify': {
      if (rest === 'on' || rest === 'off') await io.store.set('osNotify', rest === 'on')
      else if (rest === 'test') {
        await osNotify(io, 'Workbench', 'System notifications are working.')
        return { text: 'Sent a test notification. If none appeared, allow notifications for Script Editor in System Settings > Notifications.' }
      } else if (rest) return { text: 'Usage: /feature notify [on|off|test]' }
      const enabled = (await io.store.get('osNotify')) !== false
      return { text: 'System notifications are ' + (enabled ? 'on' : 'off') + ' (Workbench Web posts them; a change applies the next time this session starts it). /feature notify ' + (enabled ? 'off' : 'on') + ' to change, /feature notify test to try one.' }
    }
    case 'status':
      link.lastVersion = -1
      await poll(io)
      return { text: await agentStatusReport(io) }
    case 'list': {
      const all = await listFeatures(io)
      if (all.length === 0) return { text: 'No features yet. Create one with /feature new <title>.' }
      const curId = await io.read(activeFeatureId)
      const map = await io.read(sessions)
      const lines = all.map(
        (f) => (f.id === curId ? '▸ ' : '  ') + statusGlyph(map[f.id]) + ' ' + f.title + ' (' + f.id + ') ' + statusWord(map[f.id]),
      )
      return { text: lines.join('\n') }
    }
    case 'remote': {
      const config = await loadConfig(io)
      const names = Object.keys(config.sources)
      if (names.length === 0) return { text: 'No remote sources. Add one to ' + CONFIG_PATH + ' (see the workbench README).' }
      const lines = []
      for (const name of rest ? [rest] : names) {
        try {
          const items = await listRemote(io, config, name)
          lines.push(name + ' (' + items.length + '):')
          for (const i of items) lines.push('  ' + i.remoteId + (i.status ? ' [' + i.status + ']' : '') + ' ' + i.title)
        } catch (err) {
          lines.push(name + ': ' + errText(err))
        }
      }
      lines.push('Load one with /feature pull <source>:<id>')
      return { text: lines.join('\n') }
    }
    case 'pull': {
      if (!rest) return { text: 'Usage: /feature pull <source>:<id>' }
      try {
        const config = await loadConfig(io)
        const item = await resolveRemoteRef(io, config, rest)
        const feature = await pullRemote(io, item)
        await setActiveFeature(io, feature.id)
        return { text: 'Loaded ' + item.source + ':' + item.remoteId + ' "' + item.title + '" as ' + feature.id + ' and made it active.' }
      } catch (err) {
        return { text: 'Could not pull "' + rest + '": ' + errText(err) }
      }
    }
    case 'archive': {
      const feature = await findFeatureByRef(io, rest)
      if (!feature) return { text: 'No feature matches "' + rest + '".' }
      await mutateFeature(io, feature.id, (f) => {
        f.status = 'archived'
      })
      io.ui.invalidate('ui.render')
      return { text: 'Archived "' + feature.title + '" (' + feature.id + ').' }
    }
    case 'delete': {
      const feature = await findFeatureByRef(io, rest)
      if (!feature) return { text: 'No feature matches "' + rest + '".' }
      await deleteFeature(io, feature)
      if ((await io.read(activeFeatureId)) === feature.id) await setActiveFeature(io, null)
      return { text: 'Deleted "' + feature.title + '" (' + feature.id + ').' }
    }
    default:
      return {
        text: 'Usage: /feature [new <title>|switch <id>|start [id]|describe [id] <text>|runner [id] session|web|approach [id] auto|plan|direct|approve [id] [note]|answer <id> <text>|say <id> <text>|interrupt [id]|stop [id]|reset [id]|status|notify [on|off|test]|list|remote [source]|pull <source>:<id>|archive <id>|delete <id>]',
      }
  }
}
