// The Workbench Web server: finding it, starting it, and calling its API.

import { CONFIG_PATH, DEFAULT_WEB_PORT, RUNTIME_PATH } from './constants.js'
import { loadConfig } from './mcp.js'
import { abs, projectRoot } from './paths.js'
import { link } from './state.js'
import { errText } from './util.js'

export async function webConfig(io) {
  const config = await loadConfig(io)
  const web = config.web || {}
  const root = await projectRoot(io)
  return { dir: web.dir || (root ? root + '/workbench-web' : 'workbench-web'), port: Number(web.port) || DEFAULT_WEB_PORT, root }
}

export async function webIsUp(io, port) {
  const url = 'http://localhost:' + port + '/'
  try {
    const r = await io.http.fetch(url)
    return (r.text || '').includes('Workbench')
  } catch {
    // The engine's fetch may refuse loopback; curl asks the same question.
    try {
      const r = await io.process.run(['curl', '-s', '--max-time', '1', url], { timeoutMs: 3000 })
      return r.exitCode === 0 && (r.stdout || '').includes('Workbench')
    } catch {
      return false
    }
  }
}

// Starts Workbench Web for this project (or finds it running) and returns its URL.
// The server lives while this module is loaded; a reload or session end stops it.
export async function startWeb(io) {
  const { dir, port, root } = await webConfig(io)
  const url = 'http://localhost:' + port + '/'
  if (await webIsUp(io, port)) {
    link.webState = { url, starting: false, error: '' }
    return url
  }
  if (!(await io.fs.exists(dir + '/server.mjs'))) {
    throw new Error('Workbench Web not found at ' + dir + '. Set "web": { "dir": "<path>" } in ' + CONFIG_PATH + '.')
  }
  if (!(await io.fs.exists(dir + '/node_modules'))) {
    throw new Error('Workbench Web needs its dependencies: run npm install in ' + dir + '.')
  }
  link.webState = { url: null, starting: true, error: '' }
  void (async () => {
    try {
      const notify = (await io.store.get('osNotify')) === false ? 'off' : 'auto'
      const child = io.process.spawn({ argv: ['node', 'server.mjs', root || '.', '--port', String(port), '--os-notify', notify], cwd: dir })
      for await (const { text } of child) io.ui.log('workbench web: ' + text.trim(), { to: 'debug' })
    } catch (err) {
      link.webState = { url: null, starting: false, error: errText(err) }
    }
    if (link.webState.url) link.webState = { url: null, starting: false, error: 'Workbench Web stopped.' }
    io.ui.invalidate('ui.render')
  })()
  for (let i = 0; i < 20; i++) {
    await io.clock.sleep(250)
    if (await webIsUp(io, port)) {
      link.webState = { url, starting: false, error: '' }
      io.ui.invalidate('ui.render')
      return url
    }
  }
  link.webState = { url: null, starting: false, error: link.webState.error || 'Workbench Web did not answer on port ' + port + '.' }
  throw new Error(link.webState.error)
}

// The running server, as its runtime file describes it; null when there is none.
export async function findServer(io) {
  try {
    const p = await abs(io, RUNTIME_PATH)
    if (!(await io.fs.exists(p))) return null
    const info = JSON.parse(await io.fs.read(p))
    return info && info.port && info.token ? { port: Number(info.port), token: String(info.token) } : null
  } catch {
    return null
  }
}

// One call to Workbench Web's API. The host's fetch may refuse loopback; curl is
// the fallback, its config (token included) on stdin so the token is never in ps.
export async function webCall(io, srv, method, path, body) {
  const url = 'http://127.0.0.1:' + srv.port + path
  const headers = { 'X-Workbench-Token': srv.token, 'Content-Type': 'application/json' }
  const payload = body === undefined ? undefined : JSON.stringify(body)
  let status
  let text
  try {
    const r = await io.http.fetch(url, { method, headers, ...(payload === undefined ? {} : { body: payload }) })
    status = r.status
    text = r.text
  } catch {
    const q = (s) =>
      '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'
    const config =
      [
        'url = ' + q(url),
        'request = ' + q(method),
        ...Object.entries(headers).map(([k, v]) => 'header = ' + q(k + ': ' + v)),
        ...(payload === undefined ? [] : ['data-binary = ' + q(payload)]),
      ].join('\n') + '\n'
    let r
    try {
      r = await io.process.run(['curl', '-s', '--max-time', '10', '-K', '-', '-w', '\n%{http_code}'], { stdin: config, timeoutMs: 15000 })
    } catch {
      throw Object.assign(new Error('Workbench Web is not reachable'), { code: 'down' })
    }
    if (r.exitCode !== 0) throw Object.assign(new Error('Workbench Web is not reachable'), { code: 'down' })
    const out = r.stdout || ''
    const cut = out.lastIndexOf('\n')
    status = Number(out.slice(cut + 1))
    text = out.slice(0, cut)
  }
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    // Not JSON: the status says enough.
  }
  if (!(status > 0)) throw Object.assign(new Error('Workbench Web is not reachable'), { code: 'down' })
  if (status === 401) throw Object.assign(new Error('Workbench Web refused the token'), { code: 401 })
  if (!(status >= 200 && status < 300)) throw new Error(data.error || 'Workbench Web answered ' + status)
  return data
}

// The server to talk to: the one the runtime file names, started for this
// project when none is running.
export async function ensureServer(io) {
  if (link.server) return link.server
  link.server = await findServer(io)
  if (link.server) return link.server
  await startWeb(io)
  // The runtime file is written just after the server starts listening.
  for (let i = 0; i < 20 && !link.server; i++) {
    link.server = await findServer(io)
    if (!link.server) await io.clock.sleep(150)
  }
  if (!link.server) throw new Error('Workbench Web started but has not written ' + RUNTIME_PATH)
  return link.server
}

export async function api(io, method, path, body) {
  try {
    return await webCall(io, await ensureServer(io), method, path, body)
  } catch (err) {
    if (err.code !== 401 && err.code !== 'down') throw err
    // The server restarted (a new token) or went away: look it up once more.
    link.server = null
    return webCall(io, await ensureServer(io), method, path, body)
  }
}
