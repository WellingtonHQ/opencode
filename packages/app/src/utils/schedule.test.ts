import { describe, expect, test } from "bun:test"
import { formatClock, formatDateTime, isValidCronExpression, nextRunAfter, weekdayLabels } from "./schedule"

const NOW = new Date(2026, 8, 10, 15, 30).getTime() // Thursday Sep 10 2026, 15:30 local

describe("nextRunAfter", () => {
  test("returns a future once spec unchanged", () => {
    const atMs = NOW + 60_000
    expect(nextRunAfter({ kind: "once", atMs }, NOW)).toBe(atMs)
  })

  test("returns undefined for an elapsed once spec", () => {
    expect(nextRunAfter({ kind: "once", atMs: NOW - 1 }, NOW)).toBeUndefined()
  })

  test("daily picks later the same day when it has not passed yet", () => {
    expect(nextRunAfter({ kind: "daily", hour: 23, minute: 0 }, NOW)).toBe(new Date(2026, 8, 10, 23, 0).getTime())
  })

  test("daily picks the next day when today's slot has passed", () => {
    expect(nextRunAfter({ kind: "daily", hour: 9, minute: 0 }, NOW)).toBe(new Date(2026, 8, 11, 9, 0).getTime())
  })

  test("a daily spec exactly at the current time waits for tomorrow", () => {
    const atSlot = new Date(2026, 8, 10, 9, 0).getTime()
    expect(nextRunAfter({ kind: "daily", hour: 9, minute: 0 }, atSlot)).toBe(new Date(2026, 8, 11, 9, 0).getTime())
  })

  test("weekly picks today when the slot is later in the day", () => {
    expect(nextRunAfter({ kind: "weekly", days: [4], hour: 18, minute: 0 }, NOW)).toBe(
      new Date(2026, 8, 10, 18, 0).getTime(),
    )
  })

  test("weekly wraps to the next week when today's slot has passed", () => {
    const friday = new Date(2026, 8, 11, 12, 0).getTime() // Friday Sep 11 12:00
    expect(nextRunAfter({ kind: "weekly", days: [4], hour: 18, minute: 0 }, friday)).toBe(
      new Date(2026, 8, 17, 18, 0).getTime(),
    )
  })

  test("weekly with no days selected never runs", () => {
    expect(nextRunAfter({ kind: "weekly", days: [], hour: 9, minute: 0 }, NOW)).toBeUndefined()
  })

  test("cron specs are evaluated server-side and return undefined locally", () => {
    expect(nextRunAfter({ kind: "cron", expr: "0 9 * * * " }, NOW)).toBeUndefined()
  })
})

describe("weekdayLabels", () => {
  test("labels selected days in Monday-first order", () => {
    expect(weekdayLabels([1, 3], "en-US")).toEqual(["Mon", "Wed"])
  })

  test("keeps Saturday before Sunday regardless of input order", () => {
    expect(weekdayLabels([0, 6], "en-US")).toEqual(["Sat", "Sun"])
  })

  test("returns an empty list when nothing is selected or inputs are out of range", () => {
    expect(weekdayLabels([], "en-US")).toEqual([])
    expect(weekdayLabels([9, -1], "en-US")).toEqual([])
  })
})

describe("format helpers", () => {
  test("formatClock pads single digits", () => {
    expect(formatClock(9, 5)).toBe("09:05")
    expect(formatClock(23, 59)).toBe("23:59")
  })

  test("formatDateTime returns an empty string for missing values", () => {
    expect(formatDateTime(undefined, "en-US")).toBe("")
  })

  test("formatDateTime renders the given moment in the requested locale", () => {
    const text = formatDateTime(NOW, "en-US")
    expect(text).toContain("2026")
    expect(text.length).toBeGreaterThan(0)
  })
})

describe("isValidCronExpression", () => {
  test("accepts the five-field forms users commonly write", () => {
    for (const expr of ["0 9 * * 1-5", "*/5 * * * *", "30 4,16 1 * *", "0 0 1 1 0", "00 09 * * 1"]) {
      expect(isValidCronExpression(expr), expr).toBe(true)
    }
  })

  test("rejects malformed expressions", () => {
    for (const expr of ["", "* * * *", "60 * * * x", "a b c d e", "0 9 * * 1-5 extra"]) {
      expect(isValidCronExpression(expr), expr).toBe(false)
    }
  })
})
