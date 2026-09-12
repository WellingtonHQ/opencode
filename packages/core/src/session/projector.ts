export * as SessionProjector from "./projector"

import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionMessage } from "./message"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { WorkspaceV2 } from "../workspace"
import { MessageTable, PartTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import type { DeepMutable } from "../schema"

type DatabaseService = Database.Interface["db"]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

function usage(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] | unknown): Usage | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  if (!("cost" in value) || !("tokens" in value)) return undefined
  return { cost: value.cost as Usage["cost"], tokens: value.tokens as Usage["tokens"] }
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ? { ...info.revert, messageID: SessionMessage.ID.make(info.revert.messageID) } : null,
    permission: info.permission ? [...info.permission] : undefined,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function messageData(
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
): typeof MessageTable.$inferInsert.data {
  const { id: _, sessionID: __, ...rest } = info
  return rest as DeepMutable<typeof rest>
}

function partData(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]): typeof PartTable.$inferInsert.data {
  const { id: _, messageID: __, sessionID: ___, ...rest } = part
  return rest as DeepMutable<typeof rest>
}

function applyUsage(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  value: Usage,
  sign = 1,
) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

const decodeSessionMessage = (row: typeof SessionMessageTable.$inferSelect) =>
  decodeMessage({ ...row.data, id: row.id, type: row.type })

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const updateMessage = (message: SessionMessage.Message) => {
      if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, event.data.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeSessionMessage(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeSessionMessage(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows
            .map(decodeSessionMessage)
            .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
    yield* syncLegacyMirror(db, event.data.sessionID)
  })
}

// The legacy UI reads sessions from the `message`/`part` tables, while V2 runs
// are projected into `session_message`. This keeps a derived mirror of every
// V2 user/assistant row in the legacy tables. It is an idempotent full-session
// recompute: message ids reuse the V2 ids, part ids are deterministic per
// content index (content entries only ever append), and session usage counters
// reconcile against the step-finish parts currently stored for this mirror.
export function syncLegacyMirror(db: DatabaseService, sessionID: (typeof SessionTable.$inferSelect)["id"]) {
  return Effect.gen(function* () {
    const session = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!session) return

    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), inArray(SessionMessageTable.type, ["user", "assistant"])))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    const messages = rows.map(decodeSessionMessage)
    if (messages.length === 0) return

    const targets = buildMirrorTargets(messages, session)
    if (targets.length === 0) {
      // Prompts only admit user rows once a step has resolved their agent/model; sync again when that lands.
      yield* applyLegacyTitle(db, sessionID, session.title, messages)
      return
    }

    const existing = yield* db
      .select({ id: PartTable.id, data: PartTable.data })
      .from(PartTable)
      .where(and(eq(PartTable.session_id, sessionID), inArray(PartTable.message_id, targets.map((target) => target.id))))
      .all()
      .pipe(Effect.orDie)

    const current = { cost: 0, tokens: zeroTokens() }
    for (const row of existing) {
      const value = usage(row.data)
      if (!value) continue
      current.cost += value.cost
      addTokens(current.tokens, value.tokens, 1)
    }
    let nextCost = 0
    const nextTokens = zeroTokens()
    for (const target of targets) {
      nextCost += target.usage.cost
      addTokens(nextTokens, target.usage.tokens, 1)
    }
    const delta: Usage = { cost: nextCost - current.cost, tokens: differenceTokens(nextTokens, current.tokens) }
    if (usageIsNonZero(delta)) yield* applyUsage(db, sessionID, delta)

    for (const target of targets) {
      yield* db
        .insert(MessageTable)
        .values({
          id: target.id,
          session_id: sessionID,
          time_created: target.timeCreated,
          data: legacyData(target.messageData),
        })
        .onConflictDoUpdate({ target: MessageTable.id, set: { data: legacyData(target.messageData) } })
        .run()
        .pipe(Effect.orDie)
    }

    const kept = new Set<string>()
    for (const target of targets) {
      for (const part of target.parts) {
        kept.add(String(part.id))
        yield* db
          .insert(PartTable)
          .values({
            id: part.id,
            message_id: target.id,
            session_id: sessionID,
            time_created: target.timeCreated,
            data: legacyData(part.data),
          })
          .onConflictDoUpdate({ target: PartTable.id, set: { data: legacyData(part.data) } })
          .run()
          .pipe(Effect.orDie)
      }
    }

    const stale = existing.filter((row) => !kept.has(String(row.id)))
    if (stale.length > 0)
      yield* db
        .delete(PartTable)
        .where(and(eq(PartTable.session_id, sessionID), inArray(PartTable.id, stale.map((row) => row.id))))
        .run()
        .pipe(Effect.orDie)

    yield* applyLegacyTitle(db, sessionID, session.title, messages)
  })
}

