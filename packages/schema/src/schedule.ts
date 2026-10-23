export * as Schedule from "./schedule.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { Model } from "./model.js"
import { ephemeral, inventory } from "./event.js"
import { Session } from "./session.js"
import { ascending } from "./identifier.js"
import { AbsolutePath, NonNegativeInt, optional, statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartingWith("task_")).pipe(
  Schema.brand("Schedule.ID"),
  statics((schema) => ({ create: () => schema.make("task_" + ascending()) })),
)
export type ID = typeof ID.Type

export const TimeZone = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value })
      return undefined
    } catch {
      return "Expected a valid IANA time zone"
    }
  }),
).annotate({ identifier: "Schedule.TimeZone" })
export type TimeZone = typeof TimeZone.Type

export const Kind = Schema.Literals(["once", "daily", "weekly", "cron"]).annotate({ identifier: "Schedule.Kind" })
export type Kind = typeof Kind.Type

const Hour = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(23))
const Minute = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(59))
const Weekday = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(6))

export interface OnceSpec extends Schema.Schema.Type<typeof OnceSpec> {}
export const OnceSpec = Schema.Struct({
  kind: Schema.Literal("once"),
  atMs: NonNegativeInt,
}).annotate({ identifier: "Schedule.Spec.Once" })

export interface DailySpec extends Schema.Schema.Type<typeof DailySpec> {}
export const DailySpec = Schema.Struct({
  kind: Schema.Literal("daily"),
  hour: Hour,
  minute: Minute,
}).annotate({ identifier: "Schedule.Spec.Daily" })

export interface WeeklySpec extends Schema.Schema.Type<typeof WeeklySpec> {}
export const WeeklySpec = Schema.Struct({
  kind: Schema.Literal("weekly"),
  days: Schema.Array(Weekday).check(Schema.isMinLength(1)),
  hour: Hour,
  minute: Minute,
}).annotate({ identifier: "Schedule.Spec.Weekly" })

export interface CronSpec extends Schema.Schema.Type<typeof CronSpec> {}
export const CronSpec = Schema.Struct({
  kind: Schema.Literal("cron"),
  expr: Schema.String,
}).annotate({ identifier: "Schedule.Spec.Cron" })

export const Spec = Schema.Union([OnceSpec, DailySpec, WeeklySpec, CronSpec])
  .pipe(Schema.toTaggedUnion("kind"))
  .annotate({ identifier: "Schedule.Spec" })
export type Spec = typeof Spec.Type

export const RunStatus = Schema.Literals(["running", "completed", "failed"]).annotate({ identifier: "Schedule.Run.Status" })
export type RunStatus = typeof RunStatus.Type

export interface Run extends Schema.Schema.Type<typeof Run> {}
export const Run = Schema.Struct({
  taskID: ID,
  sessionID: Session.ID.pipe(optional),
  status: RunStatus,
  startedAtMs: NonNegativeInt,
  finishedAtMs: NonNegativeInt.pipe(optional),
  errorText: optional(Schema.String),
}).annotate({ identifier: "Schedule.Run" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: optional(Schema.String),
  prompt: Schema.String,
  spec: Spec,
  timezone: TimeZone,
  agentId: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  directory: AbsolutePath,
  enabled: Schema.Boolean,
  nextRunAtMs: NonNegativeInt.pipe(optional),
  lastRunAtMs: NonNegativeInt.pipe(optional),
  lastSessionId: Session.ID.pipe(optional),
  lastError: optional(Schema.String),
  runCount: NonNegativeInt,
  recentRuns: optional(Schema.Array(Run)),
}).annotate({ identifier: "Schedule.Info" })

export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  name: optional(Schema.String),
  prompt: Schema.String,
  spec: Spec,
  timezone: TimeZone.pipe(optional),
  agentId: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  directory: AbsolutePath,
}).annotate({ identifier: "Schedule.CreateInput" })

export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
export const UpdateInput = Schema.Struct({
  name: optional(Schema.String),
  prompt: optional(Schema.String),
  spec: Spec.pipe(optional),
  timezone: TimeZone.pipe(optional),
  agentId: Agent.ID.pipe(optional),
  // Absent leaves the stored model untouched; null clears it back to the default.
  model: optional(Schema.NullOr(Model.Ref)),
  directory: AbsolutePath.pipe(optional),
  enabled: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Schedule.UpdateInput" })

const Changed = ephemeral({
  type: "schedule.changed",
  schema: { info: Info },
})
export const Event = { Changed, Definitions: inventory(Changed) }
