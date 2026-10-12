import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fakeWeb } from './fake-web'

const ITEM = { key: 'TRK-1', name: 'Checkout redesign', body: 'New cart flow', state: { name: 'In Progress' }, link: 'https://t/1' }

// In-memory file system, process and MCP server beneath the plugin.
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
  on('process.run', async (_$, e) => {
    const argv = e.argv as readonly string[]
    if (argv[0] === 'sh') return value({ exitCode: 0, stdout: 'ran: ' + argv[2], stderr: '' })
    return value({ exitCode: 0, stdout: '', stderr: '' })
  })
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'get_item' && (e.args as { key?: string }).key === 'TRK-1') {
      return value({ isError: false, content: [{ type: 'text', text: JSON.stringify(ITEM) }] })
    }
    return value({ isError: true, content: [{ type: 'text', text: 'not found' }] })
  })
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(String((e as unknown as { text?: string }).text ?? ''))
    return value(undefined)
  })
  on('ui.status', async () => value(undefined))
  on('ui.log', async () => value(undefined))
  on('ui.open', async () => value({ isPlaced: true }))
  return { toasts }
}

test('context providers resolve files, shell commands and MCP tools into the prompt', async ($, on) => {
  const files: Record<string, string> = {}
  fakeWorld(on, files)
  let seen: readonly string[] = []
  on('prompt.submit', async (_$, e) => {
    seen = e.context ?? []
    return { text: e.text }
  })

  await $.command.run({ command: 'feature', args: 'new Checkout redesign' } as never)
  await $.command.run({ command: 'ctx', args: 'add command git log --format="%h %s" -1' } as never)
  await $.command.run({ command: 'ctx', args: 'add mcp tracker get_item {"key":"TRK-1"}' } as never)
  await $.command.run({ command: 'ctx', args: 'add note Ship behind the checkout-v2 flag' } as never)
  const bad = await $.command.run({ command: 'ctx', args: 'add mcp tracker get_item {not json' } as never)
  expect(bad.text).toContain('Usage')

  await $.prompt.submit({ text: 'hi', wait: true, origin: { kind: 'composer' } } as never)
  const joined = seen.join('\n')
  expect(joined).toContain('ran: git log --format="%h %s" -1')
  expect(joined).toContain('New cart flow')
  expect(joined).toContain('Ship behind the checkout-v2 flag')
})

test('an agent runs in Workbench Web: start, a question answered from the CLI, the finish', async ($, on) => {
  const files: Record<string, string> = {}
  const { toasts } = fakeWorld(on, files)
  const clock = mock.clock(on)
  const web = fakeWeb(on, files)
  // The session starts: the mod begins polling the server on a timer. The test
  // stands for the engine beneath it.
  on('session.start', async (_$, e) => e as never)
  on('command.register', async () => ({ value: undefined }) as never)
  await $.session.start({ source: 'startup', cwd: '/project' } as never)

  await $.command.run({ command: 'feature', args: 'new Checkout redesign' } as never)
  await $.command.run({ command: 'feature', args: 'describe New cart flow' } as never)
  const started = await $.command.run({ command: 'feature', args: 'start' } as never)
  expect(started.text).toContain('Started an agent on "Checkout redesign"')
  expect(started.text).toContain('#/f/checkout-redesign')
  expect(web.calls.some((c) => c.method === 'POST' && c.path === '/api/features/checkout-redesign/start')).toBe(true)

  // Starting again is refused: the conversation already exists.
  const again = await $.command.run({ command: 'feature', args: 'start checkout-redesign' } as never)
  expect(again.text).toContain('already')

  // The agent asks; the next poll tells the user.
  web.askQuestion('checkout-redesign', 'Which table?', ['orders', 'carts'])
  await clock.advance(1500)
  expect(toasts.at(-1)).toContain('Checkout redesign needs you: Which table?')
  const status = await $.command.run({ command: 'feature', args: 'status' } as never)
  expect(status.text).toContain('needs you')
  expect(status.text).toContain('Which table?')

  // Answered from the command line: it goes to that question.
  const answered = await $.command.run({ command: 'feature', args: 'answer checkout-redesign carts' } as never)
  expect(answered.text).toContain('Sent to "Checkout redesign"')
  const call = web.calls.at(-2)
  expect(call?.path).toMatch(/\/api\/features\/checkout-redesign\/answer\/p\d+/)
  expect(call?.body).toEqual({ answers: { 'Which table?': 'carts' } })

  // It finishes its turn; the user hears about it.
  web.say('checkout-redesign', 'Added the carts migration.')
  web.finish('checkout-redesign')
  await clock.advance(1500)
  expect(toasts.at(-1)).toContain('Checkout redesign: finished its turn')
  const done = await $.command.run({ command: 'feature', args: 'status' } as never)
  expect(done.text).toContain('your turn')
})

test('a tool permission is allowed with yes, or denied with the reply as the reason', async ($, on) => {
  const files: Record<string, string> = {}
  fakeWorld(on, files)
  const web = fakeWeb(on, files)
  await $.command.run({ command: 'feature', args: 'new Search' } as never)
  await $.command.run({ command: 'feature', args: 'say search Index the products table' } as never)

  web.askTool('search', 'Bash', { command: 'rm -rf build' })
  await $.command.run({ command: 'feature', args: 'status' } as never)
  await $.command.run({ command: 'feature', args: 'answer search use git clean instead' } as never)
  expect(web.calls.at(-2)?.body).toEqual({ allow: false, message: 'use git clean instead' })

  web.askTool('search', 'Bash', { command: 'npm test' })
  await $.command.run({ command: 'feature', args: 'status' } as never)
  await $.command.run({ command: 'feature', args: 'answer search yes' } as never)
  expect(web.calls.at(-2)?.body).toEqual({ allow: true })
})

test('interrupt, stop and reset go to the server; no server means a clear error', async ($, on) => {
  const files: Record<string, string> = {}
  fakeWorld(on, files)
  const web = fakeWeb(on, files)
  await $.command.run({ command: 'feature', args: 'new Search' } as never)
  await $.command.run({ command: 'feature', args: 'say search go' } as never)
  for (const sub of ['interrupt', 'stop', 'reset'] as const) {
    const r = await $.command.run({ command: 'feature', args: sub + ' search' } as never)
    expect(r.text).toContain('"Search":')
    expect(web.calls.some((c) => c.path === '/api/features/search/' + sub)).toBe(true)
  }
  expect(web.sessions['search']?.sessionId).toBeNull()

  // With no server running and none installed, starting says what is missing.
  web.down()
  const r = await $.command.run({ command: 'feature', args: 'start search' } as never)
  expect(r.text).toContain('Could not start')
  expect(r.text).toContain('Workbench Web not found')
})