type MirrorTarget = {
  id: SessionV1.MessageID
  timeCreated: number
  messageData: Record<string, unknown>
  parts: Array<{ id: SessionV1.PartID; data: Record<string, unknown> }>
  usage: Usage
}

const zeroTokens = (): Usage["tokens"] => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

function addTokens(target: Usage["tokens"], value: Usage["tokens"], sign = 1) {
  target.input += value.input * sign
  target.output += value.output * sign
  target.reasoning += value.reasoning * sign
  target.cache.read += value.cache.read * sign
  target.cache.write += value.cache.write * sign
}

function differenceTokens(next: Usage["tokens"], previous: Usage["tokens"]): Usage["tokens"] {
  return {
    input: next.input - previous.input,
    output: next.output - previous.output,
    reasoning: next.reasoning - previous.reasoning,
    cache: { read: next.cache.read - previous.cache.read, write: next.cache.write - previous.cache.write },
  }
}

function usageIsNonZero(value: Usage) {
  return (
    value.cost !== 0 ||
    value.tokens.input !== 0 ||
    value.tokens.output !== 0 ||
    value.tokens.reasoning !== 0 ||
    value.tokens.cache.read !== 0 ||
    value.tokens.cache.write !== 0
  )
}

function legacyData<T>(value: Record<string, unknown>): T {
  // V1 message/part data is stored as raw JSON; the shapes built below satisfy the schema fields.
  return value as unknown as T
}

function legacyMessageID(id: SessionMessage.ID) {
  return SessionV1.MessageID.ascending(String(id))
}

// Part ids must order lexicographically to occurrence order, because legacy reads sort parts by id.
function mirrorPartID(messageID: SessionMessage.ID, index: number) {
  const suffix = String(messageID).replace(/^msg_/, "")
  return SessionV1.PartID.ascending(`prt_${suffix}_${index.toString().padStart(4, "0")}`)
}

const DEFAULT_SESSION_TITLE = /^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/

function applyLegacyTitle(
  db: DatabaseService,
  sessionID: (typeof SessionTable.$inferSelect)["id"],
  title: string,
  messages: SessionMessage.Message[],
) {
  return Effect.gen(function* () {
    if (!DEFAULT_SESSION_TITLE.test(title)) return yield* Effect.void
    const user = messages.find((message): message is SessionMessage.User => message.type === "user" && message.text.trim() !== "")
    if (!user) return yield* Effect.void
    const next = user.text.replace(/\s+/g, " ").trim().slice(0, 80)
    if (next === "") return yield* Effect.void
    yield* db
      .update(SessionTable)
      .set({ title: next, time_updated: Date.now() })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
  })
}

function toolTitle(toolName: string, input: Record<string, unknown>) {
  for (const key of ["command", "filePath", "file_path", "path", "pattern", "query", "url"]) {
    const value = input[key]
    if (typeof value === "string" && value !== "") return value
  }
  return toolName
}

function legacyToolState(tool: SessionMessage.AssistantTool) {
  const start = tool.time.ran !== undefined ? DateTime.toEpochMillis(tool.time.ran) : DateTime.toEpochMillis(tool.time.created)
  if (tool.state.status === "pending")
    return { status: "pending", input: {}, raw: tool.state.input } as Record<string, unknown>
  if (tool.state.status === "running")
    return { status: "running", input: tool.state.input, time: { start } } as Record<string, unknown>
  const end = tool.time.completed !== undefined ? DateTime.toEpochMillis(tool.time.completed) : start
  if (tool.state.status === "completed") {
    const output = tool.state.content.map((item) => (item.type === "text" ? item.text : "")).join("")
    return {
      status: "completed",
      input: tool.state.input,
      output,
      title: toolTitle(tool.name, tool.state.input),
      metadata: tool.provider?.resultMetadata ?? {},
      time: { start, end },
      ...(tool.state.attachments
        ? { attachments: tool.state.attachments.map((file) => ({ mime: file.mime, filename: file.name, url: file.uri })) }
        : {}),
    } as Record<string, unknown>
  }
  return {
    status: "error",
    input: tool.state.input,
    error: tool.state.error.message,
    time: { start, end },
  } as Record<string, unknown>
}

