import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260927235637_auth_session",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`auth_session\` (
          \`token_hash\` text PRIMARY KEY,
          \`expires_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`auth_session_expires_at_idx\` ON \`auth_session\` (\`expires_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
