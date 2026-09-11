export * as Schedule from "./schedule"

import { Schema } from "effect"
import { Agent } from "./agent"
import { define, inventory } from "./event"
import { Session } from "./session"
import { ascending } from "./identifier"
import { AbsolutePath, NonNegativeInt, optional, statics } from "./schema"

export const ID = Schema.String.check(Schema.isStartsWith("task_")).pipe(
  Schema.brand("Schedule.ID"),
  statics((schema) => ({ create: () => schema.make("task_" + ascending()) })),
)
export type ID = typeof ID.Type

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
  days: Schema.Array(Weekday),
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

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: optional(Schema.String),
  prompt: Schema.String,
  spec: Spec,
  agentId: Agent.ID.pipe(optional),
  directory: AbsolutePath,
  enabled: Schema.Boolean,
  nextRunAtMs: NonNegativeInt.pipe(optional),
  lastRunAtMs: NonNegativeInt.pipe(optional),
  lastSessionId: Session.ID.pipe(optional),
  lastError: optional(Schema.String),
  runCount: NonNegativeInt,
}).annotate({ identifier: "Schedule.Info" })

export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  name: optional(Schema.String),
  prompt: Schema.String,
  spec: Spec,
  agentId: Agent.ID.pipe(optional),
  directory: AbsolutePath,
}).annotate({ identifier: "Schedule.CreateInput" })

export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
export const UpdateInput = Schema.Struct({
  name: optional(Schema.String),
  prompt: optional(Schema.String),
  spec: Spec.pipe(optional),
  agentId: Agent.ID.pipe(optional),
  directory: AbsolutePath.pipe(optional),
  enabled: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Schedule.UpdateInput" })

const Changed = define({
  type: "schedule.changed",
  schema: { info: Info },
})
export const Event = { Changed, Definitions: inventory(Changed) }
