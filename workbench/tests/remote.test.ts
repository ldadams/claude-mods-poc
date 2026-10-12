import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const CONFIG = {
  sources: {
    tracker: {
      server: 'tracker',
      list: { tool: 'list_items', args: { mine: true }, itemsPath: 'items' },
      get: { tool: 'get_item', args: { key: '{id}' } },
      fields: { id: 'key', title: 'name', description: 'body', status: 'state.name', url: 'link' },
    },
  },
}

const ITEMS = [
  { key: 'TRK-1', name: 'Checkout redesign', body: 'New cart flow', state: { name: 'In Progress' }, link: 'https://t/1' },
  { key: 'TRK-2', name: 'Faster search', body: 'Index tuning', state: { name: 'Todo' }, link: 'https://t/2' },
]

// In-memory file system and MCP server beneath the plugin.
function fakeWorld(on: On, files: Record<string, string>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  mock.store(on)
  // The engine takes a non-object answer from a hook as { value }.
  const value = <T,>(v: T) => ({ value: v }) as never
  // Paths arrive resolved against the working directory; the fake keeps them relative.
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
  on('mcp.call', async (_$, e) => {
    calls.push({ tool: e.tool, args: e.args })
    if (e.tool === 'list_items') {
      return value({ isError: false, content: [{ type: 'text', text: JSON.stringify({ items: ITEMS }) }] })
    }
    const item = ITEMS.find((i) => i.key === e.args.key)
    return value(
      item
        ? { isError: false, content: [{ type: 'text', text: JSON.stringify(item) }] }
        : { isError: true, content: [{ type: 'text', text: 'not found' }] },
    )
  })
  return calls
}

test('lists remote features from the configured MCP source', async ($, on) => {
  const calls = fakeWorld(on, { '.claude/workbench.json': JSON.stringify(CONFIG) })
  const r = await $.command.run({ command: 'feature', args: 'remote' } as never)
  expect(r.text).toContain('TRK-1 [In Progress] Checkout redesign')
  expect(r.text).toContain('TRK-2 [Todo] Faster search')
  expect(calls[0]).toEqual({ tool: 'list_items', args: { mine: true } })
})

test('pull creates a local overlay, keeps its context, and injects live remote context', async ($, on) => {
  const files: Record<string, string> = { '.claude/workbench.json': JSON.stringify(CONFIG) }
  const calls = fakeWorld(on, files)
  let seen: readonly string[] = []
  on('prompt.submit', async (_$, e) => {
    seen = e.context ?? []
    return { text: e.text }
  })

  const r = await $.command.run({ command: 'feature', args: 'pull tracker:TRK-1' } as never)
  expect(r.text).toContain('tracker-trk-1')
  expect(calls[0]).toEqual({ tool: 'get_item', args: { key: 'TRK-1' } })

  await $.command.run({ command: 'ctx', args: 'add note Ship behind flag' } as never)
  // Pulling again refreshes the remote fields without dropping local context.
  await $.command.run({ command: 'feature', args: 'pull TRK-1' } as never)
  const overlay = JSON.parse(files['.claude/features/tracker-trk-1.json'] ?? '{}')
  expect(overlay.remote).toEqual({ source: 'tracker', id: 'TRK-1', url: 'https://t/1', status: 'In Progress' })
  expect(overlay.context.length).toBe(1)

  await $.prompt.submit({ text: 'hi', wait: true, origin: { kind: 'composer' } } as never)
  const joined = seen.join('\n')
  expect(joined).toContain('[remote tracker:TRK-1] https://t/1')
  expect(joined).toContain('New cart flow')
  expect(joined).toContain('Ship behind flag')
})

test('pull reports a missing item without creating a feature', async ($, on) => {
  const files: Record<string, string> = { '.claude/workbench.json': JSON.stringify(CONFIG) }
  fakeWorld(on, files)
  const r = await $.command.run({ command: 'feature', args: 'pull tracker:NOPE' } as never)
  expect(r.text).toContain('not found')
  expect(Object.keys(files).some((p) => p.startsWith('.claude/features/'))).toBe(false)
})
