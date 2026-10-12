// What waits on the user in a feature's session: the same cards the browser shows.

import { answerPending, approvePlan } from '../lib/sessions.js'
import { pane } from '../lib/state.js'
import { toolBrief } from '../lib/status.js'
import { truncate } from '../lib/util.js'

export function askCards(io, ctx, kit, feature, pending) {
  const { Box, Text, Button, Input, Markdown } = ctx.el
  const { act, hint, key, actions, card } = kit
  const out = []
  // -- what is waiting on you: the same cards the browser shows --
  pending.forEach((p, idx) => {
    const first = idx === 0
    if (p.kind === 'question') {
      const qs = (p.input && p.input.questions) || []
      const chosen = pane.picks[p.id] || {}
      // One plain question answers on the first pick; several, or a
      // multi-select, collect picks and send them together.
      const together = qs.length > 1 || qs.some((q) => q.multiSelect)
      const sendPicks = (chosenNow) => answerPending(io, feature, p.id, { answers: Object.fromEntries(qs.map((q, qi) => [q.question, chosenNow[qi] || ''])) })
      const pick = async (qi, label) => {
        if (!label) return
        const q = qs[qi]
        const nowPicked = { ...chosen }
        if (q.multiSelect) {
          const set = new Set((nowPicked[qi] || '').split(', ').filter(Boolean))
          if (set.has(label)) set.delete(label)
          else set.add(label)
          nowPicked[qi] = [...set].join(', ')
        } else nowPicked[qi] = label
        if (!together) {
          delete pane.picks[p.id]
          return sendPicks(nowPicked)
        }
        pane.picks[p.id] = nowPicked
      }
      out.push(
        card('ask-' + p.id, [
          Text({ children: ['Claude has a question'], bold: true, color: 'permission' }),
          ...qs.flatMap((q, qi) => {
            const picked = new Set((chosen[qi] || '').split(', ').filter(Boolean))
            return [
              Text({ children: [q.question], wrap: 'wrap' }),
              ...(q.options || []).map((o, oi) =>
                Box({
                  key: 'opt-row-' + p.id + '-' + qi + '-' + oi,
                  flexDirection: 'row',
                  columnGap: 1,
                  children: [
                    Button({
                      key: 'opt-' + p.id + '-' + qi + '-' + oi,
                      ...(first && qs.length === 1 && oi < 9 ? { hotkey: String(oi + 1) } : {}),
                      plain: true,
                      onPress: act(() => pick(qi, o.label)),
                      children: [Text({ children: [(picked.has(o.label) ? '◉ ' : '○ ') + o.label], bold: picked.has(o.label) })],
                    }),
                    ...(o.description ? [hint(o.description)] : []),
                  ],
                }),
              ),
              Input({
                key: 'other-' + p.id + '-' + qi,
                placeholder: 'or type your own answer, then Enter',
                value: '',
                submitLabel: 'answer',
                ...(first && qi === 0 ? { autoFocus: true } : {}),
                onSubmit: act((value) => pick(qi, value.trim())),
              }),
            ]
          }),
          ...(together
            ? [
                key('send-picks-' + p.id, 'send answer', undefined, () => {
                  if (qs.some((q, qi) => !chosen[qi])) throw new Error('answer every question first')
                  delete pane.picks[p.id]
                  return sendPicks(chosen)
                }),
              ]
            : []),
        ], 'permission'),
      )
    } else if (p.toolName === 'ExitPlanMode') {
      // The end of a planning phase: approve it to build, or send it back with feedback.
      out.push(
        card('ask-' + p.id, [
          Text({ children: ["Claude's plan"], bold: true, color: 'permission' }),
          Markdown({ key: 'plan-' + p.id, text: truncate(String((p.input && p.input.plan) || '(no plan text)'), 6000) }),
          ...(p.review
            ? [
                hint(p.review.revise ? 'Laya: some checks failed' : 'Laya: checks passed'),
                ...p.review.checks.map((c) =>
                  Text({
                    key: 'check-' + p.id + '-' + c.id,
                    children: [({ pass: '✓', fail: '✗', unsure: '?' }[c.status] || '·') + ' ' + c.label],
                    ...(c.status === 'fail' ? { color: 'error' } : c.status === 'pass' ? { color: 'success' } : { dimColor: true }),
                    wrap: 'truncate-end',
                  }),
                ),
              ]
            : []),
          actions([key('approve-plan', 'approve plan', first ? 'p' : undefined, () => approvePlan(io, feature))]),
          Input({
            key: 'keep-planning-' + p.id,
            placeholder: 'or keep planning: what should change? then Enter',
            value: '',
            submitLabel: 'revise',
            onSubmit: act(async (value) => {
              await answerPending(io, feature, p.id, { allow: false, message: value.trim() || 'Keep planning: revise the plan before building.' })
            }),
          }),
        ], 'permission'),
      )
    } else {
      const detail = p.toolName === 'Bash' ? (p.input && p.input.command) || '' : toolBrief(p.input) || JSON.stringify(p.input || {})
      out.push(
        card('ask-' + p.id, [
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [Text({ children: ['Allow ' + p.toolName + '?'], bold: true, color: 'permission' }), ...(pending.length > 1 ? [hint(idx + 1 + ' of ' + pending.length)] : [])],
          }),
          Text({ children: [truncate(detail, 800)], wrap: 'wrap' }),
          actions([
            key('allow-' + p.id, 'allow', first ? 'y' : undefined, () => answerPending(io, feature, p.id, { allow: true })),
            p.canAlways ? key('always-' + p.id, 'always allow', first ? 'l' : undefined, () => answerPending(io, feature, p.id, { allow: true, always: true })) : null,
            key('deny-' + p.id, 'deny', first ? 'd' : undefined, () => answerPending(io, feature, p.id, { allow: false, message: '' })),
          ]),
          Input({
            key: 'deny-reason-' + p.id,
            placeholder: 'or deny with a reason or instructions, then Enter',
            value: '',
            submitLabel: 'deny',
            onSubmit: act(async (value) => {
              await answerPending(io, feature, p.id, { allow: false, message: value.trim() })
            }),
          }),
        ], 'permission'),
      )
    }
  })

  return out
}
