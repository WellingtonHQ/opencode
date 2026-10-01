export * as ServerSession from "./session"

import { AuthConfigTable, AuthSessionTable } from "@opencode-ai/core/database/auth-session.sql"
import { Database } from "@opencode-ai/core/database/database"
import { ServerAuth } from "../auth"
import { eq, lte } from "drizzle-orm"
import { Effect, Option } from "effect"
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto"

export const COOKIE_NAME = "opencode_session"

// How long a signed-in session stays valid on the server. "Remember me"
// sessions outlive the browser; ordinary sessions expire sooner.
export const REMEMBER_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60

// Keep bearer tokens out of the database, while allowing revocation after a password change.
function hash(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

// The bearer token is the HMAC key, so the database never stores the password.
function credentialHash(token: string, config: ServerAuth.Info) {
  return createHmac("sha256", token)
    .update(config.username)
    .update("\0")
    .update(Option.getOrThrow(config.password))
    .digest("hex")
}

// Reconcile credentials before serving requests, including when no old cookie is presented.
// The salted, slow verifier detects changes without storing the server password.
export function configure(db: Database.Interface["db"], config: ServerAuth.Info) {
  return db
    .transaction((tx) =>
      Effect.gen(function* () {
        const existing = yield* tx.select().from(AuthConfigTable).get()
        const credentials = ServerAuth.required(config)
          ? `enabled\0${config.username}\0${Option.getOrThrow(config.password)}`
          : "disabled"
        if (existing) {
          const actual = scryptSync(credentials, Buffer.from(existing.salt, "hex"), 32)
          if (timingSafeEqual(actual, Buffer.from(existing.verifier, "hex"))) return
        }

        yield* tx.delete(AuthSessionTable)
        const salt = randomBytes(16)
        const verifier = scryptSync(credentials, salt, 32).toString("hex")
        yield* tx
          .insert(AuthConfigTable)
          .values({ id: 1, salt: salt.toString("hex"), verifier })
          .onConflictDoUpdate({ target: AuthConfigTable.id, set: { salt: salt.toString("hex"), verifier } })
      }),
    )
    .pipe(Effect.orDie)
}

export function issue(db: Database.Interface["db"], remember: boolean, config: ServerAuth.Info) {
  return Effect.gen(function* () {
    yield* configure(db, config)
    const now = Date.now()
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
}

export function isValid(db: Database.Interface["db"], token: string, config: ServerAuth.Info) {
  return Effect.gen(function* () {
    const row = yield* db
      .select({ expires_at: AuthSessionTable.expires_at, credential_hash: AuthSessionTable.credential_hash })
      .from(AuthSessionTable)
      .where(eq(AuthSessionTable.token_hash, hash(token)))
      .get()
      .pipe(Effect.orDie)
    if (!row || row.expires_at <= Date.now()) return false
    if (row.credential_hash === credentialHash(token, config)) return true
    // Reject and remove the old record so restoring the former password cannot revive it.
    yield* revoke(db, token)
    return false
  })
}

export function revoke(db: Database.Interface["db"], token: string) {
  return Effect.gen(function* () {
    yield* db.delete(AuthSessionTable).where(eq(AuthSessionTable.token_hash, hash(token))).pipe(Effect.orDie)
  })
}

export function tokenFromCookies(cookies: Readonly<Record<string, string>>): string | undefined {
  return Object.hasOwn(cookies, COOKIE_NAME) ? cookies[COOKIE_NAME] : undefined
}
