// Experience: its shared context and its features.

import { deleteExperience, loadExperience, saveExperience } from '../lib/experiences.js'
import { createFeature, isReady } from '../lib/features.js'
import { pane } from '../lib/state.js'

export async function experienceView(io, ctx, kit) {
  const { Text, Input } = ctx.el
  const { map, allFeatures } = ctx
  const { go, act, hint, gap, rule, section, key, confirmKey, actions, topBar, nextKey, footer, featureRow, byAttention, startReady } = kit
  let rows
  const x = await loadExperience(io, pane.view.id)
  if (!x) {
    rows = [topBar([]), rule(), hint('That experience no longer exists.'), key('back', 'back', 'b', () => go({ kind: 'home' }))]
  } else {
    const mine = byAttention(allFeatures.filter((f) => f.experience === x.id))
    const ready = mine.filter((f) => isReady(f, map[f.id])).length
    rows = [
      topBar([x.title]),
      rule(),
      actions([
        key('back', 'back', 'b', () => go({ kind: 'home' }), { dimColor: true }),
        nextKey(),
        key('start-exp', ready ? 'start ' + ready + ' ready' : 'nothing ready', 's', () => startReady(x.id), { dimColor: !ready }),
        key('runner-exp', 'runs ' + (x.runner === 'session' ? 'in session' : x.runner === 'web' ? 'Workbench Web' : 'project default'), 'r', async () => {
          const fresh = await loadExperience(io, x.id)
          if (!fresh) throw new Error('experience no longer exists')
          // Cycles project default → in session → Workbench Web.
          fresh.runner = !fresh.runner ? 'session' : fresh.runner === 'session' ? 'web' : undefined
          if (!fresh.runner) delete fresh.runner
          await saveExperience(io, fresh)
        }, { dimColor: !x.runner }),
        key('plan-first', 'plan first: ' + (x.planFirst ? 'on' : 'off'), 'p', async () => {
          const fresh = await loadExperience(io, x.id)
          if (!fresh) throw new Error('experience no longer exists')
          fresh.planFirst = !fresh.planFirst
          await saveExperience(io, fresh)
        }, { dimColor: !x.planFirst }),
        confirmKey('delete-exp', 'delete experience', undefined, async () => {
          await deleteExperience(io, x)
          pane.view = { kind: 'home' }
        }),
      ]),
      gap(),
      section('Shared context'),
      ...((x.description || '').trim()
        ? [Text({ children: [x.description.trim()], wrap: 'wrap' })]
        : [hint('No shared context yet. What ties these features together? Every feature here gets it in its brief.')]),
      Input({
        key: 'exp-desc',
        label: (x.description || '').trim() ? 'Edit' : 'Describe',
        placeholder: (x.description || '').trim() ? 'replace the shared context, then Enter' : 'goals, constraints, links…',
        value: '',
        submitLabel: 'save',
        onSubmit: act(async (value) => {
          const fresh = await loadExperience(io, x.id)
          if (!fresh) throw new Error('experience no longer exists')
          fresh.description = value.trim()
          await saveExperience(io, fresh)
        }),
      }),
      gap(),
      section('Features', mine.length),
      ...(mine.length ? mine.map((f) => featureRow(f, '')) : [hint('None yet. Add one below, or move one here from its own view.')]),
      Input({
        key: 'exp-new-feature',
        label: 'New',
        placeholder: 'feature title, then Enter',
        value: '',
        submitLabel: 'create',
        onSubmit: act(async (value) => {
          const title = value.trim()
          if (!title) return
          await createFeature(io, title, x.id)
        }),
      }),
      ...footer('b back · s start ready · r runner · p plan first · 1-9 open · Esc close'),
    ]
  }
  return rows
}
