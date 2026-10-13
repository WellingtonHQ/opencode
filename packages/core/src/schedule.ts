export * as ScheduleTask from "./schedule.js"

import { asc, and, desc, eq, lte, notInArray, sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Exit, Layer, Scope, Schema } from "effect"
import { Schedule } from "@opencode/schema/schedule"
import { Identifier } from "@opencode/schema/identifier"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "./bus.js"
import { Database } from "./database/database.js"
import { Location } from "./location.js"
import { ScheduleRunTable, ScheduleTaskTable } from "./schedule/sql.js"
import { nextRunAt } from "./schedule/time.js"
import { Session } from "./session.js"

export const ID = Schedule.ID
export type ID = Schedule.ID

export class InvalidSpecError extends Schema.TaggedError<InvalidSpecError>()("Schedule.InvalidSpecError", {
  message: Schema.String,
}) {}

export class LimitExceededError extends Schema.TaggedError<LimitExceededError>()("Schedule.LimitExceededError", {
  message: Schema.String,
}) {}

type Row = typeof ScheduleTaskTable.$inferSelect
type RunRow = typeof ScheduleRunTable.$inferSelect

const TICK_MS = 15_000
const MAX_TASKS = 50
const MAX_RUNS = 10

const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

export interface Interface {
  /** Returns every scheduled task. */
  readonly list: () => Effect.Effect<Schedule.Info[]>
  /** Returns one scheduled task by ID, or undefined when it does not exist. */
  readonly get: (id: ID) => Effect.Effect<Schedule.Info | undefined>
  /** Creates a scheduled task and computes its first next run time. */
  readonly create: (input: Schedule.CreateInput) => Effect.Effect<Schedule.Info, InvalidSpecError | LimitExceededError>
  /** Updates one or more fields of a scheduled task; recomputes the next run when the spec or time zone changes. */
  readonly update: (id: ID, updates: Schedule.UpdateInput) => Effect.Effect<Schedule.Info | undefined, InvalidSpecError>
  /** Removes a scheduled task and returns the removed record. */
  readonly remove: (id: ID) => Effect.Effect<Schedule.Info | undefined>
  /** Runs one scheduled task immediately regardless of its enabled state or next run time. */
  readonly runNow: (id: ID) => Effect.Effect<Schedule.Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ScheduleTask") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope

    const runFrom = (row: RunRow): Schedule.Run => ({
      taskID: row.task_id,
      ...(row.session_id ? { sessionID: row.session_id } : {}),
      status: row.status,
      startedAtMs: row.started_at,
      ...(row.finished_at !== null && row.finished_at !== undefined ? { finishedAtMs: row.finished_at } : {}),
      ...(row.error_text !== null && row.error_text !== undefined ? { errorText: row.error_text } : {}),
    })

    const runsFor = Effect.fn("ScheduleTask.runsFor")(function* (taskID: ID) {
      const rows = yield* db
        .select()
        .from(ScheduleRunTable)
        .where(eq(ScheduleRunTable.task_id, taskID))
        .orderBy(desc(ScheduleRunTable.started_at), desc(ScheduleRunTable.id))
        .limit(MAX_RUNS)
        .all()
        .pipe(Effect.orDie)
      return rows.map(runFrom)
    })

    const infoFrom = Effect.fn("ScheduleTask.infoFrom")(function* (row: Row) {
      const recentRuns = yield* runsFor(row.id)
      return {
        id: row.id,
        ...(row.name ? { name: row.name } : {}),
        prompt: row.prompt,
        spec: specFrom(row),
        timezone: row.timezone,
        ...(row.agent_id ? { agentId: row.agent_id } : {}),
        ...(row.model ? { model: row.model } : {}),
        directory: row.directory,
        enabled: row.enabled,
        nextRunAtMs: row.next_run_at_ms ?? undefined,
        lastRunAtMs: row.last_run_at_ms ?? undefined,
        ...(row.last_session_id ? { lastSessionId: row.last_session_id } : {}),
        ...(row.last_error !== null && row.last_error !== undefined ? { lastError: row.last_error } : {}),
        runCount: row.run_count,
        ...(recentRuns.length > 0 ? { recentRuns } : {}),
      }
    })

