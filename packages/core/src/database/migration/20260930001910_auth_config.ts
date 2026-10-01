import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930001910_auth_config",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`auth_config\` (
          \`id\` integer PRIMARY KEY,
          \`salt\` text NOT NULL,
          \`verifier\` text NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
