import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Schedule } from "@opencode-ai/schema/schedule"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ScheduleTask } from "@opencode-ai/core/schedule"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node, ScheduleTask.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

const directory = AbsolutePath.make("/schedules")

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

  it.effect("runs a fired session with the stored model and without one when cleared", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduleTask.Service
      const sessions = yield* SessionV2.Service
      const model = { id: Model.ID.make("qwen3.8-27b"), providerID: Provider.ID.make("normandysr1") } satisfies Model.Ref
      const created = yield* tasks.create({ prompt: "standup", spec: { kind: "once", atMs: Date.now() + 60_000 }, model, directory })

      const fired = yield* tasks.runNow(created.id)
      expect(fired?.lastSessionId).toBeDefined()
      if (fired === undefined || !fired.lastSessionId) throw new Error("runNow did not record a session")
      // Session reads normalize an absent variant to "default" (see session/info.ts), so the ref
      // round-trips through storage carrying that canonical value.
      const withModel = yield* sessions.get(fired.lastSessionId)
      expect(withModel.model).toEqual({ ...model, variant: Model.VariantID.make("default") })

      const cleared = yield* tasks.update(created.id, { model: null })
      if (cleared === undefined) throw new Error("update returned no record for an existing task")
      const refired = yield* tasks.runNow(created.id)
      expect(refired?.lastSessionId).toBeDefined()
      if (refired === undefined || !refired.lastSessionId) throw new Error("runNow did not record a session")
      const withoutModel = yield* sessions.get(refired.lastSessionId)
      expect(withoutModel.model).toBeUndefined()
    }),
  )
})
