import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fakeWeb } from './fake-web'

// In-memory world beneath the plugin. Paths are kept whole so a test can see
// where a file was written; `rel` maps them onto the in-memory tree.
function fakeWorld(on: On, files: Record<string, string>, opts: { root?: string; web?: boolean } = {}) {
  mock.store(on)
  const value = <T,>(v: T) => ({ value: v }) as never
  const rel = (p: string) => p.replace(/^.*?\/(?=\.claude(\/|$))/, '')
  const written: string[] = []
  const runs: string[] = []
  const prompts: string[] = []
  if (opts.root) on('session.root', async () => value(opts.root))
  on('fs.exists', async (_$, e) =>
    value(rel(e.path) in files || Object.keys(files).some((p) => p.startsWith(rel(e.path) + '/'))),
  )
  on('fs.read', async (_$, e) => {
    if (!(rel(e.path) in files)) throw new Error('ENOENT ' + rel(e.path))
    return value(files[rel(e.path)])
  })
  on('fs.write', async (_$, e) => {
    written.push(e.path)
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
    if (argv[0] === 'sh') {
      runs.push(argv[2] ?? '')
      return value({ exitCode: 0, stdout: 'ran: ' + argv[2], stderr: '' })
    }
    if (argv[0] === 'rm') delete files[rel(argv[2] ?? '')]
    return value({ exitCode: 0, stdout: '', stderr: '' })
  })
  on('ui.open', async () => value({ isPlaced: true }))
  on('ui.status', async () => value(undefined))
  on('ui.toast', async () => value(undefined))
  on('prompt.submit', async (_$, e) => {
    prompts.push([e.text, ...(e.context ?? [])].join('\n'))
    return { text: e.text }
  })
  on('ui.log', async () => value(undefined))
  // Agents run in Workbench Web; a test of /workbench web brings its own.
  const web = opts.web === false ? null : fakeWeb(on, files)
  return { written, runs, prompts, web }
}

const PANE = {
  plugin: 'workbench',
  component: 'Pane',
  requestId: 'workbench',
  props: { title: 'Workbench', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

test('experiences group features and their shared context reaches every brief', async ($, on) => {
  const files: Record<string, string> = {}
  const world = fakeWorld(on, files)

  const made = await $.command.run({ command: 'experience', args: 'new Checkout' } as never)
  expect(made.text).toContain('Created experience "Checkout" (checkout)')
  await $.command.run({ command: 'experience', args: 'describe checkout Ship behind the checkout-v2 flag. Mobile first.' } as never)
  await $.command.run({ command: 'feature', args: 'new Cart redesign' } as never)
  await $.command.run({ command: 'feature', args: 'new Payment retries' } as never)
  await $.command.run({ command: 'experience', args: 'add checkout cart-redesign' } as never)
  await $.command.run({ command: 'experience', args: 'add checkout payment-retries' } as never)
  expect(JSON.parse(files['.claude/features/cart-redesign.json'] ?? '{}').experience).toBe('checkout')

  const list = await $.command.run({ command: 'experience', args: 'list' } as never)
  expect(list.text).toContain('Checkout (checkout) · 2 features')
  expect(list.text).toContain('Cart redesign')

  // The active feature's prompts carry the experience and its siblings.
  await $.command.run({ command: 'feature', args: 'switch cart-redesign' } as never)
  await $.prompt.submit({ text: 'hi', wait: true, origin: { kind: 'composer' } } as never)
  const brief = world.prompts.at(-1) ?? ''
  expect(brief).toContain('part of the "Checkout" experience')
  expect(brief).toContain('Mobile first.')
  expect(brief).toContain('"Payment retries"')

  // Starting the experience starts only features with a description or
  // context, and names the ones it skipped.
  const none = await $.command.run({ command: 'experience', args: 'start checkout' } as never)
  expect(none.text).toContain('nothing started')
  expect(none.text).toContain('Cart redesign')
  expect(none.text).toContain('need a description or context first')
  const f = JSON.parse(files['.claude/features/cart-redesign.json'] ?? '{}')
  files['.claude/features/cart-redesign.json'] = JSON.stringify({ ...f, description: 'New cart flow' })
  const started = await $.command.run({ command: 'experience', args: 'start checkout' } as never)
  expect(started.text).toContain('Started 1 agent')

  // Deleting the experience keeps its features, ungrouped.
  await $.command.run({ command: 'experience', args: 'delete checkout' } as never)
  expect(files['.claude/experiences/checkout.json']).toBeUndefined()
  expect(JSON.parse(files['.claude/features/payment-retries.json'] ?? '{}').experience).toBeUndefined()
})

test('the pane groups features by experience and opens an experience view', async ($, on) => {
  const files: Record<string, string> = {}
  fakeWorld(on, files)
  await $.command.run({ command: 'experience', args: 'new Checkout' } as never)
  await $.command.run({ command: 'feature', args: 'new Cart redesign' } as never)
  await $.command.run({ command: 'feature', args: 'new Loose end' } as never)
  await $.command.run({ command: 'experience', args: 'add checkout cart-redesign' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    await $.command.run({ command: 'workbench', args: '' } as never)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', key: 'open-exp-checkout' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Ungrouped' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'open-cart-redesign' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'open-loose-end' })).toBeDefined()

    // Into the experience: its features, shared context and a field for new ones.
    await ui.press({ key: 'open-exp-checkout' } as never)
    expect(await ui.find({ type: 'Input', key: 'exp-desc' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'open-cart-redesign' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'open-loose-end' })).toBeUndefined()
    await ui.input({ key: 'exp-desc', text: 'Mobile first' } as never)
    expect(JSON.parse(files['.claude/experiences/checkout.json'] ?? '{}').description).toBe('Mobile first')
    await ui.input({ key: 'exp-new-feature', text: 'Gift cards ' + surface } as never)
    expect(JSON.parse(files['.claude/features/gift-cards-' + surface + '.json'] ?? '{}').experience).toBe('checkout')

    // A feature in it can be moved out from its own view.
    await ui.press({ key: 'open-cart-redesign' } as never)
    expect(await ui.find({ type: 'Select', key: 'feature-exp' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'reg-review' })).toBeDefined()
    await ui.select({ key: 'feature-exp', value: '' } as never)
    expect(JSON.parse(files['.claude/features/cart-redesign.json'] ?? '{}').experience).toBeUndefined()
    await $.command.run({ command: 'experience', args: 'add checkout cart-redesign' } as never)
    await ui.unmount()
  }
})

