import { Schedule } from "@opencode-ai/schema/schedule"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, ScheduleLimitExceededError, ScheduleNotFoundError } from "../errors"

export const ScheduleGroup = HttpApiGroup.make("server.schedule")
  .add(
    HttpApiEndpoint.get("schedule.list", "/api/schedule", {
      success: Schema.Array(Schedule.Info),
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.schedule.list",
          summary: "List scheduled tasks",
          description: "Retrieve all scheduled tasks.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("schedule.get", "/api/schedule/:scheduleID", {
      params: { scheduleID: Schedule.ID },
      success: Schedule.Info,
      error: ScheduleNotFoundError,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.schedule.get",
          summary: "Get scheduled task",
          description: "Retrieve one scheduled task by ID.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("schedule.create", "/api/schedule", {
      payload: Schedule.CreateInput,
      success: Schedule.Info,
      error: [InvalidRequestError, ScheduleLimitExceededError],
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.schedule.create",
          summary: "Create scheduled task",
          description: "Create a scheduled task and compute its first next run time.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.patch("schedule.update", "/api/schedule/:scheduleID", {
      params: { scheduleID: Schedule.ID },
      payload: Schedule.UpdateInput,
      success: Schedule.Info,
      error: [InvalidRequestError, ScheduleNotFoundError],
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.schedule.update",
          summary: "Update scheduled task",
          description: "Update one or more fields of a scheduled task; recomputes the next run when the spec changes.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("schedule.remove", "/api/schedule/:scheduleID", {
      params: { scheduleID: Schedule.ID },
      success: Schedule.Info,
      error: ScheduleNotFoundError,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.schedule.remove",
          summary: "Remove scheduled task",
          description: "Remove a scheduled task and return the removed record.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("schedule.runNow", "/api/schedule/:scheduleID/run-now", {
      params: { scheduleID: Schedule.ID },
      success: Schedule.Info,
      error: ScheduleNotFoundError,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.schedule.runNow",
          summary: "Run scheduled task now",
          description: "Run one scheduled task immediately regardless of its enabled state or next run time.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "schedule", description: "Scheduled prompt execution routes." }))
