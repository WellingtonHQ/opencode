import { expect } from "bun:test"
import path from "node:path"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { ServerAuth } from "../src/auth"
import { ServerFetch } from "../src/fetch"
import type { ServerOptions } from "../src/options"
import { startServer } from "./fixture/server"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"

// The production server owns authentication around the caller's bundled-UI
// transform. Keep this fixture local so no request can proxy to an external app.
const start = Effect.fnUntraced(function* (directory: string, options: ServerOptions = {}) {
  const server = yield* startServer(directory, options, (api) => Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const pathname = new URL(request.url, "http://localhost").pathname
    if (pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/auth/") || pathname === "/openapi.json") return yield* api
    return HttpServerResponse.text(pathname.startsWith("/_assets/") ? "local asset" : "<html>local bundled app</html>")
  }))
  return {
    ...server,
    request: (pathname: string, init?: RequestInit) => Effect.promise(() => fetch(new URL(pathname, server.base), { redirect: "manual", ...init })),
    signIn: (body = "username=opencode&password=secret&remember=on", headers?: Record<string, string>) => Effect.promise(() => fetch(new URL("/sign-in", server.base), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body,
    })),
  }
})

function cookie(response: Response) {
  const value = response.headers.getSetCookie().find((value) => value.startsWith("opencode_session"))?.split(";")[0]
  if (!value) throw new Error("Missing session cookie")
  return value
}

it.live("reserves browser sign-in and sign-out pages ahead of the bundled UI", () => Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const server = yield* start(directory.path)
  const form = yield* server.request("/sign-in?next=/some/page")
  expect(form.status).toBe(200)
  expect(form.headers.get("cache-control")).toBe("no-store")
  expect(form.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
  expect(form.headers.get("www-authenticate")).toBeNull()
  const body = yield* Effect.promise(() => form.text())
  expect(body).toContain('<form method="post" action="/sign-in">')
  expect(body).toContain('autocomplete="username"')
  expect(body).toContain('autocomplete="current-password"')
  expect(body).toContain("Remember me for 30 days")
  const selfRef = yield* server.request("/sign-in?next=%2Fsign-in")
  expect(selfRef.status).toBe(200)
  expect(yield* Effect.promise(() => selfRef.text())).toContain('<input type="hidden" name="next" value="/"')
  const signOut = yield* server.request("/sign-out")
  expect(yield* Effect.promise(() => signOut.text())).toContain('<form method="post" action="/sign-out">')

  const page = yield* server.request("/some/page?view=full", { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } })
  expect(page.status).toBe(302)
  expect(page.headers.get("location")).toBe("/sign-in?next=%2Fsome%2Fpage%3Fview%3Dfull")
  expect(page.headers.get("www-authenticate")).toBeNull()
  const missing = yield* server.request("/api/info", { headers: { "sec-fetch-mode": "cors" } })
  expect(missing.status).toBe(401)
  expect(missing.headers.get("www-authenticate")).toBeNull()
  expect(yield* Effect.promise(() => missing.json())).toEqual({ _tag: "UnauthorizedError", message: "Authentication required" })
  const asset = yield* server.request("/_assets/app.js")
  expect(asset.status).toBe(200)
  expect(yield* Effect.promise(() => asset.text())).toBe("local asset")
}))

it.live("validates the form and returns signed-in browsers to their local bundled UI", () => Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const server = yield* start(directory.path)
  for (const body of ["username=opencode&password=wrong", "username=custom&password=secret"]) {
    const rejected = yield* server.signIn(body)
    expect(rejected.status).toBe(401)
    expect(rejected.headers.get("set-cookie")).toBeNull()
    expect(yield* Effect.promise(() => rejected.text())).toContain("Invalid username or password")
  }
  const signedIn = yield* server.signIn("username=opencode&password=secret&remember=on&next=/some/page")
  expect(signedIn.status).toBe(302)
  expect(signedIn.headers.get("location")).toBe("/some/page")
  const setCookie = signedIn.headers.get("set-cookie") ?? ""
  expect(setCookie).toContain(`opencode_session_${new URL(server.base).port}=`)
  expect(setCookie.toLowerCase()).toContain("max-age=2592000")
  expect(setCookie.toLowerCase()).toContain("httponly")
  expect(setCookie.toLowerCase()).toContain("samesite=lax")
  const session = cookie(signedIn)
  expect((yield* server.request("/api/info", { headers: { cookie: session } })).status).toBe(200)
  const signedInSignIn = yield* server.request("/sign-in?next=/some/page", { headers: { cookie: session } })
  expect(signedInSignIn.status).toBe(302)
  expect(signedInSignIn.headers.get("location")).toBe("/some/page")
  const home = yield* server.request("/some/page", { headers: { cookie: session, accept: "text/html" } })
  expect(home.status).toBe(200)
  expect(yield* Effect.promise(() => home.text())).toBe("<html>local bundled app</html>")
  expect((yield* server.request("/api/info", { headers: { cookie: `${session}x` } })).status).toBe(401)
  expect((yield* server.request("/api/info", { headers: { cookie: session, origin: "http://127.0.0.1:1" } })).status).toBe(401)
  expect((yield* server.request("/api/info", { headers: { cookie: session, origin: server.base } })).status).toBe(200)
  expect((yield* server.request("/api/info?auth_token=", { headers: server.headers })).status).toBe(200)
  expect((yield* server.request(`/api/pty/pty_missing/connect?location[directory]=${encodeURIComponent(directory.path)}`, {
    headers: { cookie: session, origin: server.base },
  })).status).toBe(404)
  expect((yield* server.request("/api/experimental/persistent-pty/pty_missing/connect?cursor=-1", {
    headers: { cookie: session, origin: server.base },
  })).status).toBe(400)

  const ordinary = yield* server.signIn("username=opencode&password=secret")
  expect(ordinary.headers.get("set-cookie")?.toLowerCase()).not.toContain("max-age")
}))

