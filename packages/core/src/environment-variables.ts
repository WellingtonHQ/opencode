export * as EnvironmentVariables from "./environment-variables.js"

import path from "node:path"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { AppProcess } from "@opencode/util/process"

export class ReadError extends Schema.TaggedError<ReadError>()("EnvironmentVariables.ReadError", {}) {
  override get message() {
    return "Could not read saved environment variables."
  }
}

export interface Interface {
  readonly get: (name: string) => string | undefined
  readonly refresh: Effect.Effect<void, ReadError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/EnvironmentVariables") {}

const Persisted = Schema.Struct({
  Machine: Schema.Record(Schema.String, Schema.String),
  User: Schema.Record(Schema.String, Schema.String),
})

export type Persisted = typeof Persisted.Type

/** Without a persisted source, names keep the process's case-sensitive semantics. */
export function make(options: {
  readonly inherited:
    | Readonly<Record<string, string | undefined>>
    | (() => Readonly<Record<string, string | undefined>>)
  readonly persisted?: Effect.Effect<Persisted, unknown>
}): Interface {
  const key = (name: string) => (options.persisted ? name.toUpperCase() : name)
  const source = options.inherited
  const inherited = new Map(
    Object.entries(typeof source === "function" ? {} : source).flatMap(([name, value]) =>
      value === undefined ? [] : [[key(name), value]],
    ),
  )
  const snapshot = Ref.makeUnsafe<{
    readonly values: ReadonlyMap<string, string>
    readonly seen: ReadonlySet<string>
  }>({ values: new Map(), seen: new Set() })

  const refresh = options.persisted
    ? options.persisted.pipe(
        Effect.mapError(() => new ReadError()),
        Effect.flatMap((saved) =>
          Ref.update(snapshot, (previous) => {
            const values = new Map(
              [...Object.entries(saved.Machine), ...Object.entries(saved.User)].map(([name, value]) => [
                key(name),
                value,
              ]),
            )
            // Remember names, not old values: deleted saved variables must not revive inherited credentials.
            return { values, seen: new Set([...previous.seen, ...values.keys()]) }
          }),
        ),
      )
    : Effect.void

  return Service.of({
    get: (name) => {
      const current = Ref.getUnsafe(snapshot)
      const normalized = key(name)
      if (current.seen.has(normalized)) return current.values.get(normalized)
      if (typeof source !== "function") return inherited.get(normalized)
      return options.persisted
        ? Object.entries(source()).find(([name]) => key(name) === normalized)?.[1]
        : source()[name]
    },
    refresh,
  })
}

// This fixed script never interpolates variable names or values into command arguments.
const script = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$saved = @{ Machine = @{}; User = @{} }",
  "foreach ($scope in @('Machine', 'User')) {",
  "  foreach ($entry in [Environment]::GetEnvironmentVariables($scope).GetEnumerator()) {",
  "    if ($entry.Key -is [string] -and $entry.Value -is [string]) {",
  "      $saved[$scope][$entry.Key] = $entry.Value",
  "    }",
  "  }",
  "}",
  "ConvertTo-Json -InputObject $saved -Depth 3 -Compress",
].join("\n")

const decodePersisted = Schema.decodeUnknownEffect(Schema.fromJsonString(Persisted))

export const readWindows = Effect.fn("EnvironmentVariables.readWindows")(
  function* (inherited: Readonly<Record<string, string | undefined>>) {
    const processes = yield* AppProcess.Service
    const root = Object.entries(inherited).find(([name]) => name.toUpperCase() === "SYSTEMROOT")?.[1] ?? "C:\\Windows"
    const result = yield* processes.run(
      ChildProcess.make(
        path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { extendEnv: true, stdin: "ignore", windowsHide: true },
      ),
      { timeout: "10 seconds", maxOutputBytes: 4 * 1024 * 1024, maxErrorBytes: 0 },
    )
    if (result.exitCode !== 0 || result.stdoutTruncated) return yield* new ReadError()
    return yield* decodePersisted(result.stdout.toString("utf8"))
  },
  // Neither process failures nor schema errors may retain output or raw causes containing secrets.
  Effect.mapError(() => new ReadError()),
)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const processes = yield* AppProcess.Service
    const inherited = { ...process.env }
    return make({
      inherited: () => process.env,
      persisted:
        process.platform === "win32"
          ? readWindows(inherited).pipe(Effect.provideService(AppProcess.Service, processes))
          : undefined,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [AppProcess.node] })
