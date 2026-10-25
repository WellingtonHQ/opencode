import { useData } from "@/runtime/server/current"
import { normalizeProviderList } from "@/runtime/server/global-sync/utils"
import { Iterable, pipe } from "effect"
import { createMemo, type Accessor } from "solid-js"
import type { ProviderListResponse } from "@/runtime/server/types"
import { useIntegrations } from "./integrations"
import { popularProviders } from "./order"

export { popularProviders } from "./order"

const emptyProviderCatalog: ProviderListResponse = { all: new Map(), connected: [], default: {} }

const popularProviderSet = new Set(popularProviders)

export function useProviders(directory: Accessor<string | undefined>) {
  const data = useData()

  const location = () => {
    const dir = directory()

    return dir ? { directory: dir } : undefined
  }

  const integrations = useIntegrations(directory)

  const snapshot = createMemo<{
    directory: string | undefined
    value: ProviderListResponse
    ready: boolean
  }>((previous) => {
    const key = directory()

    if (previous && previous.directory === key && (integrations.loading() || integrations.error())) return previous
    const ref = location()
    const provider = data.location.provider.list(ref)
    const model = data.location.model.list(ref)

    return {
      directory: key,
      value: provider && model ? normalizeProviderList(provider, model) : emptyProviderCatalog,
      ready: provider !== undefined && model !== undefined,
    }
  })

  const providers = () => snapshot().value
  const ready = () => snapshot().ready

  return {
    loading: integrations.loading,
    error: integrations.error,
    retrying: integrations.retrying,
    retry: integrations.retry,
    ready,
    all: () => providers().all,
    default: () => providers().default,
    // V2 servers list only available providers, so the connectable catalog
    // comes from the integration list, with the provider catalog as fallback.
    popular: () => {
      const catalog = integrations
        .list()
        .filter((integration) => popularProviderSet.has(integration.id))
        .map((integration) => ({ id: integration.id, name: integration.name }))

      const seen = new Set(catalog.map((integration) => integration.id))

      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id) && !seen.has(p.id)),
        Iterable.map((p) => ({ id: p.id, name: p.name })),
        (v) => [...catalog, ...v],
      )
    },
    connected: () => {
      const connected = new Set(providers().connected)

      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => connected.has(p.id)),
        (v) => Array.from(v),
      )
    },
    // Any stored or detected connection, or a provider with models beyond the keyless OpenCode catalog.
    // Undefined until both catalogs load, so callers never mistake loading for a first run.
    anyConnection: () => {
      if (!integrations.ready() || !ready()) return undefined

      if (integrations.list().some((integration) => integration.connections.length > 0)) return true

      return providers().connected.some(
        (id) => id !== "opencode" && Object.keys(providers().all.get(id)?.models ?? {}).length > 0,
      )
    },
    paid: () => {
      const connected = new Set(providers().connected)

      const paid = [
        ...Iterable.filter(
          providers().all,
          ([id]) =>
            connected.has(id) &&
            (id !== "opencode" || Object.values(providers().all.get(id)?.models ?? {}).some((m) => m.cost?.input)),
        ),
      ]

      return paid
    },
  }
}