function buildMirrorTargets(messages: SessionMessage.Message[], session: typeof SessionTable.$inferSelect): MirrorTarget[] {
  const targets: MirrorTarget[] = []
  let parentID: SessionMessage.ID | undefined
  for (let index = 0; index < messages.length; index++) {
    const row = messages[index]!
    if (row.type === "user") {
      // The user prompt does not carry agent/model in the V2 store; resolve them from the session or the next step.
      const nextAssistant = messages.slice(index + 1).find((item): item is SessionMessage.Assistant => item.type === "assistant")
      const agent = session.agent ?? nextAssistant?.agent
      const model = session.model
        ? { providerID: session.model.providerID, modelID: session.model.id, ...(session.model.variant !== undefined ? { variant: session.model.variant } : {}) }
        : nextAssistant
          ? { providerID: nextAssistant.model.providerID, modelID: nextAssistant.model.id }
          : undefined
      if (!agent || !model) continue
      const parts: MirrorTarget["parts"] = []
      let partIndex = 0
      if (row.text !== "") parts.push({ id: mirrorPartID(row.id, partIndex++), data: { type: "text", text: row.text } })
      for (const file of row.files ?? [])
        parts.push({ id: mirrorPartID(row.id, partIndex++), data: { type: "file", mime: file.mime, filename: file.name, url: file.uri } })
      const created = DateTime.toEpochMillis(row.time.created)
      targets.push({
        id: legacyMessageID(row.id),
        timeCreated: created,
        messageData: { role: "user", time: { created }, agent, model },
        parts,
        usage: { cost: 0, tokens: zeroTokens() },
      })
      parentID = row.id
      continue
    }
    if (row.type !== "assistant") continue

    const createdMs = DateTime.toEpochMillis(row.time.created)
    const completedMs = row.time.completed !== undefined ? DateTime.toEpochMillis(row.time.completed) : undefined
    const finished = completedMs !== undefined
    const tokens = finished && row.tokens ? row.tokens : zeroTokens()
    const parts: MirrorTarget["parts"] = []
    let partIndex = 0
    parts.push({
      id: mirrorPartID(row.id, partIndex++),
      data: { type: "step-start", ...(row.snapshot?.start !== undefined ? { snapshot: row.snapshot.start } : {}) },
    })
    for (const item of row.content) {
      if (item.type === "text") {
        parts.push({ id: mirrorPartID(row.id, partIndex++), data: { type: "text", text: item.text } })
        continue
      }
      if (item.type === "reasoning") {
        const startedAt = item.time && item.time.created !== undefined ? DateTime.toEpochMillis(item.time.created) : createdMs
        const endedAt = item.time && item.time.completed !== undefined ? DateTime.toEpochMillis(item.time.completed) : undefined
        parts.push({
          id: mirrorPartID(row.id, partIndex++),
          data: {
            type: "reasoning",
            text: item.text,
            time: { start: startedAt, end: endedAt },
            ...(item.providerMetadata ? { metadata: item.providerMetadata } : {}),
          },
        })
        continue
      }
      parts.push({ id: mirrorPartID(row.id, partIndex++), data: { type: "tool", callID: item.id, tool: item.name, state: legacyToolState(item) } })
    }
    if (finished)
      parts.push({
        id: mirrorPartID(row.id, partIndex++),
        data: {
          type: "step-finish",
          reason: row.finish ?? "stop",
          cost: row.cost ?? 0,
          tokens,
          ...(row.snapshot?.end !== undefined ? { snapshot: row.snapshot.end } : {}),
        },
      })
    targets.push({
      id: legacyMessageID(row.id),
      timeCreated: createdMs,
      messageData: {
        role: "assistant",
        time: { created: createdMs, ...(completedMs !== undefined ? { completed: completedMs } : {}) },
        parentID: legacyMessageID(parentID ?? row.id),
        modelID: row.model.id,
        providerID: row.model.providerID,
        mode: row.agent,
        agent: row.agent,
        path: { cwd: session.directory, root: session.directory },
        cost: finished ? (row.cost ?? 0) : 0,
        tokens,
        ...(row.finish !== undefined ? { finish: row.finish } : {}),
        ...(row.error !== undefined ? { error: { name: "UnknownError", data: { message: row.error.message } } } : {}),
      },
      parts,
      usage: finished ? { cost: row.cost ?? 0, tokens } : { cost: 0, tokens: zeroTokens() },
    })
  }
  return targets
}

