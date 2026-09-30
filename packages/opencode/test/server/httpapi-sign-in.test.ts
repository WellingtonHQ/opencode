import { afterAll, describe, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { AuthSessionTable } from "@opencode-ai/core/database/auth-session.sql"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { ServerRateLimit } from "@opencode-ai/server/auth/rate-limit"
import { ServerSession } from "@opencode-ai/server/auth/session"
import * as TestClock from "effect/testing/TestClock"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { ServerAuth } from "../../src/server/auth"
import { authorizationRouterMiddleware } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { signInRoute } from "../../src/server/shared/sign-in"
import { testEffect } from "../lib/effect"

function authConfigLayer(input?: { password?: string; username?: string }) {
  return ServerAuth.Config.configLayer({
    password: input?.password === undefined ? Option.none() : Option.some(input.password),
    username: input?.username ?? "opencode",
  })
}

const pageRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/", HttpServerResponse.text("home", { headers: { "content-type": "text/html" } }))
    yield* router.add("GET", "/some/page", HttpServerResponse.text("page", { headers: { "content-type": "text/html" } }))
  }),
).pipe(Layer.provide(authorizationRouterMiddleware.layer))

const directory = mkdtempSync(join(tmpdir(), "opencode-auth-test-"))
const database = Database.layerFromPath(join(directory, "auth.db"))
const credentials = { username: "opencode", password: Option.some("secret") }
const disposers: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(disposers.map((dispose) => dispose()))
  rmSync(directory, { recursive: true, force: true })
})

// Stands in for the production app: a protected HTML page wired with the same
// router middleware the UI fallback uses, plus the real sign-in routes.
function app(
  input?: { password?: string; username?: string },
  // The web handler takes an opaque request context; the cast is the seam that
  // lets tests hand a TestClock through to the handler.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  context: Context.Context<unknown> = Context.empty() as Context.Context<unknown>,
) {
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(pageRoute, signInRoute).pipe(
      Layer.provide(authConfigLayer(input)),
      Layer.provide(ServerRateLimit.layer),
      Layer.provide(database),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  )
  disposers.push(web.dispose)
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          web.handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            context,
          ),
        ),
      )
    },
  }
}

const responseText = (response: Response) => Effect.promise(() => response.text())

const formPost = (body: string, headers?: Record<string, string>, context?: Context.Context<unknown>) =>
  app({ password: "secret" }, context).request("/sign-in", {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  })

const it = testEffect(database)

