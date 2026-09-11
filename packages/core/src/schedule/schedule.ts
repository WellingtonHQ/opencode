export * as ScheduleV2 from "./schedule"

import { Context, Duration, Effect, Layer, Option, Scope, Schedule, Schema } from "effect"
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Identifier } from "../id/id"
import { Location } from "../location"
import { LocationServiceMap } from "../location-service-map"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { ProviderV2 } from "../provider"
import { AbsolutePath } from "../schema"
import { SessionTable } from "../session/sql"
import { SessionV2 } from "../session"
import { makeGlobalNode } from "../effect/app-node"
import { isTimeHhMm, isValidDayList, latestSlot, minuteSlotOf, nextSlot, parseCron } from "./cron"
import { ScheduleRunTable, ScheduledTaskTable, type ScheduleRunRow, type ScheduledTaskRow } from "./sql"

export const ID = {
  create: (): string => Identifier.create("sch", "ascending"),
}

// v1 ships auto-approval only; add stricter modes by extending this literal and the responder in the layer below.
export type PermissionPolicy = "allow_all"

export type ScheduleSpec =
  | { readonly kind: "one_shot"; atMs: number }
  | { readonly kind: "daily"; timeHhMm: string }
  | { readonly kind: "weekly"; days: readonly number[]; timeHhMm: string }
  | { readonly kind: "cron"; expr: string }

export type ModelSelection = {
  readonly id: string
  readonly providerID: string
}

export type CreateInput = {
  readonly name: string
  readonly promptText: string
  readonly spec: ScheduleSpec
  readonly directory: string
  readonly agentId?: string
  readonly model?: ModelSelection
  readonly permissionPolicy?: PermissionPolicy
  readonly enabled?: boolean
}

// A replacement model; omit to keep the current one. v1 has no way to clear an agent or model once set.
export type UpdateInput = {
  readonly name?: string
  readonly promptText?: string
  readonly spec?: ScheduleSpec
  readonly directory?: string
  readonly agentId?: string
  readonly model?: ModelSelection
  readonly permissionPolicy?: PermissionPolicy
  readonly enabled?: boolean
}

export type TaskInfo = {
  readonly id: string
  readonly name: string
  readonly promptText: string
  readonly spec: ScheduleSpec
  readonly agentId?: string
  readonly model?: ModelSelection
  readonly permissionPolicy: PermissionPolicy
  readonly directory: string
  readonly enabled: boolean
  readonly lastFiredSlot: number | null
  readonly nextFireMs?: number
  readonly timeCreated: number
  readonly timeUpdated: number
}

export type TaskWithLatest = TaskInfo & {
  readonly latestRun?: RunInfo
}

export type RunStatus = "fired" | "catch_up" | "missed" | "error"

export type RunInfo = {
  readonly id: string
  readonly taskId: string
  readonly sessionId?: string
  readonly status: RunStatus
  readonly startedAt: number
  readonly finishedAt?: number
  readonly errorText?: string
}

export class ScheduleNotFoundError extends Schema.TaggedErrorClass<ScheduleNotFoundError>()("Schedule.NotFoundError", {
  id: Schema.String,
}) {}

export class InvalidSpecError extends Schema.TaggedErrorClass<InvalidSpecError>()("Schedule.InvalidSpecError", {
  message: Schema.String,
}) {}

export class PastOneShotError extends Schema.TaggedErrorClass<PastOneShotError>()("Schedule.PastOneShotError", {
  atMs: Schema.Number,
}) {}

export class RunFailedError extends Schema.TaggedErrorClass<RunFailedError>()("Schedule.RunFailedError", {
  taskId: Schema.String,
  message: Schema.String,
}) {}

export type Error = ScheduleNotFoundError | InvalidSpecError | PastOneShotError | RunFailedError

type LaunchFailure = {
  readonly sessionId?: string
  readonly message: string
}

// A claimed due slot. Carrying the slot keeps callers from re-deriving it when recording one-shot misses.
export type DueResult =
  | { readonly kind: "fire"; slotMs: number; isCatchUp: boolean }
  | { readonly kind: "missed_one_shot"; slotMs: number }

