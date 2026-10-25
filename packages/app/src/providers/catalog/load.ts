import { useData } from "@/runtime/server/current"
import { createMemo, type Accessor } from "solid-js"

export function useCatalog(directory: Accessor<string | undefined>) {
  const data = useData()
  const catalog = createMemo(() => {
    const value = directory()
    return data.location.catalog.watch(value ? { directory: value } : undefined)
  })

  return {
    loading: () => catalog().state.loading,
    error: () => catalog().state.error,
    retrying: () => catalog().state.retrying,
    retry: () => catalog().retry(),
  }
}
