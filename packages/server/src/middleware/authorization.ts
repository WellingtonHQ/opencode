import { ServerAuth } from "../auth"
import { ServerRateLimit } from "../auth/rate-limit"
import { ServerSession } from "../auth/session"
import { Database } from "@opencode-ai/core/database/database"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"
import { Authorization } from "@opencode-ai/protocol/middleware/authorization"
export { Authorization } from "@opencode-ai/protocol/middleware/authorization"
import { hasPtyConnectTicketURL } from "@opencode-ai/protocol/groups/pty"
import { Clock, Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

function attemptedAuth(request: HttpServerRequest.HttpServerRequest) {
  if (/^Basic\s+/i.test(request.headers.authorization ?? "")) return true
  return new URL(request.url, "http://localhost").searchParams.has(AUTH_TOKEN_QUERY)
}

function unauthorized(retryAfter: number) {
  return Effect.gen(function* () {
    if (retryAfter > 0)
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "retry-after", String(retryAfter))),
      )
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
    )
    return yield* new UnauthorizedError({ message: "Authentication required" })
  })
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const rateLimit = yield* ServerRateLimit.Service
    const { db } = yield* Database.Service
    yield* ServerSession.configure(db, config)
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
        // credential checks here; the connect handler consumes and validates the ticket.
        if (hasPtyConnectTicketURL(new URL(request.url, "http://localhost"))) return yield* effect
        const token = ServerSession.tokenFromCookies(request.cookies)
        if (token !== undefined && (yield* ServerSession.isValid(db, token, config))) return yield* effect
        if (!attemptedAuth(request)) return yield* unauthorized(0)
        const now = yield* Clock.currentTimeMillis
        const retryAfter = rateLimit.retryAfterSeconds(now)
        if (retryAfter === 0) {
          const credential = yield* credentialFromRequest(request)
          if (ServerAuth.authorized(credential, config)) {
            rateLimit.reset()
            return yield* effect
          }
          rateLimit.recordFailure(now)
        }
        return yield* unauthorized(retryAfter)
      }),
    )
  }),
)
