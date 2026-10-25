import { afterEach, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, withSignInRedirect } from "./api"

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
