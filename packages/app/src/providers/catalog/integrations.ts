import { useData } from "@/runtime/server/current"
import { createMemo, type Accessor } from "solid-js"
import type { IntegrationInfo } from "@opencode/client/promise"
import { useCatalog } from "./load"

export function useIntegrations(directory: Accessor<string | undefined>) {
  const data = useData()
  const catalog = useCatalog(directory)

  const location = () => {
    const value = directory()

    return value ? { directory: value } : undefined
  }

  const snapshot = createMemo<{ directory: string | undefined; list: IntegrationInfo[] | undefined }>((previous) => {
    const key = directory()

    if (previous && previous.directory === key && (catalog.loading() || catalog.error())) return previous
    return { directory: key, list: data.location.integration.list(location()) }
  })

  return {
    ...catalog,
    ready: () => snapshot().list !== undefined,
    list: () => snapshot().list ?? [],
  }
}
