import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fakeWeb } from './fake-web'

// In-memory world beneath the plugin, with Workbench Web faked behind $.http.fetch.
function fakeWorld(on: On, files: Record<string, string>) {
  mock.store(on)
  const value = <T,>(v: T) => ({ value: v }) as never
  const rel = (p: string) => p.replace(/^.*?\/(?=\.claude(\/|$))/, '')
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
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
    // `rm -f <path>` is how the mod deletes; mirror it in memory.
    const argv = (e as unknown as { argv?: string[]; command?: string[] }).argv ?? (e as unknown as { command?: string[] }).command
    if (Array.isArray(argv) && argv[0] === 'rm') delete files[rel(String(argv.at(-1)))]
    return value({ exitCode: 0, stdout: '', stderr: '' })
  })
  on('ui.open', async () => value({ isPlaced: true }))
  on('ui.status', async (_$, e) => {
    statuses.push((e as unknown as { text?: string }).text)
    return value(undefined)
  })
  on('ui.toast', async (_$, e) => {
    toasts.push(String((e as unknown as { text?: string }).text ?? ''))
    return value(undefined)
  })
  on('ui.log', async () => value(undefined))
  const web = fakeWeb(on, files)
  return { web, statuses, toasts }
}

const PANE = {
  plugin: 'workbench',
  component: 'Pane',
  requestId: 'workbench',
  surface: 'terminal',
  props: { title: 'Workbench', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

test('a feature without a description is flagged, can be described from the pane, and then starts', async ($, on) => {
  const files: Record<string, string> = {}
  fakeWorld(on, files)
  await $.command.run({ command: 'feature', args: 'new GraphQL service' } as never)

  const ui = await $.ui.mount(PANE)
  // The feature view opened on creation, asks for a description, and refuses to start without one.
  expect(await ui.find({ type: 'Text', text: /No description yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Input', key: 'feature-desc' })).toBeDefined()

  await ui.input({ key: 'feature-desc', text: 'Expose features over GraphQL' } as never)
  expect(JSON.parse(files['.claude/features/graphql-service.json'] ?? '{}').description).toBe('Expose features over GraphQL')
  expect(await ui.find({ type: 'Text', text: 'Expose features over GraphQL' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No description yet/ })).toBeUndefined()

  await ui.press({ key: 'start' } as never)
  expect(await ui.find({ type: 'Text', text: /working/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'start' })).toBeUndefined()
  await ui.unmount()
})

test('/feature describe sets the description; start-all names the features it skipped', async ($, on) => {
  const files: Record<string, string> = {}
  const { toasts } = fakeWorld(on, files)
  await $.command.run({ command: 'feature', args: 'new Alpha' } as never)
  await $.command.run({ command: 'feature', args: 'new Beta' } as never)

  // With an explicit id, and for the active feature.
  const r1 = await $.command.run({ command: 'feature', args: 'describe alpha Build the alpha thing' } as never)
  expect(r1.text).toContain('Described "Alpha"')
  expect(JSON.parse(files['.claude/features/alpha.json'] ?? '{}').description).toBe('Build the alpha thing')
  await $.command.run({ command: 'feature', args: 'switch beta' } as never)

  // Home's start-all starts Alpha and is quiet; a second press names Beta.
  await $.command.run({ command: 'workbench', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: 'needs a description' })).toBeDefined()
  await ui.press({ key: 'start-all' } as never)
  await ui.press({ key: 'start-all' } as never)
  expect(toasts.at(-1)).toContain('Beta needs a description or context first')
  await ui.unmount()

  const r2 = await $.command.run({ command: 'feature', args: 'describe Ship the beta' } as never)
  expect(r2.text).toContain('Described "Beta"')
  expect(JSON.parse(files['.claude/features/beta.json'] ?? '{}').description).toBe('Ship the beta')
})

test('stopping and resetting a session from the pane take a confirming press', async ($, on) => {
  const files: Record<string, string> = {}
  const { web } = fakeWorld(on, files)
  await $.command.run({ command: 'feature', args: 'new Search' } as never)
  await $.command.run({ command: 'feature', args: 'describe search Faster search' } as never)
  await $.command.run({ command: 'feature', args: 'start search' } as never)
  web.askQuestion('search', 'Which index?')

  await $.command.run({ command: 'workbench', args: 'search' } as never)
  const ui = await $.ui.mount(PANE)
  // First press only arms it.
  await ui.press({ key: 'stop' } as never)
  expect(await ui.find({ type: 'Text', text: 'press again to stop session' })).toBeDefined()
  expect(web.calls.some((c) => c.path === '/api/features/search/stop')).toBe(false)
  // Second press stops it; the question goes with it and it can be resumed.
  await ui.press({ key: 'stop' } as never)
  expect(web.calls.some((c) => c.path === '/api/features/search/stop')).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'Claude has a question' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^paused/ })).toBeDefined()

  // Reset forgets the conversation, so it can start fresh.
  await ui.press({ key: 'reset-agent' } as never)
  await ui.press({ key: 'reset-agent' } as never)
  expect(web.sessions['search']?.sessionId).toBeNull()
  expect(await ui.find({ type: 'Button', key: 'start' })).toBeDefined()
  await ui.unmount()
})

test('n cycles through the features waiting on you', async ($, on) => {
  const files: Record<string, string> = {}
  const { web } = fakeWorld(on, files)
  for (const t of ['One', 'Two', 'Three']) {
    await $.command.run({ command: 'feature', args: 'new ' + t } as never)
    await $.command.run({ command: 'feature', args: 'say ' + t.toLowerCase() + ' do ' + t } as never)
  }
  web.askQuestion('two', 'Q2?')
  web.askQuestion('three', 'Q3?')

  await $.command.run({ command: 'workbench', args: '' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: 'next waiting (2)' })).toBeDefined()
  await ui.press({ key: 'next-waiting' } as never)
  expect(await ui.find({ type: 'Text', text: 'Q2?' })).toBeDefined()
  await ui.press({ key: 'next-waiting' } as never)
  expect(await ui.find({ type: 'Text', text: 'Q3?' })).toBeDefined()
  await ui.press({ key: 'next-waiting' } as never)
  expect(await ui.find({ type: 'Text', text: 'Q2?' })).toBeDefined()
  await ui.unmount()
})

test('deleting a feature from the pane takes two presses', async ($, on) => {
  const files: Record<string, string> = {}
  fakeWorld(on, files)
  await $.command.run({ command: 'feature', args: 'new Doomed' } as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'delete' } as never)
  expect(files['.claude/features/doomed.json']).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'press again to delete' })).toBeDefined()
  await ui.press({ key: 'delete' } as never)
  expect(files['.claude/features/doomed.json']).toBeUndefined()
  await ui.unmount()
})

test('the status line names the focused feature even with no agents', async ($, on) => {
  const { statuses } = fakeWorld(on, {})
  await $.command.run({ command: 'feature', args: 'new Checkout redesign' } as never)
  expect(statuses.at(-1)).toContain('▸ Checkout redesign')
  await $.command.run({ command: 'feature', args: 'delete checkout-redesign' } as never)
  expect(statuses.at(-1)).toBeUndefined()
})
