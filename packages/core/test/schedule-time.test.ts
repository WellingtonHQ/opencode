import { describe, expect, test } from "bun:test"
import { nextRunAt } from "@opencode-ai/core/schedule/time"

const NY = "America/New_York"

describe("schedule time", () => {
  test("once returns the instant when it is still ahead of the anchor and never otherwise", async () => {
    expect(await nextRunAt({ kind: "once", atMs: 5000 }, 1000)).toBe(5000)
    expect(await nextRunAt({ kind: "once", atMs: 1000 }, 1000)).toBeNull()
    expect(await nextRunAt({ kind: "once", atMs: 999 }, 1000)).toBeNull()
  })

  test("daily fires later the same day when the slot is still ahead of the anchor", async () => {
    const anchor = Date.UTC(2026, 4, 1, 15, 0) // local Fri 2026-05-01 11:00 EDT
    expect(await nextRunAt({ kind: "daily", hour: 14, minute: 30 }, anchor, NY)).toBe(Date.UTC(2026, 4, 1, 18, 30))
  })

  test("daily fires on the following day when the slot has already passed", async () => {
    const anchor = Date.UTC(2026, 4, 1, 15, 0) // local Fri 2026-05-01 11:00 EDT
    expect(await nextRunAt({ kind: "daily", hour: 9, minute: 30 }, anchor, NY)).toBe(Date.UTC(2026, 4, 2, 13, 30))
  })

  test("daily shifts forward across a DST spring gap to the first valid instant", async () => {
    const anchor = Date.UTC(2026, 2, 7, 15, 0) // local Sun 2026-03-07 10:00 EST, before Mar 8 switch
    expect(await nextRunAt({ kind: "daily", hour: 2, minute: 30 }, anchor, NY)).toBe(Date.UTC(2026, 2, 8, 7, 30))
  })

  test("daily fires once on a DST fall-back day, resolved to the first occurrence", async () => {
    const anchor = Date.UTC(2025, 10, 2, 4, 30) // local Sun 2025-11-02 00:30 EDT
    expect(await nextRunAt({ kind: "daily", hour: 1, minute: 30 }, anchor, NY)).toBe(Date.UTC(2025, 10, 2, 5, 30))
  })

  test("weekly fires on the next matching weekday within the week", async () => {
    const anchor = Date.UTC(2026, 4, 1, 16, 0) // local Fri 2026-05-01 12:00 EDT
    expect(await nextRunAt({ kind: "weekly", days: [6, 0], hour: 9, minute: 0 }, anchor, NY)).toBe(
      Date.UTC(2026, 4, 2, 13, 0),
    )
  })

  test("weekly skips forward to a later matching weekday", async () => {
    const anchor = Date.UTC(2026, 4, 1, 16, 0) // local Fri 2026-05-01 12:00 EDT
    expect(await nextRunAt({ kind: "weekly", days: [3], hour: 9, minute: 0 }, anchor, NY)).toBe(Date.UTC(2026, 4, 6, 13, 0))
  })

  test("weekly with no days never matches", async () => {
    const anchor = Date.UTC(2026, 4, 1, 16, 0)
    expect(await nextRunAt({ kind: "weekly", days: [], hour: 9, minute: 0 }, anchor, NY)).toBeNull()
  })

  test("cron uses strictly-after semantics at an exact slot boundary", async () => {
    const anchor = Date.UTC(2026, 4, 1, 9, 30) // Fri 2026-05-01 exactly on the 09:30 UTC slot
    expect(await nextRunAt({ kind: "cron", expr: "30 9 * * 1-5" }, anchor, "UTC")).toBe(Date.UTC(2026, 4, 4, 9, 30))
  })

  test("cron evaluates wall-clock slots in the requested timezone", async () => {
    const anchor = Date.UTC(2026, 4, 1, 15, 0) // local Fri 2026-05-01 11:00 EDT
    expect(await nextRunAt({ kind: "cron", expr: "30 9 * * 1-5" }, anchor, NY)).toBe(Date.UTC(2026, 4, 4, 13, 30))
  })

  test("cron returns null when the pattern can never match", async () => {
    expect(await nextRunAt({ kind: "cron", expr: "0 0 30 2 *" }, Date.UTC(2026, 0, 15), "UTC")).toBeNull()
  })

  test("cron rejects malformed expressions", async () => {
    await expect(nextRunAt({ kind: "cron", expr: "not a cron" }, Date.UTC(2026, 0, 1), "UTC")).rejects.toThrow()
  })
})