test('the shared workflow registry runs scripts here and sends prompts to the feature\'s session in Workbench Web', async ($, on) => {
  const files: Record<string, string> = {
    '.claude/workbench-workflows.json': JSON.stringify({
      workflows: [
        { id: 'run-tests', name: 'Unit tests', kind: 'script', command: 'make test' },
        { id: 'lint', name: 'Lint', kind: 'script', command: 'npm run lint' },
        { id: 'changelog', name: 'Changelog entry', kind: 'prompt', template: 'Write a CHANGELOG entry for "{{feature.title}}".' },
      ],
    }),
  }
  const world = fakeWorld(on, files)
  await $.command.run({ command: 'feature', args: 'new Search' } as never)

  const list = await $.command.run({ command: 'workflow', args: 'list' } as never)
  expect(list.text).toContain('review  Review changes [prompt]')
  expect(list.text).toContain('run-tests  Unit tests [script] (project)')
  expect(list.text).toContain('lint  Lint [script] (project)')

  const ran = await $.command.run({ command: 'workflow', args: 'run run-tests' } as never)
  expect(world.runs.at(-1)).toBe('make test')
  expect(ran.text).toContain('ran: make test')

  // A prompt workflow goes to the feature's session in Workbench Web, by id.
  const sent = await $.command.run({ command: 'workflow', args: 'run review' } as never)
  expect(sent.text).toContain('Sent "Review changes" to the agent on "Search"')
  expect(world.web?.calls.some((c) => c.path === '/api/features/search/workflow/review')).toBe(true)
  const byName = await $.command.run({ command: 'workflow', args: 'run Write tests' } as never)
  expect(byName.text).toContain('Sent "Write tests"')
  expect(world.web?.calls.some((c) => c.path === '/api/features/search/workflow/tests')).toBe(true)

  // One the server does not know (a project prompt) is sent as its text.
  await $.command.run({ command: 'workflow', args: 'run changelog' } as never)
  const msg = world.web?.calls.find((c) => c.path === '/api/features/search/message')
  expect(msg?.body?.text).toBe('Write a CHANGELOG entry for "Search".')
})

test('features are written under the project root, not the shell working directory', async ($, on) => {
  const files: Record<string, string> = {}
  const world = fakeWorld(on, files, { root: '/work/proj' })
  await $.command.run({ command: 'feature', args: 'new Rooted' } as never)
  await $.command.run({ command: 'experience', args: 'new Group' } as never)
  expect(world.written).toContain('/work/proj/.claude/features/rooted.json')
  expect(world.written).toContain('/work/proj/.claude/experiences/group.json')
})

test('/workbench web finds a running Workbench Web, and explains when it is not installed', async ($, on) => {
  const files: Record<string, string> = {}
  fakeWorld(on, files, { root: '/work/proj', web: false })
  let up = true
  on('http.fetch', async () => (up ? { value: { status: 200, ok: true, headers: {}, text: '<title>Workbench</title>' } } : { value: { status: 0, ok: false, headers: {}, text: '' } }) as never)
  const running = await $.command.run({ command: 'workbench', args: 'web' } as never)
  expect(running.text).toContain('Workbench Web is running at http://localhost:4477/')

  up = false
  const missing = await $.command.run({ command: 'workbench', args: 'web' } as never)
  expect(missing.text).toContain('Workbench Web not found at /work/proj/workbench-web')
})