describe("sign-in page", () => {
  it.live("serves the sign-in form for browsers", () =>
    Effect.gen(function* () {
      const response = yield* app({ password: "secret" }).request("/sign-in")
      const body = yield* responseText(response)

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(body).toContain("<form method=\"post\" action=\"/sign-in\">")
      expect(body).toContain("name=\"username\"")
      expect(body).toContain("autocomplete=\"username\"")
      expect(body).toContain("name=\"password\"")
      expect(body).toContain("autocomplete=\"current-password\"")
      expect(body).toContain("name=\"remember\"")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    }),
  )

  it.live("redirects to home when no password is configured", () =>
    Effect.gen(function* () {
      const get = yield* app().request("/sign-in")
      const post = yield* app().request("/sign-in", {
        method: "POST",
        body: "username=opencode&password=secret",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      })

      expect(get.status).toBe(302)
      expect(get.headers.get("location")).toBe("/")
      expect(post.status).toBe(302)
      expect(post.headers.get("location")).toBe("/")
    }),
  )

  it.live("redirects unauthenticated browser document requests to /sign-in", () =>
    Effect.gen(function* () {
      const response = yield* app({ password: "secret" }).request("/", { headers: { accept: "text/html" } })

      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe("/sign-in")
      expect(response.headers.get("www-authenticate")).toBeNull()
    }),
  )

  it.live("carries the requested path through the redirect", () =>
    Effect.gen(function* () {
      const response = yield* app({ password: "secret" }).request("/some/page", { headers: { accept: "text/html" } })

      expect(response.status).toBe(302)
      expect(new URL(response.headers.get("location") ?? "", "http://localhost").searchParams.get("next")).toBe(
        "/some/page",
      )
    }),
  )

  it.live("still answers non-browser requests with a plain 401", () =>
    Effect.gen(function* () {
      const response = yield* app({ password: "secret" }).request("/")

      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBeNull()
    }),
  )

  it.live("accepts basic auth and signed-in session cookies on protected pages", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const token = yield* ServerSession.issue(db, true, credentials)
      const [basic, session] = yield* Effect.all(
        [
          app({ password: "secret" }).request("/", {
            headers: { authorization: `Basic ${btoa("opencode:secret")}` },
          }),
          app({ password: "secret" }).request("/", {
            headers: { accept: "text/html", cookie: `opencode_session=${token}` },
          }),
        ],
        { concurrency: "unbounded" },
      )

      expect(basic.status).toBe(200)
      expect(session.status).toBe(200)
      expect(yield* responseText(session)).toBe("home")
    }),
  )

  it.live("rejects invalid credentials with an error page", () =>
    Effect.gen(function* () {
      const response = yield* formPost("username=opencode&password=wrong")
      const body = yield* responseText(response)

      expect(response.status).toBe(401)
      expect(body).toContain("Invalid username or password")
      expect(response.headers.get("set-cookie")).toBeNull()
    }),
  )

  it.live("rejects a valid password with the wrong username", () =>
    Effect.gen(function* () {
      const response = yield* formPost("username=intruder&password=secret")

      expect(response.status).toBe(401)
      expect(response.headers.get("set-cookie")).toBeNull()
    }),
  )

  it.live("signs in with remember me and sets a persistent cookie", () =>
    Effect.gen(function* () {
      const response = yield* formPost("username=opencode&password=secret&remember=on")
      const setCookie = response.headers.get("set-cookie") ?? ""
      const token = /opencode_session=([^;]+)/.exec(setCookie)?.[1] ?? ""

      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe("/")
      expect(setCookie.toLowerCase()).toContain("max-age=2592000")
      expect(setCookie.toLowerCase()).toContain("httponly")
      expect(setCookie.toLowerCase()).toContain("samesite=lax")
      expect(setCookie.toLowerCase()).toContain("path=/")
      const { db } = yield* Database.Service
      expect(yield* ServerSession.isValid(db, token, credentials)).toBe(true)
    }),
  )

  it.live("keeps a remembered session across server lifetimes and revokes it on sign-out", () =>
    Effect.gen(function* () {
      const signedIn = yield* formPost("username=opencode&password=secret&remember=on")
      const token = /opencode_session=([^;]+)/.exec(signedIn.headers.get("set-cookie") ?? "")?.[1] ?? ""

      // Each app() builds a new database connection, as a restarted server does.
      const resumed = yield* app({ password: "secret" }).request("/", {
        headers: { accept: "text/html", cookie: `opencode_session=${token}` },
      })
      expect(resumed.status).toBe(200)

      const signedOut = yield* app({ password: "secret" }).request("/sign-out", {
        method: "POST",
        headers: { cookie: `opencode_session=${token}` },
      })
      expect(signedOut.status).toBe(302)

      const revoked = yield* app({ password: "secret" }).request("/", {
        headers: { accept: "text/html", cookie: `opencode_session=${token}` },
      })
      expect(revoked.status).toBe(302)
      expect(revoked.headers.get("location")).toBe("/sign-in")
    }),
  )

  it.live("invalidates a remembered session when the server password changes", () =>
    Effect.gen(function* () {
      const signedIn = yield* formPost("username=opencode&password=secret&remember=on")
      const token = /opencode_session=([^;]+)/.exec(signedIn.headers.get("set-cookie") ?? "")?.[1] ?? ""

      const rotated = yield* app({ password: "new-secret" }).request("/", {
        headers: { accept: "text/html", cookie: `opencode_session=${token}` },
      })
      expect(rotated.status).toBe(302)
      expect(rotated.headers.get("location")).toBe("/sign-in")

      const restored = yield* app({ password: "secret" }).request("/", {
        headers: { accept: "text/html", cookie: `opencode_session=${token}` },
      })
      expect(restored.status).toBe(302)
    }),
  )

  it.live("does not revive an unused remembered cookie when credentials are restored", () =>
    Effect.gen(function* () {
      for (const changed of [{ password: "new-secret" }, { password: "secret", username: "new-user" }]) {
        const signedIn = yield* formPost("username=opencode&password=secret&remember=on")
        const token = /opencode_session=([^;]+)/.exec(signedIn.headers.get("set-cookie") ?? "")?.[1] ?? ""

        // Build the server with changed credentials without presenting the old cookie.
        expect((yield* app(changed).request("/sign-in")).status).toBe(200)
        const restored = yield* app({ password: "secret" }).request("/", {
          headers: { accept: "text/html", cookie: `opencode_session=${token}` },
        })
        expect(restored.status).toBe(302)
      }
    }),
  )

  it.live("revokes a remembered session on sign-out even after credentials change", () =>
    Effect.gen(function* () {
      const signedIn = yield* formPost("username=opencode&password=secret&remember=on")
      const token = /opencode_session=([^;]+)/.exec(signedIn.headers.get("set-cookie") ?? "")?.[1] ?? ""
      const signedOut = yield* app({ password: "new-secret" }).request("/sign-out", {
        method: "POST",
        headers: { cookie: `opencode_session=${token}` },
      })
      expect(signedOut.status).toBe(302)

      const restored = yield* app({ password: "secret" }).request("/", {
        headers: { accept: "text/html", cookie: `opencode_session=${token}` },
      })
      expect(restored.status).toBe(302)
    }),
  )

  it.live("rejects an expired remembered session even when the browser still has its cookie", () =>
    Effect.gen(function* () {
      const response = yield* formPost("username=opencode&password=secret&remember=on")
      const token = /opencode_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? ""
      const { db } = yield* Database.Service
      yield* db
        .update(AuthSessionTable)
        .set({ expires_at: Date.now() - 1 })
        .where(eq(AuthSessionTable.token_hash, createHash("sha256").update(token).digest("hex")))

      const expired = yield* app({ password: "secret" }).request("/", {
        headers: { accept: "text/html", cookie: `opencode_session=${token}` },
      })
      expect(expired.status).toBe(302)
      expect(expired.headers.get("location")).toBe("/sign-in")
    }),
  )

  it.live("signs in without remember me and sets a session cookie", () =>
    Effect.gen(function* () {
      const response = yield* formPost("username=opencode&password=secret")
      const setCookie = response.headers.get("set-cookie") ?? ""
      const token = /opencode_session=([^;]+)/.exec(setCookie)?.[1] ?? ""

      expect(response.status).toBe(302)
      expect(setCookie.toLowerCase()).not.toContain("max-age")
      const { db } = yield* Database.Service
      expect(yield* ServerSession.isValid(db, token, credentials)).toBe(true)
    }),
  )

  it.live("returns a signed-in browser to the page it requested", () =>
    Effect.gen(function* () {
      const response = yield* formPost("username=opencode&password=secret&remember=on&next=/some/page")

      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe("/some/page")
    }),
  )

  it.live("rejects open-redirect next values", () =>
    Effect.gen(function* () {
      const body = yield* formPost("username=opencode&password=secret&next=//evil.example")
      const query = yield* app({ password: "secret" }).request("/sign-in?next=https%3A%2F%2Fevil.example", {
        method: "POST",
        body: "username=opencode&password=secret",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      })

      expect(body.status).toBe(302)
      expect(body.headers.get("location")).toBe("/")
      expect(query.status).toBe(302)
      expect(query.headers.get("location")).toBe("/")
    }),
  )

  it.live("rejects sign-in attempts from foreign origins", () =>
    Effect.gen(function* () {
      const response = yield* formPost("username=opencode&password=secret", { origin: "http://evil.example" })

      expect(response.status).toBe(403)
      expect(response.headers.get("set-cookie")).toBeNull()
    }),
  )

  it.live("signs out and clears the session cookie", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const token = yield* ServerSession.issue(db, true, credentials)
      const response = yield* app({ password: "secret" }).request("/sign-out", {
        method: "POST",
        headers: { cookie: `opencode_session=${token}` },
      })

      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe("/sign-in")
      const setCookie = response.headers.get("set-cookie") ?? ""
      expect(setCookie.toLowerCase()).toContain("max-age=0")
      expect(yield* ServerSession.isValid(db, token, credentials)).toBe(false)
    }),
  )

  it.live("ignores sign-out without a session cookie", () =>
    Effect.gen(function* () {
      const response = yield* app({ password: "secret" }).request("/sign-out", { method: "POST" })

      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe("/sign-in")
    }),
  )

  it.effect("locks out after ten failures and unlocks after a minute", () =>
    Effect.gen(function* () {
      // The web handler runs in its own runtime, so hand it a TestClock
      // through the request context to keep the lockout expiry deterministic.
      // One app() instance is reused so its single rate limiter accumulates.
      const clock = yield* TestClock.make()
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const context = Context.make(Clock.Clock, clock) as Context.Context<unknown>
      const a = app({ password: "secret" }, context)
      const post = (body: string) =>
        a.request("/sign-in", {
          method: "POST",
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        })
      for (let i = 0; i < 10; i++) {
        const failed = yield* post("username=opencode&password=wrong")
        expect(failed.status).toBe(401)
      }

      const locked = yield* post("username=opencode&password=secret")
      expect(locked.status).toBe(429)
      expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0)

      yield* clock.adjust("1 minute")

      const unlocked = yield* post("username=opencode&password=secret")
      expect(unlocked.status).toBe(302)
    }),
  )

  it.effect("locks out repeated bad basic auth on protected pages with 429", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make()
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const context = Context.make(Clock.Clock, clock) as Context.Context<unknown>
      const a = app({ password: "secret" }, context)
      const basic = (password: string) => ({ authorization: `Basic ${btoa(`opencode:${password}`)}` })
      for (let i = 0; i < 10; i++) {
        const failed = yield* a.request("/", { headers: basic("wrong") })
        expect(failed.status).toBe(401)
      }

      const locked = yield* a.request("/", { headers: basic("secret") })
      expect(locked.status).toBe(429)
      expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0)

      yield* clock.adjust("1 minute")

      const unlocked = yield* a.request("/", { headers: basic("secret") })
      expect(unlocked.status).toBe(200)
    }),
  )

  it.effect("shares the failure counter across the sign-in form and basic auth", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make()
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const context = Context.make(Clock.Clock, clock) as Context.Context<unknown>
      const a = app({ password: "secret" }, context)
      const post = (body: string) =>
        a.request("/sign-in", {
          method: "POST",
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        })
      for (let i = 0; i < 5; i++) expect((yield* post("username=opencode&password=wrong")).status).toBe(401)
      for (let i = 0; i < 5; i++)
        expect((yield* a.request("/", { headers: { authorization: `Basic ${btoa("opencode:wrong")}` } })).status).toBe(
          401,
        )
      // Ten combined failures across channels lock out even a correct basic auth.
      const locked = yield* a.request("/", { headers: { authorization: `Basic ${btoa("opencode:secret")}` } })
      expect(locked.status).toBe(429)
    }),
  )

  it.effect("keeps existing sessions working during lockout", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make()
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const context = Context.make(Clock.Clock, clock) as Context.Context<unknown>
      const a = app({ password: "secret" }, context)
      const { db } = yield* Database.Service
      const token = yield* ServerSession.issue(db, true, credentials)
      for (let i = 0; i < 10; i++)
        expect((yield* a.request("/", { headers: { authorization: `Basic ${btoa("opencode:wrong")}` } })).status).toBe(
          401,
        )
      // A valid session still works even while new credential attempts are locked out.
      const session = yield* a.request("/", { headers: { accept: "text/html", cookie: `opencode_session=${token}` } })
      expect(session.status).toBe(200)
    }),
  )
})
