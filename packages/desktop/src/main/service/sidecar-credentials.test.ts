import { describe, expect, test } from "bun:test"
import { authorization, ready } from "./sidecar-credentials"

const sidecar = { url: "http://127.0.0.1:4096", password: "secret" }

describe("sidecar authorization", () => {
  test.each([undefined, "custom"])("adds the %s Basic credential only for the sidecar origin", (username) => {
    const connection = { ...sidecar, username }
    expect(authorization(connection, "http://127.0.0.1:4096/api/session?limit=1")).toBe(
      `Basic ${Buffer.from(`${username ?? "opencode"}:secret`).toString("base64")}`,
    )
    expect(authorization(sidecar, "http://127.0.0.1:4097/api/session")).toBeUndefined()
    expect(authorization(sidecar, "http://localhost:4096/api/session")).toBeUndefined()
    expect(authorization(sidecar, "https://127.0.0.1:4096/api/session")).toBeUndefined()
    expect(authorization(sidecar, "not a url")).toBeUndefined()
    expect(authorization(undefined, "http://127.0.0.1:4096/api/session")).toBeUndefined()
    expect(authorization({ url: sidecar.url, password: null }, "http://127.0.0.1:4096/api/session")).toBeUndefined()
  })

  test("hands the renderer the origin only", () => {
    expect(ready({ ...sidecar, username: "custom" })).toEqual({ url: sidecar.url })
  })
})
