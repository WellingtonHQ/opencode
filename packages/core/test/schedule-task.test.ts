import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Schedule } from "@opencode-ai/schema/schedule"
import { Session } from "@opencode-ai/schema/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Identifier } from "@opencode-ai/core/id/id"
import { ScheduleTask } from "@opencode-ai/core/schedule"
import { PromptRunner } from "@opencode-ai/core/schedule/executor"
import { ScheduleRunTable, ScheduleTaskTable } from "@opencode-ai/core/schedule/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const runnerCalls = new Array<PromptRunner.RunInput>()
let runnerFailure: string | undefined
const runnerStub = Layer.succeed(
  PromptRunner.Service,
  PromptRunner.Service.of({
    run: (input) => {
      runnerCalls.push(input)
      if (runnerFailure !== undefined) return Effect.fail(new Error(runnerFailure))
      return Effect.succeed(Session.ID.create())
    },
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, ScheduleTask.node]), [[PromptRunner.node, runnerStub]]),
)

const directory = AbsolutePath.make("/schedules")

// Fires the task and waits for its completion announcement; returns the announced record.
const fireAndAwait = (tasks: ScheduleTask.Interface, events: EventV2.Interface, id: Schedule.ID) =>
  Effect.gen(function* () {
    const listener = yield* events.subscribe(Schedule.Event.Changed).pipe(
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
      const events = yield* EventV2.Service
      const listener = yield* events.subscribe(Schedule.Event.Changed).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      const info = yield* tasks.create({ prompt: "standup", spec: { kind: "daily", hour: 9, minute: 0 }, directory })

      const [event] = Array.from(yield* Fiber.join(listener))
      expect(event?.type).toBe("schedule.changed")
      expect(event?.data).toEqual({ info })
      expect(event?.location).toEqual({ directory })
    }),
  )

  it.effect("announces an updated task with the recomputed record", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const events = yield* EventV2.Service
      const created = yield* tasks.create({ prompt: "standup", spec: { kind: "daily", hour: 9, minute: 0 }, directory })

      const listener = yield* events.subscribe(Schedule.Event.Changed).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const updated = yield* tasks.update(created.id, { name: "Morning standup", enabled: false })

      const [event] = Array.from(yield* Fiber.join(listener))
      expect(updated).toMatchObject({ id: created.id, name: "Morning standup", enabled: false })
      if (updated === undefined) throw new Error("update returned no record for an existing task")
      expect(event?.type).toBe("schedule.changed")
      expect(event?.data).toEqual({ info: updated })
    }),
  )

  it.effect("announces a removed task and leaves no readable record behind", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const events = yield* EventV2.Service
      const created = yield* tasks.create({ prompt: "cleanup", spec: { kind: "once", atMs: Date.now() + 60_000 }, directory })

      const listener = yield* events.subscribe(Schedule.Event.Changed).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
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

  it.effect("hands the scheduled title, agent, and model to the runner and records the finished run", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const events = yield* EventV2.Service
      runnerCalls.length = 0
      const agentId = Agent.ID.make("build")
      const model = { id: Model.ID.make("qwen3.8-27b"), providerID: Provider.ID.make("normandysr1") } satisfies Model.Ref
      const created = yield* tasks.create({
        name: "Standup",
        prompt: "standup",
        spec: { kind: "once", atMs: Date.now() + 60_000 },
        agentId,
        model,
        directory,
      })

      const listener = yield* events.subscribe(Schedule.Event.Changed).pipe(
        Stream.filter((event) => event.data.info.id === created.id && event.data.info.recentRuns?.[0]?.status === "completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* Effect.yieldNow

      const fired = yield* tasks.runNow(created.id)
      expect(fired?.recentRuns?.[0]?.status).toBe("running")

      const [event] = Array.from(yield* Fiber.join(listener))
      if (event === undefined) throw new Error("the run never completed")
      expect(event.data.info.lastSessionId).toBeDefined()
      expect(event.data.info.lastError).toBeUndefined()
      expect(event.data.info.recentRuns?.[0]).toMatchObject({ status: "completed", sessionID: event.data.info.lastSessionId })
      expect(runnerCalls).toEqual([{ directory, title: "[scheduled] Standup", promptText: "standup", agentId, model }])
    }),
  )

  it.effect("records a failed run with the error text on both the run and the task", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const events = yield* EventV2.Service
      runnerFailure = "provider exploded"
      try {
        const created = yield* tasks.create({ prompt: "cleanup", spec: { kind: "once", atMs: Date.now() + 60_000 }, directory })

        const finished = yield* fireAndAwait(tasks, events, created.id)
        expect(finished.lastError).toBe("provider exploded")
        expect(finished.recentRuns?.[0]).toMatchObject({ status: "failed", errorText: "provider exploded" })
      } finally {
        runnerFailure = undefined
      }
    }),
  )

  it.effect("keeps only the ten most recent runs after twelve fires", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      runnerCalls.length = 0

      const created = yield* tasks.create({ prompt: "heartbeat", spec: { kind: "once", atMs: Date.now() + 60_000 }, directory })
      for (let i = 0; i < 12; i++) {
        yield* fireAndAwait(tasks, events, created.id)
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
      const events = yield* EventV2.Service
      runnerCalls.length = 0

      const created = yield* tasks.create({ prompt: "twice", spec: { kind: "once", atMs: Date.now() + 60_000 }, directory })
      yield* fireAndAwait(tasks, events, created.id)
      yield* fireAndAwait(tasks, events, created.id)

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
      AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, ScheduleTask.node]), [
        [PromptRunner.node, runnerStub],
        [Database.node, Database.layerFromPath(file)],
      ])

    // First process: seed the task and an in-flight run row, then die.
    const taskID = Schedule.ID.create()
    await Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ScheduleTaskTable)
        .values({ id: taskID, prompt: "restart", kind: "once", at_ms: Date.now() + 60_000, directory })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ScheduleRunTable)
        .values({ id: Identifier.create("run", "ascending"), task_id: taskID, status: "running", started_at: Date.now() })
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
