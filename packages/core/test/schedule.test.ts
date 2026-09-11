import { describe, expect, test } from "bun:test"
import * as Cron from "@opencode-ai/core/schedule/cron"
import { latestDueSlot, nextFireMs, type ScheduleSpec } from "@opencode-ai/core/schedule/schedule"

const at = (year: number, month: number, day: number, hours = 0, minutes = 0) => new Date(year, month, day, hours, minutes).getTime()
// January avoids DST transitions in every timezone.
const J1 = { y: 2027, m: 0 }

describe("parseCron", () => {
  test("parses fixed values and stars", () => {
    const result = Cron.parseCron("30 9 * * *")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cron.minutes).toEqual([30])
    expect(result.cron.hours).toEqual([9])
    expect(result.cron.dayOfMonthRestricted).toBe(false)
    expect(result.cron.dayOfWeekRestricted).toBe(false)
  })

  test("parses steps, ranges, and lists", () => {
    const result = Cron.parseCron("*/15 0-6 1,15 * MON-FRI")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cron.minutes).toEqual([0, 15, 30, 45])
    expect(result.cron.hours).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(result.cron.daysOfMonth).toEqual([1, 15])
    expect(result.cron.dayOfMonthRestricted).toBe(true)
    expect(result.cron.daysOfWeek).toEqual([1, 2, 3, 4, 5])
  })

  test("stepped star fields still count as unrestricted", () => {
    const result = Cron.parseCron("*/15 * * * *")
    if (!result.ok) throw new Error("parse failed")
    expect(result.cron.minutes).toEqual([0, 15, 30, 45])
    // dayOfMonthRestricted only tracks the DOM field; a starred minute/hour/dow leaves days unrestricted.
    expect(result.cron.dayOfMonthRestricted).toBe(false)
    expect(result.cron.dayOfWeekRestricted).toBe(false)
  })

  test("maps month and weekday names", () => {
    const result = Cron.parseCron("0 9 * JAN-MAR MON")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cron.months).toEqual([1, 2, 3])
    expect(result.cron.daysOfWeek).toEqual([1])
  })

  test("treats weekday 7 as Sunday", () => {
    const result = Cron.parseCron("* * * * 7")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cron.daysOfWeek).toContain(0)
    expect(result.cron.daysOfWeek).not.toContain(7)
  })

  test("applies vixie DOM/DOW OR rule when both day fields are restricted", () => {
    // January 1, 2027 is a Friday; this matches Jan 1 (DOM) and every Monday.
    const result = Cron.parseCron("0 9 1 * MON")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const cron = result.cron
    const jan1 = new Date(2027, 0, 1)
    const firstMonday = new Date(2027, 0, 4)
    expect(jan1.getDay()).toBe(5)
    expect(firstMonday.getDay()).toBe(1)
    expect(Cron.matches(cron, at(J1.y, J1.m, 1, 9))).toBe(true)
    expect(Cron.matches(cron, firstMonday.getTime() + 9 * 3_600_000)).toBe(true)
    expect(Cron.matches(cron, new Date(2027, 0, 8).getTime() + 9 * 3_600_000)).toBe(false)
  })

  test("rejects expressions that never match", () => {
    const result = Cron.parseCron("0 0 31 2 *")
    expect(result.ok).toBe(false)
  })

  test.each([
    ["0 9 * *", "expected 5 cron fields"],
    ["60 * * * *", "out of range"],
    ["* 24 * * *", "out of range"],
    ["0 0 32 * *", "out of range"],
    ["5-1 * * * *", "reversed range"],
    ["*/0 * * * *", "step must be >= 1"],
    ["a * * * *", "invalid characters"],
    ["* * * FOO *", "invalid characters"],
  ])("rejects %s (%p)", (expr, expectedMessage) => {
    const result = Cron.parseCron(expr)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.toLowerCase()).toContain(expectedMessage)
  })
})

