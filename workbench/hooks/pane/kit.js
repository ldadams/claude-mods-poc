// The pane's vocabulary: every view is drawn from these, so they look alike.
// Built per render, over that render's data.

import { nothingReadyText, startReadyIn } from '../lib/experiences.js'
import { hasBrief, isArchived } from '../lib/features.js'
import { poll } from '../lib/sessions.js'
import { link, pane } from '../lib/state.js'
import { hasSession, pendingSummary, statusColor, statusGlyph, statusWord } from '../lib/status.js'
import { elapsed, errText, truncate } from '../lib/util.js'
import { startWeb } from '../lib/web.js'

export function makeKit(io, ctx) {
  const { Box, Text, Button, Link } = ctx.el
  const { curId, map, srv, allFeatures, waiting, width, redraw } = ctx
  const go = (nextView) => {
    pane.view = nextView
    pane.armed = null
    pane.showAll = false
    redraw()
    if (nextView.kind === 'feature') {
      link.lastVersion = -1
      poll(io).catch(() => {})
    }
  }
  const fail = (err) => io.ui.toast('workbench: ' + errText(err), { timeoutMs: 8000 })
  const act = (fn) => async (value) => {
    pane.armed = null
    try {
      await fn(value)
    } catch (err) {
      fail(err)
    }
    redraw()
  }

  // -- the pane's vocabulary: every view is drawn from these --
  const hint = (text) => Text({ children: [text], dimColor: true })
  const gap = () => Text({ children: [' '] })
  const rule = () => Text({ children: ['─'.repeat(width)], dimColor: true })
  const ago = (iso) => {
    const t = elapsed(iso)
    return t === 'just now' ? t : t + ' ago'
  }
  const section = (title, count) =>
    Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [Text({ children: [title], bold: true }), ...(count === undefined ? [] : [hint(String(count))])],
    })
  const key = (name, label, hotkey, onPress, extra) =>
    Button({ key: name, label, ...(hotkey ? { hotkey } : {}), plain: true, onPress: act(onPress), ...(extra || {}) })
  // A destructive button: the first press arms it, the second acts.
  const confirmKey = (name, label, hotkey, onPress) =>
    pane.armed === name
      ? Button({
          key: name,
          ...(hotkey ? { hotkey } : {}),
          plain: true,
          onPress: act(onPress),
          children: [Text({ children: ['press again to ' + label], color: 'error', bold: true })],
        })
      : Button({
          key: name,
          label,
          ...(hotkey ? { hotkey } : {}),
          plain: true,
          dimColor: true,
          onPress: () => {
            pane.armed = name
            redraw()
          },
        })
  const actions = (buttons) => Box({ flexDirection: 'row', columnGap: 3, flexWrap: 'wrap', children: buttons.filter(Boolean) })
  // A rounded card; the accent colors its border.
  const card = (cardKey, children, accent) =>
    Box({
      key: cardKey,
      flexDirection: 'column',
      borderStyle: 'round',
      ...(accent ? { borderColor: accent } : { borderDimColor: true }),
      paddingX: 1,
      width,
      children,
    })

  const countChips = (list, helpWord) => {
    const c = { 'needs-you': 0, running: 0, ready: 0, error: 0 }
    for (const f of list) {
      const a = map[f.id]
      if (a && a.status in c) c[a.status]++
    }
    const out = []
    const help = c['needs-you']
    if (help) out.push(Text({ children: ['? ' + help + ' need' + (help === 1 ? 's' : '') + ' ' + helpWord], color: 'permission', bold: true }))
    if (c.running) out.push(Text({ children: ['● ' + c.running + ' working'], color: 'claude' }))
    if (c.ready) out.push(Text({ children: ['✓ ' + c.ready + ' your turn'], color: 'success' }))
    if (c.error) out.push(Text({ children: ['✗ ' + c.error + ' error'], color: 'error' }))
    return out
  }

  // The bar on every view: where you are on the left, what needs you on the right.
  const topBar = (crumbs) =>
    Box({
      flexDirection: 'row',
      justifyContent: 'space-between',
      width,
      children: [
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Text({ children: ['◆ Workbench'], bold: true, color: 'claude' }),
            ...crumbs.flatMap((c) => [hint('›'), Text({ children: [truncate(c, 40)], bold: true, wrap: 'truncate-end' })]),
          ],
        }),
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            ...countChips(allFeatures, 'your answer'),
            srv.up
              ? hint('web ✓' + (srv.browsers ? ' · ' + srv.browsers + ' browser' + (srv.browsers === 1 ? '' : 's') : ''))
              : Text({ children: ['web off'], color: 'warning' }),
          ],
        }),
      ],
    })

  // `n` from any view: the next feature waiting on you, oldest question first.
  const nextKey = () =>
    waiting.length
      ? Button({
          key: 'next-waiting',
          hotkey: 'n',
          plain: true,
          onPress: act(() => {
            const at = pane.view.kind === 'feature' ? waiting.indexOf(pane.view.id) : -1
            pane.view = { kind: 'feature', id: waiting[(at + 1) % waiting.length] }
          }),
          children: [Text({ children: ['next waiting (' + waiting.length + ')'], color: 'permission' })],
        })
      : null
  const footer = (text) => [rule(), hint((waiting.length ? 'n next waiting · ' : '') + text)]

  const statusText = (a, long) => {
    let text = statusWord(a)
    if (a && a.status === 'running') text += ' · ' + elapsed(a.resumedAt || a.startedAt)
    if (long && a && a.status === 'needs-you' && (a.pending || []).length) text += ' · ' + pendingSummary(a.pending[0])
    return Text({ children: [text], color: statusColor(a), wrap: 'truncate-end' })
  }



  // A row per feature; the first nine take the number keys in display order.
  // Titles sit in one column so the states line up.
  let hot = 0
  const titleWidth = Math.min(44, Math.floor(width / 2))
  const featureRow = (f, indent) => {
    const a = map[f.id]
    const hotkey = hot < 9 ? String(++hot) : undefined
    const archived = isArchived(f)
    const lead = indent + (f.id === curId ? '▸ ' : '  ')
    const room = titleWidth - lead.length - (hotkey ? 5 : 2)
    return Box({
      key: 'row-' + f.id,
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Box({
          width: titleWidth,
          overflow: 'hidden',
          children: [
            Button({
              key: 'open-' + f.id,
              ...(hotkey ? { hotkey } : {}),
              plain: true,
              ...(archived ? { dimColor: true } : {}),
              onPress: act(() => go({ kind: 'feature', id: f.id })),
              children: [lead, Text({ children: [statusGlyph(a)], color: statusColor(a) }), ' ' + truncate(f.title, Math.max(8, room))],
            }),
          ],
        }),
        archived
          ? hint('archived')
          : !hasSession(a) && !hasBrief(f)
            ? Text({ children: ['needs a description'], color: 'warning' })
            : statusText(a, true),
        ...(hasSession(a) ? [hint(a.runner === 'session' ? '· in session' : '· web')] : []),
      ],
    })
  }
  const rank = { 'needs-you': 0, running: 1, error: 2, ready: 3, paused: 4, idle: 5 }
  const byAttention = (list) =>
    [...list].sort((x, y) => {
      const ax = isArchived(x) ? 9 : rank[(map[x.id] && map[x.id].status) || 'idle'] ?? 5
      const ay = isArchived(y) ? 9 : rank[(map[y.id] && map[y.id].status) || 'idle'] ?? 5
      return ax - ay
    })
  const startReady = async (expId) => {
    const { started, empty } = await startReadyIn(io, expId)
    if (!started) io.ui.toast('workbench: ' + nothingReadyText(empty), { timeoutMs: 8000 })
  }
  const webRow = () =>
    srv.up
      ? Box({ flexDirection: 'row', columnGap: 1, children: [hint('browser'), Link({ href: srv.url, label: srv.url }), hint('·'), Link({ href: srv.url + 'docs/', label: 'docs' })] })
      : key('open-web', link.webState.starting ? 'starting browser view…' : 'open in browser', 'w', async () => {
          await startWeb(io)
        }, { dimColor: true })


  return { go, fail, act, hint, gap, rule, ago, section, key, confirmKey, actions, card, countChips, topBar, nextKey, footer, statusText, titleWidth, featureRow, rank, byAttention, startReady, webRow }
}
