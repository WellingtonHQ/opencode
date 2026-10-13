import { Database } from "@opencode/core/database/database"
import { Clock, Duration, Effect, Redacted } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { ServerAuth } from "./auth"
import { ServerRateLimit } from "./auth/rate-limit"
import { ServerSession } from "./auth/session"

function escapeHtml(value: string) {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
  return value.replace(/[&<>"']/g, (char) => map[char])
}

function safeNext(raw: string | null) {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || /[\s\\\u0000-\u001f\u007f]/.test(raw)) return "/"
  return raw
}

function page(body: string, status = 200, title = "Sign in") {
  return HttpServerResponse.text(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · opencode</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #161618; color: #ececf1; font: 15px/1.5 system-ui, -apple-system, sans-serif; padding: 16px; }
  form { width: min(100%, 360px); display: grid; gap: 16px; padding: 28px; border: 1px solid #2c2c31; border-radius: 12px; background: #1d1d20; }
  h1 { margin: 0; font-size: 18px; }
  .field { display: grid; gap: 6px; font-size: 13px; color: #a5a5ad; }
  input[type="text"], input[type="password"] { padding: 9px 10px; border: 1px solid #3a3a41; border-radius: 8px; background: #111113; color: inherit; font: inherit; }
  input[type="text"]:focus, input[type="password"]:focus { outline: 2px solid #4a6fa5; border-color: transparent; }
  .remember { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #a5a5ad; }
  .remember input { accent-color: #6a8fc7; }
  button { padding: 10px 12px; border: 0; border-radius: 8px; background: #ececf1; color: #161618; font: inherit; font-weight: 600; cursor: pointer; }
  .error { margin: 0; color: #ff8582; font-size: 13px; }
</style>
</head>
<body>${body}</body>
</html>`,
    {
      status,
      contentType: "text/html; charset=utf-8",
      headers: {
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "cache-control": "no-store",
      },
    },
  )
}

function signInPage(username: string, next: string, error?: string) {
  return page(
    `<form method="post" action="/sign-in">
  <h1>Sign in to opencode</h1>
  <label class="field">Username
    <input name="username" type="text" autocomplete="username" value="${escapeHtml(username)}" autofocus required />
  </label>
  <label class="field">Password
    <input name="password" type="password" autocomplete="current-password" required />
  </label>
  <label class="remember"><input type="checkbox" name="remember" value="on" checked /> Remember me for 30 days</label>
  <input type="hidden" name="next" value="${escapeHtml(next)}" />
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
  <button type="submit">Sign in</button>
</form>`,
    error ? 401 : 200,
  )
}

const postSignIn = Effect.fnUntraced(
  function* (
    request: HttpServerRequest.HttpServerRequest,
    config: ServerAuth.Info,
    rateLimit: ServerRateLimit.RateLimit,
    db: Database.Interface["db"],
  ) {
    if (!ServerAuth.required(config)) return HttpServerResponse.redirect("/")
    if (!ServerAuth.sameOrigin(request))
      return HttpServerResponse.text("Forbidden", { status: 403, headers: { "cache-control": "no-store" } })
    const now = yield* Clock.currentTimeMillis
    const retryAfter = rateLimit.retryAfterSeconds(now)
    if (retryAfter > 0)
      return HttpServerResponse.text("Too many sign-in attempts. Try again later.", {
        status: 429,
        headers: { "retry-after": String(retryAfter), "cache-control": "no-store" },
      })
    const params = new URLSearchParams(yield* request.text)
    const next = safeNext(params.get("next") ?? new URL(request.url, "http://localhost").searchParams.get("next"))
    if (
      !ServerAuth.authorized(
        { username: params.get("username") ?? "", password: Redacted.make(params.get("password") ?? "") },
        config,
      )
    ) {
      rateLimit.recordFailure(now)
      return signInPage(config.username, next, "Invalid username or password")
    }
    rateLimit.reset()
    const remember = params.get("remember") === "on"
    const token = yield* ServerSession.issue(db, remember, config)
    return HttpServerResponse.redirect(next).pipe(
      HttpServerResponse.setCookieUnsafe(ServerAuth.sessionCookieName(ServerAuth.requestHost(request)), token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        ...(remember ? { maxAge: Duration.seconds(ServerSession.REMEMBER_MAX_AGE_SECONDS) } : {}),
      }),
    )
  },
  Effect.catchTag("HttpServerError", () =>
    Effect.succeed(
      HttpServerResponse.text("Invalid sign-in form", { status: 400, headers: { "cache-control": "no-store" } }),
    ),
  ),
)

const postSignOut = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  db: Database.Interface["db"],
) {
  if (!ServerAuth.sameOrigin(request)) return HttpServerResponse.text("Forbidden", { status: 403 })
  const token = ServerSession.tokenFromCookies(request.cookies, ServerAuth.requestHost(request))
  if (token !== undefined) yield* ServerSession.revoke(db, token)
  return HttpServerResponse.redirect("/sign-in").pipe(
    HttpServerResponse.expireCookieUnsafe(ServerAuth.sessionCookieName(ServerAuth.requestHost(request)), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    }),
    HttpServerResponse.expireCookieUnsafe(ServerSession.COOKIE_NAME, { path: "/", httpOnly: true, sameSite: "lax" }),
  )
})

export const signInRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const rateLimit = yield* ServerRateLimit.Service
    const database = yield* Database.Service
    yield* router.add("GET", "/sign-in", (request) =>
      Effect.succeed(
        ServerAuth.required(config)
          ? signInPage(config.username, safeNext(new URL(request.url, "http://localhost").searchParams.get("next")))
          : HttpServerResponse.redirect("/"),
      ),
    )
    yield* router.add("POST", "/sign-in", (request) => postSignIn(request, config, rateLimit, database.db))
    yield* router.add(
      "GET",
      "/sign-out",
      page(
        `<form method="post" action="/sign-out"><h1>Sign out of opencode</h1><button type="submit">Sign out</button></form>`,
        200,
        "Sign out",
      ),
    )
    yield* router.add("POST", "/sign-out", (request) => postSignOut(request, database.db))
  }),
)
