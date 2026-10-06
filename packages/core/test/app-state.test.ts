import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppState } from "@opencode-ai/core/app-state"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, AppState.node]), []))

describe("AppState", () => {
  it.effect("defaults auto-approve to false when nothing is stored", () =>
    Effect.gen(function* () {
      const state = yield* AppState.Service
      expect(yield* state.autoApprove()).toBe(false)
    }),
  )

  it.effect("stores and reads raw values under a key, replacing on conflict", () =>
    Effect.gen(function* () {
      const state = yield* AppState.Service
      expect(yield* state.get("some.key")).toBeUndefined()

      yield* state.set("some.key", JSON.stringify({ hello: "world" }))
      expect(yield* state.get("some.key")).toBe(JSON.stringify({ hello: "world" }))

      yield* state.set("some.key", JSON.stringify({ hello: "again" }))
      expect(yield* state.get("some.key")).toBe(JSON.stringify({ hello: "again" }))
    }),
  )

  it.effect("persists the auto-approve switch through setAutoApprove", () =>
    Effect.gen(function* () {
      const state = yield* AppState.Service
      expect(yield* state.autoApprove()).toBe(false)

      yield* state.setAutoApprove(true)
      expect(yield* state.autoApprove()).toBe(true)

      yield* state.setAutoApprove(false)
      expect(yield* state.autoApprove()).toBe(false)
    }),
  )
})
