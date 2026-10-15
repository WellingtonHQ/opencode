import { Schedule } from "@opencode/schema/schedule"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { InvalidRequestError, ScheduleLimitExceededError, ScheduleNotFoundError } from "../errors.js"

// Keep the wire shape canonical while leaving the custom Intl-based time-zone check to Core.
const TimeZone = Schema.String
const ScheduleID = Schedule.ID.annotate({ identifier: "Schedule.ID" })
const Run = Schema.Struct({ ...Schedule.Run.fields, taskID: ScheduleID })
const Info = Schema.Struct({
  ...Schedule.Info.fields,
  id: ScheduleID,
  timezone: TimeZone,
  recentRuns: Schema.Array(Run).pipe(Schema.optional),
})
const CreateInput = Schema.Struct({
  ...Schedule.CreateInput.fields,
  timezone: TimeZone.pipe(Schema.optional),
})
const UpdateInput = Schema.Struct({
  ...Schedule.UpdateInput.fields,
  timezone: TimeZone.pipe(Schema.optional),
})

export const ScheduleGroup = HttpApiGroup.make("server.schedule")
  .add(
    HttpApiEndpoint.get("schedule.list", "/api/schedule", {
      success: Schema.Array(Info),
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
      params: { scheduleID: ScheduleID },
      success: Info,
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
      payload: CreateInput,
      success: Info,
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
      params: { scheduleID: ScheduleID },
      payload: UpdateInput,
      success: Info,
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
      params: { scheduleID: ScheduleID },
      success: Info,
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
      params: { scheduleID: ScheduleID },
      success: Info,
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
