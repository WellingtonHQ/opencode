import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261005063756_add_app_setting_and_schedule_run",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`app_setting\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`schedule_run\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`session_id\` text,
          \`status\` text NOT NULL,
          \`started_at\` integer NOT NULL,
          \`finished_at\` integer,
          \`error_text\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_schedule_run_task_id_scheduled_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`scheduled_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`schedule_run_task_id_idx\` ON \`schedule_run\` (\`task_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
