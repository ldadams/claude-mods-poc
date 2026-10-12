// A feature's conversation as its runner holds it, and the field for the next message.

import { MODES, TRANSCRIPT_TAIL } from '../lib/constants.js'
import { runnerLabel } from '../lib/runner.js'
import { featureCall } from '../lib/sessions.js'
import { pane } from '../lib/state.js'
import { pendingSummary, statusColor, statusGlyph, statusWord, toolBrief } from '../lib/status.js'
import { firstLine, truncate } from '../lib/util.js'

export function conversationRows(io, ctx, kit, { feature, a, started, busy, asking, runner }) {
  const { Box, Text, Input, Select, Link, Markdown } = ctx.el
  const { tx, srv } = ctx
  const { act, hint, gap, key, card } = kit
  const out = []
  // -- the conversation, as Workbench Web holds it --
  const eventRow = (ev, i) => {
    const k = 'ev-' + i
    switch (ev.t) {
      case 'user':
        return Box({
          key: k,
          flexDirection: 'row',
          columnGap: 1,
          children: [Text({ children: ['›'], color: 'suggestion', bold: true }), Text({ children: [truncate((ev.text || '').trim(), 400)], wrap: 'wrap', bold: true })],
        })
      case 'text':
        return Box({
          key: k,
          flexDirection: 'row',
          columnGap: 1,
          children: [Text({ children: ['⏺'], color: 'claude' }), Box({ flexGrow: 1, flexShrink: 1, children: [Markdown({ key: k + '-md', text: truncate(ev.text || '', 2500) })] })],
        })
      case 'tool':
        return Box({
          key: k,
          flexDirection: 'row',
          columnGap: 1,
          children: [Text({ children: ['⏺'], dimColor: true }), Text({ children: [ev.name || 'tool'], bold: true }), Text({ children: [toolBrief(ev.input)], dimColor: true, wrap: 'truncate-end' })],
        })
      case 'tool_result':
        return Text({ key: k, children: ['  ⎿ ' + (firstLine(ev.text) || '(no output)')], ...(ev.isError ? { color: 'error' } : { dimColor: true }), wrap: 'truncate-end' })
      case 'result':
        return hint('── turn ' + (ev.ok ? 'done' : 'ended (' + ev.subtype + ')') + (ev.cost ? ' · $' + ev.cost.toFixed(2) : ''))
      case 'ask':
        return Text({ key: k, children: ['? ' + (ev.kind === 'question' ? pendingSummary({ kind: 'question', input: ev.input }) : 'asked to use ' + ev.toolName)], color: 'permission', wrap: 'truncate-end' })
      case 'answered':
        return hint('  ↳ ' + firstLine(ev.text))
      case 'error':
        return Text({ key: k, children: [ev.text || 'error'], color: 'error', wrap: 'wrap' })
      case 'workflow':
        return hint('▶ workflow ' + ev.name + (ev.command ? ': ' + ev.command : ''))
      case 'workflow_output':
        return Text({ key: k, children: [truncate(ev.text || '', 600)], dimColor: true, wrap: 'wrap' })
      case 'decision': {
        const what = ev.kind === 'tool' ? 'tool ' + (ev.toolName || '') : ev.kind === 'turn' ? 'turn end' : ev.kind
        const verdict = { allow: 'allow', deny: 'deny', ask: 'ask you', revise: 'send back', ok: 'looks fine', 'follow-up': 'follow up', error: 'no judgment' }[ev.verdict] || ev.verdict
        const shadow = ev.verdict !== 'error' && ev.verdict !== 'ask' && ev.verdict !== 'ok' && !ev.applied
        const color = { deny: 'warning', revise: 'warning', 'follow-up': 'warning', allow: 'success', ok: 'success' }[ev.verdict]
        return Text({
          key: k,
          children: ['◆ Laya · ' + what + ' · ' + verdict + (ev.standard ? ' · ' + ev.standard : '') + (shadow ? ' (shadow)' : '') + (ev.reason ? ': ' + firstLine(ev.reason) : '')],
          ...(color ? { color } : { dimColor: true }),
          wrap: 'truncate-end',
        })
      }
      case 'system':
        return hint(ev.text || '')
      default:
        return null
    }
  }
  const shown = tx && tx.featureId === feature.id ? tx.events : null
  const limit = pane.showAll ? TRANSCRIPT_TAIL : 12
  const visible = shown ? shown.slice(-limit) : []
  const hidden = shown ? tx.total - visible.length : 0

  if (runner === 'web' && !srv.up) {
    out.push(
      card('server-off', [
        Text({ children: ['Workbench Web is not running'], bold: true, color: 'warning' }),
        Text({ children: ['Agents run there, so the browser and this pane share them. ' + (started ? 'Send a message' : 'Press s') + ' to start it, or run /workbench web.'], wrap: 'wrap' }),
      ], 'warning'),
      gap(),
    )
  }
  if (started || shown) {
    out.push(
      card('agent', [
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Text({ children: ['Conversation'], bold: true }),
            Text({ children: [statusGlyph(a) + ' ' + statusWord(a)], color: statusColor(a) }),
            ...(a && a.cost ? [hint('$' + a.cost.toFixed(2))] : []),
            hint(runnerLabel(runner)),
            // A permission mode and a browser view exist only on Workbench Web.
            ...(runner === 'web'
              ? [
                  Select({
                    key: 'mode',
                    options: MODES,
                    value: (a && a.mode) || 'default',
                    onSelect: act(async (value) => {
                      await featureCall(io, feature.id, 'mode', { mode: value })
                    }),
                  }),
                  ...(srv.up ? [Link({ href: srv.url + '#/f/' + feature.id, label: 'open in browser' })] : []),
                ]
              : []),
          ],
        }),
        ...(hidden > 0
          ? [key('more', pane.showAll ? hidden + ' earlier · m fewer' : hidden + ' earlier · m more', 'm', () => {
              pane.showAll = !pane.showAll
            }, { dimColor: true })]
          : pane.showAll
            ? [key('more', 'm fewer', 'm', () => {
                pane.showAll = false
              }, { dimColor: true })]
            : []),
        ...(shown ? visible.map(eventRow).filter(Boolean) : [hint('loading…')]),
        ...(a && a.status === 'running' ? [Text({ children: ['● working…'], color: 'claude' })] : []),
      ], a && a.status === 'error' ? 'error' : asking ? 'permission' : undefined),
    )
  }
  out.push(
    Input({
      key: 'message',
      label: started ? 'Message' : 'Or start with',
      placeholder: busy ? 'queue a follow-up, then Enter' : started ? 'message Claude about this feature, then Enter' : 'a first message (Claude gets the brief first), then Enter',
      value: '',
      submitLabel: 'send',
      ...(started && !asking ? { autoFocus: true } : {}),
      onSubmit: act(async (value) => {
        const text = value.trim()
        if (!text) return
        await featureCall(io, feature.id, 'message', { text })
      }),
    }),
    gap(),
  )

  return out
}
