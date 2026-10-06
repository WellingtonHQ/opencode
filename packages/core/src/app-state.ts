export * as AppState from "./app-state"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { AppSettingTable } from "./app-state/sql"

const AUTO_APPROVE_KEY = "permissions.auto-approve"

export interface Interface {
  /** Returns the raw JSON-encoded value stored for a key, or undefined when absent. */
  readonly get: (key: string) => Effect.Effect<string | undefined>
  /** Stores a JSON-encoded value under a key, replacing any existing one. */
  readonly set: (key: string, valueJsonString: string) => Effect.Effect<void>
  /** Global auto-approve switch for headless permission handling; defaults to false when unset. */
  readonly autoApprove: () => Effect.Effect<boolean>
  readonly setAutoApprove: (enabled: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/AppState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const get = Effect.fn("AppState.get")(function* (key: string) {
      const row = yield* db.select().from(AppSettingTable).where(eq(AppSettingTable.key, key)).get().pipe(Effect.orDie)
      return row?.value
    })

    const set = Effect.fn("AppState.set")(function* (key: string, valueJsonString: string) {
      yield* db
        .insert(AppSettingTable)
        .values({ key, value: valueJsonString, time_updated: Date.now() })
        .onConflictDoUpdate({ target: AppSettingTable.key, set: { value: valueJsonString, time_updated: Date.now() } })
        .run()
        .pipe(Effect.orDie)
    })

    // Values are only written by setAutoApprove, so the stored string is always valid JSON.
    const autoApprove = Effect.fn("AppState.autoApprove")(function* () {
      const raw = yield* get(AUTO_APPROVE_KEY)
      if (raw === undefined) return false
      return JSON.parse(raw) === true
    })

    const setAutoApprove = Effect.fn("AppState.setAutoApprove")(function* (enabled: boolean) {
      yield* set(AUTO_APPROVE_KEY, JSON.stringify(enabled))
    })

    return Service.of({ get, set, autoApprove, setAutoApprove })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
