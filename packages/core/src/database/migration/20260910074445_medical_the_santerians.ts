import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260910074445_medical_the_santerians",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`scheduled_task\` (
          \`id\` text PRIMARY KEY,
          \`name\` text,
          \`prompt\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`at_ms\` integer,
          \`hour\` integer,
          \`minute\` integer,
          \`days\` text,
          \`expr\` text,
          \`agent_id\` text,
          \`directory\` text NOT NULL,
          \`enabled\` integer DEFAULT true NOT NULL,
          \`next_run_at_ms\` integer,
          \`last_run_at_ms\` integer,
          \`last_session_id\` text,
          \`last_error\` text,
          \`run_count\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`scheduled_task_next_run_at_ms_idx\` ON \`scheduled_task\` (\`next_run_at_ms\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
