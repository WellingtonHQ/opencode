import { ScheduleV2 } from "@opencode-ai/core/schedule/schedule"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import {
  ScheduleInvalidSpecError,
  ScheduleNotFoundError,
  SchedulePastOneShotError,
  ScheduleRunFailedError,
} from "@opencode-ai/protocol/errors"

export const ScheduleHandler = HttpApiBuilder.group(Api, "server.schedule", (handlers) =>
  Effect.gen(function* () {
    const schedule = yield* ScheduleV2.Service

    return handlers
      .handle(
        "schedule.list",
        Effect.fn(function* (ctx) {
          return { data: yield* schedule.list(ctx.query) }
        }),
      )
      .handle(
        "schedule.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* schedule
              .create({
                name: ctx.payload.name,
                promptText: ctx.payload.promptText,
                spec: ctx.payload.spec,
                agentId: ctx.payload.agentId,
                model: ctx.payload.model,
                permissionPolicy: ctx.payload.permissionPolicy,
                directory: ctx.payload.directory ?? process.cwd(),
              })
              .pipe(
                Effect.catchTag("Schedule.InvalidSpecError", (error) =>
                  Effect.fail(new ScheduleInvalidSpecError({ message: error.message })),
                ),
                Effect.catchTag("Schedule.PastOneShotError", (error) =>
                  Effect.fail(new SchedulePastOneShotError({ atMs: error.atMs, message: "Scheduled time is in the past" })),
                ),
              ),
          }
        }),
      )
      .handle(
        "schedule.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* schedule.get(ctx.params.id).pipe(
              Effect.catchTag("Schedule.NotFoundError", (error) =>
                new ScheduleNotFoundError({ id: error.id, message: `Schedule not found: ${error.id}` }),
              ),
            ),
          }
        }),
      )
      .handle(
        "schedule.update",
        Effect.fn(function* (ctx) {
          return {
            data: yield* schedule
              .update(ctx.params.id, ctx.payload)
              .pipe(
                Effect.catchTag("Schedule.NotFoundError", (error) =>
                  new ScheduleNotFoundError({ id: error.id, message: `Schedule not found: ${error.id}` }),
                ),
                Effect.catchTag("Schedule.InvalidSpecError", (error) =>
                  Effect.fail(new ScheduleInvalidSpecError({ message: error.message })),
                ),
                Effect.catchTag("Schedule.PastOneShotError", (error) =>
                  Effect.fail(
                    new SchedulePastOneShotError({ atMs: error.atMs, message: "Scheduled time is in the past" }),
                  ),
                ),
                Effect.catchTag("Schedule.RunFailedError", (error) =>
                  Effect.fail(new ScheduleRunFailedError({ taskId: error.taskId, message: error.message })),
                ),
              ),
          }
        }),
      )
      .handle(
        "schedule.remove",
        Effect.fn(function* (ctx) {
          yield* schedule.delete(ctx.params.id).pipe(
            Effect.catchTag("Schedule.NotFoundError", (error) =>
              new ScheduleNotFoundError({ id: error.id, message: `Schedule not found: ${error.id}` }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "schedule.run",
        Effect.fn(function* (ctx) {
          return {
            data: {
              sessionID: yield* schedule.runNow(ctx.params.id).pipe(
                Effect.catchTag("Schedule.NotFoundError", (error) =>
                  new ScheduleNotFoundError({ id: error.id, message: `Schedule not found: ${error.id}` }),
                ),
                Effect.catchTag("Schedule.RunFailedError", (error) =>
                  Effect.fail(new ScheduleRunFailedError({ taskId: error.taskId, message: error.message })),
                ),
              ),
            },
          }
        }),
      )
      .handle(
        "schedule.runs",
        Effect.fn(function* (ctx) {
          return {
            data: yield* schedule.listRuns(ctx.params.id, ctx.query.limit).pipe(
              Effect.catchTag("Schedule.NotFoundError", (error) =>
                new ScheduleNotFoundError({ id: error.id, message: `Schedule not found: ${error.id}` }),
              ),
            ),
          }
        }),
      )
  }),
)
