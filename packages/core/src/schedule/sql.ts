import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Schedule as ScheduledTask } from "@opencode/schema/scheduled-task"
import type { Session } from "@opencode/schema/session"
import * as DatabasePath from "../database/path.js"
import { Timestamps } from "../database/schema.sql.js"
export const ScheduleTaskTable = sqliteTable(
  "scheduled_task",
  {
    id: text().$type<ScheduledTask.ID>().primaryKey(),
    name: text(),
    prompt: text().notNull(),
    session: text().$type<ScheduledTask.SessionMode>().notNull().default("new"),
    kind: text().$type<ScheduledTask.Kind>().notNull(),
    timezone: text().$type<ScheduledTask.TimeZone>().notNull(),
    at_ms: integer(),
    hour: integer(),
    minute: integer(),
    days: text(),
    expr: text(),
    agent_id: text().$type<Agent.ID>(),
    model: text({ mode: "json" }).$type<Model.Ref>(),
    directory: DatabasePath.absoluteColumn().notNull(),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    next_run_at_ms: integer(),
    last_run_at_ms: integer(),
    last_session_id: text().$type<Session.ID>(),
    last_error: text(),
    run_count: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [index("scheduled_task_next_run_at_ms_idx").on(table.next_run_at_ms)],
)

export const ScheduleRunTable = sqliteTable(
  "schedule_run",
  {
    id: text().primaryKey(),
    task_id: text()
      .$type<ScheduledTask.ID>()
      .notNull()
      .references(() => ScheduleTaskTable.id, { onDelete: "cascade" }),
    session_id: text().$type<Session.ID>(),
    status: text().$type<ScheduledTask.RunStatus>().notNull(),
    started_at: integer().notNull(),
    finished_at: integer(),
    error_text: text(),
    ...Timestamps,
  },
  (table) => [index("schedule_run_task_id_idx").on(table.task_id)],
)
