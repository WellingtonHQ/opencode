import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Agent } from "@opencode/schema/agent"
import { Identifier } from "@opencode/schema/identifier"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Schedule } from "@opencode/schema/schedule"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { ScheduleTask } from "@opencode/core/schedule"
import { ScheduleRunTable, ScheduleTaskTable } from "@opencode/core/schedule/sql"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { AbsolutePath } from "@opencode/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { promptLocationNode } from "./fixture/prompt-location"
import { globalProjectNode } from "./lib/project"
import { testEffect } from "./lib/effect"

const node = (execution = SessionExecution.noopLayer) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      ScheduleTask.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(execution),
    ],
  )

const it = testEffect(node())
const failedExecution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.die(new Error("provider exploded")),
    wake: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)
const failing = testEffect(node(failedExecution))

const directory = AbsolutePath.make("/schedules")

// Fires the task and waits for its completion announcement; returns the announced record.
const fireAndAwait = (tasks: ScheduleTask.Interface, bus: Bus.Interface, id: Schedule.ID) =>
  Effect.gen(function* () {
    const listener = yield* bus.subscribe(Schedule.Event.Changed).pipe(
      Stream.filter((event) => event.data.info.id === id),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    )
    yield* Effect.yieldNow

    const fired = yield* tasks.runNow(id)
    if (fired === undefined) return yield* Effect.fail(new Error("runNow returned no record"))

    const [event] = Array.from(yield* Fiber.join(listener))
    if (event === undefined) return yield* Effect.fail(new Error("the run never completed"))
    return event.data.info
  })