    // Inserts the new run row and prunes that task's history to the MAX_RUNS most recent rows.
    const recordRun = Effect.fn("ScheduleTask.recordRun")(function* (taskID: ID, runID: string, startedAtMs: number) {
      yield* db
        .insert(ScheduleRunTable)
        .values({ id: runID, task_id: taskID, status: "running", started_at: startedAtMs })
        .run()
        .pipe(Effect.orDie)
      const keep = yield* db
        .select({ id: ScheduleRunTable.id })
        .from(ScheduleRunTable)
        .where(eq(ScheduleRunTable.task_id, taskID))
        .orderBy(desc(ScheduleRunTable.started_at), desc(ScheduleRunTable.id))
        .limit(MAX_RUNS)
        .all()
        .pipe(Effect.orDie)
      if (keep.length < MAX_RUNS) return
      yield* db
        .delete(ScheduleRunTable)
        .where(and(eq(ScheduleRunTable.task_id, taskID), notInArray(ScheduleRunTable.id, keep.map((row) => row.id))))
        .run()
        .pipe(Effect.orDie)
    })

    const specFrom = (row: Row): Schedule.Spec => {
      if (row.kind === "once") return { kind: "once", atMs: row.at_ms ?? 0 }
      if (row.kind === "daily") return { kind: "daily", hour: row.hour ?? 0, minute: row.minute ?? 0 }
      if (row.kind === "weekly")
        return {
          kind: "weekly",
          days: (row.days ?? "").split(",").map((day) => Number(day)).filter((day) => day >= 0 && day <= 6),
          hour: row.hour ?? 0,
          minute: row.minute ?? 0,
        }
      return { kind: "cron", expr: row.expr ?? "" }
    }

    // Explicit nulls keep stale spec columns from leaking across kind switches.
    const specColumns = (spec: Schedule.Spec) =>
      spec.kind === "once"
        ? { kind: spec.kind, at_ms: spec.atMs, hour: null, minute: null, days: null, expr: null }
        : spec.kind === "daily"
          ? { kind: spec.kind, at_ms: null, hour: spec.hour, minute: spec.minute, days: null, expr: null }
          : spec.kind === "weekly"
            ? { kind: spec.kind, at_ms: null, hour: spec.hour, minute: spec.minute, days: spec.days.join(","), expr: null }
            : { kind: spec.kind, at_ms: null, hour: null, minute: null, days: null, expr: spec.expr }

    const computeNext = Effect.fn("ScheduleTask.computeNext")(function* (
      spec: Schedule.Spec,
      anchorMs: number,
      timezone: string,
    ) {
      if (!Schema.is(Schedule.TimeZone)(timezone))
        return yield* new InvalidSpecError({ message: `Invalid IANA time zone: ${timezone}` })
      return yield* Effect.tryPromise(() => nextRunAt(spec, anchorMs, timezone)).pipe(
        Effect.mapError((error) => new InvalidSpecError({ message: error instanceof Error ? error.message : String(error) })),
      )
    })

    const validateSpec = Effect.fn("ScheduleTask.validateSpec")(function* (
      spec: Schedule.Spec,
      anchorMs: number,
      timezone: string,
    ) {
      if (spec.kind === "once" && spec.atMs <= anchorMs)
        return yield* Effect.fail(new InvalidSpecError({ message: `The one-shot time ${new Date(spec.atMs).toISOString()} has already passed` }))
      return yield* computeNext(spec, anchorMs, timezone)
    })

