// GraphQL API for Workbench: the same features, experiences, sessions, workflows and remote
// sources the REST API and the Workbench plugin use, behind one endpoint (POST /api/graphql).
//
// server.mjs passes in its storage and session functions, so both APIs share one code path and
// every edit still reaches open browsers through the SSE stream. Live updates stay on that stream
// (GET /api/events); this API has queries and mutations only.
import { graphql, buildSchema, parse, validate, specifiedRules, GraphQLError } from 'graphql'

export const typeDefs = /* GraphQL */ `
  "Any JSON value (tool inputs, MCP args, transcript events)."
  scalar JSON

  enum FeatureStatus { active archived }
  enum ContextType { file command url note mcp }
  enum PermissionMode { default acceptEdits plan auto }
  enum SessionStatus { idle running needs_you ready paused error }

  type Query {
    "Absolute path of the project whose .claude/ folder this server reads."
    project: String!
    features(status: FeatureStatus, experience: ID): [Feature!]!
    feature(id: ID!): Feature
    experiences: [Experience!]!
    experience(id: ID!): Experience
    "Shared registry workflows merged with the project's .claude/workbench-workflows.json."
    workflows: [Workflow!]!
    "Items in the remote trackers: Jira epics and stories, GitHub issues. Epic means a group (a Jira epic, a GitHub issue with sub-issues)."
    remoteItems(type: RemoteItemType, source: String): [RemoteItem!]!
    "The remote trackers."
    remoteSources: [RemoteSource!]!
    "Sessions that are waiting for an answer or a tool approval."
    needsYou: [Session!]!
  }

  type Feature {
    id: ID!
    title: String!
    description: String!
    status: FeatureStatus!
    experienceId: ID
    experience: Experience
    createdAt: String
    updatedAt: String
    context: [ContextItem!]!
    workflows: [FeatureWorkflow!]!
    remote: Remote
    session: Session!
  }

  type ContextItem {
    id: ID!
    type: ContextType!
    value: String!
    label: String
    server: String
    tool: String
    args: JSON
  }

  type FeatureWorkflow {
    id: ID
    name: String!
    kind: String!
    target: String
    description: String
  }

  enum RemoteItemType {
    Epic
    Story
  }

  type RemoteSource {
    "The tracker's id, its file name in remotes/."
    source: String!
    "jira or github."
    kind: String!
    name: String!
    "The repository or the browse URL."
    where: String
  }

  type Remote {
    source: String!
    id: ID!
    "How the tracker writes it: WB-101, example/workbench#42."
    ref: String!
    type: RemoteItemType!
    "The epic a pulled story belongs to."
    epicId: ID
    url: String
    status: String
    labels: [String!]!
  }

  type Experience {
    id: ID!
    title: String!
    description: String!
    order: Int
    "Remote items carrying one of these labels are grouped under this experience and pulled into it."
    labels: [String!]!
    createdAt: String
    updatedAt: String
    features(status: FeatureStatus): [Feature!]!
  }

  type Session {
    featureId: ID!
    status: SessionStatus!
    "True while a Claude query is attached to this feature."
    live: Boolean!
    sessionId: String
    mode: PermissionMode!
    costUsd: Float!
    pending: [PendingRequest!]!
    "The most recent transcript events, oldest first (same shape as the SSE stream's events)."
    events(last: Int = 50): [JSON!]!
  }

  type PendingRequest {
    id: ID!
    kind: String!
    toolName: String!
    input: JSON
    canAlways: Boolean!
  }

  type Workflow {
    id: ID!
    name: String!
    kind: String!
    description: String
    mode: PermissionMode
    template: String
    command: String
    source: String!
  }

  type RemoteItem {
    source: String!
    kind: String!
    id: ID!
    ref: String!
    type: RemoteItemType!
    "What the tracker calls this type: Epic, Story, Parent issue, Issue."
    typeLabel: String!
    title: String!
    description: String
    status: String
    url: String
    labels: [String!]!
    "A story's epic."
    epic: RemoteItem
    "An epic's stories."
    stories: [RemoteItem!]!
    "The experience this item belongs to: its pulled feature's, or the one whose labels match."
    experienceId: ID
    experience: Experience
    "The local feature this item was pulled into, if any."
    feature: Feature
  }

  input UpdateFeatureInput {
    title: String
    description: String
    status: FeatureStatus
    "Experience id; pass null to ungroup the feature."
    experience: ID
  }

  input UpdateExperienceInput {
    title: String
    description: String
    labels: [String!]
  }

  input AnswerInput {
    "For tool approvals."
    allow: Boolean
    "Also remember this permission (when the request offers it)."
    always: Boolean
    "Reason shown to Claude when denying."
    message: String
    "For AskUserQuestion: { question: answer }."
    answers: JSON
  }

  type Mutation {
    createFeature(title: String!, description: String, experience: ID): Feature!
    updateFeature(id: ID!, input: UpdateFeatureInput!): Feature!
    addContext(featureId: ID!, type: ContextType!, value: String!): Feature!
    removeContext(featureId: ID!, contextId: ID!): Feature!

    createExperience(title: String!, description: String, labels: [String!]): Experience!
    updateExperience(id: ID!, input: UpdateExperienceInput!): Experience!
    "Deletes the experience; its features are kept, ungrouped."
    deleteExperience(id: ID!): ID!

    "Starts a session with the feature's brief. Fails if it already has one."
    startSession(featureId: ID!): Session!
    "Sends a message, starting (with the brief) or resuming the session as needed."
    sendMessage(featureId: ID!, text: String!): Session!
    interruptSession(featureId: ID!): Session!
    stopSession(featureId: ID!): Session!
    "Forgets the session, its transcript and its cost."
    resetSession(featureId: ID!): Session!
    setMode(featureId: ID!, mode: PermissionMode!): Session!
    answerRequest(featureId: ID!, requestId: ID!, input: AnswerInput!): Session!
    runWorkflow(featureId: ID!, workflowId: ID!): Session!

    "Pull a remote item as a feature; a group's brief lists its items. source may be left out when only one tracker has the id."
    pullRemote(id: ID!, source: String, experience: ID): Feature!
  }
`

