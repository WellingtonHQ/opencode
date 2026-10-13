export * as AuthSession from "./auth-session.js"

import { AuthConfigTable, AuthSessionTable } from "./auth-session.sql.js"
import type { Database } from "./database.js"
import { eq, lte } from "drizzle-orm"
import { Clock, Effect, Option } from "effect"
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"

export const REMEMBER_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60

type Credentials = {
  readonly username: string
  readonly password: Option.Option<string>
}

function hash(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

// The token is the HMAC key, so neither the password nor the bearer token is stored.
function credentialHash(token: string, config: Credentials) {
  return createHmac("sha256", token)
    .update(config.username)
    .update("\0")
    .update(Option.getOrThrow(config.password))
    .digest("hex")
}

// Reconcile at boot even if no old cookie is presented, so restoring credentials
// cannot revive sessions issued before a credential change or disabling auth.
export function configure(db: Database.Interface["db"], config: Credentials) {
  return db
    .transaction((tx) =>
      Effect.gen(function* () {
        const existing = yield* tx.select().from(AuthConfigTable).get()
        const credentials =
          Option.isSome(config.password) && config.password.value !== ""
            ? `enabled\0${config.username}\0${config.password.value}`
            : "disabled"
        if (existing) {
          const actual = existing.verifier.startsWith("pbkdf2:")
            ? yield* verifier(credentials, existing.salt)
            : yield* Effect.gen(function* () {
                // Wellington's existing SQLite verifier used scrypt. Keep those
                // sessions valid on upgrade, then migrate to Workerd's Web Crypto API.
                const { scryptSync } = yield* Effect.promise(() => import("node:crypto"))
                return scryptSync(credentials, Buffer.from(existing.salt, "hex"), 32).toString("hex")
              })
          if (timingSafeEqual(Buffer.from(actual), Buffer.from(existing.verifier))) {
            if (!existing.verifier.startsWith("pbkdf2:")) {
              const value = yield* verifier(credentials, existing.salt)
              yield* tx.update(AuthConfigTable).set({ verifier: value }).where(eq(AuthConfigTable.id, 1))
            }
            return
          }
        }

        yield* tx.delete(AuthSessionTable)
        const salt = randomBytes(16).toString("hex")
        const value = yield* verifier(credentials, salt)
        yield* tx
          .insert(AuthConfigTable)
          .values({ id: 1, salt, verifier: value })
          .onConflictDoUpdate({ target: AuthConfigTable.id, set: { salt, verifier: value } })
      }),
    )
    .pipe(Effect.orDie)
}

function verifier(credentials: string, salt: string) {
  return Effect.promise(async () => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(credentials), "PBKDF2", false, [
      "deriveBits",
    ])
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(salt, "hex"), iterations: 100_000 },
      key,
      256,
    )
    return `pbkdf2:${Buffer.from(bits).toString("hex")}`
  })
}

export const issue = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  remember: boolean,
  config: Credentials,
) {
  yield* configure(db, config)
  const now = yield* Clock.currentTimeMillis
  const token = randomUUID()
  yield* db.delete(AuthSessionTable).where(lte(AuthSessionTable.expires_at, now)).pipe(Effect.orDie)
  yield* db
    .insert(AuthSessionTable)
    .values({
      token_hash: hash(token),
      credential_hash: credentialHash(token, config),
      expires_at: now + (remember ? REMEMBER_MAX_AGE_SECONDS : SESSION_MAX_AGE_SECONDS) * 1000,
    })
    .pipe(Effect.orDie)
  return token
})

export const isValid = Effect.fnUntraced(function* (db: Database.Interface["db"], token: string, config: Credentials) {
  if (Option.isNone(config.password) || config.password.value === "") return false
  const row = yield* db
    .select()
    .from(AuthSessionTable)
    .where(eq(AuthSessionTable.token_hash, hash(token)))
    .get()
    .pipe(Effect.orDie)
  if (!row) return false
  const now = yield* Clock.currentTimeMillis
  if (row.expires_at > now && row.credential_hash === credentialHash(token, config)) return true
  yield* revoke(db, token)
  return false
})

export function revoke(db: Database.Interface["db"], token: string) {
  return db
    .delete(AuthSessionTable)
    .where(eq(AuthSessionTable.token_hash, hash(token)))
    .pipe(Effect.asVoid, Effect.orDie)
}