    // Claims the row by conditionally bumping its next run time; a concurrent tick that moves the
    // timestamp first makes this update match no rows and the claim is lost.
    const fire = Effect.fn("ScheduleTask.fire")(function* (row: Row, claimNextMs?: number) {
      const now = Date.now()
      const spec = specFrom(row)
      const nextRunMs = spec.kind === "once" ? null : yield* computeNext(spec, now, row.timezone).pipe(Effect.orDie)
      const claimedRow = yield* db
        .update(ScheduleTaskTable)
        .set({
          last_run_at_ms: now,
          run_count: sql`${ScheduleTaskTable.run_count} + 1`,
          next_run_at_ms: nextRunMs,
          ...(spec.kind === "once" ? { enabled: false } : {}),
        })
        .where(
          claimNextMs === undefined
            ? eq(ScheduleTaskTable.id, row.id)
            : and(eq(ScheduleTaskTable.id, row.id), eq(ScheduleTaskTable.next_run_at_ms, claimNextMs)),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!claimedRow) return undefined

      const runID = `run_${Identifier.ascending()}`
      yield* recordRun(claimedRow.id, runID, now).pipe(Effect.orDie)

      const title = "[scheduled] " + (claimedRow.name ?? claimedRow.prompt.slice(0, 50))
      // Execution is forked into the service scope so tick never blocks and run-now responses
      // return before the prompt finishes.
      yield* Effect.gen(function* () {
        const created = yield* Effect.exit(
          sessions.create({
            title,
            location: Location.Ref.make({ directory: claimedRow.directory }),
            ...(claimedRow.agent_id ? { agent: claimedRow.agent_id } : {}),
            ...(claimedRow.model ? { model: claimedRow.model } : {}),
          }),
        )
        const sessionID = Exit.isSuccess(created) ? created.value.id : undefined
        const exit = Exit.isFailure(created)
          ? created
          : yield* Effect.gen(function* () {
              yield* db
                .transaction(() =>
                  Effect.gen(function* () {
                    yield* db
                      .update(ScheduleRunTable)
                      .set({ session_id: created.value.id })
                      .where(eq(ScheduleRunTable.id, runID))
                      .run()
                      .pipe(Effect.orDie)
                    yield* db
                      .update(ScheduleTaskTable)
                      .set({ last_session_id: created.value.id })
                      .where(eq(ScheduleTaskTable.id, claimedRow.id))
                      .run()
                      .pipe(Effect.orDie)
                  }),
                )
                .pipe(Effect.orDie)
              yield* sessions.prompt({ sessionID: created.value.id, text: claimedRow.prompt, resume: false })
              yield* sessions.resume(created.value.id)
            }).pipe(Effect.exit)
        const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        const lastError = failure === undefined ? undefined : failure instanceof Error ? failure.message : String(failure)
        yield* db
          .update(ScheduleRunTable)
          .set({
            session_id: sessionID ?? null,
            status: lastError === undefined ? "completed" : "failed",
            finished_at: Date.now(),
            error_text: lastError ?? null,
          })
          .where(eq(ScheduleRunTable.id, runID))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(ScheduleTaskTable)
          .set({ last_session_id: sessionID ?? null, last_error: lastError ?? null })
          .where(eq(ScheduleTaskTable.id, claimedRow.id))
          .run()
          .pipe(Effect.orDie)
        const fresh = yield* db.select().from(ScheduleTaskTable).where(eq(ScheduleTaskTable.id, claimedRow.id)).get().pipe(Effect.orDie)
        if (!fresh) return
        const info = yield* infoFrom(fresh)
        yield* announce(info)
      }).pipe(Effect.forkIn(scope))

      return yield* infoFrom(claimedRow)
    })

    // Publishes schedule.changed scoped to the task's directory so location-filtered event streams see it.
    const announce = (info: Schedule.Info) =>
      bus.publish(Schedule.Event.Changed, { info }, { location: { directory: info.directory } }).pipe(Effect.asVoid)

    const tick = Effect.fn("ScheduleTask.tick")(function* () {
      const now = Date.now()
      const due = yield* db
        .select()
        .from(ScheduleTaskTable)
        .where(and(eq(ScheduleTaskTable.enabled, true), lte(ScheduleTaskTable.next_run_at_ms, now)))
        .orderBy(asc(ScheduleTaskTable.next_run_at_ms))
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(due, (row) => fire(row, row.next_run_at_ms ?? undefined).pipe(Effect.asVoid), { discard: true })
    })

    const runTicks = Effect.fn("ScheduleTask.runTicks")(function* () {
      while (true) {
        yield* tick().pipe(Effect.catchCause((cause) => Effect.logError("Scheduled task tick failed", { cause })))
        yield* Effect.sleep(Duration.millis(TICK_MS))
      }
    })

    // A server restart interrupts in-flight runs; their rows would otherwise stay "running" forever.
    yield* db
      .update(ScheduleRunTable)
      .set({ status: "failed", finished_at: Date.now(), error_text: "Interrupted by server restart" })
      .where(eq(ScheduleRunTable.status, "running"))
      .run()
      .pipe(Effect.orDie)

