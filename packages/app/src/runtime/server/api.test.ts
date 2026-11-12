import { afterEach, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, createApiForServer, fileStreamUrl, withSignInRedirect } from "./api"

const originalUrl = window.location.href

afterEach(() => {
  window.location.href = originalUrl
})

test.each([
  [btoa("opencode:secret"), { username: "opencode", password: "secret" }],
  [btoa("legacy:secret:with:colons"), { username: "legacy", password: "secret:with:colons" }],
  [btoa(":secret"), { username: "", password: "secret" }],
  ["not base64", undefined],
  [btoa("missing-separator"), undefined],
])("authFromToken(%p) extracts the username and password", (token, expected) => {
  expect(authFromToken(token)).toEqual(expected)
})

test.each([undefined, "custom", "équipe"])("authTokenFromCredentials preserves the username (%s)", (username) => {
  expect(authTokenFromCredentials({ username, password: "secret" })).toBe(
    Buffer.from(`${username ?? "opencode"}:secret`).toString("base64"),
  )
})

test.each([
  { server: "http://localhost:4444", status: 401, location: "/server/local/session/ses_active", next: "/sign-in?next=%2Fserver%2Flocal%2Fsession%2Fses_active" },
  { server: "http://localhost:4444", status: 200, location: "/server/local/session/ses_active", next: "/server/local/session/ses_active" },
  { server: "http://localhost:4096", status: 401, location: "/server/local/session/ses_active", next: "/server/local/session/ses_active" },
  { server: "not a URL", status: 401, location: "/server/local/session/ses_active", next: "/server/local/session/ses_active" },
  { server: "http://localhost:4444", status: 401, location: "/sign-in", next: "/sign-in" },
  { server: "http://localhost:4444", status: 401, location: "/sign-out", next: "/sign-in" },
])("server fetch preserves the transport and redirects $server ($status) appropriately", async (row) => {
  window.location.href = `http://localhost:4444${row.location}`

  const response = new Response(null, { status: row.status })

  const calls: Parameters<typeof fetch>[] = []

  const fetcher: typeof fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      calls.push(args)

      return response
    },
    { preconnect: fetch.preconnect },
  )

  const wrapped = withSignInRedirect({ url: row.server }, fetcher)
  const request = new Request("http://localhost:4444/api/info", { credentials: "include" })
  const init = { signal: new AbortController().signal }
  expect(await wrapped(request, init)).toBe(response)
  expect(calls).toEqual([[request, init]])
  expect(wrapped.preconnect).toBe(fetcher.preconnect)
  expect(`${window.location.pathname}${window.location.search}`).toBe(row.next)
})

test("an expired same-origin session at Home opens sign-in without a return path", async () => {
  window.location.href = "http://localhost:4444/"

  const fetcher: typeof fetch = Object.assign(async () => new Response(null, { status: 401 }), {
    preconnect: fetch.preconnect,
  })

  await withSignInRedirect({ url: "http://localhost:4444" }, fetcher)("http://localhost:4444/api/info")
  expect(`${window.location.pathname}${window.location.search}`).toBe("/sign-in")
})

test("fileStreamUrl never puts a credential in a media URL", () => {
  const input = { path: "clips/final cut.mp4", directory: "/work/app" }
  expect(fileStreamUrl({ url: "http://127.0.0.1:4096", password: "secret" }, input)).toBeUndefined()
  expect(fileStreamUrl({ url: "http://127.0.0.1:4096" }, input)).toBe(
    "http://127.0.0.1:4096/api/fs/read/clips/final%20cut.mp4?location%5Bdirectory%5D=%2Fwork%2Fapp",
  )
})

test("only message and inbox reads ask for media refs, so other cross-origin requests stay unpreflighted", async () => {
  const requests: Array<{ path: string; headers: Headers }> = []

  const api = createApiForServer({
    server: { url: "https://server.example:4096", username: "custom", password: "secret" },
    // SAFETY: the API client only calls fetch with a URL and init, which this stub accepts.
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        path: new URL(input instanceof Request ? input.url : input).pathname,
        headers: new Headers(init?.headers),
      })

      return Response.json({ data: [], cursor: {} })
    }) as typeof fetch,
  })

  await api.message.list({ sessionID: "ses_1" })
  await api.message.list({ sessionID: "ses_1" }, { mediaRefs: false, headers: { "X-Trace": "1" } })
  await api.session.message.get({ sessionID: "ses_1", messageID: "msg_1" })
  await api.session.inbox.list({ sessionID: "ses_1" }, { headers: { "X-Trace": "1" } })
  await api.session.list()

  expect(
    requests.map((request) => [
      request.path,
      request.headers.get("x-opencode-capabilities"),
      request.headers.get("authorization"),
    ]),
  ).toEqual([
    ["/api/session/ses_1/message", "experimental-media-uri", `Basic ${btoa("custom:secret")}`],
    ["/api/session/ses_1/message", null, `Basic ${btoa("custom:secret")}`],
    ["/api/session/ses_1/message/msg_1", "experimental-media-uri", `Basic ${btoa("custom:secret")}`],
    ["/api/session/ses_1/inbox", "experimental-media-uri", `Basic ${btoa("custom:secret")}`],
    ["/api/session", null, `Basic ${btoa("custom:secret")}`],
  ])
  expect(requests[1].headers.get("x-trace")).toBe("1")
  expect(requests[3].headers.get("x-trace")).toBe("1")
})
