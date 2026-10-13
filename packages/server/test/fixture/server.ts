import { Effect } from "effect"
import { HttpServer } from "effect/http"
import { ServerProcess } from "../../src/process"
import type { ServerOptions } from "../../src/options"

export const startServer = Effect.fnUntraced(function* (
  directory: string,
  options: ServerOptions = {},
  transform?: ServerProcess.Transform,
) {
  const server = yield* ServerProcess.start<never, never>(
    {
      hostname: "127.0.0.1",
      port: 0,
      password: "secret",
      app: { version: "test-version" },
      database: { path: ":memory:" },
      config: { directory },
      fs: { filewatcher: false },
      models: { fetch: false },
      ...options,
    },
    undefined,
    transform,
  )
  return {
    base: HttpServer.formatAddress(server.address),
    headers: {
      authorization: `Basic ${Buffer.from(`${options.username ?? "opencode"}:${options.password ?? "secret"}`).toString("base64")}`,
    },
  }
})
