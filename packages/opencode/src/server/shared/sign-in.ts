import { ServerRateLimit } from "@opencode-ai/server/auth/rate-limit"
import { ServerSession } from "@opencode-ai/server/auth/session"
import { Database } from "@opencode-ai/core/database/database"
import { ServerAuth } from "@/server/auth"
import { Clock, Effect, Option, Stream } from "effect"
import { Cookies, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash, timingSafeEqual } from "node:crypto"

function escapeHtml(value: string) {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
  return value.replace(/[&<>"']/g, (char) => map[char])
}

function safeEqual(a: string, b: string) {
  const left = createHash("sha256").update(a, "utf8").digest()
  const right = createHash("sha256").update(b, "utf8").digest()
  return timingSafeEqual(left, right)
}

// Only allow same-site absolute paths; reject protocol-relative, backslash,
// and control-character input so the value is safe for Location and HTML.
function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/"
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\s\\]/.test(raw)) return "/"
  return raw
}

function isCrossOrigin(request: HttpServerRequest.HttpServerRequest): boolean {
  const origin = request.headers.origin
  if (!origin) return false
  const host = request.headers.host
  if (!host) return true
  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}

function formParams(request: HttpServerRequest.HttpServerRequest) {
  return Stream.runFold(request.stream, () => new Uint8Array(0), (acc, chunk) => {
    const next = new Uint8Array(acc.length + chunk.length)
    next.set(acc, 0)
    next.set(chunk, acc.length)
    return next
  }).pipe(
    Effect.map((body) => new URLSearchParams(new TextDecoder().decode(body))),
  )
}

function signInPage(next: string, error: string | undefined) {
  return HttpServerResponse.text(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in · opencode</title>
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
<body>
<form method="post" action="/sign-in">
  <h1>Sign in to opencode</h1>
  <label class="field">Username
    <input name="username" type="text" autocomplete="username" autofocus required />
  </label>
  <label class="field">Password
    <input name="password" type="password" autocomplete="current-password" required />
  </label>
  <label class="remember"><input type="checkbox" name="remember" value="on" checked /> Remember me for 30 days</label>
  <input type="hidden" name="next" value="${escapeHtml(next)}" />
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
  <button type="submit">Sign in</button>
</form>
</body>
</html>
`,
    {
      status: error ? 401 : 200,
      contentType: "text/html; charset=utf-8",
      headers: {
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "cache-control": "no-store",
      },
    },
  )
}

function getSignIn(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info): HttpServerResponse.HttpServerResponse {
  if (!ServerAuth.required(config)) return HttpServerResponse.redirect("/")
  return signInPage(safeNext(new URL(request.url, "http://localhost").searchParams.get("next")), undefined)
}

function postSignIn(
  request: HttpServerRequest.HttpServerRequest,
  config: ServerAuth.Info,
  rateLimit: ServerRateLimit.RateLimit,
  db: Database.Interface["db"],
) {
  return Effect.gen(function* () {
    if (!ServerAuth.required(config)) return HttpServerResponse.redirect("/")
    if (isCrossOrigin(request))
      return HttpServerResponse.text("Forbidden", { status: 403, headers: { "cache-control": "no-store" } })
    const now = yield* Clock.currentTimeMillis
    const retryAfter = rateLimit.retryAfterSeconds(now)
    if (retryAfter > 0)
      return HttpServerResponse.text("Too many sign-in attempts. Try again later.", {
        status: 429,
        headers: { "retry-after": String(retryAfter), "cache-control": "no-store" },
      })
    const params = yield* formParams(request)
    const username = params.get("username") ?? ""
    const password = params.get("password") ?? ""
    const remember = params.get("remember") === "on"
    // The form resubmits `next` as a body field; the URL query only carries it
    // on the first redirect.
    const next = safeNext(params.get("next") ?? new URL(request.url, "http://localhost").searchParams.get("next"))
    const expected = Option.isSome(config.password) ? config.password.value : ""
    if (!safeEqual(username, config.username) || !safeEqual(password, expected)) {
      rateLimit.recordFailure(now)
      return signInPage(next, "Invalid username or password")
    }
    rateLimit.reset()
    const token = yield* ServerSession.issue(db, remember, config)
    const options: { httpOnly: boolean; sameSite: "lax"; path: string; maxAge?: number } = {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    }
    if (remember) options.maxAge = ServerSession.REMEMBER_MAX_AGE_SECONDS * 1000
    const cookie = Cookies.makeCookieUnsafe(ServerSession.COOKIE_NAME, token, options)
    return HttpServerResponse.redirect(next, {
      cookies: Cookies.setCookie(Cookies.empty, cookie),
    })
  })
}

function postSignOut(request: HttpServerRequest.HttpServerRequest, db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const token = ServerSession.tokenFromCookies(request.cookies)
    if (token !== undefined) yield* ServerSession.revoke(db, token)
    const cleared = Cookies.makeCookieUnsafe(ServerSession.COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    })
    return HttpServerResponse.redirect("/sign-in", {
      cookies: Cookies.setCookie(Cookies.empty, cleared),
    })
  })
}

export const signInRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const rateLimit = yield* ServerRateLimit.Service
    const { db } = yield* Database.Service
    yield* ServerSession.configure(db, config)
    yield* router.add("GET", "/sign-in", (request) => Effect.succeed(getSignIn(request, config)))
    yield* router.add("POST", "/sign-in", (request) => postSignIn(request, config, rateLimit, db))
    yield* router.add("POST", "/sign-out", (request) => postSignOut(request, db))
  }),
)
