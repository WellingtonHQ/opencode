export * as ScheduleTask from "./schedule"

import { asc, and, eq, lte, sql } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { Schedule } from "@opencode-ai/schema/schedule"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { SessionV2 } from "./session"
import { ScheduleTaskTable } from "./schedule/sql"
import { nextRunAt } from "./schedule/time"

export const ID = Schedule.ID
export type ID = Schedule.ID

export class InvalidSpecError extends Schema.TaggedErrorClass<InvalidSpecError>()("Schedule.InvalidSpecError", {
  message: Schema.String,
}) {}

export class LimitExceededError extends Schema.TaggedErrorClass<LimitExceededError>()("Schedule.LimitExceededError", {
  message: Schema.String,
}) {}

type Row = typeof ScheduleTaskTable.$inferSelect

const TICK_MS = 15_000
const MAX_TASKS = 50

export interface Interface {
  /** Returns every scheduled task. */
  readonly list: () => Effect.Effect<Schedule.Info[]>
  /** Returns one scheduled task by ID, or undefined when it does not exist. */
  readonly get: (id: ID) => Effect.Effect<Schedule.Info | undefined>
  /** Creates a scheduled task and computes its first next run time. */
  readonly create: (input: Schedule.CreateInput) => Effect.Effect<Schedule.Info, InvalidSpecError | LimitExceededError>
  /** Updates one or more fields of a scheduled task; recomputes the next run when the spec changes. */
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
    const events = yield* EventV2.Service
    const sessions = yield* SessionV2.Service

    const infoFrom = (row: Row): Schedule.Info => ({
      id: row.id,
      ...(row.name ? { name: row.name } : {}),
      prompt: row.prompt,
      spec: specFrom(row),
      ...(row.agent_id ? { agentId: row.agent_id } : {}),
      directory: row.directory,
      enabled: row.enabled,
      nextRunAtMs: row.next_run_at_ms ?? undefined,
      lastRunAtMs: row.last_run_at_ms ?? undefined,
      ...(row.last_session_id ? { lastSessionId: row.last_session_id } : {}),
      ...(row.last_error !== null && row.last_error !== undefined ? { lastError: row.last_error } : {}),
      runCount: row.run_count,
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

    const validateSpec = Effect.fn("ScheduleTask.validateSpec")(function* (spec: Schedule.Spec, anchorMs: number) {
      if (spec.kind === "once" && spec.atMs <= anchorMs)
        return yield* Effect.fail(new InvalidSpecError({ message: `The one-shot time ${new Date(spec.atMs).toISOString()} has already passed` }))
      const next = yield* Effect.tryPromise(() => nextRunAt(spec, anchorMs)).pipe(
        Effect.mapError((error) => new InvalidSpecError({ message: error instanceof Error ? error.message : String(error) })),
      )
      return next
    })

    // Undefined means the spec was not updated and the stored next run time stays untouched.
    const recomputeNext = Effect.fn("ScheduleTask.recomputeNext")(function* (spec?: Schedule.Spec) {
      if (spec === undefined) return yield* Effect.succeed(undefined as number | null | undefined)
      return yield* validateSpec(spec, Date.now())
    })

    // Claims the row by conditionally bumping its next run time; a concurrent tick that moves the
    // timestamp first makes this update match no rows and the claim is lost.
    const fire = Effect.fn("ScheduleTask.fire")(function* (row: Row, claimNextMs?: number) {
      const now = Date.now()
      const spec = specFrom(row)
      const nextRunMs = spec.kind === "once" ? null : yield* Effect.tryPromise(() => nextRunAt(spec, now)).pipe(Effect.orDie)
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

      const outcome = yield* Effect.gen(function* () {
        const session = yield* sessions.create({
          location: { directory: claimedRow.directory },
          ...(claimedRow.agent_id ? { agent: claimedRow.agent_id } : {}),
        })
        yield* sessions.prompt({ sessionID: session.id, prompt: { text: claimedRow.prompt } })
        return session.id
      }).pipe(
        Effect.map((sessionID) => ({ sessionID, lastError: undefined as string | undefined })),
        Effect.catch((error) => Effect.succeed({ sessionID: undefined, lastError: error instanceof Error ? error.message : String(error) })),
      )
      yield* db
        .update(ScheduleTaskTable)
        .set({ last_session_id: outcome.sessionID ?? null, last_error: outcome.lastError ?? null })
        .where(eq(ScheduleTaskTable.id, claimedRow.id))
        .run()
        .pipe(Effect.orDie)
      const fresh = yield* db.select().from(ScheduleTaskTable).where(eq(ScheduleTaskTable.id, claimedRow.id)).get().pipe(Effect.orDie)
      if (!fresh) return undefined
      const info = infoFrom(fresh)
      yield* announce(info)
      return info
    })

    // Publishes schedule.changed scoped to the task's directory so location-filtered event streams see it.
    const announce = (info: Schedule.Info) => events.publish(Schedule.Event.Changed, { info }, { location: { directory: info.directory } }).pipe(Effect.asVoid)

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

    yield* runTicks().pipe(Effect.forkScoped)

    return Service.of({
      list: Effect.fn("ScheduleTask.list")(function* () {
        const rows = yield* db.select().from(ScheduleTaskTable).orderBy(asc(ScheduleTaskTable.time_created)).all().pipe(Effect.orDie)
        return rows.map(infoFrom)
      }),
      get: Effect.fn("ScheduleTask.get")(function* (id) {
        const row = yield* db.select().from(ScheduleTaskTable).where(eq(ScheduleTaskTable.id, id)).get().pipe(Effect.orDie)
        return row ? infoFrom(row) : undefined
      }),
      create: Effect.fn("ScheduleTask.create")(function* (input) {
        const now = Date.now()
        const next = yield* validateSpec(input.spec, now)
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
            agent_id: input.agentId ?? null,
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
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
          directory: input.directory,
          enabled: true,
          nextRunAtMs: next ?? undefined,
          runCount: 0,
        }
        yield* announce(info)
        return info
      }),
      update: Effect.fn("ScheduleTask.update")(function* (id, updates) {
        const specNext = yield* recomputeNext(updates.spec)
        const row = yield* db.select().from(ScheduleTaskTable).where(eq(ScheduleTaskTable.id, id)).get().pipe(Effect.orDie)
        if (!row) return undefined
        const updatedRow = yield* db
          .update(ScheduleTaskTable)
          .set({
            ...(updates.name !== undefined ? { name: updates.name } : {}),
            ...(updates.prompt !== undefined ? { prompt: updates.prompt } : {}),
            ...(updates.spec !== undefined ? specColumns(updates.spec) : {}),
            ...(specNext !== undefined ? { next_run_at_ms: specNext } : {}),
            ...(updates.agentId !== undefined ? { agent_id: updates.agentId } : {}),
            ...(updates.directory !== undefined ? { directory: updates.directory } : {}),
            ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
          })
          .where(eq(ScheduleTaskTable.id, id))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!updatedRow) return undefined
        const info = infoFrom(updatedRow)
        yield* announce(info)
        return info
      }),
      remove: Effect.fn("ScheduleTask.remove")(function* (id) {
        const removed = yield* db.delete(ScheduleTaskTable).where(eq(ScheduleTaskTable.id, id)).returning().get().pipe(Effect.orDie)
        if (!removed) return undefined
        const info = infoFrom(removed)
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

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node, SessionV2.node] })
