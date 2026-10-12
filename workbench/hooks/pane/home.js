// Home: every feature, grouped by experience, the ones needing you first.

import { createExperience } from '../lib/experiences.js'
import { createFeature, isReady } from '../lib/features.js'
import { setActiveFeature } from '../lib/focus.js'
import { refreshRemoteLists } from '../lib/remote.js'
import { pane } from '../lib/state.js'

export async function homeView(io, ctx, kit) {
  const { Box, Text, Button, Input } = ctx.el
  const { map, allFeatures, experiences, groupOf } = ctx
  const { go, act, hint, gap, rule, key, actions, card, countChips, topBar, nextKey, footer, featureRow, byAttention, startReady, webRow } = kit
  let rows
  const readyCount = allFeatures.filter((f) => isReady(f, map[f.id])).length
  rows = [
    topBar([]),
    rule(),
    actions([
      nextKey(),
      key('start-all', readyCount ? 'start ' + readyCount + ' ready' : 'start all ready', 's', () => startReady(undefined), { dimColor: !readyCount }),
      key('go-remote', 'remote', 'r', async () => {
        await refreshRemoteLists(io)
        pane.view = { kind: 'remote' }
      }, { dimColor: true }),
      webRow(),
    ]),
    gap(),
  ]
  if (allFeatures.length === 0 && experiences.length === 0) {
    rows.push(
      card('get-started', [
        Text({ children: ['Get started'], bold: true, color: 'claude' }),
        Text({ children: ['1  Type a feature title in New below, or press r to pull one from GitHub, Linear, Jira…'], wrap: 'wrap' }),
        Text({ children: ['2  Describe what the agent should do, and add context: files, commands, URLs, notes'], wrap: 'wrap' }),
        Text({ children: ['3  Press s to start an agent. The status line and this pane tell you when it needs you'], wrap: 'wrap' }),
      ]),
    )
  }
  for (const x of experiences) {
    const mine = byAttention(allFeatures.filter((f) => groupOf(f) === x.id))
    rows.push(
      Box({
        key: 'exp-' + x.id,
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Button({
            key: 'open-exp-' + x.id,
            plain: true,
            onPress: act(() => go({ kind: 'experience', id: x.id })),
            children: [Text({ children: ['▾ ' + x.title], bold: true })],
          }),
          hint(mine.length + ' feature' + (mine.length === 1 ? '' : 's')),
          ...countChips(mine, 'you'),
        ],
      }),
      ...(mine.length ? mine.map((f) => featureRow(f, '  ')) : [hint('    no features yet')]),
    )
  }
  const loose = byAttention(allFeatures.filter((f) => !groupOf(f)))
  if (loose.length) {
    if (experiences.length) rows.push(Text({ key: 'ungrouped', children: ['▾ Ungrouped'], bold: true, dimColor: true }))
    rows.push(...loose.map((f) => featureRow(f, experiences.length ? '  ' : '')))
  }
  rows.push(
    gap(),
    Input({
      key: 'new-feature',
      label: 'New',
      placeholder: 'feature title, then Enter',
      value: '',
      submitLabel: 'create',
      ...(allFeatures.length === 0 ? { autoFocus: true } : {}),
      onSubmit: act(async (value) => {
        const title = value.trim()
        if (!title) return
        const feature = await createFeature(io, title)
        await setActiveFeature(io, feature.id)
        pane.view = { kind: 'feature', id: feature.id }
      }),
    }),
    Input({
      key: 'new-experience',
      label: 'Group',
      placeholder: 'new experience title, then Enter',
      value: '',
      submitLabel: 'create',
      onSubmit: act(async (value) => {
        const title = value.trim()
        if (!title) return
        const exp = await createExperience(io, title)
        pane.view = { kind: 'experience', id: exp.id }
      }),
    }),
    ...footer('1-9 open · s start · r remote · w browser · Esc close'),
  )
  return rows
}
