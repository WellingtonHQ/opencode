import { describe, expect, test } from "bun:test"
import {
  createEndpointSyncState,
  transitionEndpointSync,
  type EndpointSyncEffect,
  type EndpointSyncEvent,
  type EndpointSyncState,
} from "./endpoint-machine"

const first = { url: "http://127.0.0.1:4101", password: "first" }

const second = { url: "http://127.0.0.1:4102", password: "second" }

const third = { url: "http://127.0.0.1:4103", password: "third" }

function replay(events: EndpointSyncEvent[], state: EndpointSyncState = createEndpointSyncState(first)) {
  return events.reduce<{ state: EndpointSyncState; effects: EndpointSyncEffect[] }>(
    (result, event) => {
      const next = transitionEndpointSync(result.state, event)

      return { state: next.state, effects: [...result.effects, ...next.effects] }
    },
    { state, effects: [] },
  )
}

describe("transitionEndpointSync", () => {
  test("snapshots a custom username without keeping the mutable endpoint", () => {
    const http = { ...first, username: "custom" }
    const state = createEndpointSyncState(http)
    http.username = "other"

    expect(state).toEqual({ type: "idle", http: { ...first, username: "custom" }, attempt: 0 })
  })

  test.each(["reported", "resolved"] as const)("a username-only %s change rotates the transport", (source) => {
    const http = { ...first, username: "custom" }
    const result = replay(
      source === "reported"
        ? [{ type: "endpoint.reported", http }]
        : [{ type: "resolve.started" }, { type: "resolve.succeeded", attempt: 1, http }],
    )

    expect(result.state).toEqual({ type: "idle", http, attempt: source === "reported" ? 0 : 1 })
    expect(result.effects).toEqual([
      { type: "transport.update", http },
      ...(source === "reported" ? [{ type: "stream.resync" as const }] : []),
    ])
    http.username = "other"
    expect(result.state).toMatchObject({ http: { username: "custom" } })
  })

  test("an explicit default username keeps the current endpoint", () => {
    const state = createEndpointSyncState(first)
    expect(transitionEndpointSync(state, { type: "endpoint.reported", http: { ...first, username: "opencode" } })).toEqual({
      state,
      effects: [],
    })
  })

  test("keeps the endpoint the plugin reported while a reconnect was resolving an older one", () => {
    const result = replay([
      { type: "resolve.started" },
      { type: "endpoint.reported", http: third },
      { type: "resolve.succeeded", attempt: 1, http: second },
    ])

    expect(result.effects).toEqual([{ type: "transport.update", http: third }, { type: "stream.resync" }])
    expect(result.state).toEqual({ type: "idle", http: third, attempt: 1 })
  })

  test("moves the transport to a resolved endpoint once, without resyncing on the plugin's echo", () => {
    const resolved = replay([{ type: "resolve.started" }, { type: "resolve.succeeded", attempt: 1, http: second }])

    expect(resolved.effects).toEqual([{ type: "transport.update", http: second }])

    const echo = transitionEndpointSync(resolved.state, { type: "endpoint.reported", http: { ...second } })

    expect(echo.state).toBe(resolved.state)
    expect(echo.effects).toEqual([])
  })

  test("keeps the current endpoint when a resolution fails or resolves it again", () => {
    expect(replay([{ type: "resolve.started" }, { type: "resolve.failed", attempt: 1 }])).toEqual({
      state: { type: "idle", http: first, attempt: 1 },
      effects: [],
    })
    expect(replay([{ type: "resolve.started" }, { type: "resolve.succeeded", attempt: 1, http: first }])).toEqual({
      state: { type: "idle", http: first, attempt: 1 },
      effects: [],
    })
  })

  test("ignores a result from an earlier attempt", () => {
    const state = replay([{ type: "resolve.started" }, { type: "resolve.started" }]).state

    for (const event of [
      { type: "resolve.succeeded", attempt: 1, http: second },
      { type: "resolve.failed", attempt: 1 },
    ] satisfies EndpointSyncEvent[]) {
      const result = transitionEndpointSync(state, event)
      expect(result.state).toBe(state)
      expect(result.effects).toEqual([])
    }
  })

  test("ignores every event once disposed", () => {
    const disposed = replay([{ type: "resolve.started" }, { type: "disposed" }]).state

    for (const event of [
      { type: "resolve.succeeded", attempt: 1, http: second },
      { type: "endpoint.reported", http: third },
      { type: "resolve.started" },
    ] satisfies EndpointSyncEvent[]) {
      const result = transitionEndpointSync(disposed, event)
      expect(result.state).toBe(disposed)
      expect(result.effects).toEqual([])
    }
  })
})
