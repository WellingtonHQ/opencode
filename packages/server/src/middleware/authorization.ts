import { Database } from "@opencode/core/database/database"
import { UnauthorizedError } from "@opencode/protocol/errors"
import { Authorization } from "@opencode/protocol/middleware/authorization"
export { Authorization } from "@opencode/protocol/middleware/authorization"
import { hasPtyConnectTicketURL, PTY_CONNECT_PATH, PTY_CONNECT_TICKET_QUERY } from "@opencode/protocol/groups/pty"
import {
  hasPersistentPtyConnectTicketURL,
  PERSISTENT_PTY_CONNECT_PATH,
} from "@opencode/protocol/groups/persistent-pty"
import { isPairingConnectURL, PAIRING_CONNECT_PATH } from "@opencode/protocol/groups/server"
import { Clock, Effect, Layer, Redacted } from "effect"
import { Base64 } from "effect/encoding"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { ServerAuth } from "../auth"
import { ServerRateLimit } from "../auth/rate-limit"
import { ServerSession } from "../auth/session"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'
const UNAUTHORIZED_MESSAGE = "Authentication required"

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Base64.decodeString(input)).pipe(
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

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest, username: string) {
  const token = new URL(request.url, "http://localhost").searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const basic = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (basic) return decodeCredential(basic[1])
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")
  return Effect.succeed(bearer ? { username, password: Redacted.make(bearer[1]) } : emptyCredential())
}

function challengeRequest(request: HttpServerRequest.HttpServerRequest) {
  return request.headers["sec-fetch-mode"] === undefined && !(request.headers.accept ?? "").includes("text/html")
}

export function unauthorizedResponse(request: HttpServerRequest.HttpServerRequest, retryAfter = 0) {
  const url = new URL(request.url, "http://localhost")
  const api = url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === "/openapi.json"
  if (!api && request.method === "GET" && (request.headers.accept ?? "").includes("text/html") && retryAfter === 0)
    return HttpServerResponse.redirect(
      url.pathname === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`,
    )
  if (!api && retryAfter > 0)
    return HttpServerResponse.text("Too many sign-in attempts. Try again later.", {
      status: 429,
      headers: { "retry-after": String(retryAfter), "cache-control": "no-store" },
    })
  return HttpServerResponse.jsonUnsafe(
    { _tag: "UnauthorizedError", message: UNAUTHORIZED_MESSAGE },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        ...(challengeRequest(request) ? { "www-authenticate": WWW_AUTHENTICATE } : {}),
        ...(retryAfter > 0 ? { "retry-after": String(retryAfter) } : {}),
      },
    },
  )
}

export const authorizedRequest = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  config: ServerAuth.Info,
  rateLimit: ServerRateLimit.RateLimit,
  db?: Database.Interface["db"],
) {
  if (!ServerAuth.required(config)) return { authorized: true, retryAfter: 0 }
  const token = ServerSession.tokenFromCookies(request.cookies, ServerAuth.requestHost(request))
  if (token && ServerAuth.sameOrigin(request)) {
    if (ServerAuth.verifySession(token, config) || (db && (yield* ServerSession.isValid(db, token, config))))
      return { authorized: true, retryAfter: 0 }
  }
  const credential = yield* credentialFromRequest(request, config.username)
  // Pairing clients carry their existing session through Basic or Bearer as well.
  if (
    credential.username === config.username &&
    db &&
    (yield* ServerSession.isValid(db, Redacted.value(credential.password), config))
  )
    return { authorized: true, retryAfter: 0 }
  const attempted =
    token !== undefined ||
    /^(Basic|Bearer)\s+/i.test(request.headers.authorization ?? "") ||
    new URL(request.url, "http://localhost").searchParams.has(AUTH_TOKEN_QUERY)
  if (!attempted) return { authorized: false, retryAfter: 0 }
  const now = yield* Clock.currentTimeMillis
  const retryAfter = rateLimit.retryAfterSeconds(now)
  if (retryAfter > 0) return { authorized: false, retryAfter }
  if (ServerAuth.authorized(credential, config)) {
    rateLimit.reset()
    return { authorized: true, retryAfter: 0 }
  }
  rateLimit.recordFailure(now)
  return { authorized: false, retryAfter: 0 }
})

export function isPublicAuthPath(method: string, pathname: string) {
  return (method === "GET" || method === "POST") && (pathname === "/sign-in" || pathname === "/sign-out")
}

export function isPublicUIPath(method: string, pathname: string) {
  return (
    (method === "GET" || method === "HEAD") &&
    (pathname.startsWith("/_assets/") ||
      pathname.startsWith("/assets/") ||
      pathname.startsWith("/icons/") ||
      [
        "/sw.js",
        "/registerSW.js",
        "/favicon.ico",
        "/favicon.svg",
        "/site.webmanifest",
        "/web-app-manifest-192x192.png",
        "/web-app-manifest-512x512.png",
      ].includes(pathname))
  )
}

function ticketed(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  return hasPtyConnectTicketURL(url) || hasPersistentPtyConnectTicketURL(url) || isPairingConnectURL(url)
}

export const authorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const rateLimit = yield* ServerRateLimit.Service
    const database = yield* Database.Service
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const pathname = new URL(request.url, "http://localhost").pathname
        if (isPublicAuthPath(request.method, pathname) || isPublicUIPath(request.method, pathname) || ticketed(request))
          return yield* effect
        const result = yield* authorizedRequest(request, config, rateLimit, database.db)
        if (result.authorized) return yield* effect
        return unauthorizedResponse(request, result.retryAfter)
      })
  }),
)

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const rateLimit = yield* ServerRateLimit.Service
    const database = yield* Database.Service
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const route = yield* HttpRouter.RouteContext
        // These handlers consume and validate their own single-use ticket or pairing code. Use the
        // route selected by Effect so authorization and dispatch cannot disagree about the request path.
        const url = new URL(request.url, "http://localhost")
        if (
          ((route.route.path === PTY_CONNECT_PATH || route.route.path === PERSISTENT_PTY_CONNECT_PATH) &&
            !!url.searchParams.get(PTY_CONNECT_TICKET_QUERY)) ||
          route.route.path === PAIRING_CONNECT_PATH
        )
          return yield* effect
        const result = yield* authorizedRequest(request, config, rateLimit, database.db)
        if (result.authorized) return yield* effect
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(
            HttpServerResponse.setHeaders(response, unauthorizedResponse(request, result.retryAfter).headers),
          ),
        )
        return yield* new UnauthorizedError({ message: UNAUTHORIZED_MESSAGE })
      }),
    )
  }),
)
