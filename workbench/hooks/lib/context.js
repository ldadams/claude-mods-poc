// Context providers: what a feature's prompts and agents read (files, commands, URLs, notes, MCP tools).

import { CONTEXT_TYPES, MAX_PROVIDER_CHARS } from './constants.js'
import { callMcp } from './mcp.js'
import { abs, projectRoot } from './paths.js'
import { errText, splitFirst, truncate } from './util.js'

export function parseContextSpec(text) {
  const [type, rest] = splitFirst(text)
  if (!CONTEXT_TYPES.includes(type) || !rest) return null
  if (type !== 'mcp') return { type, value: rest }
  const [serverName, afterServer] = splitFirst(rest)
  const [tool, argsText] = splitFirst(afterServer)
  if (!serverName || !tool) return null
  let args = {}
  if (argsText) {
    try {
      args = JSON.parse(argsText)
    } catch {
      return null
    }
  }
  return { type, value: serverName + ' ' + tool + (argsText ? ' ' + argsText : ''), server: serverName, tool, args }
}

export function describeProvider(p) {
  return '[' + p.type + '] ' + p.value
}

export async function resolveProvider(io, p) {
  const label = p.label || p.value
  const tag = '[context:' + p.type + ' ' + label + ']'
  try {
    if (p.type === 'file') {
      const path = p.value.startsWith('/') ? p.value : await abs(io, p.value)
      return tag + '\n' + truncate(await io.fs.read(path), MAX_PROVIDER_CHARS)
    }
    if (p.type === 'command') {
      const r = await io.process.run(['sh', '-c', p.value], { cwd: (await projectRoot(io)) || undefined })
      const out = r.stdout || r.stderr || ''
      return tag + (r.exitCode ? ' (exit ' + r.exitCode + ')' : '') + '\n' + truncate(out, MAX_PROVIDER_CHARS)
    }
    if (p.type === 'url') {
      const r = await io.http.fetch(p.value)
      return tag + '\n' + truncate(r.text, MAX_PROVIDER_CHARS)
    }
    if (p.type === 'note') {
      return tag + '\n' + p.value
    }
    if (p.type === 'mcp') {
      const data = await callMcp(io, p.server, p.tool, p.args || {})
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
      return tag + '\n' + truncate(text, MAX_PROVIDER_CHARS)
    }
  } catch (err) {
    return tag + ' failed to resolve: ' + errText(err)
  }
  return '[context] unknown provider type ' + p.type
}
