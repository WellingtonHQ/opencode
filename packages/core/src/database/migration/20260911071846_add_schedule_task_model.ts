import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911071846_add_schedule_task_model",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`scheduled_task\` ADD \`model\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
