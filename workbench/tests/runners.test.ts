import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fakeWeb } from './fake-web'

// In-memory world with both runners beneath the plugin: Workbench Web faked behind
// $.http.fetch, and this session's subagents faked behind agent.spawn / session.send.
function fakeWorld(on: On, files: Record<string, string>) {
  mock.store(on)
  const value = <T,>(v: T) => ({ value: v }) as never
  const rel = (p: string) => p.replace(/^.*?\/(?=\.claude(\/|$))/, '')
  const spawns: { prompt: string; description: string }[] = []
  const sends: { to: unknown; text: string }[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  on('fs.exists', async (_$, e) => value(rel(e.path) in files || Object.keys(files).some((p) => p.startsWith(rel(e.path) + '/'))))
  on('fs.read', async (_$, e) => {
    if (!(rel(e.path) in files)) throw new Error('ENOENT ' + rel(e.path))
    return value(files[rel(e.path)])
  })
  on('fs.write', async (_$, e) => {
    files[rel(e.path)] = e.text
    return value(undefined)
  })
  on('fs.list', async (_$, e) =>
    value(
      Object.keys(files)
        .filter((p) => p.startsWith(rel(e.path) + '/'))
        .map((p) => ({ name: p.slice(rel(e.path).length + 1), kind: 'file' })),
    ),
  )
  on('process.run', async () => value({ exitCode: 0, stdout: '', stderr: '' }))
  on('ui.open', async () => value({ isPlaced: true }))
  on('ui.log', async () => value(undefined))
  on('ui.status', async (_$, e) => {
    statuses.push((e as unknown as { text?: string }).text)
    return value(undefined)
  })
  on('ui.toast', async (_$, e) => {
    toasts.push(String((e as unknown as { text?: string }).text ?? ''))
    return value(undefined)
  })
  on('agent.spawn', async (_$, e) => {
    spawns.push({ prompt: e.prompt, description: e.description ?? '' })
    return { model: 'test-model' } as never
  })
  on('session.send', async (_$, e) => {
    sends.push({ to: e.to, text: e.text })
    return { isDelivered: true } as never
  })
  // The kit has no engine beneath turn.complete; the test is its bottom.
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  // Tools an agent uses run beneath the plugin; here they just say they ran.
  on('tool.call', async (_$, e) => ({ result: 'ran ' + e.tool }) as never)
  return { web: fakeWeb(on, files), spawns, sends, toasts, statuses }
}

const PANE = {
  plugin: 'workbench',
  component: 'Pane',
  requestId: 'workbench',
  surface: 'terminal',
  props: { title: 'Workbench', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

test('one observer across both runners: an in-session agent and a Workbench Web session side by side', async ($, on) => {
  const files: Record<string, string> = {}
  const { web, spawns, sends, toasts, statuses } = fakeWorld(on, files)
  await $.command.run({ command: 'feature', args: 'new Search' } as never)
  await $.command.run({ command: 'feature', args: 'describe search Faster product search' } as never)
  await $.command.run({ command: 'feature', args: 'new Cart' } as never)

  // Search runs in this session; Cart on Workbench Web (the default).
  const set = await $.command.run({ command: 'feature', args: 'runner search session' } as never)
  expect(set.text).toContain('inside this Claude Code session')
  await $.command.run({ command: 'feature', args: 'start search' } as never)
  expect(spawns.length).toBe(1)
  expect(spawns[0]?.prompt).toContain('Faster product search')
  expect(spawns[0]?.prompt).toContain('mcp__workbench__ask_user')
  await $.command.run({ command: 'feature', args: 'say cart Rework the cart' } as never)
  expect(web.sessions['cart']?.live).toBe(true)
  expect(web.sessions['search']?.sessionId ?? null).toBeNull()

  // Both ask: the in-session one through the engine's tool.call, the other through the server.
  const asked = await $.tool.call({ tool: 'mcp__workbench__ask_user', feature: 'search', question: 'Which index?', agentId: 'agent-1' } as never)
  expect(JSON.stringify(asked)).toContain('End your turn')
  expect(toasts.at(-1)).toContain('Search needs you: Which index?')
  web.askQuestion('cart', 'Which table?')
  const status = await $.command.run({ command: 'feature', args: 'status' } as never)
  expect(status.text).toMatch(/Search \(search\): needs you · in session/)
  expect(status.text).toMatch(/Cart \(cart\): needs you · Workbench Web/)
  expect(statuses.at(-1)).toContain('2 need your answer')

  // One pane over both: the count, a runner tag per row, n through both.
  await $.command.run({ command: 'workbench', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /2 need your answer/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '· in session' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '· web' })).toBeDefined()
  await ui.press({ key: 'next-waiting' } as never)
  expect(await ui.find({ type: 'Text', text: 'Which index?' })).toBeDefined()

  // Answering the in-session one resumes that subagent.
  await ui.input({ key: 'other-ask-0', text: 'the btree one' } as never)
  expect(sends.at(-1)).toEqual({ to: 'agent-1', text: 'the btree one' })
  // The card is gone; the question stays in the conversation.
  expect(await ui.find({ type: 'Text', text: 'Claude has a question' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '↳ the btree one' })).toBeDefined()
  expect(await ui.find({ type: 'Select', key: 'mode' })).toBeUndefined()

  // The other is answered on its own runner.
  await ui.press({ key: 'next-waiting' } as never)
  expect(await ui.find({ type: 'Text', text: 'Which table?' })).toBeDefined()
  const p = web.sessions['cart']?.pending[0]?.id ?? ''
  await ui.input({ key: 'other-' + p + '-0', text: 'orders' } as never)
  expect(web.calls.find((c) => c.path === '/api/features/cart/answer/' + p)?.body).toEqual({ answers: { 'Which table?': 'orders' } })
  await ui.unmount()

  // The in-session agent finishes: the engine's turn.complete tells the observer.
  await $.turn.complete({ agentId: 'agent-1', reason: 'answer', answer: 'Added a btree index on products.name.' } as never)
  expect(toasts.some((t) => t.includes('Search: finished its turn'))).toBe(true)
  const after = await $.command.run({ command: 'feature', args: 'status' } as never)
  expect(after.text).toMatch(/Search \(search\): your turn · in session/)
})

test('an in-session agent needs no server; web-only actions say so', async ($, on) => {
  const files: Record<string, string> = { '.claude/workbench.json': JSON.stringify({ runner: 'session' }) }
  const { web, spawns, sends } = fakeWorld(on, files)
  web.down()
  await $.command.run({ command: 'feature', args: 'new Docs' } as never)
  await $.command.run({ command: 'feature', args: 'describe Write the hooks diagram' } as never)

  // The project default sends it to this session, server or not.
  const started = await $.command.run({ command: 'feature', args: 'start docs' } as never)
  expect(started.text).toContain('Started an agent on "Docs"')
  expect(spawns.length).toBe(1)

  await $.command.run({ command: 'workbench', args: 'docs' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: 'Workbench Web is not running' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'in session' })).toBeDefined()
  await ui.unmount()

  // Plan approval and permission modes are Workbench Web's.
  const approve = await $.command.run({ command: 'feature', args: 'approve docs' } as never)
  expect(approve.text).toContain('in-session agents have no plan phase')

  // Once it has reported in, interrupt asks it to stop; reset forgets it so it can start again.
  await $.tool.call({ tool: 'mcp__workbench__ask_user', feature: 'docs', question: 'Which format?', agentId: 'agent-9' } as never)
  await $.command.run({ command: 'feature', args: 'interrupt docs' } as never)
  expect(sends.at(-1)?.text).toContain('Stop what you are doing')
  await $.command.run({ command: 'feature', args: 'reset docs' } as never)
  const again = await $.command.run({ command: 'feature', args: 'start docs' } as never)
  expect(again.text).toContain('Started an agent on "Docs"')
  expect(spawns.length).toBe(2)
})

test('experience runner: its features follow it unless they say otherwise', async ($, on) => {
  const files: Record<string, string> = {}
  const { spawns, web } = fakeWorld(on, files)
  await $.command.run({ command: 'experience', args: 'new Garage' } as never)
  await $.command.run({ command: 'feature', args: 'new Landing polish' } as never)
  await $.command.run({ command: 'feature', args: 'new Hooks doc' } as never)
  await $.command.run({ command: 'experience', args: 'add garage landing-polish' } as never)
  await $.command.run({ command: 'experience', args: 'add garage hooks-doc' } as never)
  const r = await $.command.run({ command: 'experience', args: 'runner garage session' } as never)
  expect(r.text).toContain('inside this Claude Code session')
  await $.command.run({ command: 'feature', args: 'runner hooks-doc web' } as never)

  await $.command.run({ command: 'feature', args: 'say landing-polish go' } as never)
  await $.command.run({ command: 'feature', args: 'say hooks-doc go' } as never)
  expect(spawns.map((s) => s.description)).toEqual(['feature: Landing polish'])
  expect(web.sessions['hooks-doc']?.live).toBe(true)
})

test('decisions for in-session agents: a broken standard is denied when on, only recorded in shadow', async ($, on) => {
  const files: Record<string, string> = {}
  const { web, spawns } = fakeWorld(on, files)
  await $.command.run({ command: 'feature', args: 'new Docs' } as never)
  await $.command.run({ command: 'feature', args: 'runner docs session' } as never)
  await $.command.run({ command: 'feature', args: 'say docs Write the hooks page' } as never)
  expect(spawns.length).toBe(1)
  // The agent reports in, so its id is known.
  await $.tool.call({ tool: 'mcp__workbench__ask_user', feature: 'docs', question: 'Go?', agentId: 'agent-7' } as never)
  await $.command.run({ command: 'feature', args: 'answer docs yes' } as never)

  const deny = () => ({ decision: 'deny', by: 'rule', standard: 'no-force-push', confidence: 1, reason: 'Push a new commit instead.' })
  web.setDecisions('shadow', { tool: deny })
  await $.command.run({ command: 'feature', args: 'status' } as never)
  const shadow = await $.tool.call({ tool: 'Bash', command: 'git push -f', agentId: 'agent-7' } as never)
  expect(JSON.stringify(shadow)).not.toContain('Code standard')
  expect(web.calls.find((c) => c.path === '/api/decide')?.body).toMatchObject({ kind: 'tool', featureId: 'docs', toolName: 'Bash', input: { command: 'git push -f' } })

  web.setDecisions('on', { tool: deny })
  await $.command.run({ command: 'feature', args: 'status' } as never)
  const denied = await $.tool.call({ tool: 'Bash', command: 'git push -f', agentId: 'agent-7' } as never)
  expect(JSON.stringify(denied)).toContain('Code standard (no-force-push): Push a new commit instead.')

  // Both show in the agent's conversation, the shadow one marked as such.
  await $.command.run({ command: 'workbench', args: 'docs' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /◆ Laya · tool Bash · deny · no-force-push \(shadow\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◆ Laya · tool Bash · deny · no-force-push: Push a new commit/ })).toBeDefined()
  await ui.unmount()

  // Another agent's tool calls, or reads, are never sent to be judged.
  const before = web.calls.filter((c) => c.path === '/api/decide').length
  await $.tool.call({ tool: 'Bash', command: 'git push -f', agentId: 'someone-else' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'a.md', agentId: 'agent-7' } as never)
  expect(web.calls.filter((c) => c.path === '/api/decide').length).toBe(before)
})

test('decisions at turn end: an unsupported claim gets one follow-up instead of a ping', async ($, on) => {
  const files: Record<string, string> = {}
  const { web, sends } = fakeWorld(on, files)
  await $.command.run({ command: 'feature', args: 'new Docs' } as never)
  await $.command.run({ command: 'feature', args: 'runner docs session' } as never)
  await $.command.run({ command: 'feature', args: 'say docs go' } as never)
  await $.tool.call({ tool: 'mcp__workbench__ask_user', feature: 'docs', question: 'Go?', agentId: 'agent-7' } as never)
  await $.command.run({ command: 'feature', args: 'answer docs yes' } as never)
  web.setDecisions('on', {
    turn: (body: any) => ({ issues: [{ id: 'unverified-claim', p: 0.95 }], followUp: 'You said tests passed, but none ran. Run them.', tools: body.tools }),
  })
  await $.command.run({ command: 'feature', args: 'status' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'a.md', old_string: 'a', new_string: 'b', agentId: 'agent-7' } as never)
  await $.turn.complete({ agentId: 'agent-7', reason: 'answer', answer: 'Done. All tests pass.' } as never)
  // The judge saw what the turn did, and the agent got the follow-up.
  expect(web.calls.filter((c) => c.path === '/api/decide').at(-1)?.body).toMatchObject({ kind: 'turn', featureId: 'docs', summary: 'Done. All tests pass.', tools: [{ name: 'Edit' }] })
  expect(sends.at(-1)?.text).toBe('You said tests passed, but none ran. Run them.')
  const status = await $.command.run({ command: 'feature', args: 'status' } as never)
  expect(status.text).toMatch(/Docs \(docs\): working · in session/)
})

test('decisions in the pane: a plan card shows its checks; an unstarted feature shows the suggested approach', async ($, on) => {
  const files: Record<string, string> = {}
  const { web } = fakeWorld(on, files)
  web.setDecisions('shadow', { approach: () => ({ recommended: 'plan', confidence: 0.82, reasons: ['changes an API, data format or schema'] }) })
  await $.command.run({ command: 'feature', args: 'new Orders API' } as never)
  await $.command.run({ command: 'feature', args: 'new Search' } as never)
  await $.command.run({ command: 'feature', args: 'say search go' } as never)
  await $.command.run({ command: 'feature', args: 'assess orders-api' } as never).catch(() => {})
  web.sessions['orders-api']!.assessment = { recommended: 'plan', confidence: 0.82, reasons: ['changes an API, data format or schema'] }
  web.setDecisions('shadow', {})

  await $.command.run({ command: 'workbench', args: 'orders-api' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Laya suggests planning first \(82%\): changes an API/ })).toBeDefined()
  await ui.press({ key: 'approach' } as never)
  expect(JSON.parse(files['.claude/features/orders-api.json'] ?? '{}').approach).toBe('plan')
  await ui.press({ key: 'approach' } as never)
  expect(JSON.parse(files['.claude/features/orders-api.json'] ?? '{}').approach).toBe('direct')
  await ui.press({ key: 'approach' } as never)
  expect(JSON.parse(files['.claude/features/orders-api.json'] ?? '{}').approach).toBeUndefined()
  await ui.unmount()

  const p = web.presentPlan('search', '1. Rewrite search')
  web.reviewPlan('search', p, { revise: true, checks: [{ id: 'verifies', label: 'says how the work will be verified', status: 'fail', p: 0.05 }, { id: 'scoped', label: 'stays within the feature', status: 'pass', p: 0.95 }] })
  await $.command.run({ command: 'workbench', args: 'search' } as never)
  const ui2 = await $.ui.mount(PANE)
  expect(await ui2.find({ type: 'Text', text: 'Laya: some checks failed' })).toBeDefined()
  expect(await ui2.find({ type: 'Text', text: '✗ says how the work will be verified' })).toBeDefined()
  expect(await ui2.find({ type: 'Text', text: '✓ stays within the feature' })).toBeDefined()
  await ui2.unmount()

  const r = await $.command.run({ command: 'feature', args: 'approach orders-api plan' } as never)
  expect(r.text).toContain('starts planning first')
})