// Drops the legacy mirror rows for V2 messages that are leaving the aggregate (revert commit).
function removeMirrorMessages(db: DatabaseService, sessionID: (typeof SessionTable.$inferSelect)["id"], messageIDs: readonly SessionMessage.ID[]) {
  if (messageIDs.length === 0) return Effect.void
  const ids = messageIDs.map((id) => legacyMessageID(id))
  return Effect.gen(function* () {
    const parts = yield* db
      .select({ data: PartTable.data })
      .from(PartTable)
      .where(and(eq(PartTable.session_id, sessionID), inArray(PartTable.message_id, ids)))
      .all()
      .pipe(Effect.orDie)
    const removed: Usage = { cost: 0, tokens: zeroTokens() }
    for (const row of parts) {
      const value = usage(row.data)
      if (!value) continue
      removed.cost += value.cost
      addTokens(removed.tokens, value.tokens, -1)
    }
    if (usageIsNonZero(removed)) yield* applyUsage(db, sessionID, removed)
    yield* db
      .delete(MessageTable)
      .where(and(eq(MessageTable.session_id, sessionID), inArray(MessageTable.id, ids)))
      .run()
      .pipe(Effect.orDie)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.durable.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    yield* events.project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionV1.Event.Updated, (event) =>
      db
        .update(SessionTable)
        .set(sessionRow(event.data.info))
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.Deleted, (event) =>
      db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie),
    )
    yield* events.project(SessionV1.Event.MessageUpdated, (event) =>
      Effect.gen(function* () {
        const time_created = event.data.info.time.created
        const id = event.data.info.id
        const sessionID = event.data.info.sessionID
        const data = messageData(event.data.info)
        yield* db
          .insert(MessageTable)
          .values({ id, session_id: sessionID, time_created, data })
          .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageRemoved, (event) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.message_id, event.data.messageID), eq(PartTable.session_id, event.data.sessionID)))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const previous = usage(row.data)
          if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        }
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .get()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        yield* db
          .delete(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      Effect.gen(function* () {
        const id = event.data.part.id
        const messageID = event.data.part.messageID
        const sessionID = event.data.part.sessionID
        const data = partData(event.data.part)
        const row = yield* db.select().from(PartTable).where(eq(PartTable.id, id)).get().pipe(Effect.orDie)
        yield* db
          .insert(PartTable)
          .values({ id, message_id: messageID, session_id: sessionID, time_created: event.data.time, data })
          .onConflictDoUpdate({ target: PartTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        const next = usage(event.data.part)
        if (previous) yield* applyUsage(db, row.session_id, previous, -1)
        if (next) yield* applyUsage(db, sessionID, next)
      }),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectPrompted(db, {
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
        })
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.ContextUpdated, (event) => run(db, event))
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    // yield* events.project(SessionEvent.Retried, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.RevertEvent.Staged, (event) =>
      db
        .update(SessionTable)
        .set({
          revert: { ...event.data.revert, files: event.data.revert.files ? [...event.data.revert.files] : undefined },
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        const boundary = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, event.data.sessionID),
              eq(SessionMessageTable.id, event.data.messageID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!boundary) return yield* Effect.die(`Revert boundary message not found: ${event.data.messageID}`)
        const doomed = yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gt(SessionMessageTable.seq, boundary.seq)),
          )
          .all()
          .pipe(Effect.orDie)
        yield* removeMirrorMessages(db, event.data.sessionID, doomed.map((row) => row.id))
        yield* db
          .delete(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gt(SessionMessageTable.seq, boundary.seq)),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, event.data.sessionID),
              or(gt(SessionInputTable.admitted_seq, boundary.seq), gt(SessionInputTable.promoted_seq, boundary.seq)),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* syncLegacyMirror(db, event.data.sessionID)
      }),
    )
  }),
)

export const node = makeGlobalNode({ name: "session-projector", layer, deps: [EventV2.node, Database.node] })
