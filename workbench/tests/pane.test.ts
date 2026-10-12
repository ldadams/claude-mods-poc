import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fakeWeb } from './fake-web'

// In-memory world beneath the plugin, with Workbench Web faked behind $.http.fetch.
function fakeWorld(on: On, files: Record<string, string>) {
  mock.store(on)
  const value = <T,>(v: T) => ({ value: v }) as never
  const rel = (p: string) => p.replace(/^.*?\/(?=\.claude(\/|$))/, '')
  on('fs.exists', async (_$, e) =>
    value(rel(e.path) in files || Object.keys(files).some((p) => p.startsWith(rel(e.path) + '/'))),
  )
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
  // The kit has no surface beneath these; the test is their bottom.
  on('ui.open', async () => value({ isPlaced: true }))
  on('ui.status', async () => value(undefined))
  on('ui.toast', async () => value(undefined))
  on('ui.log', async () => value(undefined))
  return fakeWeb(on, files)
}

const PANE = {
  plugin: 'workbench',
  component: 'Pane',
  requestId: 'workbench',
  props: { title: 'Workbench', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

test('the pane shows the shared session: the one needing you first, its question, the conversation, a reply', async ($, on) => {
  const files: Record<string, string> = {}
  const web = fakeWorld(on, files)
  await $.command.run({ command: 'feature', args: 'new Faster search' } as never)
  await $.command.run({ command: 'feature', args: 'new Checkout redesign' } as never)
  await $.command.run({ command: 'ctx', args: 'add note Ship behind the checkout-v2 flag' } as never)
  await $.command.run({ command: 'workflow', args: 'add tests script npm test' } as never)
  // Started from the browser, say: the pane sees the same session.
  await $.command.run({ command: 'feature', args: 'say faster-search Speed up product search' } as never)
  web.tool('faster-search', 'Read', { file_path: 'src/search/index.ts' }, 'export function search() {}')

  for (const surface of ['terminal', 'desktop'] as const) {
    web.askQuestion('faster-search', 'Which index?', ['btree', 'gin'])
    await $.command.run({ command: 'workbench', args: '' } as never)
    const ui = await $.ui.mount({ ...PANE, surface })

    // Home: a header that counts what needs you, rows with the waiting one first.
    expect(await ui.find({ type: 'Text', text: /1 needs your answer/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /web ✓/ })).toBeDefined()
    const rows = await ui.findAll({ type: 'Button', text: /Faster search|Checkout redesign/ })
    expect(rows.length).toBe(2)
    expect(rows[0]?.text).toContain('Faster search')
    expect(await ui.find({ type: 'Text', text: /needs you.*Which index\?/ })).toBeDefined()

    // Open it: the question card and the conversation so far.
    await ui.press({ key: 'open-faster-search' } as never)
    expect(await ui.find({ type: 'Text', text: 'Claude has a question' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Which index?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Speed up product search' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/search/index.ts' })).toBeDefined()

    // Pick an option: the answer goes to that question in Workbench Web.
    const p = web.sessions['faster-search']?.pending[0]?.id ?? ''
    await ui.press({ key: 'opt-' + p + '-0-1' } as never)
    const answer = web.calls.find((c) => c.path === '/api/features/faster-search/answer/' + p)
    expect(answer?.body).toEqual({ answers: { 'Which index?': 'gin' } })
    expect(await ui.find({ type: 'Text', text: 'Claude has a question' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /working/ })).toBeDefined()

    // A follow-up from the pane is the next message of the same session.
    await ui.input({ key: 'message', text: 'Also cover the admin search' } as never)
    expect(web.calls.filter((c) => c.path === '/api/features/faster-search/message').at(-1)?.body).toEqual({ text: 'Also cover the admin search' })
    expect(await ui.find({ type: 'Text', text: 'Also cover the admin search' })).toBeDefined()

    // The permission mode is the session's, changed from here.
    await ui.select({ key: 'mode', value: 'acceptEdits' } as never)
    expect(web.sessions['faster-search']?.mode).toBe('acceptEdits')

    // Back home, then into the other feature: no session yet, its context and workflows.
    await ui.press({ key: 'back' } as never)
    await ui.press({ key: 'open-checkout-redesign' } as never)
    expect(await ui.find({ type: 'Button', key: 'start' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Ship behind the checkout-v2 flag' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'npm test' })).toBeDefined()
    await ui.select({ key: 'ctx-type', value: 'command' } as never)
    await ui.input({ key: 'ctx-value', text: 'git status --short ' + surface } as never)
    expect(await ui.find({ type: 'Text', text: 'git status --short ' + surface })).toBeDefined()

    await ui.unmount()
  }
})

test('a tool permission card allows, always-allows, or denies with a reason', async ($, on) => {
  const files: Record<string, string> = {}
  const web = fakeWorld(on, files)
  await $.command.run({ command: 'feature', args: 'new Search' } as never)
  await $.command.run({ command: 'feature', args: 'say search go' } as never)
  const p1 = web.askTool('search', 'Bash', { command: 'npm test' })
  await $.command.run({ command: 'workbench', args: 'search' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Allow Bash?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'npm test' })).toBeDefined()
  await ui.press({ key: 'always-' + p1 } as never)
  expect(web.calls.at(-2)?.body).toEqual({ allow: true, always: true })

  const p2 = web.askTool('search', 'Write', { file_path: '/etc/hosts' }, false)
  await $.command.run({ command: 'workbench', args: 'search' } as never)
  expect(await ui.find({ type: 'Button', key: 'always-' + p2 })).toBeUndefined()
  await ui.input({ key: 'deny-reason-' + p2, text: 'never touch /etc' } as never)
  expect(web.calls.at(-2)?.body).toEqual({ allow: false, message: 'never touch /etc' })
  expect(await ui.find({ type: 'Text', text: 'Allow Write?' })).toBeUndefined()
  await ui.unmount()
})

test('with Workbench Web down, the feature view says so and nothing pretends to run', async ($, on) => {
  const files: Record<string, string> = {}
  const web = fakeWorld(on, files)
  web.down()
  await $.command.run({ command: 'feature', args: 'new Search' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Workbench Web is not running' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'web off' })).toBeDefined()
  await ui.unmount()
})

test('a multi-select question collects picks, toggles them, and sends them together', async ($, on) => {
  const files: Record<string, string> = {}
  const web = fakeWorld(on, files)
  await $.command.run({ command: 'feature', args: 'new Search' } as never)
  await $.command.run({ command: 'feature', args: 'say search go' } as never)
  const p = web.askQuestion('search', 'Which indexes?', ['btree', 'gin', 'hash'], { multiSelect: true })
  await $.command.run({ command: 'workbench', args: 'search' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Picks toggle and nothing is sent until "send answer".
  await ui.press({ key: 'opt-' + p + '-0-0' } as never)
  await ui.press({ key: 'opt-' + p + '-0-2' } as never)
  await ui.press({ key: 'opt-' + p + '-0-0' } as never)
  await ui.press({ key: 'opt-' + p + '-0-1' } as never)
  expect(web.calls.some((c) => c.path.includes('/answer/'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: '◉ hash' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '○ btree' })).toBeDefined()

  await ui.press({ key: 'send-picks-' + p } as never)
  expect(web.calls.find((c) => c.path === '/api/features/search/answer/' + p)?.body).toEqual({ answers: { 'Which indexes?': 'hash, gin' } })
  await ui.unmount()
})

test('plan first: an experience starts its features planning; the plan card approves and builds', async ($, on) => {
  const files: Record<string, string> = {}
  const web = fakeWorld(on, files)
  await $.command.run({ command: 'experience', args: 'new Checkout' } as never)
  await $.command.run({ command: 'feature', args: 'new Cart redesign' } as never)
  await $.command.run({ command: 'experience', args: 'add checkout cart-redesign' } as never)
  const on1 = await $.command.run({ command: 'experience', args: 'planfirst checkout on' } as never)
  expect(on1.text).toContain('start by planning')
  expect(JSON.parse(files['.claude/experiences/checkout.json'] ?? '{}').planFirst).toBe(true)

  // Starting it opens the session in plan mode.
  await $.command.run({ command: 'feature', args: 'say cart-redesign Rework the cart' } as never)
  expect(web.sessions['cart-redesign']?.mode).toBe('plan')
  expect(web.sessions['cart-redesign']?.phase).toBe('planning')

  // Claude presents the plan: the pane shows it as its own card, and p approves it.
  const p = web.presentPlan('cart-redesign', '1. Split Cart.tsx\n2. Add tests')
  await $.command.run({ command: 'workbench', args: 'cart-redesign' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: "Claude's plan" })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'planning' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'allow-' + p })).toBeUndefined()
  await ui.press({ key: 'approve-plan' } as never)
  expect(web.calls.some((c) => c.path === '/api/features/cart-redesign/approve-plan')).toBe(true)
  expect(web.sessions['cart-redesign']?.mode).toBe('default')
  expect(await ui.find({ type: 'Text', text: 'building' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: "Claude's plan" })).toBeUndefined()
  await ui.unmount()
})

test('keep planning sends the plan back with feedback; approve works without a plan card too', async ($, on) => {
  const files: Record<string, string> = { '.claude/workbench.json': JSON.stringify({ planFirst: true }) }
  const web = fakeWorld(on, files)
  await $.command.run({ command: 'feature', args: 'new Search' } as never)
  await $.command.run({ command: 'feature', args: 'say search go' } as never)
  expect(web.sessions['search']?.phase).toBe('planning')

  const p = web.presentPlan('search', 'Rewrite everything')
  await $.command.run({ command: 'workbench', args: 'search' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'keep-planning-' + p, text: 'smaller steps please' } as never)
  expect(web.calls.find((c) => c.path === '/api/features/search/answer/' + p)?.body).toEqual({ allow: false, message: 'smaller steps please' })
  expect(web.sessions['search']?.phase).toBe('planning')

  // No plan card waiting: the action bar offers approve plan, as does /feature approve.
  expect(await ui.find({ type: 'Button', key: 'approve-plan' })).toBeDefined()
  await ui.unmount()
  const r = await $.command.run({ command: 'feature', args: 'approve search keep it small' } as never)
  expect(r.text).toContain('Approved the plan for "Search"')
  expect(web.calls.find((c) => c.path === '/api/features/search/approve-plan')?.body).toEqual({ note: 'keep it small' })
  expect(web.sessions['search']?.phase).toBe('building')

  // Approving again is refused: nothing is planning.
  const again = await $.command.run({ command: 'feature', args: 'approve search' } as never)
  expect(again.text).toContain('Could not approve')
})
