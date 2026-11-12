import { OpenCode, withMediaRefs, type MediaRequestOptions } from "@opencode/client/promise"
import type { ServerConnection } from "@/runtime/server/registry"
import { decode64 } from "@/runtime/persistence/base64"
import { bytesToBase64 } from "@opencode/util/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return bytesToBase64(new TextEncoder().encode(`${input.username ?? "opencode"}:${input.password}`))
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)

  if (!decoded) return
  const separator = decoded.indexOf(":")

  if (separator === -1) return

  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  }
}

// Same-origin browser sessions use the server's sign-in page when their cookie
// expires. Remote servers still surface their own authentication failure.
export function withSignInRedirect(
  server: ServerConnection.HttpBase,
  fetcher: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const wrapped = (input: Parameters<typeof fetcher>[0], init?: Parameters<typeof fetcher>[1]) =>
    fetcher(input, init).then((response) => {
      if (
        response.status !== 401 ||
        typeof window === "undefined" ||
        !URL.canParse(server.url) ||
        new URL(server.url).origin !== window.location.origin
      )
        return response

      // The sign-in pages are the destination itself; a self-referential return path loops after sign-in.
      const next =
        window.location.pathname === "/sign-in" || window.location.pathname === "/sign-out" ? "/" : window.location.pathname
      window.location.assign(next === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(next)}`)

      return response
    })

  // Native fetch implementations may carry statics such as Bun's preconnect.
  return Object.assign(wrapped, fetcher)
}

/** `mediaRefs: false` reads stored media as inline bytes, for callers such as export that need self-contained messages. */
export type ServerRequestOptions = MediaRequestOptions

export function createApiForServer(input: { server: ServerConnection.HttpBase; fetch?: typeof globalThis.fetch }) {
  return withMediaRefs(
    OpenCode.make({
      baseUrl: input.server.url,
      fetch: withSignInRedirect(input.server, input.fetch ?? globalThis.fetch),
      headers: input.server.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({
              username: input.server.username,
              password: input.server.password,
            })}`,
          }
        : undefined,
    }),
  )
}

/**
 * The server's ranged read of one file, for media elements. They cannot send the Authorization header, and a credential
 * never goes in a DOM URL, so a server that needs a password has none: its media downloads through the API instead.
 */
export function fileStreamUrl(server: ServerConnection.HttpBase, input: { path: string; directory: string }) {
  if (server.password) return

  const url = new URL(
    `api/fs/read/${input.path.split("/").map(encodeURIComponent).join("/")}`,
    server.url.endsWith("/") ? server.url : `${server.url}/`,
  )

  url.searchParams.set("location[directory]", input.directory)

  return url.href
}

export type ServerApi = ReturnType<typeof createApiForServer>
