// MCP plumbing for remote sources and mcp context providers, on the user's own connections.

import { CONFIG_PATH } from './constants.js'
import { abs } from './paths.js'
import { errText } from './util.js'

export function mcpText(result) {
  return (result.content || [])
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n')
}

export async function callMcp(io, serverName, tool, args) {
  const result = await io.mcp.call(serverName, tool, args)
  if (result.isError) throw new Error(mcpText(result) || tool + ' failed')
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = mcpText(result)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function loadConfig(io) {
  try {
    const path = await abs(io, CONFIG_PATH)
    if (!(await io.fs.exists(path))) return { sources: {} }
    const config = JSON.parse(await io.fs.read(path))
    return { ...config, sources: config.sources || {} }
  } catch (err) {
    io.ui.log('workbench: could not read ' + CONFIG_PATH + ': ' + errText(err))
    return { sources: {} }
  }
}

export function getPath(obj, path) {
  if (!path) return obj
  return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj)
}

export function fillArgs(value, vars) {
  if (typeof value === 'string') {
    const whole = value.match(/^\{(\w+)\}$/)
    if (whole && whole[1] in vars) return vars[whole[1]]
    return value.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
  }
  if (Array.isArray(value)) return value.map((v) => fillArgs(v, vars))
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) out[k] = fillArgs(value[k], vars)
    return out
  }
  return value
}
