import { ServerRateLimit } from "@opencode-ai/server/auth/rate-limit"
import { ServerSession } from "@opencode-ai/server/auth/session"
import { Database } from "@opencode-ai/core/database/database"
import { ServerAuth } from "@/server/auth"
import { Clock, Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { hasPtyConnectTicketURL } from "@/server/shared/pty-ticket"
import { isPublicUIPath } from "@/server/shared/public-ui"
export {
  Authorization as ServerAuthorization,
  authorizationLayer as serverAuthorizationLayer,
} from "@opencode-ai/server/middleware/authorization"

const AUTH_TOKEN_QUERY = "auth_token"
const UNAUTHORIZED = 401

function sessionAuthorized(request: HttpServerRequest.HttpServerRequest, db: Database.Interface["db"], config: ServerAuth.Info) {
  const token = ServerSession.tokenFromCookies(request.cookies)
  return token === undefined ? Effect.succeed(false) : ServerSession.isValid(db, token, config)
}

function isBrowserDocument(request: HttpServerRequest.HttpServerRequest) {
  return request.method === "GET" && (request.headers.accept ?? "").includes("text/html")
}

function attemptedAuth(request: HttpServerRequest.HttpServerRequest) {
  if (/^Basic\s+/i.test(request.headers.authorization ?? "")) return true
  return new URL(request.url, "http://localhost").searchParams.has(AUTH_TOKEN_QUERY)
}

function redirectToSignIn(request: HttpServerRequest.HttpServerRequest) {
  const pathname = new URL(request.url, "http://localhost").pathname
  return HttpServerResponse.redirect(pathname === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(pathname)}`)
}

// Avoid HttpApiSecurity alternatives here: Effect security middleware wraps the
// full handler, so a downstream failure can make the next auth alternative run
// and remap an authorized NotFound into Unauthorized.
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@opencode/ExperimentalHttpApiAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

export class PtyConnectAuthorization extends HttpApiMiddleware.Service<PtyConnectAuthorization>()(
  "@opencode/ExperimentalHttpApiPtyConnectAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

function emptyCredential() {
  return {
    username: "",
    password: Redacted.make(""),
  }
}

function unauthorized(retryAfter: number) {
  return Effect.gen(function* () {
    if (retryAfter > 0)
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "retry-after", String(retryAfter))),
      )
    return yield* new HttpApiError.Unauthorized({})
  })
}

function validateCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  request: HttpServerRequest.HttpServerRequest,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
  rateLimit: ServerRateLimit.RateLimit,
  db: Database.Interface["db"],
) {
  if (!ServerAuth.required(config)) return effect
  return Effect.gen(function* () {
    if (yield* sessionAuthorized(request, db, config)) return yield* effect
    if (!attemptedAuth(request)) return yield* unauthorized(0)
    const now = yield* Clock.currentTimeMillis
    const retryAfter = rateLimit.retryAfterSeconds(now)
    if (retryAfter === 0) {
      if (ServerAuth.authorized(credential, config)) {
        rateLimit.reset()
        return yield* effect
      }
      rateLimit.recordFailure(now)
    }
    return yield* unauthorized(retryAfter)
  })
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return {
          username: header.slice(0, separator),
          password: Redacted.make(header.slice(separator + 1)),
        }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  return credentialFromURL(new URL(request.url, "http://localhost"), request)
}

function credentialFromURL(url: URL, request: HttpServerRequest.HttpServerRequest) {
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

function validateRawCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  request: HttpServerRequest.HttpServerRequest,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
  rateLimit: ServerRateLimit.RateLimit,
  db: Database.Interface["db"],
) {
  if (!ServerAuth.required(config)) return effect
  return Effect.gen(function* () {
    if (yield* sessionAuthorized(request, db, config)) return yield* effect
    if (!attemptedAuth(request)) {
      if (isBrowserDocument(request)) return redirectToSignIn(request)
      return HttpServerResponse.empty({ status: UNAUTHORIZED })
    }
    const now = yield* Clock.currentTimeMillis
    const retryAfter = rateLimit.retryAfterSeconds(now)
    if (retryAfter > 0)
      return HttpServerResponse.text("Too many sign-in attempts. Try again later.", {
        status: 429,
        headers: { "retry-after": String(retryAfter), "cache-control": "no-store" },
      })
    if (ServerAuth.authorized(credential, config)) {
      rateLimit.reset()
      return yield* effect
    }
    rateLimit.recordFailure(now)
    return HttpServerResponse.empty({ status: UNAUTHORIZED })
  })
}

export const authorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const rateLimit = yield* ServerRateLimit.Service
    const { db } = yield* Database.Service
    yield* ServerSession.configure(db, config)
    if (!ServerAuth.required(config)) return (effect) => effect

    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (isPublicUIPath(request.method, url.pathname)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateRawCredential(effect, request, credential, config, rateLimit, db)),
        )
      })
  }),
)

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
        return yield* credentialFromRequest(request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, request, credential, config, rateLimit, db)),
        )
      }),
    )
  }),
)

export const ptyConnectAuthorizationLayer = Layer.effect(
  PtyConnectAuthorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const rateLimit = yield* ServerRateLimit.Service
    const { db } = yield* Database.Service
    yield* ServerSession.configure(db, config)
    if (!ServerAuth.required(config)) return PtyConnectAuthorization.of((effect) => effect)
    return PtyConnectAuthorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (hasPtyConnectTicketURL(url)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, request, credential, config, rateLimit, db)),
        )
      }),
    )
  }),
)
