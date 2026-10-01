import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const AuthSessionTable = sqliteTable(
  "auth_session",
  {
    token_hash: text().primaryKey(),
    credential_hash: text().notNull().default(""),
    expires_at: integer().notNull(),
  },
  (table) => [index("auth_session_expires_at_idx").on(table.expires_at)],
)

export const AuthConfigTable = sqliteTable("auth_config", {
  id: integer().primaryKey(),
  salt: text().notNull(),
  verifier: text().notNull(),
})
