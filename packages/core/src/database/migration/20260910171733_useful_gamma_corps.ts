import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260910171733_useful_gamma_corps",
  up(tx) {
    return Effect.gen(function* () {
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
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`scheduled_task\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`prompt_text\` text NOT NULL,
          \`spec_kind\` text NOT NULL,
          \`one_shot_at\` integer,
          \`daily_time\` text,
          \`weekly_days\` text,
          \`cron_expr\` text,
          \`agent_id\` text,
          \`model_provider_id\` text,
          \`model_id\` text,
          \`permission_policy\` text DEFAULT 'allow_all' NOT NULL,
          \`directory\` text NOT NULL,
          \`enabled\` integer DEFAULT 1 NOT NULL,
          \`last_fired_slot\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
