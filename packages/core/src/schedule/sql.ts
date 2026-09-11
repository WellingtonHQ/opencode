import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

export const ScheduledTaskTable = sqliteTable("scheduled_task", {
  id: text().primaryKey(),
  name: text().notNull(),
  prompt_text: text().notNull(),
  spec_kind: text().$type<"one_shot" | "daily" | "weekly" | "cron">().notNull(),
  one_shot_at: integer(),
  daily_time: text(),
  weekly_days: text({ mode: "json" }).$type<number[]>(),
  cron_expr: text(),
  agent_id: text(),
  model_provider_id: text(),
  model_id: text(),
  permission_policy: text().notNull().default("allow_all"),
  directory: text().notNull(),
  // drizzle sqlite-core in this repo has no boolean column type; booleans live as integers and the service converts.
  enabled: integer().notNull().default(1),
  last_fired_slot: integer(),
  ...Timestamps,
})

export const ScheduleRunTable = sqliteTable("schedule_run", {
  id: text().primaryKey(),
  task_id: text().notNull(),
  session_id: text(),
  status: text().$type<"fired" | "catch_up" | "missed" | "error">().notNull(),
  started_at: integer().notNull(),
  finished_at: integer(),
  error_text: text(),
  ...Timestamps,
})

export type ScheduledTaskRow = typeof ScheduledTaskTable.$inferSelect
export type ScheduleRunRow = typeof ScheduleRunTable.$inferSelect
