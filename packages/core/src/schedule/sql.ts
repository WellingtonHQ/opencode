import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Agent } from "@opencode-ai/schema/agent"
import type { Schedule } from "@opencode-ai/schema/schedule"
import type { Session } from "@opencode-ai/schema/session"
import * as DatabasePath from "../database/path"
import { Timestamps } from "../database/schema.sql"

export const ScheduleTaskTable = sqliteTable(
  "scheduled_task",
  {
    id: text().$type<Schedule.ID>().primaryKey(),
    name: text(),
    prompt: text().notNull(),
    kind: text().$type<Schedule.Kind>().notNull(),
    at_ms: integer(),
    hour: integer(),
    minute: integer(),
    days: text(),
    expr: text(),
    agent_id: text().$type<Agent.ID>(),
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