describe("ScheduleTask", () => {
  it.effect("announces a created task on schedule.changed scoped to its directory", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const bus = yield* Bus.Service
      const listener = yield* bus.subscribe(Schedule.Event.Changed).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      const info = yield* tasks.create({ prompt: "standup", spec: { kind: "daily", hour: 9, minute: 0 }, directory })

      const [event] = Array.from(yield* Fiber.join(listener))
      expect(event?.type).toBe("schedule.changed")
      expect(event?.data).toEqual({ info })
      expect(event?.location).toEqual({ directory })
      expect(info.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")
    }),
  )

  it.effect("announces an updated task with the recomputed record", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const bus = yield* Bus.Service
      const created = yield* tasks.create({ prompt: "standup", spec: { kind: "daily", hour: 9, minute: 0 }, directory })

      const listener = yield* bus.subscribe(Schedule.Event.Changed).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const updated = yield* tasks.update(created.id, { name: "Morning standup", enabled: false })

      const [event] = Array.from(yield* Fiber.join(listener))
      expect(updated).toMatchObject({ id: created.id, name: "Morning standup", enabled: false })
      if (updated === undefined) throw new Error("update returned no record for an existing task")
      expect(event?.type).toBe("schedule.changed")
      expect(event?.data).toEqual({ info: updated })
    }),
  )

  it.effect("stores a chosen timezone and recomputes the next run when it changes", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const { db } = yield* Database.Service
      const created = yield* tasks.create({
        prompt: "timezone",
        spec: { kind: "daily", hour: 9, minute: 0 },
        timezone: "America/New_York",
        directory,
      })
      const updated = yield* tasks.update(created.id, { timezone: "UTC" })
      if (updated === undefined) throw new Error("update returned no record for an existing task")

      expect(created.timezone).toBe("America/New_York")
      expect(updated.timezone).toBe("UTC")
      expect(updated.nextRunAtMs).not.toBe(created.nextRunAtMs)
      expect(
        yield* db
          .select({ timezone: ScheduleTaskTable.timezone })
          .from(ScheduleTaskTable)
          .where(eq(ScheduleTaskTable.id, created.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ timezone: "UTC" })
    }),
  )

  it.effect("announces a removed task and leaves no readable record behind", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const bus = yield* Bus.Service
      const created = yield* tasks.create({ prompt: "cleanup", spec: { kind: "once", atMs: Date.now() + 60_000 }, directory })

      const listener = yield* bus.subscribe(Schedule.Event.Changed).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const removed = yield* tasks.remove(created.id)

      const [event] = Array.from(yield* Fiber.join(listener))
      expect(removed?.id).toBe(created.id)
      if (removed === undefined) throw new Error("remove returned no record for an existing task")
      expect(event?.type).toBe("schedule.changed")
      expect(event?.data).toEqual({ info: removed })
      expect(yield* tasks.get(created.id)).toBeUndefined()
    }),
  )

  it.effect("stores a chosen model and clears it with an explicit null", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const first = { id: Model.ID.make("qwen3.8-27b"), providerID: Provider.ID.make("normandysr1") } satisfies Model.Ref
      const created = yield* tasks.create({ prompt: "standup", spec: { kind: "daily", hour: 9, minute: 0 }, model: first, directory })
      expect(created.model).toEqual(first)

      const second = { id: Model.ID.make("gpt-5"), providerID: Provider.ID.make("openai") } satisfies Model.Ref
      const updated = yield* tasks.update(created.id, { model: second })
      if (updated === undefined) throw new Error("update returned no record for an existing task")
      expect(updated.model).toEqual(second)

      const cleared = yield* tasks.update(created.id, { model: null })
      if (cleared === undefined) throw new Error("update returned no record for an existing task")
      expect(cleared.model).toBeUndefined()
    }),
  )

  it.effect("creates a Session, admits one prompt, and records its run before resuming", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service
      const agentId = Agent.ID.make("build")
      const model = { id: Model.ID.make("qwen3.8-27b"), providerID: Provider.ID.make("normandysr1") } satisfies Model.Ref
      const created = yield* tasks.create({
        name: "Standup",
        prompt: "standup",
        spec: { kind: "once", atMs: Date.now() + 60_000 },
        timezone: "America/New_York",
        agentId,
        model,
        directory,
      })

      const listener = yield* bus.subscribe(Schedule.Event.Changed).pipe(
        Stream.filter((event) => event.data.info.id === created.id && event.data.info.recentRuns?.[0]?.status === "completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* Effect.yieldNow

      const fired = yield* tasks.runNow(created.id)
      expect(fired?.recentRuns?.[0]?.status).toBeDefined()

      const [event] = Array.from(yield* Fiber.join(listener))
      if (event === undefined) throw new Error("the run never completed")
      const sessionID = event.data.info.lastSessionId
      if (sessionID === undefined) throw new Error("the scheduled run has no Session ID")
      expect(event.data.info.timezone).toBe("America/New_York")
      expect(event.data.info.lastError).toBeUndefined()
      expect(event.data.info.recentRuns?.[0]).toMatchObject({ status: "completed", sessionID })

      const session = yield* sessions.get(sessionID)
      expect(session).toMatchObject({
        title: "[scheduled] Standup",
        agent: agentId,
        model,
        location: { directory },
      })
      expect(yield* sessions.inbox(sessionID)).toMatchObject([{ type: "user", payload: { text: "standup" } }])
    }),
  )

  failing.effect("records a failed Session execution on both the run and the task", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const bus = yield* Bus.Service
      const created = yield* tasks.create({ prompt: "cleanup", spec: { kind: "once", atMs: Date.now() + 60_000 }, directory })

      const finished = yield* fireAndAwait(tasks, bus, created.id)
      expect(finished.lastError).toBe("provider exploded")
      expect(finished.recentRuns?.[0]).toMatchObject({ status: "failed", errorText: "provider exploded" })
    }),
  )

  it.effect("keeps only the ten most recent runs after twelve fires", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service

      const created = yield* tasks.create({ prompt: "heartbeat", spec: { kind: "once", atMs: Date.now() + 60_000 }, directory })
      for (let i = 0; i < 12; i++) {
        yield* fireAndAwait(tasks, bus, created.id)
      }

      const info = yield* tasks.get(created.id)
      if (info === undefined) throw new Error("task disappeared")
      expect(info.runCount).toBe(12)
      expect(info.recentRuns?.length).toBe(10)
      for (let i = 1; i < (info.recentRuns?.length ?? 0); i++) {
        expect(info.recentRuns![i - 1].startedAtMs).toBeGreaterThanOrEqual(info.recentRuns![i].startedAtMs)
      }

      const rows = yield* db.select().from(ScheduleRunTable).where(eq(ScheduleRunTable.task_id, created.id)).all().pipe(Effect.orDie)
      expect(rows.length).toBe(10)
    }),
  )

  it.effect("includes recent runs in list and get, newest first", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const bus = yield* Bus.Service

      const created = yield* tasks.create({ prompt: "twice", spec: { kind: "once", atMs: Date.now() + 60_000 }, directory })
      yield* fireAndAwait(tasks, bus, created.id)
      yield* fireAndAwait(tasks, bus, created.id)

      const listed = (yield* tasks.list()).find((task) => task.id === created.id)
      expect(listed?.recentRuns?.length).toBe(2)
      if (listed?.recentRuns !== undefined && listed.recentRuns.length === 2) {
        expect(listed.recentRuns[0].startedAtMs).toBeGreaterThanOrEqual(listed.recentRuns[1].startedAtMs)
      }

      const fetched = yield* tasks.get(created.id)
      expect(fetched?.recentRuns?.length).toBe(2)
    }),
  )

  test("marks runs left running by a previous process as failed on startup", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "restart.sqlite")
    // Each runtime builds the full service stack against one shared database file.
    const layerFor = (file: string) =>
      AppNodeBuilder.build(LayerNode.group([
        Database.node,
        Bus.node,
        Project.node,
        SessionProjector.node,
        SessionStore.node,
        Session.node,
        ScheduleTask.node,
      ]), [
        Bus.node.replace(Bus.configured({ persist: true })),
        Project.node.replace(globalProjectNode),
        LocationServiceMap.node.replace(promptLocationNode),
        SessionExecution.node.replace(SessionExecution.noopLayer),
        Database.node.replace(Database.configured({ path: file })),
      ])

    // First process: seed the task and an in-flight run row, then die.
    const taskID = Schedule.ID.create()
    await Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ScheduleTaskTable)
        .values({ id: taskID, prompt: "restart", kind: "once", at_ms: Date.now() + 60_000, timezone: "UTC", directory })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ScheduleRunTable)
        .values({ id: `run_${Identifier.ascending()}`, task_id: taskID, status: "running", started_at: Date.now() })
        .run()
        .pipe(Effect.orDie)
    }).pipe(Effect.provide(layerFor(filename)), Effect.runPromise)

    // Second process (restart): the orphaned run must be failed.
    const info = await Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      return yield* tasks.get(taskID)
    }).pipe(Effect.provide(layerFor(filename)), Effect.runPromise)
    if (info === undefined) throw new Error("task disappeared")
    expect(info.recentRuns?.[0]).toMatchObject({ status: "failed", errorText: "Interrupted by server restart" })
  })
})
