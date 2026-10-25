import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { ClientError, type LocationRef } from "../promise"

// One recovery cycle per observed location, shared by providers and integrations.
export function createCatalog(input: {
  key: (ref?: LocationRef) => string
  connected: () => boolean
  load: (ref?: LocationRef) => Promise<void>
}) {
  const entries = new Map<string, ReturnType<typeof createEntry>>()

  function createEntry(ref?: LocationRef) {
    const [state, setState] = createStore<{
      loading: boolean
      error?: "authentication" | "failed"
      retrying: boolean
    }>({ loading: false, retrying: false })
    let active = true
    let count = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let running: Promise<void> | undefined
    let queued = false
    let version = 0
    let users = 0

    const cancel = () => {
      clearTimeout(timer)
      timer = undefined
      setState("retrying", false)
    }

    const sync = (reset = false): Promise<void> => {
      if (!active || !input.connected()) return Promise.resolve()
      if (reset) count = 0
      if (running) return running
      cancel()
      const current = version
      setState("loading", true)
      running = Promise.resolve()
        .then(() => input.load(ref))
        .then(() => {
          if (!active || current !== version) return
          count = 0
          setState("error", undefined)
        })
        .catch((error: unknown) => {
          if (!active || current !== version) return
          const failure = catalogFailure(error)
          setState("error", failure.authentication ? "authentication" : "failed")
          const delay = Math.max(1_000 * 2 ** count, failure.after ?? 0)
          if (failure.retry && count < 3 && input.connected() && delay <= 2_147_483_647) {
            count++
            setState("retrying", true)
            timer = setTimeout(() => {
              timer = undefined
              void sync().catch(() => undefined)
            }, delay)
          }
          throw error
        })
        .finally(() => {
          running = undefined
          if (!active) return
          setState("loading", false)
          if (!queued || !input.connected()) return
          queued = false
          void sync().catch(() => undefined)
        })
      return running
    }

    return {
      ref,
      state,
      retry: () => sync(true),
      refresh() {
        if (running) queued = true
        return sync()
      },
      pause() {
        version++
        queued = false
        cancel()
      },
      resume() {
        if (running) queued = true
        void sync(true).catch(() => undefined)
      },
      retain() {
        users++
      },
      release() {
        return --users
      },
      dispose() {
        active = false
        cancel()
      },
    }
  }

  onCleanup(() => entries.forEach((entry) => entry.dispose()))

  return {
    watch(ref?: LocationRef) {
      // Keep the default-location observer stable while syncInfo resolves its directory.
      const key = ref ? input.key(ref) : "default"
      const existing = entries.get(key)
      const entry = existing ?? createEntry(ref)
      entries.set(key, entry)
      entry.retain()
      onCleanup(() => {
        if (entry.release() !== 0) return
        entry.dispose()
        entries.delete(key)
      })
      if (!existing) entry.resume()
      return { state: entry.state, retry: entry.retry }
    },
    refresh(ref?: LocationRef) {
      const matching = [...entries.values()].filter((entry) => input.key(entry.ref) === input.key(ref))
      if (matching.length === 0) return
      return Promise.all(matching.map((entry) => entry.refresh())).then(() => undefined)
    },
    pause: () => entries.forEach((entry) => entry.pause()),
    resume: () => entries.forEach((entry) => entry.resume()),
  }
}

function catalogFailure(error: unknown): { authentication?: boolean; retry: boolean; after?: number } {
  if (error instanceof AggregateError) {
    const failures = error.errors.map(catalogFailure)
    if (failures.some((failure) => failure.authentication)) return { authentication: true, retry: false }
    return {
      retry: failures.length > 0 && failures.every((failure) => failure.retry),
      after: Math.max(0, ...failures.map((failure) => failure.after ?? 0)),
    }
  }
  if (!(error instanceof Error)) return { retry: false }
  const cause = error.cause
  if (cause && typeof cause === "object" && "status" in cause && typeof cause.status === "number") {
    if (cause.status === 401 || cause.status === 403) return { authentication: true, retry: false }
    const value = "retryAfter" in cause && typeof cause.retryAfter === "string" ? cause.retryAfter : undefined
    const after = value ? (/^\d+(\.\d+)?$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now()) : 0
    return {
      retry: cause.status === 408 || cause.status === 429 || (cause.status >= 500 && cause.status < 600),
      after: Number.isFinite(after) && after > 0 ? after : undefined,
    }
  }
  if (error instanceof ClientError && error.reason === "Transport") return { retry: true }
  if (error.name === "TimeoutError") return { retry: true }
  return { retry: false }
}