const MAX_RUNS = 50
const TICK_SECONDS = 30
// Drive letter, UNC share, or POSIX root.
const ABSOLUTE_DIRECTORY_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

export interface Interface {
  readonly list: (input?: { directory?: string }) => Effect.Effect<TaskWithLatest[]>
  readonly get: (id: string) => Effect.Effect<TaskInfo, ScheduleNotFoundError>
  readonly create: (input: CreateInput) => Effect.Effect<TaskInfo, InvalidSpecError | PastOneShotError>
  readonly update: (id: string, input: UpdateInput) => Effect.Effect<TaskInfo, Error>
  readonly delete: (id: string) => Effect.Effect<void, ScheduleNotFoundError>
  readonly listRuns: (taskID: string, limit?: number) => Effect.Effect<RunInfo[], ScheduleNotFoundError>
  // Manual trigger that does not advance the fire cursor; returns the created Session ID.
  readonly runNow: (id: string) => Effect.Effect<string, ScheduleNotFoundError | RunFailedError>
  // One scheduler pass over all enabled tasks; exposed so tests can drive the engine without waiting for ticks.
  readonly tick: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Schedule") {}

// Recurring specs are stored as cron expressions too, so both shapes share one evaluator.
function toCron(spec: Extract<ScheduleSpec, { kind: "daily" | "weekly" }>): string {
  const [hours, minutes] = spec.timeHhMm.split(":")
  return `${Number(minutes)} ${Number(hours)} * * ${spec.kind === "weekly" ? spec.days.join(",") : "*"}`
}

function recurringCron(spec: ScheduleSpec): string | undefined {
  if (spec.kind === "cron") return spec.expr
  if (spec.kind === "daily" || spec.kind === "weekly") return toCron(spec)
  return undefined
}

export function nextFireMs(spec: ScheduleSpec, fromMs: number): number | undefined {
  if (spec.kind === "one_shot") return spec.atMs > fromMs ? spec.atMs : undefined
  const expr = recurringCron(spec)
  const parsed = parseCron(expr ?? "* * * * *")
  if (!parsed.ok) return undefined
  return nextSlot(parsed.cron, fromMs)
}

export function latestDueSlot(
  spec: ScheduleSpec,
  lastFiredSlot: number | null | undefined,
  nowMs: number,
  upSinceMs: number,
): DueResult | undefined {
  if (spec.kind === "one_shot") {
    // Once fired the cursor is set; never due again.
    if (lastFiredSlot !== null && lastFiredSlot !== undefined) return undefined
    if (nowMs < spec.atMs) return undefined
    // Missed while this process was down: record it but do not run the prompt retroactively.
    return spec.atMs < upSinceMs ? { kind: "missed_one_shot", slotMs: spec.atMs } : { kind: "fire", slotMs: spec.atMs, isCatchUp: false }
  }
  const parsed = parseCron(recurringCron(spec) ?? "* * * * *")
  if (!parsed.ok) return undefined
  const slot = latestSlot(parsed.cron, nowMs, lastFiredSlot ?? 0)
  if (slot === undefined) return undefined
  // A catch-up run is a slot predating this process starting; it still executes exactly once.
  return { kind: "fire", slotMs: slot, isCatchUp: slot < upSinceMs }
}

function specProblem(spec: ScheduleSpec): string | undefined {
  if (spec.kind === "one_shot") return Number.isFinite(spec.atMs) ? undefined : "atMs must be a finite epoch-milliseconds value"
  if (spec.kind === "daily" || spec.kind === "weekly") {
    // isTimeHhMm already enforces hour/minute ranges, so the converted expression always parses.
    if (!isTimeHhMm(spec.timeHhMm)) return `${spec.kind} time must be HH:MM with hours 0-23 and minutes 0-59`
    if (spec.kind === "weekly" && !isValidDayList(spec.days)) return "weekly days must be a non-empty list of integers in 0-6 (Sunday=0)"
    return undefined
  }
  const parsed = parseCron(spec.expr)
  return parsed.ok ? undefined : `invalid cron expression "${spec.expr}": ${parsed.message}`
}

// Exact shape so the spread into insert/update values keeps every column required.
type SpecColumns = {
  readonly spec_kind: "one_shot" | "daily" | "weekly" | "cron"
  readonly one_shot_at: number | null
  readonly daily_time: string | null
  readonly weekly_days: number[] | null
  readonly cron_expr: string | null
}

function encodeSpecColumns(spec: ScheduleSpec): SpecColumns {
  if (spec.kind === "one_shot")
    return { spec_kind: "one_shot", one_shot_at: spec.atMs, daily_time: null, weekly_days: null, cron_expr: null }
  if (spec.kind === "daily" || spec.kind === "weekly")
    return {
      spec_kind: spec.kind,
      one_shot_at: null,
      daily_time: spec.timeHhMm,
      weekly_days: spec.kind === "weekly" ? [...spec.days] : null,
      cron_expr: null,
    }
  return { spec_kind: "cron", one_shot_at: null, daily_time: null, weekly_days: null, cron_expr: spec.expr }
}

function decodeSpec(row: ScheduledTaskRow): ScheduleSpec {
  if (row.spec_kind === "one_shot") return { kind: "one_shot", atMs: row.one_shot_at ?? 0 }
  if (row.spec_kind === "daily" || row.spec_kind === "weekly")
    return { kind: row.spec_kind, days: row.weekly_days ?? [], timeHhMm: row.daily_time ?? "00:00" }
  return { kind: "cron", expr: row.cron_expr ?? "* * * * *" }
}

function toItem(row: ScheduledTaskRow): TaskInfo {
  const spec = decodeSpec(row)
  return {
    id: row.id,
    name: row.name,
    promptText: row.prompt_text,
    spec,
    agentId: row.agent_id ?? undefined,
    model:
      row.model_provider_id && row.model_id ? { providerID: row.model_provider_id, id: row.model_id } : undefined,
    permissionPolicy: storedPolicy(row.permission_policy),
    directory: row.directory,
    enabled: row.enabled === 1,
    lastFiredSlot: row.last_fired_slot ?? null,
    nextFireMs: row.enabled ? nextFireMs(spec, Date.now()) : undefined,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}

function toRun(row: ScheduleRunRow): RunInfo {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id ?? undefined,
    status: row.status as RunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    errorText: row.error_text ?? undefined,
  }
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string") return error
  return JSON.stringify(error) ?? String(error)
}

type LaunchInfo = { policy: PermissionPolicy; directory: string }

function storedPolicy(value: string): PermissionPolicy {
  if (value === "allow_all") return value
  // Unknown persisted values fall back to the only policy v1 supports.
  return "allow_all"
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const sessions = yield* SessionV2.Service
    // Slot this process started; recurring slots before it are catch-up fires, after it are normal.
    const bootAt = Date.now()
    const scope = yield* Scope.Scope
    const locations = yield* LocationServiceMap.Service
    // Sessions we launched, remembered until process restart so asks can be auto-approved by session ID alone.
    const policies = new Map<string, LaunchInfo>()
    // Task IDs whose launch fiber is still running; prevents a tick from double-firing them.
    const inFlight = new Set<string>()

    const permissionReply = (directory: string, requestID: PermissionV2.ID) =>
      Effect.gen(function* () {
        const permissions = yield* PermissionV2.Service
        // Swallow the race where a human or another responder already settled the request.
        return yield* permissions.reply({ requestID, reply: "once" }).pipe(
          Effect.catchTag("PermissionV2.NotFoundError", () => Effect.void),
        )
      })

    const autoReply = (info: LaunchInfo, requestID: PermissionV2.ID) => {
      // Reply must run against the session's own location instance, since pending requests live there.
      return permissionReply(info.directory, requestID).pipe(
        // Instance lookup keeps the listener pure; the static wrapper would leave the map itself as a requirement.
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(info.directory) }))),
        // The location stack can fail or die for an arbitrary directory; keep the event loop alive and leave the ask manual.
        Effect.catchCause((cause) => Effect.logWarning("scheduled permission auto-reply failed", { cause })),
      )
    }

    // Headless equivalent of `opencode run --auto`: approve asks raised by sessions we launched under allow_all.
    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== PermissionV2.Event.Asked.type) return Effect.void
      // listen() payloads are untyped; validate against the ask schema before replying.
      const request = Schema.decodeUnknownOption(PermissionV2.Event.Asked.data)(event.data)
      return Option.match(request, {
        onNone: () => Effect.void,
        onSome: (asked) => {
          const info = policies.get(asked.sessionID)
          // Only scheduled sessions under allow_all are auto-approved; every other ask stays manual for now.
          if (!info || info.policy !== "allow_all") return Effect.void
          return autoReply(info, asked.id)
        },
      })
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    const record = (taskId: string, run: { status: RunStatus; startedAt: number; sessionId?: string; errorText?: string }) =>
      Effect.gen(function* () {
        yield* db
          .insert(ScheduleRunTable)
          .values({
            id: Identifier.create("srun", "ascending"),
            task_id: taskId,
            session_id: run.sessionId ?? null,
            status: run.status,
            started_at: run.startedAt,
            error_text: run.errorText ?? null,
          })
          .run()
          .pipe(Effect.orDie)
        // Keep per-task run history bounded.
        const rows = yield* db
          .select({ id: ScheduleRunTable.id })
          .from(ScheduleRunTable)
          .where(eq(ScheduleRunTable.task_id, taskId))
          .orderBy(desc(ScheduleRunTable.started_at), desc(ScheduleRunTable.time_created))
          .limit(MAX_RUNS + 1)
          .all()
          .pipe(Effect.orDie)
        if (rows.length <= MAX_RUNS) return
        yield* db
          .delete(ScheduleRunTable)
          .where(inArray(ScheduleRunTable.id, rows.slice(MAX_RUNS).map((row) => row.id)))
          .run()
          .pipe(Effect.orDie)
      })

    const launch = (row: ScheduledTaskRow): Effect.Effect<string, LaunchFailure> =>
      Effect.gen(function* () {
        const location = Location.Ref.make({ directory: AbsolutePath.make(row.directory) })
        const session = yield* sessions.create({
          location,
          agent: row.agent_id ? AgentV2.ID.make(row.agent_id) : undefined,
          model:
            row.model_provider_id && row.model_id
              ? { id: ModelV2.ID.make(row.model_id), providerID: ProviderV2.ID.make(row.model_provider_id) }
              : undefined,
        })
        // V2 create has no title input; set it after projection so the transcript shows where it came from.
        yield* db
          .update(SessionTable)
          .set({ title: `[scheduled] ${row.name}` })
          .where(eq(SessionTable.id, session.id))
          .run()
          .pipe(Effect.orDie)
        policies.set(session.id, { policy: storedPolicy(row.permission_policy), directory: row.directory })
        yield* sessions.prompt({ sessionID: session.id, prompt: { text: row.prompt_text } }).pipe(
          Effect.mapError((error): LaunchFailure => ({ sessionId: session.id, message: describe(error) })),
        )
        return session.id as string
      })

    const launchRun = (row: ScheduledTaskRow, status: Exclude<RunStatus, "missed" | "error">) =>
      launch(row).pipe(
        Effect.flatMap((sessionId) => record(row.id, { status, startedAt: Date.now(), sessionId })),
        Effect.catch((failure) =>
          record(row.id, {
            status: "error",
            startedAt: Date.now(),
            sessionId: failure.sessionId,
            errorText: failure.message,
          }),
        ),
      )

    const tick = Effect.fn("ScheduleV2.tick")(function* () {
      const now = Date.now()
      const rows = yield* db
        .select()
        .from(ScheduledTaskTable)
        .where(eq(ScheduledTaskTable.enabled, 1))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        if (inFlight.has(row.id)) continue
        const due = latestDueSlot(decodeSpec(row), row.last_fired_slot, now, bootAt)
        if (due === undefined) continue
        // Claim the slot before any side effect; an empty result means another process won the race.
        const claimed = yield* db
          .update(ScheduledTaskTable)
          .set({ last_fired_slot: due.slotMs })
          .where(
            and(
              eq(ScheduledTaskTable.id, row.id),
              or(isNull(ScheduledTaskTable.last_fired_slot), lt(ScheduledTaskTable.last_fired_slot, due.slotMs)),
            ),
          )
          .returning()
          .all()
          .pipe(Effect.orDie)
        if (claimed.length === 0) continue
        if (due.kind === "missed_one_shot") {
          yield* record(row.id, { status: "missed", startedAt: due.slotMs })
          continue
        }
        inFlight.add(row.id)
        yield* launchRun(row, due.isCatchUp ? "catch_up" : "fired").pipe(
          Effect.ensuring(Effect.sync(() => inFlight.delete(row.id))),
          Effect.forkIn(scope),
        )
      }
    })

    // The engine loop: one immediate pass so tasks due while the process was down are handled on boot, then every 30s.
    yield* tick().pipe(
      Effect.repeat(Schedule.spaced(Duration.seconds(TICK_SECONDS))),
      Effect.forkIn(scope),
    )

    const load = (id: string) =>
      db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get().pipe(
        Effect.orDie,
        Effect.flatMap((row) =>
          row ? Effect.succeed(row as ScheduledTaskRow) : Effect.fail(new ScheduleNotFoundError({ id })),
        ),
      )

    const get = (id: string) => load(id).pipe(Effect.map(toItem))

    const create = Effect.fn("ScheduleV2.create")(function* (input: CreateInput) {
      if (!input.name.trim()) return yield* new InvalidSpecError({ message: "name must not be empty" })
      if (!input.promptText.trim()) return yield* new InvalidSpecError({ message: "promptText must not be empty" })
      if (!ABSOLUTE_DIRECTORY_RE.test(input.directory))
        return yield* new InvalidSpecError({ message: "directory must be an absolute path" })
      const problem = specProblem(input.spec)
      if (problem) return yield* new InvalidSpecError({ message: problem })
      if (input.spec.kind === "one_shot" && input.spec.atMs <= Date.now())
        return yield* new PastOneShotError({ atMs: input.spec.atMs })

      const now = Date.now()
      const id = ID.create()
      // Recurring tasks seed the cursor with their creation minute so a mid-window slot is not re-fired as catch-up.
      const lastFiredSlot = input.spec.kind === "one_shot" ? null : minuteSlotOf(now)
      yield* db
        .insert(ScheduledTaskTable)
        .values({
          id,
          name: input.name.trim(),
          prompt_text: input.promptText,
          ...encodeSpecColumns(input.spec),
          agent_id: input.agentId ?? null,
          model_provider_id: input.model?.providerID ?? null,
          model_id: input.model?.id ?? null,
          permission_policy: input.permissionPolicy ?? "allow_all",
          directory: input.directory,
          enabled: (input.enabled ?? true) ? 1 : 0,
          last_fired_slot: lastFiredSlot,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      return {
        id,
        name: input.name.trim(),
        promptText: input.promptText,
        spec: input.spec,
        agentId: input.agentId,
        model: input.model,
        permissionPolicy: input.permissionPolicy ?? "allow_all",
        directory: input.directory,
        enabled: input.enabled ?? true,
        lastFiredSlot,
        nextFireMs: (input.enabled ?? true) ? nextFireMs(input.spec, now) : undefined,
        timeCreated: now,
        timeUpdated: now,
      }
    })

    const update = Effect.fn("ScheduleV2.update")(function* (id: string, input: UpdateInput) {
      if (input.spec !== undefined) {
        const problem = specProblem(input.spec)
        if (problem) return yield* new InvalidSpecError({ message: problem })
        if (input.spec.kind === "one_shot" && input.spec.atMs <= Date.now())
          return yield* new PastOneShotError({ atMs: input.spec.atMs })
      }
      const set: Partial<typeof ScheduledTaskTable.$inferInsert> = {}
      // Never touch last_fired_slot here: a stale cursor is always in the past and stays a valid lower bound for the next schedule.
      if (input.name !== undefined) {
        if (!input.name.trim()) return yield* new InvalidSpecError({ message: "name must not be empty" })
        set.name = input.name.trim()
      }
      if (input.promptText !== undefined) {
        if (!input.promptText.trim()) return yield* new InvalidSpecError({ message: "promptText must not be empty" })
        set.prompt_text = input.promptText
      }
      if (input.spec !== undefined) Object.assign(set, encodeSpecColumns(input.spec))
      if (input.directory !== undefined) {
        if (!ABSOLUTE_DIRECTORY_RE.test(input.directory))
          return yield* new InvalidSpecError({ message: "directory must be an absolute path" })
        set.directory = input.directory
      }
      if (input.agentId !== undefined) set.agent_id = input.agentId || null
      if (input.model !== undefined) {
        set.model_provider_id = input.model.providerID
        set.model_id = input.model.id
      }
      if (input.permissionPolicy !== undefined) set.permission_policy = input.permissionPolicy
      if (input.enabled !== undefined) set.enabled = input.enabled ? 1 : 0
      // The final reload also answers missing tasks, so a no-op update on an unknown ID still fails.
      if (Object.keys(set).length > 0)
        yield* db.update(ScheduledTaskTable).set(set).where(eq(ScheduledTaskTable.id, id)).run().pipe(Effect.orDie)
      return toItem(yield* load(id))
    })

    const remove = Effect.fn("ScheduleV2.delete")(function* (id: string) {
      yield* load(id)
      yield* db.transaction((tx) =>
        tx
          .delete(ScheduleRunTable)
          .where(eq(ScheduleRunTable.task_id, id))
          .run()
          .pipe(Effect.andThen(tx.delete(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).run())),
      ).pipe(Effect.orDie)
    })

    const listRuns = (taskID: string, limit?: number) =>
      load(taskID).pipe(
        Effect.andThen(() => {
          const query = db
            .select()
            .from(ScheduleRunTable)
            .where(eq(ScheduleRunTable.task_id, taskID))
            .orderBy(desc(ScheduleRunTable.started_at), desc(ScheduleRunTable.time_created))
          return (limit === undefined ? query.all() : query.limit(limit).all()).pipe(
            Effect.map((rows) => rows.map(toRun)),
            Effect.orDie,
          )
        }),
      )

    const list = (input?: { directory?: string }) =>
      Effect.gen(function* () {
        const base = db.select().from(ScheduledTaskTable)
        const query = input?.directory === undefined ? base : base.where(eq(ScheduledTaskTable.directory, input.directory))
        const rows = yield* query.all().pipe(Effect.orDie)
        if (rows.length === 0) return [] as TaskWithLatest[]
        const runRows = yield* db
          .select()
          .from(ScheduleRunTable)
          .where(inArray(ScheduleRunTable.task_id, rows.map((row) => row.id)))
          .orderBy(desc(ScheduleRunTable.started_at), desc(ScheduleRunTable.time_created))
          .all()
          .pipe(Effect.orDie)
        const latestByTask = new Map<string, RunInfo>()
        for (const run of runRows) {
          if (!latestByTask.has(run.task_id)) latestByTask.set(run.task_id, toRun(run))
        }
        return rows.map((row) => ({ ...toItem(row), latestRun: latestByTask.get(row.id) }))
      })

    const runNow = Effect.fn("ScheduleV2.runNow")(function* (id: string) {
      const row = yield* load(id)
      inFlight.add(row.id)
      return yield* launch(row).pipe(
        Effect.flatMap((sessionId) => record(id, { status: "fired", startedAt: Date.now(), sessionId }).pipe(Effect.as(sessionId))),
        Effect.catch((failure) =>
          record(id, {
            status: "error",
            startedAt: Date.now(),
            sessionId: failure.sessionId,
            errorText: failure.message,
          }).pipe(Effect.andThen(() => Effect.fail(new RunFailedError({ taskId: id, message: failure.message })))),
        ),
        Effect.ensuring(Effect.sync(() => inFlight.delete(row.id))),
      )
    })

    return Service.of({ list, get, create, update, delete: remove, listRuns, runNow, tick })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node, SessionV2.node, LocationServiceMap.node] })
