import { afterEach, expect, jest, setSystemTime, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData } from "../src/solid"
import { OpenCode } from "../src/promise"

afterEach(() => {
  jest.useRealTimers()
  setSystemTime()
})

// Flush promise-based fetch/JSON decoding without advancing the recovery clock.
async function settle(state: { loading: boolean }) {
  for (let turn = 0; turn < 100 && state.loading; turn++) await Promise.resolve()
  expect(state.loading).toBe(false)
}

function fixture(response: (path: string) => Response | Promise<Response>) {
  const reads: { path: string; time: number }[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const path = new URL((input instanceof Request ? input : new Request(input, init)).url).pathname
      reads.push({ path, time: Date.now() })
      return response(path)
    },
  })
  const setup = createRoot((dispose) => {
    const data = createData({
      api: () => api,
      directory: "/project",
      event: { on: () => () => {}, listen: () => () => {} },
    })
    const observers = createRoot((release) => ({
      catalog: data.location.catalog.watch({ directory: "/project" }),
      second: data.location.catalog.watch({ directory: "/project" }),
      release,
    }))
    return {
      data,
      ...observers,
      dispose: () => {
        observers.release()
        dispose()
      },
    }
  })
  return { ...setup, reads }
}

for (const failure of [500, 503, 429, "network", "timeout"] as const) {
  test(`catalog bounds shared recovery for ${failure} to three exponential retries`, async () => {
    jest.useFakeTimers()
    const setup = fixture((path) => {
      if (path !== "/api/provider") return Response.json({ location: { directory: "/project" }, data: [] })
      if (failure === "network") throw new TypeError("Failed to fetch")
      if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError")
      return Response.json({ _tag: "ServerUnavailableError", message: "Unavailable" }, { status: failure })
    })
    try {
      await settle(setup.catalog.state)
      expect(setup.catalog.state).toMatchObject({ error: "failed", retrying: true })
      expect(setup.second.state).toBe(setup.catalog.state)
      const initial = setup.reads.find((read) => read.path === "/api/provider")!.time
      for (const delay of [1_000, 2_000, 4_000]) {
        const count = setup.reads.length
        jest.advanceTimersByTime(delay - 1)
        expect(setup.reads).toHaveLength(count)
        jest.advanceTimersByTime(1)
        await settle(setup.catalog.state)
      }
      expect(setup.reads.filter((read) => read.path === "/api/provider").map((read) => read.time - initial)).toEqual([
        0, 1_000, 3_000, 7_000,
      ])
      expect(setup.reads.filter((read) => read.path === "/api/model")).toHaveLength(1)
      expect(setup.reads.filter((read) => read.path === "/api/integration")).toHaveLength(1)
      expect(setup.catalog.state.retrying).toBe(false)
      jest.advanceTimersByTime(60_000)
      expect(setup.reads).toHaveLength(6)
    } finally {
      setup.dispose()
    }
  })
}

for (const status of [400, 401, 403, 404]) {
  test(`catalog does not automatically retry HTTP ${status}`, async () => {
    jest.useFakeTimers()
    const setup = fixture(() => Response.json({ _tag: "UnauthorizedError", message: "Rejected" }, { status }))
    try {
      await settle(setup.catalog.state)
      expect(setup.catalog.state.error).toBe(status === 401 || status === 403 ? "authentication" : "failed")
      expect(setup.catalog.state.retrying).toBe(false)
      jest.advanceTimersByTime(60_000)
      expect(setup.reads).toHaveLength(3)
    } finally {
      setup.dispose()
    }
  })
}

for (const header of ["10", "Sun, 25 Oct 2026 12:00:10 GMT", "invalid"]) {
  test(`catalog honors Retry-After ${header}`, async () => {
    jest.useFakeTimers()
    setSystemTime(new Date("2026-10-25T12:00:00Z"))
    let failed = true
    const setup = fixture(() =>
      failed
        ? new Response("Rate limited", { status: 429, headers: { "retry-after": header } })
        : Response.json({ location: { directory: "/project" }, data: [] }),
    )
    try {
      await settle(setup.catalog.state)
      failed = false
      jest.advanceTimersByTime((header === "invalid" ? 1_000 : 10_000) - 1)
      expect(setup.reads).toHaveLength(3)
      jest.advanceTimersByTime(1)
      await settle(setup.catalog.state)
      expect(setup.reads).toHaveLength(6)
      expect(setup.catalog.state.error).toBeUndefined()
      expect(setup.catalog.state.retrying).toBe(false)
    } finally {
      setup.dispose()
    }
  })
}

test("catalog ignores a previous location's late failure after switching observers", async () => {
  jest.useFakeTimers()
  const response = Promise.withResolvers<Response>()
  let switched = false
  const setup = fixture(() =>
    switched ? Response.json({ location: { directory: "/other" }, data: [] }) : response.promise,
  )
  await Promise.resolve()
  expect(setup.reads).toHaveLength(3)
  setup.release()
  switched = true
  const other = createRoot((dispose) => ({
    catalog: setup.data.location.catalog.watch({ directory: "/other" }),
    dispose,
  }))
  try {
    await settle(other.catalog.state)
    response.resolve(new Response("Offline", { status: 500 }))
    for (let turn = 0; turn < 100; turn++) await Promise.resolve()
    expect(setup.catalog.state.error).toBeUndefined()
    expect(other.catalog.state.error).toBeUndefined()
    expect(setup.data.location.provider.list({ directory: "/other" })).toEqual([])
    jest.advanceTimersByTime(60_000)
    expect(setup.reads).toHaveLength(6)
  } finally {
    other.dispose()
    setup.dispose()
  }
})

test("catalog cancels a scheduled retry when its last observer leaves", async () => {
  jest.useFakeTimers()
  const setup = fixture(() => new Response("Offline", { status: 500 }))
  await settle(setup.catalog.state)
  expect(setup.catalog.state.retrying).toBe(true)
  setup.dispose()
  jest.advanceTimersByTime(60_000)
  expect(setup.reads).toHaveLength(3)
})

test("catalog retries default-location metadata before loading the three catalogs", async () => {
  jest.useFakeTimers()
  const paths: string[] = []
  let failed = true
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const path = new URL((input instanceof Request ? input : new Request(input, init)).url).pathname
      paths.push(path)
      if (path === "/api/location")
        return failed ? new Response("Unavailable", { status: 503 }) : Response.json({ directory: "/project" })
      return Response.json({ location: { directory: "/project" }, data: [] })
    },
  })
  const setup = createRoot((dispose) => {
    const data = createData({ api: () => api, directory: "", event: { on: () => () => {}, listen: () => () => {} } })
    return { catalog: data.location.catalog.watch(), dispose }
  })
  try {
    await settle(setup.catalog.state)
    expect(paths).toEqual(["/api/location"])
    failed = false
    jest.advanceTimersToNextTimer()
    await settle(setup.catalog.state)
    expect(paths).toEqual(["/api/location", "/api/location", "/api/provider", "/api/model", "/api/integration"])
    expect(setup.catalog.state.error).toBeUndefined()
  } finally {
    setup.dispose()
  }
})
