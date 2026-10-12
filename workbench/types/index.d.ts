declare module 'claude-code' {
  interface PluginState {
    workbench: {
      /** The feature this session is focused on; null when none. */
      activeFeatureId: string | null
      /** Workbench Web's session per feature id, as last polled. */
      sessions: Record<string, WorkbenchSession>
      /** The open feature's recent transcript, as last polled; null when none. */
      transcript: WorkbenchTranscript | null
      /** Whether Workbench Web answers, and where. */
      serverState: WorkbenchServerState
    }
  }
}

/** A session's state in Workbench Web. */
export type WorkbenchSessionStatus = 'idle' | 'running' | 'needs-you' | 'ready' | 'paused' | 'error'

/** A tool permission or a question waiting on the user. */
export type WorkbenchPending = {
  id: string
  kind: 'tool' | 'question'
  toolName: string
  input: any
  canAlways?: boolean
}

export type WorkbenchSession = {
  featureId: string
  /** Who holds it: a subagent of this session, or a Workbench Web session. */
  runner?: 'session' | 'web'
  /** Workbench Web: the decisions model's suggested approach for a feature not yet started. */
  assessment?: { recommended?: 'plan' | 'direct'; confidence?: number; reasons?: string[]; error?: string } | null
  /** In-session agents: the subagent's id, its last summary and a short transcript. */
  agentId?: string | null
  summary?: string
  events?: WorkbenchEvent[]
  status: WorkbenchSessionStatus
  /** A query is running for it in the server right now. */
  live: boolean
  /** The Claude session id; set once it has a conversation. */
  sessionId: string | null
  mode: string
  cost: number
  historyLoaded?: boolean
  pending: WorkbenchPending[]
}

/** One transcript entry; `t` names its kind (user, text, tool, tool_result, result, ask, …). */
export type WorkbenchEvent = { t: string; [field: string]: any }

export type WorkbenchTranscript = {
  featureId: string
  /** How many entries the server holds, of which `events` is the tail. */
  total: number
  events: WorkbenchEvent[]
}

export type WorkbenchServerState = {
  up: boolean
  /** Browser pages connected to it. */
  browsers: number
  url: string
  error: string
  /** Its decisions model, when it reports one: provider, mode (shadow or on), readiness. */
  decisions?: { provider: string; mode: string; ready?: boolean; loading?: boolean; error?: string } | null
}