    yield* runTicks().pipe(Effect.forkScoped)

    return Service.of({
      list: Effect.fn("ScheduleTask.list")(function* () {
        const rows = yield* db.select().from(ScheduleTaskTable).orderBy(asc(ScheduleTaskTable.time_created)).all().pipe(Effect.orDie)
        return yield* Effect.forEach(rows, (row) => infoFrom(row))
      }),
      get: Effect.fn("ScheduleTask.get")(function* (id) {
        const row = yield* db.select().from(ScheduleTaskTable).where(eq(ScheduleTaskTable.id, id)).get().pipe(Effect.orDie)
        if (!row) return undefined
        return yield* infoFrom(row)
      }),
      create: Effect.fn("ScheduleTask.create")(function* (input) {
        const now = Date.now()
        const timezone = input.timezone ?? localTimeZone()
        const next = yield* validateSpec(input.spec, now, timezone)
        const total = yield* db.select({ value: sql<number>`COUNT(*)` }).from(ScheduleTaskTable).get().pipe(Effect.orDie)
        if ((total?.value ?? 0) >= MAX_TASKS)
          return yield* Effect.fail(new LimitExceededError({ message: `The maximum number of scheduled tasks (${MAX_TASKS}) has been reached` }))
        const id = ID.create()
        yield* db
          .insert(ScheduleTaskTable)
          .values({
            id,
            name: input.name ?? null,
            prompt: input.prompt,
            ...specColumns(input.spec),
            timezone,
            agent_id: input.agentId ?? null,
            model: input.model ?? null,
            directory: input.directory,
            enabled: true,
            next_run_at_ms: next,
          })
          .run()
          .pipe(Effect.orDie)
        const info: Schedule.Info = {
          id,
          ...(input.name !== undefined ? { name: input.name } : {}),
          prompt: input.prompt,
          spec: input.spec,
          timezone,
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          directory: input.directory,
          enabled: true,
          nextRunAtMs: next ?? undefined,
          runCount: 0,
        }
        yield* announce(info)
        return info
      }),
      update: Effect.fn("ScheduleTask.update")(function* (id, updates) {
        const row = yield* db.select().from(ScheduleTaskTable).where(eq(ScheduleTaskTable.id, id)).get().pipe(Effect.orDie)
        if (!row) return undefined
        const timezone = updates.timezone ?? row.timezone
        const spec = updates.spec ?? specFrom(row)
        const specNext =
          updates.spec === undefined
            ? updates.timezone === undefined
              ? undefined
              : yield* computeNext(spec, Date.now(), timezone)
            : yield* validateSpec(spec, Date.now(), timezone)
        const updatedRow = yield* db
          .update(ScheduleTaskTable)
          .set({
            ...(updates.name !== undefined ? { name: updates.name } : {}),
            ...(updates.prompt !== undefined ? { prompt: updates.prompt } : {}),
            ...(updates.spec !== undefined ? specColumns(updates.spec) : {}),
            ...(updates.timezone !== undefined ? { timezone: updates.timezone } : {}),
            ...(specNext !== undefined ? { next_run_at_ms: specNext } : {}),
            ...(updates.agentId !== undefined ? { agent_id: updates.agentId } : {}),
            ...(updates.model !== undefined ? { model: updates.model } : {}),
            ...(updates.directory !== undefined ? { directory: updates.directory } : {}),
            ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
          })
          .where(eq(ScheduleTaskTable.id, id))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!updatedRow) return undefined
        const info = yield* infoFrom(updatedRow)
        yield* announce(info)
        return info
      }),
      remove: Effect.fn("ScheduleTask.remove")(function* (id) {
        const removed = yield* db.delete(ScheduleTaskTable).where(eq(ScheduleTaskTable.id, id)).returning().get().pipe(Effect.orDie)
        if (!removed) return undefined
        const info = yield* infoFrom(removed)
        yield* announce(info)
        return info
      }),
      runNow: Effect.fn("ScheduleTask.runNow")(function* (id) {
        const row = yield* db.select().from(ScheduleTaskTable).where(eq(ScheduleTaskTable.id, id)).get().pipe(Effect.orDie)
        if (!row) return undefined
        return yield* fire(row)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node, Session.node] })
