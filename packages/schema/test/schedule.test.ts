import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Schedule } from "../src/schedule.js"

describe("Schedule.TimeZone", () => {
  test("accepts IANA time zones and rejects unknown zone names", () => {
    const decode = Schema.decodeUnknownSync(Schedule.TimeZone)
    expect(decode("America/New_York")).toBe("America/New_York")
    expect(() => decode("Mars/Olympus_Mons")).toThrow()
  })

  test("allows older create callers to omit the zone while validating a supplied one", () => {
    const decode = Schema.decodeUnknownSync(Schedule.CreateInput)
    const input = { prompt: "standup", spec: { kind: "daily", hour: 9, minute: 0 }, directory: "/project" }
    expect(decode(input).timezone).toBeUndefined()
    expect(() => decode({ ...input, timezone: "Mars/Olympus_Mons" })).toThrow()
  })
})

describe("Schedule.Spec", () => {
  test("requires a weekly spec to name at least one day", () => {
    const decode = Schema.decodeUnknownSync(Schedule.WeeklySpec)
    expect(decode({ kind: "weekly", days: [1, 3], hour: 9, minute: 0 }).days).toEqual([1, 3])
    expect(() => decode({ kind: "weekly", days: [], hour: 9, minute: 0 })).toThrow()
  })
})
