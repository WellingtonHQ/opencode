import { AbsolutePath, PositiveInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ScheduleInvalidSpecError,
  ScheduleNotFoundError,
  SchedulePastOneShotError,
  ScheduleRunFailedError,
} from "../errors"

const ScheduleModel = Schema.Struct({
  id: Schema.String,
  providerID: Schema.String,
}).annotate({ identifier: "ScheduleModel" })

const ScheduleSpec = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("one_shot"), atMs: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("daily"), timeHhMm: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("weekly"), days: Schema.Array(Schema.Number), timeHhMm: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("cron"), expr: Schema.String }),
]).annotate({ identifier: "ScheduleSpec" })

const ScheduleRun = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  sessionId: Schema.String.pipe(Schema.optional),
  status: Schema.Literals(["fired", "catch_up", "missed", "error"]),
  startedAt: Schema.Number,
  finishedAt: Schema.Number.pipe(Schema.optional),
  errorText: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "ScheduleRun" })

const ScheduleTask = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  promptText: Schema.String,
  spec: ScheduleSpec,
  agentId: Schema.String.pipe(Schema.optional),
  model: ScheduleModel.pipe(Schema.optional),
  permissionPolicy: Schema.Literal("allow_all"),
  directory: Schema.String,
  enabled: Schema.Boolean,
  lastFiredSlot: Schema.NullOr(Schema.Number),
  nextFireMs: Schema.Number.pipe(Schema.optional),
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "ScheduleTask" })

const ScheduleTaskWithLatest = Schema.Struct({ ...ScheduleTask.fields, latestRun: ScheduleRun.pipe(Schema.optional) }).annotate(
  { identifier: "ScheduleTaskWithLatest" },
)

const ScheduleListQuery = Schema.Struct({
  directory: AbsolutePath.pipe(Schema.optional).annotate({
    description: "Only return schedules bound to this directory.",
  }),
}).annotate({ identifier: "ScheduleListQuery" })

const ScheduleRunsQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
}).annotate({ identifier: "ScheduleRunsQuery" })

const ScheduleRunNow = Schema.Struct({
  sessionID: Schema.String,
}).annotate({ identifier: "ScheduleRunNow" })

export const ScheduleGroup = HttpApiGroup.make("server.schedule")
  .add(
    HttpApiEndpoint.get("schedule.list", "/api/schedule", {
      query: ScheduleListQuery,
      success: Schema.Struct({ data: Schema.Array(ScheduleTaskWithLatest) }).annotate({ identifier: "ScheduleTasks" }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.schedule.list",
        summary: "List schedules",
        description:
          "Retrieve scheduled prompt tasks, optionally filtered by directory. Each task includes its most recent run when one exists.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("schedule.create", "/api/schedule", {
      payload: Schema.Struct({
        name: Schema.String,
        promptText: Schema.String,
        spec: ScheduleSpec,
        agentId: Schema.String.pipe(Schema.optional),
        model: ScheduleModel.pipe(Schema.optional),
        permissionPolicy: Schema.Literal("allow_all").pipe(Schema.optional),
        directory: AbsolutePath.pipe(Schema.optional).annotate({
          description: "Directory the prompt runs in. Defaults to the server working directory.",
        }),
      }).annotate({ identifier: "ScheduleCreate" }),
      success: Schema.Struct({ data: ScheduleTask }),
      error: [ScheduleInvalidSpecError, SchedulePastOneShotError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.schedule.create",
        summary: "Create schedule",
        description:
          "Create a scheduled prompt task. The spec is one of one_shot, daily, weekly, or cron; recurring specs are evaluated in the directory's local timezone.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("schedule.get", "/api/schedule/:id", {
      params: { id: Schema.String },
      success: Schema.Struct({ data: ScheduleTask }),
      error: ScheduleNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.schedule.get",
        summary: "Get schedule",
        description: "Retrieve a scheduled prompt task by ID.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("schedule.update", "/api/schedule/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.String.pipe(Schema.optional),
        promptText: Schema.String.pipe(Schema.optional),
        spec: ScheduleSpec.pipe(Schema.optional),
        agentId: Schema.String.pipe(Schema.optional),
        model: ScheduleModel.pipe(Schema.optional),
        permissionPolicy: Schema.Literal("allow_all").pipe(Schema.optional),
        directory: AbsolutePath.pipe(Schema.optional),
        enabled: Schema.Boolean.pipe(Schema.optional),
      }).annotate({ identifier: "ScheduleUpdate" }),
      success: Schema.Struct({ data: ScheduleTask }),
      error: [ScheduleNotFoundError, ScheduleInvalidSpecError, SchedulePastOneShotError, ScheduleRunFailedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.schedule.update",
        summary: "Update schedule",
        description: "Partially update a scheduled prompt task; omitted fields keep their current values.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("schedule.remove", "/api/schedule/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: ScheduleNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.schedule.remove",
        summary: "Remove schedule",
        description: "Delete a scheduled prompt task and its run history.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("schedule.run", "/api/schedule/:id/run", {
      params: { id: Schema.String },
      success: Schema.Struct({ data: ScheduleRunNow }),
      error: [ScheduleNotFoundError, ScheduleRunFailedError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.schedule.run",
        summary: "Run schedule now",
        description: "Trigger one manual run of a scheduled prompt task and return the created session ID.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("schedule.runs", "/api/schedule/:id/runs", {
      params: { id: Schema.String },
      query: ScheduleRunsQuery,
      success: Schema.Struct({ data: Schema.Array(ScheduleRun) }).annotate({ identifier: "ScheduleRuns" }),
      error: ScheduleNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.schedule.runs",
        summary: "List schedule runs",
        description: "Retrieve the most recent runs of a scheduled prompt task.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "schedule", description: "Experimental scheduled prompt routes." }))
