// State, by how long it lasts: host atoms (the session), and module objects (until a reload).

// Session state, held by the host: survives a hot reload, and a write redraws
// every pane that read it. register.js declares the atoms (the engine reads
// them only there); the rest of the mod names them by these keys, as
// io.read(key) and io.update(key, fn).
export const activeFeatureId = 'activeFeatureId'
// What Workbench Web last said about each feature's session (see `poll`):
// featureId -> { status, live, sessionId, mode, cost, pending[] }.
export const sessions = 'sessions'
// The open feature's recent transcript: { featureId, total, events[] } or null.
export const transcript = 'transcript'
// Whether the server answers: { up, browsers, url, error }.
export const serverState = 'serverState'

export const remoteItemCache = new Map()

// The pane's own state. Losing it on reload just returns the pane to Home.
export const pane = {
  view: { kind: 'home' }, // | { kind: 'feature', id } | { kind: 'remote' }
  pendingCtxType: 'file',
  remoteLists: {},
  remoteError: '',
  showAll: false, // the Feature view shows the whole transcript tail, not just the last few
  picks: {}, // pendingId -> { questionIndex: chosen label(s) } for multi-part questions
  armed: null, // the destructive button pressed once, waiting for the confirming press
  lastOutput: null, // { featureId, name, text } from the latest script workflow
}

// The link to Workbench Web: where it is, and the poll that watches it.
export const link = {
  webState: { url: null, starting: false, error: '' },
  server: null, // { port, token } from the runtime file, once found
  pollTimer: null,
  polling: false,
  lastVersion: -1,
  lastPolledFeature: null,
}
