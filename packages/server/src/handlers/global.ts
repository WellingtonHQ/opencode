import { AppState } from "@opencode/core/app-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"

export const GlobalHandler = HttpApiBuilder.group(Api, "server.global", (handlers) =>
  Effect.gen(function* () {
    const appState = yield* AppState.Service
    return handlers
      .handle("global.autoApprove.get", () => Effect.map(appState.autoApprove(), (enabled) => ({ enabled })))
      .handle(
        "global.autoApprove.set",
        Effect.fn(function* (ctx) {
          yield* appState.setAutoApprove(ctx.payload.enabled)
          return { enabled: ctx.payload.enabled }
        }),
      )
  }),
)