describe("nextSlot", () => {
  test("returns the first slot strictly after fromMs", () => {
    const parsed = Cron.parseCron("30 9 * * *")
    if (!parsed.ok) throw new Error("parse failed")
    // Already at today's slot: fires tomorrow, not now.
    expect(Cron.nextSlot(parsed.cron, at(J1.y, J1.m, 5, 9, 30))).toBe(at(J1.y, J1.m, 6, 9, 30))
    // One second after the slot: still tomorrow.
    expect(Cron.nextSlot(parsed.cron, at(J1.y, J1.m, 5, 9, 30) + 1_000)).toBe(at(J1.y, J1.m, 6, 9, 30))
    // Before the slot: fires today.
    expect(Cron.nextSlot(parsed.cron, at(J1.y, J1.m, 5, 8, 0))).toBe(at(J1.y, J1.m, 5, 9, 30))
  })

  test("finds Feb 29 within the horizon", () => {
    const parsed = Cron.parseCron("0 0 29 2 *")
    if (!parsed.ok) throw new Error("parse failed")
    expect(Cron.nextSlot(parsed.cron, at(2027, 0, 1))).toBe(at(2028, 1, 29))
  })

  test("nextFire reports invalid expressions", () => {
    const result = Cron.nextFire("* * * *", at(2027, 0, 1))
    expect(result.isValid).toBe(false)
  })
})

describe("latestSlot", () => {
  test("finds the newest slot after lastFired and before now", () => {
    const parsed = Cron.parseCron("30 9 * * *")
    if (!parsed.ok) throw new Error("parse failed")
    // Last fired yesterday; now is past today's slot -> today.
    expect(Cron.latestSlot(parsed.cron, at(J1.y, J1.m, 5, 17, 0), at(J1.y, J1.m, 4, 9, 30))).toBe(at(J1.y, J1.m, 5, 9, 30))
    // No slot since the last fire -> none.
    expect(Cron.latestSlot(parsed.cron, at(J1.y, J1.m, 5, 8, 0), at(J1.y, J1.m, 4, 9, 30))).toBeUndefined()
    // Same-minute boundary is not "after".
    expect(Cron.latestSlot(parsed.cron, at(J1.y, J1.m, 5, 17, 0), at(J1.y, J1.m, 5, 9, 30))).toBeUndefined()
  })
})

describe("nextFireMs", () => {
  test("one_shot fires only when in the future", () => {
    const spec: ScheduleSpec = { kind: "one_shot", atMs: at(J1.y, J1.m, 5, 9, 0) }
    expect(nextFireMs(spec, at(J1.y, J1.m, 4))).toBe(spec.atMs)
    expect(nextFireMs(spec, spec.atMs)).toBeUndefined()
  })

  test("daily resolves in local wall-clock time", () => {
    const spec: ScheduleSpec = { kind: "daily", timeHhMm: "09:30" }
    // Before today's fire -> today; after -> tomorrow.
    expect(nextFireMs(spec, at(J1.y, J1.m, 5, 8))).toBe(at(J1.y, J1.m, 5, 9, 30))
    expect(nextFireMs(spec, at(J1.y, J1.m, 5, 9, 31))).toBe(at(J1.y, J1.m, 6, 9, 30))
  })

  test("weekly honors the day list", () => {
    // January 4, 2027 is a Monday.
    const spec: ScheduleSpec = { kind: "weekly", days: [1], timeHhMm: "09:30" }
    expect(nextFireMs(spec, at(J1.y, J1.m, 2))).toBe(at(J1.y, J1.m, 4, 9, 30))
    // After Monday's fire the next one is a week later.
    expect(nextFireMs(spec, at(J1.y, J1.m, 4, 9, 31))).toBe(at(J1.y, J1.m, 11, 9, 30))
  })

  test("invalid cron spec yields no fire time", () => {
    expect(nextFireMs({ kind: "cron", expr: "* * * *" }, at(2027, 0, 1))).toBeUndefined()
  })
})