it.live("uses an escaped custom username for browser login and pairing credentials", () => Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const username = 'custom"<&'
  const server = yield* start(directory.path, { username })
  const form = yield* server.request("/sign-in")
  expect(yield* Effect.promise(() => form.text())).toContain('value="custom&quot;&lt;&amp;"')
  expect((yield* server.signIn()).status).toBe(401)
  const session = cookie(yield* server.signIn(`username=${encodeURIComponent(username)}&password=secret&remember=on`))
  expect((yield* server.request("/api/info", { headers: { cookie: session } })).status).toBe(200)
  expect((yield* server.request("/api/info", { headers: server.headers })).status).toBe(200)
  expect((yield* server.request("/api/info", { headers: { authorization: "Bearer secret" } })).status).toBe(200)
  const pair = yield* server.request("/api/pair", { method: "POST", headers: server.headers })
  const body = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(yield* Effect.promise(() => pair.json()))
  const connected = yield* server.request(`/auth/connect/${body.code}`)
  const paired = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String, username: Schema.String }))(yield* Effect.promise(() => connected.json()))
  expect(paired.username).toBe(username)
  const headers = { authorization: `Basic ${Buffer.from(`${paired.username}:${paired.token}`).toString("base64")}` }
  expect((yield* server.request("/api/info", { headers })).status).toBe(200)
}))

it.live("persists remembered logins in SQLite across fixture lifetimes and revokes them on sign-out", () => Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const database = { path: path.join(directory.path, "auth.db") }
  const saved = yield* Effect.scoped(Effect.gen(function* () {
    const server = yield* start(directory.path, { database })
    return { session: cookie(yield* server.signIn()), port: Number(new URL(server.base).port) }
  }))
  yield* Effect.scoped(Effect.gen(function* () {
    const server = yield* start(directory.path, { database, port: saved.port })
    expect((yield* server.request("/api/info", { headers: { cookie: saved.session } })).status).toBe(200)
    const signedOut = yield* server.request("/sign-out", { method: "POST", headers: { cookie: saved.session } })
    expect(signedOut.status).toBe(302)
    expect(signedOut.headers.get("location")).toBe("/sign-in")
    expect(signedOut.headers.get("set-cookie")?.toLowerCase()).toContain("max-age=0")
  }))
  const server = yield* start(directory.path, { database, port: saved.port })
  expect((yield* server.request("/api/info", { headers: { cookie: saved.session } })).status).toBe(401)
}))

it.live("invalidates unused remembered cookies on credential changes without reviving them when restored", () => Effect.gen(function* () {
  for (const changed of [{ password: "rotated" }, { username: "rotated" }]) {
  const directory = yield* tmpdirScoped()
  const database = { path: path.join(directory.path, "auth.db") }
  const saved = yield* Effect.scoped(Effect.gen(function* () {
    const server = yield* start(directory.path, { database })
    return { session: cookie(yield* server.signIn()), port: Number(new URL(server.base).port) }
  }))
  yield* Effect.scoped(Effect.gen(function* () {
    const server = yield* start(directory.path, { database, port: saved.port, ...changed })
    expect((yield* server.request("/sign-in")).status).toBe(200)
  }))
  const server = yield* start(directory.path, { database, port: saved.port })
  expect((yield* server.request("/api/info", { headers: { cookie: saved.session } })).status).toBe(401)
  expect((yield* server.request("/sign-out", { method: "POST", headers: { cookie: saved.session } })).status).toBe(302)
  }
}))

it.live("revokes remembered sessions when authentication is disabled", () => Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const database = { path: path.join(directory.path, "auth.db") }
  const saved = yield* Effect.scoped(Effect.gen(function* () {
    const server = yield* start(directory.path, { database })
    return { session: cookie(yield* server.signIn()), port: Number(new URL(server.base).port) }
  }))
  yield* Effect.scoped(Effect.gen(function* () {
    const handler = yield* ServerFetch.make({ database, config: { directory: directory.path }, models: { fetch: false }, fs: { filewatcher: false } })
    const response = yield* Effect.promise(() => handler(new Request("http://opencode.local/sign-in")))
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/")
    const post = yield* Effect.promise(() => handler(new Request("http://opencode.local/sign-in", { method: "POST" })))
    expect(post.status).toBe(302)
  }))
  const server = yield* start(directory.path, { database, port: saved.port })
  expect((yield* server.request("/api/info", { headers: { cookie: saved.session } })).status).toBe(401)
}))

