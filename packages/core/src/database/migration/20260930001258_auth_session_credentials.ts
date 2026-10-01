import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930001258_auth_session_credentials",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`auth_session\` ADD \`credential_hash\` text DEFAULT '' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