const MAX_DEPTH = 8

// Rejects deeply nested queries (feature -> experience -> features -> experience ...).
function depthLimit(max) {
  return (context) => {
    let depth = 0
    return {
      SelectionSet: {
        enter(node) {
          if (++depth > max) context.reportError(new GraphQLError('Query is nested more than ' + max + ' levels deep', { nodes: [node] }))
        },
        leave() {
          depth--
        },
      },
    }
  }
}

// GraphQL enum values can't contain '-', so the session status uses underscores.
const toEnumStatus = (s) => String(s || 'idle').replace(/-/g, '_')

export function createGraphQL(deps) {
  const schema = buildSchema(typeDefs)

  const mustFeature = async (id) => {
    const f = await deps.readFeature(id)
    if (!f) throw new Error('No such feature: ' + id)
    return f
  }
  const mustExperience = async (id) => {
    const e = await deps.readExperience(id)
    if (!e) throw new Error('No such experience: ' + id)
    return e
  }

  function sessionView(id) {
    const s = deps.sessionFor(id)
    const sum = s.summary()
    return {
      featureId: sum.featureId,
      status: toEnumStatus(sum.status),
      live: sum.live,
      sessionId: sum.sessionId,
      mode: sum.mode,
      costUsd: sum.cost || 0,
      pending: sum.pending.map((p) => ({ ...p, canAlways: !!p.canAlways })),
      events: ({ last }) => {
        const n = Math.max(0, Math.min(Number(last) || 0, 1000))
        return n ? s.events.slice(-n) : []
      },
    }
  }

  function featureView(f) {
    if (!f) return null
    return {
      id: f.id,
      title: f.title,
      description: f.description || '',
      status: f.status === 'archived' || f.status === 'done' ? 'archived' : 'active',
      experienceId: f.experience || null,
      experience: () => (f.experience ? deps.readExperience(f.experience).then(experienceView) : null),
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      context: (f.context || []).map((c) => ({ ...c, type: c.type })),
      workflows: f.workflows || [],
      remote: f.remote ? { ...f.remote, source: f.remote.source || 'jira', ref: f.remote.ref || f.remote.id, type: f.remote.type || 'Story', epicId: f.remote.epic || null, labels: f.remote.labels || [] } : null,
      session: () => sessionView(f.id),
    }
  }

  function experienceView(e) {
    if (!e) return null
    return {
      id: e.id,
      title: e.title,
      description: e.description || '',
      order: Number.isInteger(e.order) ? e.order : null,
      labels: e.labels || [],
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      features: async ({ status }) =>
        (await deps.listFeatures()).filter((f) => f.experience === e.id && (!status || featureView(f).status === status)).map(featureView),
    }
  }

  // Session mutations return the session's state after the action, like the REST API does.
  const onSession = (fn) => async (args) => {
    await mustFeature(args.featureId)
    const s = deps.sessionFor(args.featureId)
    await fn(s, args)
    return sessionView(args.featureId)
  }

  const root = {
    project: () => deps.project,
    features: async ({ status, experience }) =>
      (await deps.listFeatures())
        .map(featureView)
        .filter((f) => (!status || f.status === status) && (experience === undefined || experience === null || f.experienceId === experience)),
    feature: async ({ id }) => featureView(await deps.readFeature(id)),
    experiences: async () => (await deps.listExperiences()).map(experienceView),
    experience: async ({ id }) => experienceView(await deps.readExperience(id)),
    workflows: () => deps.loadWorkflows(),
    remoteItems: async ({ type, source }) => {
      const items = await deps.listRemotes()
      const same = (a, b) => a.source === b.source
      const view = (it) => ({
        ...it,
        epic: () => {
          const e = it.epic && items.find((x) => same(x, it) && x.id === it.epic)
          return e ? view(e) : null
        },
        stories: () => items.filter((x) => same(x, it) && x.epic === it.id).map(view),
        experienceId: it.experienceId || null,
        experience: () => (it.experienceId ? deps.readExperience(it.experienceId).then(experienceView) : null),
        feature: () => (it.featureId ? deps.readFeature(it.featureId).then(featureView) : null),
      })
      return items.filter((it) => (!type || it.type === type) && (!source || it.source === source)).map(view)
    },
    remoteSources: () => deps.listRemoteSources(),
    needsYou: async () =>
      (await deps.listFeatures()).map((f) => sessionView(f.id)).filter((s) => s.status === 'needs_you' || s.pending.length),

    createFeature: async (args) => featureView(await deps.createFeature(args)),
    updateFeature: async ({ id, input }) => featureView(await deps.updateFeature(await mustFeature(id), { ...input })),
    addContext: async ({ featureId, type, value }) => {
      if (type === 'mcp') throw new Error('mcp context items are added from the Workbench plugin (/ctx add mcp ...)')
      return featureView(await deps.addContext(await mustFeature(featureId), { type, value }))
    },
    removeContext: async ({ featureId, contextId }) => featureView(await deps.removeContext(await mustFeature(featureId), contextId)),

    createExperience: async (args) => experienceView(await deps.createExperience(args)),
    updateExperience: async ({ id, input }) => experienceView(await deps.updateExperience(await mustExperience(id), { ...input })),
    deleteExperience: async ({ id }) => (await deps.deleteExperience(await mustExperience(id))).id,

    startSession: onSession((s) => s.start()),
    sendMessage: onSession((s, { text }) => deps.sendMessage(s, text)),
    interruptSession: onSession((s) => s.interrupt()),
    stopSession: onSession((s) => s.stop()),
    resetSession: onSession((s) => s.reset()),
    setMode: onSession((s, { mode }) => s.setMode(mode)),
    answerRequest: onSession((s, { requestId, input }) => s.answer(requestId, { ...input })),
    runWorkflow: onSession(async (s, { workflowId }) => {
      const wf = (await deps.loadWorkflows()).find((w) => w.id === workflowId)
      if (!wf) throw new Error('No such workflow: ' + workflowId)
      await s.runWorkflow(wf)
    }),

    pullRemote: async ({ id, source, experience }) =>
      featureView(await deps.pullRemote(String(id), experience === undefined ? undefined : experience || null, source || undefined)),
  }

  // body: { query, variables?, operationName? }. Returns an HTTP status and a GraphQL response.
  async function execute(body) {
    const query = body?.query
    if (typeof query !== 'string' || !query.trim()) return { status: 400, result: { errors: [{ message: 'Body must be JSON with a "query" string' }] } }
    let doc
    try {
      doc = parse(query)
    } catch (e) {
      return { status: 400, result: { errors: [{ message: e.message, locations: e.locations }] } }
    }
    const invalid = validate(schema, doc, [...specifiedRules, depthLimit(MAX_DEPTH)])
    if (invalid.length) return { status: 400, result: { errors: invalid.map((e) => ({ message: e.message, locations: e.locations })) } }
    const result = await graphql({
      schema,
      source: query,
      rootValue: root,
      variableValues: body.variables && typeof body.variables === 'object' ? body.variables : undefined,
      operationName: typeof body.operationName === 'string' ? body.operationName : undefined,
    })
    return { status: 200, result }
  }

  return { schema, execute }
}
