// Remote sources: features listed and fetched from MCP servers (GitHub, Linear, Jira…) by config alone.

import { CONFIG_PATH, MAX_PROVIDER_CHARS, REMOTE_TTL_MS } from './constants.js'
import { loadFeature, saveFeature } from './features.js'
import { callMcp, fillArgs, getPath, loadConfig } from './mcp.js'
import { pane, remoteItemCache } from './state.js'
import { errText, slugify, truncate } from './util.js'

export async function callSource(io, source, op, vars) {
  const spec = source[op]
  if (!spec || !spec.tool) throw new Error('source has no "' + op + '" tool configured')
  return callMcp(io, source.server, spec.tool, fillArgs(spec.args || {}, vars))
}

export function normalizeItem(sourceName, source, raw) {
  const f = { id: 'id', title: 'title', description: 'description', status: 'status', url: 'url', ...(source.fields || {}) }
  const remoteId = getPath(raw, f.id)
  if (remoteId == null) return null
  return {
    source: sourceName,
    remoteId: String(remoteId),
    title: String(getPath(raw, f.title) ?? remoteId),
    description: String(getPath(raw, f.description) ?? ''),
    status: String(getPath(raw, f.status) ?? ''),
    url: String(getPath(raw, f.url) ?? ''),
  }
}

export async function listRemote(io, config, sourceName) {
  const source = config.sources[sourceName]
  if (!source) throw new Error('no source named "' + sourceName + '" in ' + CONFIG_PATH)
  const data = await callSource(io, source, 'list', {})
  const items = getPath(data, source.list.itemsPath)
  if (!Array.isArray(items)) {
    throw new Error(
      source.list.tool + ' did not return a list' +
        (source.list.itemsPath ? ' at "' + source.list.itemsPath + '"' : '') + '; check list.itemsPath',
    )
  }
  const normalized = items.map((raw) => normalizeItem(sourceName, source, raw)).filter(Boolean)
  pane.remoteLists[sourceName] = normalized
  return normalized
}

export async function getRemote(io, config, sourceName, remoteId) {
  const source = config.sources[sourceName]
  if (!source) throw new Error('no source named "' + sourceName + '"')
  if (!source.get) {
    const all = pane.remoteLists[sourceName] || (await listRemote(io, config, sourceName))
    return all.find((i) => i.remoteId === remoteId) || null
  }
  const data = await callSource(io, source, 'get', { id: remoteId })
  const raw = getPath(data, source.get.itemPath)
  return raw && typeof raw === 'object' ? normalizeItem(sourceName, source, raw) : null
}

export function remoteFeatureId(sourceName, remoteId) {
  return slugify(sourceName + '-' + remoteId)
}

export async function pullRemote(io, item) {
  const id = remoteFeatureId(item.source, item.remoteId)
  const now = new Date().toISOString()
  const feature = (await loadFeature(io, id)) || {
    id,
    description: '',
    status: 'active',
    createdAt: now,
    context: [],
    workflows: [],
  }
  feature.title = item.title
  feature.remote = { source: item.source, id: item.remoteId, url: item.url, status: item.status }
  await saveFeature(io, feature)
  remoteItemCache.set(id, { at: Date.now(), item })
  return feature
}

export async function resolveRemoteRef(io, config, ref) {
  const names = Object.keys(config.sources)
  if (names.length === 0) throw new Error('no remote sources configured in ' + CONFIG_PATH)
  let sourceName
  let remoteId
  const colon = ref.indexOf(':')
  if (colon > 0 && config.sources[ref.slice(0, colon)]) {
    sourceName = ref.slice(0, colon)
    remoteId = ref.slice(colon + 1)
  } else if (names.length === 1) {
    sourceName = names[0]
    remoteId = ref
  } else {
    throw new Error('several sources configured; use <source>:<id> (' + names.join(', ') + ')')
  }
  const item = await getRemote(io, config, sourceName, remoteId)
  if (!item) throw new Error('"' + remoteId + '" not found in ' + sourceName)
  return item
}

export async function liveRemoteSection(io, feature) {
  const r = feature.remote
  const tag = '[remote ' + r.source + ':' + r.id + ']'
  let item = null
  const cached = remoteItemCache.get(feature.id)
  if (cached && Date.now() - cached.at < REMOTE_TTL_MS) {
    item = cached.item
  } else {
    try {
      const config = await loadConfig(io)
      item = await getRemote(io, config, r.source, r.id)
      if (item) remoteItemCache.set(feature.id, { at: Date.now(), item })
    } catch (err) {
      return tag + ' failed to fetch: ' + errText(err)
    }
  }
  if (!item) return tag + ' not found'
  return (
    tag +
    (item.url ? ' ' + item.url : '') +
    (item.status ? '\nStatus: ' + item.status : '') +
    '\nTitle: ' + item.title +
    (item.description ? '\n' + truncate(item.description, MAX_PROVIDER_CHARS) : '')
  )
}

export async function refreshRemoteLists(io) {
  const config = await loadConfig(io)
  const names = Object.keys(config.sources)
  pane.remoteLists = {}
  pane.remoteError = names.length === 0 ? 'No remote sources yet. Add one to ' + CONFIG_PATH + ' (see README).' : ''
  for (const name of names) {
    try {
      await listRemote(io, config, name)
    } catch (err) {
      pane.remoteError += name + ': ' + errText(err) + '\n'
    }
  }
}
