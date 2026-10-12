// Feature: one feature, its session, description, context and workflows.

import { CONTEXT_TYPES, WORKFLOW_KINDS } from '../lib/constants.js'
import { parseContextSpec } from '../lib/context.js'
import { deleteFeature, hasBrief, isArchived, loadFeature, mutateFeature } from '../lib/features.js'
import { setActiveFeature } from '../lib/focus.js'
import { approvePlan, featureCall, startFeatureAgent } from '../lib/sessions.js'
import { runnerFor, runnerLabel } from '../lib/runner.js'
import { pane } from '../lib/state.js'
import { hasSession, isBusy, statusColor, statusGlyph } from '../lib/status.js'
import { firstLine, newId, splitFirst } from '../lib/util.js'
import { loadRegistry, runRegistryWorkflow, runWorkflow } from '../lib/workflows.js'
import { askCards } from './feature-asks.js'
import { conversationRows } from './feature-conversation.js'

export async function featureView(io, ctx, kit) {
  const { Box, Text, Input, Select, Link } = ctx.el
  const { curId, map, experiences, groupOf, redraw } = ctx
  const { go, act, hint, gap, rule, section, key, confirmKey, actions, card, topBar, nextKey, footer, statusText } = kit
  let rows
  const feature = await loadFeature(io, pane.view.id)
  if (!feature) {
    rows = [topBar([]), rule(), hint('That feature no longer exists.'), key('back', 'back', 'b', () => go({ kind: 'home' }))]
  } else {
    const a = map[feature.id]
    const registry = await loadRegistry(io)
    const busy = isBusy(a)
    const live = !!(a && a.live)
    const started = hasSession(a)
    const pending = (a && a.pending) || []
    const asking = pending.length > 0
    const isActive = feature.id === curId
    const desc = (feature.description || '').trim()
    // The runner that holds its agent, or the one a new agent would start on.
    const runner = a && a.runner === 'session' && started ? 'session' : started ? 'web' : await runnerFor(io, feature)
    const exp = groupOf(feature) ? experiences.find((x) => x.id === groupOf(feature)) : null
    const ctxPlaceholder = {
      file: 'path/to/file',
      command: 'shell command, e.g. git log -5 --oneline',
      url: 'https://…',
      note: 'free text the model should know',
      mcp: '<server> <tool> {"json":"args"}',
    }[pane.pendingCtxType]

    rows = [
      topBar([...(exp ? [exp.title] : []), feature.title]),
      rule(),
      actions([
        key('back', 'back', 'b', () => go(groupOf(feature) ? { kind: 'experience', id: groupOf(feature) } : { kind: 'home' }), { dimColor: true }),
        nextKey(),
        started
          ? null
          : key('start', 'start agent', 's', () => {
              if (!hasBrief(feature)) throw new Error('describe what the agent should do, or add context, first')
              return startFeatureAgent(io, feature)
            }, { dimColor: !hasBrief(feature) }),
        a && a.phase === 'planning' && !pending.some((p) => p.toolName === 'ExitPlanMode')
          ? key('approve-plan', 'approve plan', 'p', () => approvePlan(io, feature))
          : null,
        a && a.status === 'running' ? key('interrupt', 'interrupt', 'i', () => featureCall(io, feature.id, 'interrupt')) : null,
        live ? confirmKey('stop', 'stop session', 'x', () => featureCall(io, feature.id, 'stop')) : null,
        started ? confirmKey('reset-agent', 'reset conversation', undefined, () => featureCall(io, feature.id, 'reset')) : null,
        started
          ? null
          : key('runner', 'runs ' + runnerLabel(runner), 'r', () =>
              mutateFeature(io, feature.id, (f) => {
                f.runner = runner === 'session' ? 'web' : 'session'
              }), { dimColor: true }),
        started
          ? null
          : key('approach', 'approach: ' + ({ plan: 'plan first', direct: 'just do it' }[feature.approach] || 'as recommended'), 'o', () =>
              mutateFeature(io, feature.id, (f) => {
                // Cycles as recommended → plan first → just do it.
                const next = { undefined: 'plan', plan: 'direct', direct: undefined }[String(f.approach)]
                if (next) f.approach = next
                else delete f.approach
              }), { dimColor: !feature.approach }),
        key('use', isActive ? '▸ prompts use this' : 'focus prompts here', 'u', () => setActiveFeature(io, isActive ? null : feature.id), { dimColor: isActive }),
        key('archive', isArchived(feature) ? 'unarchive' : 'archive', 'a', () =>
          mutateFeature(io, feature.id, (f) => {
            f.status = isArchived(f) ? 'active' : 'archived'
          }), { dimColor: true }),
        confirmKey('delete', 'delete', undefined, async () => {
          await deleteFeature(io, feature)
          if (isActive) await setActiveFeature(io, null)
          pane.view = { kind: 'home' }
        }),
      ]),
      gap(),
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Text({ children: [statusGlyph(a) + ' ' + feature.title], bold: true, color: statusColor(a) === 'inactive' ? undefined : statusColor(a) }),
          statusText(a, false),
          ...(a && a.phase ? [Text({ children: [a.phase], color: a.phase === 'planning' ? 'planMode' : 'claude', bold: true })] : []),
          ...(isActive ? [Text({ children: ['▸ prompts carry this'], color: 'suggestion' })] : []),
          ...(isArchived(feature) ? [hint('archived')] : []),
        ],
      }),
      ...(!started && a && a.assessment
        ? [
            a.assessment.error
              ? hint('Laya: no suggestion (' + a.assessment.error + ')')
              : Text({
                  children: ['◆ Laya suggests ' + (a.assessment.recommended === 'plan' ? 'planning first' : 'just doing it') + ' (' + Math.round(a.assessment.confidence * 100) + '%): ' + a.assessment.reasons.join(', ')],
                  color: 'suggestion',
                  wrap: 'wrap',
                }),
          ]
        : []),
      ...(feature.remote
        ? [
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [
                hint(feature.remote.source + ':' + feature.remote.id + (feature.remote.status ? ' · ' + feature.remote.status : '')),
                ...(feature.remote.url ? [Link({ href: feature.remote.url, label: feature.remote.url })] : []),
              ],
            }),
          ]
        : []),
      ...(experiences.length
        ? [
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [
                hint('Experience'),
                Select({
                  key: 'feature-exp',
                  options: [{ value: '', label: '(none)' }, ...experiences.map((x) => ({ value: x.id, label: x.title }))],
                  value: groupOf(feature) || '',
                  onSelect: act(async (value) => {
                    await mutateFeature(io, feature.id, (f) => {
                      if (value) f.experience = value
                      else delete f.experience
                    })
                  }),
                }),
                ...(groupOf(feature) ? [key('open-exp', 'open', undefined, () => go({ kind: 'experience', id: groupOf(feature) }), { dimColor: true })] : []),
              ],
            }),
          ]
        : []),
      gap(),
    ]

    rows.push(...askCards(io, ctx, kit, feature, pending))
    if (asking) rows.push(gap())
    rows.push(...conversationRows(io, ctx, kit, { feature, a, started, busy, asking, runner }))
    rows.push(
      section('Description'),
      ...(desc
        ? [Text({ children: [desc], wrap: 'wrap' })]
        : [Text({ children: ['No description yet. Say what the agent should do; it needs this or some context to start.'], color: 'warning', wrap: 'wrap' })]),
      Input({
        key: 'feature-desc',
        label: desc ? 'Edit' : 'Describe',
        placeholder: desc ? 'replace the description, then Enter' : 'what should the agent do? then Enter',
        value: '',
        submitLabel: 'save',
        ...(!desc && !asking && !started ? { autoFocus: true } : {}),
        onSubmit: act(async (value) => {
          const text = value.trim()
          if (!text) return
          await mutateFeature(io, feature.id, (f) => {
            f.description = text
          })
        }),
      }),
      rule(),
      section('Context', feature.context.length),
      ...(feature.context.length === 0 ? [hint('Nothing yet. Files, commands, URLs, notes and MCP tools go here.')] : []),
      ...feature.context.map((c) =>
        Box({
          key: 'ctx-' + c.id,
          flexDirection: 'row',
          columnGap: 1,
          children: [
            key('del-ctx-' + c.id, '×', undefined, () =>
              mutateFeature(io, feature.id, (f) => {
                f.context = f.context.filter((x) => x.id !== c.id)
              }), { dimColor: true }),
            Box({ width: 8, children: [Text({ children: [c.type], color: 'suggestion' })] }),
            Text({ children: [c.value], wrap: 'truncate-end' }),
          ],
        }),
      ),
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Select({
            key: 'ctx-type',
            options: CONTEXT_TYPES.map((t) => ({ value: t, label: t })),
            value: pane.pendingCtxType,
            onSelect: (value) => {
              pane.pendingCtxType = value
              redraw()
            },
          }),
          Input({
            key: 'ctx-value',
            placeholder: ctxPlaceholder,
            value: '',
            submitLabel: 'add',
            onSubmit: act(async (value) => {
              const spec = parseContextSpec(pane.pendingCtxType + ' ' + value.trim())
              if (!spec) throw new Error('could not parse that ' + pane.pendingCtxType + ' provider')
              await mutateFeature(io, feature.id, (f) => f.context.push({ id: newId('c'), label: '', ...spec }))
            }),
          }),
        ],
      }),
      rule(),
      section('Shared workflows', registry.length),
      Box({
        flexDirection: 'row',
        columnGap: 3,
        flexWrap: 'wrap',
        children: registry.map((w) =>
          key('reg-' + w.id, (w.kind === 'script' ? '$ ' : '› ') + w.name, undefined, async () => {
            const result = await runRegistryWorkflow(io, feature, w)
            io.ui.toast(firstLine(result.text) || 'Workflow finished.', { timeoutMs: 8000 })
          }),
        ),
      }),
      ...(pane.lastOutput && pane.lastOutput.featureId === feature.id
        ? [
            card('last-output-card', [
              Box({
                flexDirection: 'row',
                columnGap: 2,
                children: [
                  Text({ children: ['$ ' + pane.lastOutput.name], bold: true }),
                  Text({ children: ['exit ' + pane.lastOutput.exitCode], color: pane.lastOutput.exitCode === 0 ? 'success' : 'error' }),
                  key('dismiss-output', '×', undefined, () => {
                    pane.lastOutput = null
                  }, { dimColor: true }),
                ],
              }),
              Text({ key: 'last-output', children: [pane.lastOutput.text], wrap: 'wrap', dimColor: true }),
            ], pane.lastOutput.exitCode === 0 ? undefined : 'error'),
          ]
        : []),
      gap(),
      section('This feature\'s workflows', feature.workflows.length),
      ...(feature.workflows.length === 0 ? [hint('Nothing yet. A script runs a shell command; a skill asks Claude to use one.')] : []),
      ...feature.workflows.map((w) =>
        Box({
          key: 'wf-' + w.id,
          flexDirection: 'row',
          columnGap: 1,
          children: [
            key('run-wf-' + w.id, '▶ run', undefined, async () => {
              const result = await runWorkflow(io, feature, w)
              io.ui.toast(firstLine(result.text) || 'Workflow finished.', { timeoutMs: 8000 })
            }),
            key('del-wf-' + w.id, '×', undefined, () =>
              mutateFeature(io, feature.id, (f) => {
                f.workflows = f.workflows.filter((x) => x.id !== w.id)
              }), { dimColor: true }),
            Text({ children: [w.name], bold: true }),
            Text({ children: [w.kind], color: 'suggestion' }),
            Text({ children: [w.target], wrap: 'truncate-end' }),
          ],
        }),
      ),
      Input({
        key: 'new-workflow',
        label: 'Add',
        placeholder: 'name script|skill target   e.g. tests script npm test',
        value: '',
        submitLabel: 'add',
        onSubmit: act(async (value) => {
          const [name, kindAndTarget] = splitFirst(value.trim())
          const [kind, target] = splitFirst(kindAndTarget)
          if (!name || !WORKFLOW_KINDS.includes(kind) || !target) throw new Error('use: <name> script|skill <target>')
          await mutateFeature(io, feature.id, (f) => f.workflows.push({ id: newId('w'), name, kind, target, description: '' }))
        }),
      }),
      ...footer('b back · s start · r runner · o approach · p approve plan · i interrupt · x stop · m more · u focus prompts · a archive · Esc close'),
    )
  }
  return rows
}
