import { createMemo } from "solid-js"
import { produce } from "solid-js/store"
import { Effect, Option, Schema, SchemaGetter } from "effect"
import type { Data } from "@opencode/client/solid"
import { base64Encode } from "@opencode/util/encode"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { ServerScope } from "@/runtime/server/scope"
import type { ServerSDK } from "@/runtime/server/client"
import { useSettings } from "@/settings/model"

const overridesSchema = Persistence.record(
  Schema.Boolean.pipe(Schema.catchDecoding(() => Effect.succeed(Option.none()))),
)

const policySchema = Persistence.migrate(
  Persistence.struct({ autoAccept: overridesSchema }),
  Persistence.legacy({
    autoAccept: Persistence.optional(overridesSchema),
    autoAcceptEdits: Persistence.optional(overridesSchema),
  }).pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) => ({
        autoAccept: value.autoAccept ?? value.autoAcceptEdits ?? {},
      })),
      encode: SchemaGetter.transform((value) => value),
    }),
  ),
)

// Keep Wellington's saved overrides, but let the current server controller own
// the policy and the upstream approver own all replies and reconnect sweeps.
export function createRequestPolicy(input: { sdk: ServerSDK; data: Data }) {
  const settings = useSettings()
  const [store, setStore, , loaded] = persisted(
    {
      ...Persist.serverGlobal(input.sdk.scope, "permission"),
      copyFrom:
        input.sdk.scope === ServerScope.local
          ? [{ key: "permission.v3" }, { key: "permission.v3", storage: "default.dat" }]
          : undefined,
    },
    policySchema,
    { autoAccept: {} },
  )

  const ready = () => loaded() && settings.ready()
  const enabled = createMemo(
    () => ready() && (settings.permissions.autoApprove() || Object.values(store.autoAccept).some(Boolean)),
  )
  const autoApproves = (sessionID: string, directory?: string) =>
    ready() &&
    permissionAutoApprove({
      overrides: store.autoAccept,
      sessionID,
      directory: directory ?? input.data.session.get(sessionID)?.location.directory,
      session: input.data.session.get,
      fallback: settings.permissions.autoApprove(),
    })

  return {
    ready,
    enabled,
    // Preserve the upstream fast path: the UI need not walk any session tree
    // while the global default is on and there are no explicit denies.
    autoApprovesAll: createMemo(
      () => ready() && settings.permissions.autoApprove() && Object.values(store.autoAccept).every(Boolean),
    ),
    autoApproves,
    async resolve(sessionID: string, directory?: string) {
      await Promise.all([loaded.promise, settings.ready.promise])

      if (!enabled()) return false

      if (!Object.keys(store.autoAccept).length) return settings.permissions.autoApprove()

      // An event can arrive before a child or its parents were loaded. Resolve
      // that lineage before using the global default, so a parent's false wins.
      const seen = new Set([sessionID])
      const ids = [sessionID]

      for (const id of ids) {
        if (!input.data.session.get(id)) await input.data.session.sync(id).catch(() => undefined)
        const session = input.data.session.get(id)

        if (!session) return false

        if (!session.parentID || seen.has(session.parentID)) continue
        seen.add(session.parentID)
        ids.push(session.parentID)
      }

      return autoApproves(sessionID, directory)
    },
    set(sessionID: string, value: boolean) {
      const directory = input.data.session.get(sessionID)?.location.directory
      const key = directory ? `${base64Encode(directory)}/${sessionID}` : sessionID
      setStore(
        "autoAccept",
        produce((overrides) => {
          overrides[key] = value

          if (directory) delete overrides[sessionID]
        }),
      )
    },
  }
}

export function permissionAutoApprove(input: {
  overrides: Record<string, boolean>
  sessionID: string
  directory?: string
  session: (id: string) => { parentID?: string } | undefined
  fallback: boolean
}) {
  if (!Object.keys(input.overrides).length) return input.fallback
  const prefix = input.directory ? `${base64Encode(input.directory)}/` : ""
  const seen = new Set([input.sessionID])
  const ids = [input.sessionID]

  for (const id of ids) {
    const value = input.overrides[`${prefix}${id}`] ?? input.overrides[id]

    if (value !== undefined) return value
    const session = input.session(id)

    // Until resolve() loads an unknown ancestor, keep the request visible.
    if (!session) return false

    if (!session.parentID || seen.has(session.parentID)) continue
    seen.add(session.parentID)
    ids.push(session.parentID)
  }

  return (prefix ? input.overrides[`${prefix}*`] : undefined) ?? input.fallback
}

export type RequestPolicy = ReturnType<typeof createRequestPolicy>
