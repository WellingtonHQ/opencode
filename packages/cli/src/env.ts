import { Config, Schema } from "effect"

// Every environment variable the CLI reads, in one place. Consumers yield
// these instead of touching process.env so the full surface stays visible,
// typed, and redacted where secret.

// The opencode server password: sent by clients connecting to an explicit
// --server, and adopted by a manually run or standalone server. The legacy
// name is still honored.
export const password = Config.Redacted("OPENCODE_PASSWORD").pipe(
  Config.orElse(() => Config.Redacted("OPENCODE_SERVER_PASSWORD")),
  Config.withDefault(undefined),
)

export const serverPassword = Config.Redacted("OPENCODE_SERVER_PASSWORD").pipe(Config.withDefault(undefined))
export const username = Config.String("OPENCODE_SERVER_USERNAME").pipe(Config.withDefault("opencode"))
export const hostname = Config.String("OPENCODE_SERVER_HOST").pipe(Config.withDefault(undefined))
// Wellington's server port name remains the contract; explicit --port still takes precedence.
export const port = Config.schema(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65_535)),
  "OPENCODE_SERVER_PORT",
).pipe(Config.withDefault(undefined))

export function session() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "OPENCODE_PASSWORD" && entry[0] !== "OPENCODE_SERVER_PASSWORD",
    ),
  )
}

export * as Env from "./env"
