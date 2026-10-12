// Workbench: Features (units of work shared through git), Experiences (named
// groups of features with shared context), Context (what each feature's prompts
// read), Workflows (a shared registry plus each feature's own), and one Claude
// session per feature run by Workbench Web, which this pane and the browser both
// drive.
//
// This file holds the host adapter and wires each hook to its handler:
// lifecycle.js (session start and prompts), commands/ (one file per slash
// command), pane/ (the Workbench pane), and lib/ (everything they share).

import { atom, read, update } from 'claude-code'
import { ctxCommand } from './commands/ctx.js'
import { experienceCommand } from './commands/experience.js'
import { featureCommand } from './commands/feature.js'
import { workbenchCommand } from './commands/workbench.js'
import { workflowCommand } from './commands/workflow.js'
import { ASK_TOOL_FULL } from './lib/constants.js'
import { onAgentToolCall } from './lib/decisions.js'
import { onAskUser, onTurnComplete } from './lib/session-runner.js'
import { onPromptSubmit, onSessionResume, onSessionStart } from './lifecycle.js'
import { renderPane } from './pane/render.js'

// The session's atoms. Only this file reads or writes them (see lib/state.js).
const activeFeatureId = atom({ plugin: 'workbench', key: 'activeFeatureId' }, null)
const sessions = atom({ plugin: 'workbench', key: 'sessions' }, {})
const transcript = atom({ plugin: 'workbench', key: 'transcript' }, null)
const serverState = atom({ plugin: 'workbench', key: 'serverState' }, { up: false, browsers: 0, url: '', error: '', decisions: null })

// The one place the mod touches $. Each hook call wraps its own $ in this
// adapter and hands that to the rest of the mod, which never sees $ itself:
// the engine follows $ only within this file, so every capability the mod
// uses is listed here.
function host($) {
  const readers = {
    activeFeatureId: () => read($, activeFeatureId),
    sessions: () => read($, sessions),
    transcript: () => read($, transcript),
    serverState: () => read($, serverState),
  }
  const updaters = {
    activeFeatureId: (fn) => update($, activeFeatureId, fn),
    sessions: (fn) => update($, sessions, fn),
    transcript: (fn) => update($, transcript, fn),
    serverState: (fn) => update($, serverState, fn),
  }
  return {
    fs: {
      exists: (path) => $.fs.exists(path),
      list: (path) => $.fs.list(path),
      read: (path) => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
    },
    process: {
      run: (argv, init) => $.process.run(argv, init),
      spawn: (request) => $.process.spawn(request),
    },
    http: { fetch: (url, init) => $.http.fetch(url, init) },
    mcp: { call: (server, tool, args) => $.mcp.call(server, tool, args) },
    store: {
      get: (key) => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
    },
    clock: {
      sleep: (ms, options) => $.clock.sleep(ms, options),
      every: (ms, fn) => $.clock.every(ms, fn),
    },
    command: { register: (command) => $.command.register(command) },
    tool: { register: (tool) => $.tool.register(tool) },
    agent: { spawn: (request) => $.agent.spawn(request) },
    session: {
      root: () => $.session.root(),
      send: (message) => $.session.send(message),
    },
    ui: {
      invalidate: (event) => $.ui.invalidate(event),
      log: (text, options) => $.ui.log(text, options),
      open: (request) => $.ui.open(request),
      resolve: (e) => $.ui.resolve(e),
      status: (text) => $.ui.status(text),
      toast: (text, options) => $.ui.toast(text, options),
    },
    // Session atoms by key (lib/state.js): read while drawing, update from anywhere.
    read: (key) => readers[key](),
    update: (key, fn) => updaters[key](fn),
  }
}

export function register(on) {
  on('session.start', ($, e, next) => onSessionStart(host($), e, next))
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, ($, e, next) => onSessionResume(host($), e, next))
  on('prompt.submit', ($, e, next) => onPromptSubmit(host($), e, next))

  // The observer's event inputs, for agents running inside this session. Agents
  // on Workbench Web are polled instead (lib/sessions.js).
  on('tool.call', { tool: ASK_TOOL_FULL }, ($, e) => onAskUser(host($), e))
  on('tool.call', ($, e, next) => onAgentToolCall(host($), e, next))
  on('turn.complete', ($, e, next) => onTurnComplete(host($), e, next))

  on('command.run', { command: 'workbench' }, ($, e) => workbenchCommand(host($), e))
  on('command.run', { command: 'wb' }, ($, e) => workbenchCommand(host($), e))
  on('command.run', { command: 'experience' }, ($, e) => experienceCommand(host($), e))
  on('command.run', { command: 'feature' }, ($, e) => featureCommand(host($), e))
  on('command.run', { command: 'ctx' }, ($, e) => ctxCommand(host($), e))
  on('command.run', { command: 'workflow' }, ($, e) => workflowCommand(host($), e))

  on('ui.render', { component: 'Pane' }, ($, e, next) => renderPane(host($), e, next))
}
