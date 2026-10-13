import { expect } from "bun:test"
import { createHash, createHmac, scryptSync } from "node:crypto"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { Database } from "@opencode/core/database/database"
import { AuthSession } from "@opencode/core/database/auth-session"
import { AuthConfigTable, AuthSessionTable } from "@opencode/core/database/auth-session.sql"
import { DatabaseMigration } from "@opencode/core/database/migration"
import authSessionMigration from "@opencode/core/database/migration/20260927235637_auth_session"
import authCredentialsMigration from "@opencode/core/database/migration/20260930001258_auth_session_credentials"
import authConfigMigration from "@opencode/core/database/migration/20260930001910_auth_config"
import { Global } from "@opencode/util/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const credentials = { username: "opencode", password: Option.some("secret") }
const database = Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const context = yield* Layer.build(Database.layer().pipe(Layer.provide(Global.layerWith({ data: directory.path }))))
  return Context.get(context, Database.Service).db
})

it.live("stores only hashes, expires remembered and ordinary sessions, and deletes expired records", () => Effect.gen(function* () {
  const db = yield* database
  yield* AuthSession.configure(db, credentials)
  const now = yield* Clock.currentTimeMillis
  const remembered = yield* AuthSession.issue(db, true, credentials)
  const ordinary = yield* AuthSession.issue(db, false, credentials)
  const rows = yield* db.select().from(AuthSessionTable)
  expect(rows).toHaveLength(2)
  expect(rows.every((row) => row.token_hash !== remembered && row.token_hash !== ordinary)).toBe(true)
  const after = yield* Clock.currentTimeMillis
  const expires = rows.map((row) => row.expires_at).toSorted()
  expect(expires[0]).toBeGreaterThanOrEqual(now + AuthSession.SESSION_MAX_AGE_SECONDS * 1000)
  expect(expires[0]).toBeLessThanOrEqual(after + AuthSession.SESSION_MAX_AGE_SECONDS * 1000)
  expect(expires[1]).toBeGreaterThanOrEqual(now + AuthSession.REMEMBER_MAX_AGE_SECONDS * 1000)
  expect(expires[1]).toBeLessThanOrEqual(after + AuthSession.REMEMBER_MAX_AGE_SECONDS * 1000)
  expect(yield* AuthSession.isValid(db, remembered, credentials)).toBe(true)
  yield* db.run("UPDATE auth_session SET expires_at = 0")
  expect(yield* AuthSession.isValid(db, remembered, credentials)).toBe(false)
  expect(yield* AuthSession.isValid(db, ordinary, credentials)).toBe(false)
  expect(yield* db.select().from(AuthSessionTable)).toEqual([])
}))

it.live("keeps legacy Wellington cookies valid while upgrading the salted verifier", () => Effect.gen(function* () {
  const db = yield* database
  const salt = "0123456789abcdef0123456789abcdef"
  const token = "legacy-cookie"
  yield* db.insert(AuthConfigTable).values({ id: 1, salt, verifier: scryptSync("enabled\0opencode\0secret", Buffer.from(salt, "hex"), 32).toString("hex") })
  yield* db.insert(AuthSessionTable).values({
    token_hash: createHash("sha256").update(token).digest("hex"),
    credential_hash: createHmac("sha256", token).update("opencode\0secret").digest("hex"),
    expires_at: Date.now() + 60_000,
  })
  yield* AuthSession.configure(db, credentials)
  expect(yield* AuthSession.isValid(db, token, credentials)).toBe(true)
  expect((yield* db.select().from(AuthConfigTable).get())?.verifier).toStartWith("pbkdf2:")
  yield* AuthSession.configure(db, credentials)
  expect(yield* AuthSession.isValid(db, token, credentials)).toBe(true)
}))

it.live("revokes unused remembered records on username changes and never revives them", () => Effect.gen(function* () {
  const db = yield* database
  yield* AuthSession.configure(db, credentials)
  const token = yield* AuthSession.issue(db, true, credentials)
  yield* AuthSession.configure(db, { ...credentials, username: "changed" })
  yield* AuthSession.configure(db, credentials)
  expect(yield* AuthSession.isValid(db, token, credentials)).toBe(false)
}))

it.live("applies the fork's auth migrations once without changing upstream migrations", () => Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const db = yield* database
  yield* db.run("DROP TABLE auth_session")
  yield* db.run("DROP TABLE auth_config")
  const migrations = [authSessionMigration, authCredentialsMigration, authConfigMigration]
  for (const migration of migrations) yield* db.run(`DELETE FROM migration WHERE id = '${migration.id}'`)
  yield* DatabaseMigration.applyOnly(db, migrations).pipe(Effect.provide(Global.layerWith({ data: directory.path })))
  yield* DatabaseMigration.applyOnly(db, migrations).pipe(Effect.provide(Global.layerWith({ data: directory.path })))
  yield* AuthSession.configure(db, credentials)
  const token = yield* AuthSession.issue(db, true, credentials)
  expect(yield* AuthSession.isValid(db, token, credentials)).toBe(true)
}))
