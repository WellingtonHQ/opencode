export * as ServerAuth from "./auth"

import { Context, Layer, Option, Redacted } from "effect"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { HttpServerRequest } from "effect/http"

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
}

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Pick<Info, "password"> & { readonly username?: string }) {
    return Layer.succeed(this, this.of({ ...input, username: input.username ?? "opencode" }))
  }

  static get layer() {
    return this.configLayer({ password: Option.none() })
  }
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

// Session tokens issued by pairing links are accepted anywhere the password is.
export function authorized(credentials: DecodedCredentials, config: Info) {
  if (Option.isNone(config.password) || credentials.username !== config.username) return false
  const password = Redacted.value(credentials.password)
  return (
    timingSafeEqual(
      createHash("sha256").update(password).digest(),
      createHash("sha256").update(config.password.value).digest(),
    ) || verifySession(password, config)
  )
}

// Changing either credential revokes signed sessions as well as SQLite-backed remembered logins.
export function issueSession(config: Info, now = Date.now()) {
  if (Option.isNone(config.password)) return
  const expires = String(Math.floor(now / 1000) + SESSION_TTL_SECONDS)
  return `${expires}.${sign(config, expires)}`
}

export function verifySession(token: string, config: Info, now = Date.now()) {
  if (Option.isNone(config.password)) return false
  const parts = token.split(".")
  if (parts.length !== 2) return false
  const expires = Number(parts[0])
  if (!Number.isSafeInteger(expires) || expires * 1000 <= now) return false
  const expected = Buffer.from(sign(config, parts[0]))
  const actual = Buffer.from(parts[1])
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// Browsers share cookies across ports on the same host, so the name carries the port to keep local servers apart.
export function sessionCookieName(host: string | undefined) {
  const port = URL.parse(`http://${host ?? ""}`)?.port
  return port ? `opencode_session_${port}` : "opencode_session"
}

export function requestHost(request: HttpServerRequest.HttpServerRequest) {
  return request.headers.host ?? URL.parse(request.originalUrl)?.host
}

export function sameOrigin(request: HttpServerRequest.HttpServerRequest) {
  return request.headers.origin === undefined || URL.parse(request.headers.origin)?.host === requestHost(request)
}

function sign(config: Info, payload: string) {
  // Preserve upstream tokens for the default identity; custom identities have separate signing keys.
  const key = createHmac("sha256", Option.getOrThrow(config.password))
    .update(config.username === "opencode" ? "opencode-session-v1" : `opencode-session-v1\0${config.username}`)
    .digest()
  return createHmac("sha256", key).update(payload).digest("base64url")
}