it.live("rejects cross-origin form posts, escapes HTML, and restricts return paths", () => Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const server = yield* start(directory.path)
  const foreign = yield* server.signIn(undefined, { origin: "http://evil.example" })
  expect(foreign.status).toBe(403)
  expect(foreign.headers.get("set-cookie")).toBeNull()
  for (const next of ["//evil.example", "https://evil.example", "/\\evil.example", "/\u0000evil", "/sign-in", "/sign-out"]) {
    const response = yield* server.signIn(`username=opencode&password=secret&next=${encodeURIComponent(next)}`)
    expect(response.headers.get("location")).toBe("/")
  }
  const escaped = yield* server.request(`/sign-in?next=${encodeURIComponent('/some/page?x="<script>')}`)
  expect(yield* Effect.promise(() => escaped.text())).toContain("&quot;&lt;script&gt;")
  const signedIn = cookie(yield* server.signIn(undefined, { origin: server.base }))
  expect((yield* server.request("/sign-out", { method: "POST", headers: { cookie: signedIn, origin: "http://evil.example" } })).status).toBe(403)
  expect((yield* server.request("/api/info", { headers: { cookie: signedIn } })).status).toBe(200)
}))

it.live("shares rate limiting across form, Basic, Bearer, query, cookie, UI, and API requests", () => Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const server = yield* start(directory.path)
  const session = cookie(yield* server.signIn())
  for (let i = 0; i < 2; i++) {
    expect((yield* server.signIn("username=opencode&password=wrong")).status).toBe(401)
    expect((yield* server.request("/api/info", { headers: { authorization: `Basic ${btoa("opencode:wrong")}` } })).status).toBe(401)
    expect((yield* server.request("/api/info", { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
    expect((yield* server.request(`/api/info?auth_token=${encodeURIComponent(btoa("opencode:wrong"))}`)).status).toBe(401)
    expect((yield* server.request("/api/info", { headers: { cookie: `${ServerAuth.sessionCookieName(new URL(server.base).host)}=invalid` } })).status).toBe(401)
  }
  const form = yield* server.signIn()
  expect(form.status).toBe(429)
  expect(Number(form.headers.get("retry-after"))).toBeGreaterThan(0)
  const api = yield* server.request("/api/info", { headers: server.headers })
  expect(api.status).toBe(401)
  expect(Number(api.headers.get("retry-after"))).toBeGreaterThan(0)
  const ui = yield* server.request("/", { headers: server.headers })
  expect(ui.status).toBe(429)
  expect(Number(ui.headers.get("retry-after"))).toBeGreaterThan(0)
  expect((yield* server.request("/api/info", { headers: { cookie: session } })).status).toBe(200)
  expect((yield* server.request("/", { headers: { cookie: session } })).status).toBe(200)
  // Existing cookies work without resetting the lockout for new credentials.
  expect((yield* server.signIn()).status).toBe(429)
}))

it.live("accepts upstream pairing tokens through Basic, Bearer, query, and same-origin cookies", () => Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const server = yield* start(directory.path)
  const pair = yield* server.request("/api/pair", { method: "POST", headers: server.headers })
  const body = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(yield* Effect.promise(() => pair.json()))
  const connected = yield* server.request(`/auth/connect/${body.code}`)
  expect(connected.status).toBe(200)
  const paired = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(yield* Effect.promise(() => connected.json()))
  const alternatives: ReadonlyArray<Record<string, string>> = [
    { authorization: `Basic ${btoa(`opencode:${paired.token}`)}` },
    { authorization: `Bearer ${paired.token}` },
    { cookie: `${ServerAuth.sessionCookieName(new URL(server.base).host)}=${paired.token}` },
  ]
  for (const headers of alternatives) expect((yield* server.request("/api/info", { headers })).status).toBe(200)
  expect((yield* server.request(`/api/info?auth_token=${encodeURIComponent(btoa(`opencode:${paired.token}`))}`)).status).toBe(200)
  expect((yield* server.request(`/auth/connect/${body.code}`)).status).toBe(401)
  const browserCode = yield* server.request("/api/pair", { method: "POST", headers: server.headers })
  const browserPair = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(yield* Effect.promise(() => browserCode.json()))
  const browser = yield* server.request(`/auth/connect/${browserPair.code}`, { headers: { accept: "text/html" } })
  const session = cookie(browser)
  expect((yield* server.request("/api/info", { headers: { cookie: session } })).status).toBe(200)
  expect((yield* server.request("/sign-out", { method: "POST", headers: { cookie: session } })).status).toBe(302)
  expect((yield* server.request("/api/info", { headers: { cookie: session } })).status).toBe(401)
}))