describe("latestDueSlot", () => {
  const upSince = at(J1.y, J1.m, 5, 8, 0)

  test("one_shot not yet due", () => {
    expect(
      latestDueSlot({ kind: "one_shot", atMs: at(J1.y, J1.m, 6, 9, 0) }, null, at(J1.y, J1.m, 5, 9, 0), upSince),
    ).toBeUndefined()
  })

  test("one_shot due within uptime fires", () => {
    const result = latestDueSlot(
      { kind: "one_shot", atMs: at(J1.y, J1.m, 5, 8, 30) },
      null,
      at(J1.y, J1.m, 5, 9, 0),
      upSince,
    )
    expect(result).toEqual({ kind: "fire", slotMs: at(J1.y, J1.m, 5, 8, 30), isCatchUp: false })
  })

  test("one_shot missed while down records without firing", () => {
    const result = latestDueSlot(
      { kind: "one_shot", atMs: at(J1.y, J1.m, 5, 6, 30) },
      null,
      at(J1.y, J1.m, 5, 9, 0),
      upSince,
    )
    expect(result).toEqual({ kind: "missed_one_shot", slotMs: at(J1.y, J1.m, 5, 6, 30) })
  })

  test("one_shot already fired is never due again", () => {
    expect(
      latestDueSlot({ kind: "one_shot", atMs: at(J1.y, J1.m, 5, 7, 30) }, at(J1.y, J1.m, 5, 7, 30), at(J1.y, J1.m, 6), upSince),
    ).toBeUndefined()
  })

  test("daily slot after process start fires normally", () => {
    const result = latestDueSlot({ kind: "daily", timeHhMm: "08:30" }, null, at(J1.y, J1.m, 5, 9, 0), upSince)
    expect(result).toEqual({ kind: "fire", slotMs: at(J1.y, J1.m, 5, 8, 30), isCatchUp: false })
  })

  test("daily slot before process start fires as catch-up", () => {
    // Process booted after today's 07:30 slot; it still runs exactly once.
    const boot = at(J1.y, J1.m, 5, 8, 45)
    expect(latestDueSlot({ kind: "daily", timeHhMm: "07:30" }, null, at(J1.y, J1.m, 5, 9, 0), boot)).toEqual(
      { kind: "fire", slotMs: at(J1.y, J1.m, 5, 7, 30), isCatchUp: true },
    )
  })

  test("recurring task resumes after its last fire without re-firing the same slot", () => {
    const result = latestDueSlot(
      { kind: "daily", timeHhMm: "07:30" },
      at(J1.y, J1.m, 5, 7, 30),
      at(J1.y, J1.m, 5, 8, 0),
      upSince,
    )
    expect(result).toBeUndefined()
  })

  test("slots already covered by the last fire are not re-fired", () => {
    // Hourly task: today's earlier :30 slots predate the last recorded fire.
    const result = latestDueSlot(
      { kind: "cron", expr: "30 * * * *" },
      at(J1.y, J1.m, 5, 8, 30),
      at(J1.y, J1.m, 5, 9, 15),
      upSince,
    )
    expect(result).toBeUndefined()
  })
})

describe("validators", () => {
  test.each([
    ["09:30", true],
    ["0:05", true],
    ["23:59", true],
    ["24:00", false],
    ["9:30", true],
    ["09:60", false],
    ["0930", false],
  ])("isTimeHhMm(%s) = %p", (value, expected) => {
    expect(Cron.isTimeHhMm(value)).toBe(expected)
  })

  test("isValidDayList requires integers in 0-6", () => {
    expect(Cron.isValidDayList([1, 3])).toBe(true)
    expect(Cron.isValidDayList([])).toBe(false)
    expect(Cron.isValidDayList([7])).toBe(false)
    expect(Cron.isValidDayList([1.5])).toBe(false)
    expect(Cron.isValidDayList([-1])).toBe(false)
  })
})
