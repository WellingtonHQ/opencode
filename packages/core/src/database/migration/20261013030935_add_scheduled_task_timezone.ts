import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

const migration: DatabaseMigration.Migration = {
  id: "20261013030935_add_scheduled_task_timezone",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`scheduled_task\` ADD \`timezone\` text NOT NULL DEFAULT '${timezone}';`)
    })
  },
}

export default migration
