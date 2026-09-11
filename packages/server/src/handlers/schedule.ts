import { ScheduleTask } from "@opencode-ai/core/schedule"
import { InvalidRequestError, ScheduleLimitExceededError, ScheduleNotFoundError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

const badSpec = <A, R>(effect: Effect.Effect<A, ScheduleTask.InvalidSpecError, R>) =>
  effect.pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message })))

const badCreate = <A, R>(effect: Effect.Effect<A, ScheduleTask.InvalidSpecError | ScheduleTask.LimitExceededError, R>) =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        error instanceof ScheduleTask.LimitExceededError
          ? new ScheduleLimitExceededError({ message: error.message })
          : new InvalidRequestError({ message: error.message }),
    ),
  )

export const ScheduleHandler = HttpApiBuilder.group(Api, "server.schedule", (handlers) =>
  handlers
    .handle(
      "schedule.list",
      Effect.fn(function* () {
        const schedule = yield* ScheduleTask.Service
        return yield* schedule.list()
      }),
    )
    .handle(
      "schedule.get",
      Effect.fn(function* (ctx) {
        const schedule = yield* ScheduleTask.Service
        const info = yield* schedule.get(ctx.params.scheduleID)
        if (!info) return yield* Effect.fail(notFound(ctx.params.scheduleID))
        return info
      }),
    )
    .handle(
      "schedule.create",
      Effect.fn(function* (ctx) {
        const schedule = yield* ScheduleTask.Service
        return yield* badCreate(schedule.create(ctx.payload))
      }),
    )
    .handle(
      "schedule.update",
      Effect.fn(function* (ctx) {
        const schedule = yield* ScheduleTask.Service
        const updated = yield* badSpec(schedule.update(ctx.params.scheduleID, ctx.payload))
        if (!updated) return yield* Effect.fail(notFound(ctx.params.scheduleID))
        return updated
      }),
    )
    .handle(
      "schedule.remove",
      Effect.fn(function* (ctx) {
        const schedule = yield* ScheduleTask.Service
        const removed = yield* schedule.remove(ctx.params.scheduleID)
        if (!removed) return yield* Effect.fail(notFound(ctx.params.scheduleID))
        return removed
      }),
    )
    .handle(
      "schedule.runNow",
      Effect.fn(function* (ctx) {
        const schedule = yield* ScheduleTask.Service
        const info = yield* schedule.runNow(ctx.params.scheduleID)
        if (!info) return yield* Effect.fail(notFound(ctx.params.scheduleID))
        return info
      }),
    ),
)

function notFound(scheduleID: string) {
  return new ScheduleNotFoundError({ scheduleID, message: "Scheduled task not found" })
}
