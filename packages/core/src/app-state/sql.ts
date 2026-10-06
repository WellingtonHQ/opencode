import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const AppSettingTable = sqliteTable("app_setting", {
  key: text().primaryKey(),
  value: text().notNull(),
  time_updated: integer().notNull(),
})
