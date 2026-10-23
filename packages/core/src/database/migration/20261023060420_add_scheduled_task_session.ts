import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261023060420_add_scheduled_task_session",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`scheduled_task\` ADD \`session\` text DEFAULT 'new' NOT NULL;`)
    })
  },
}

export default migration
