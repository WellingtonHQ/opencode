import { describe, expect, test } from "bun:test"
import type { ScheduleSpec } from "@opencode-ai/sdk/v2/client"
import { describeScheduleSpec, scheduleSpecToFormValues, validateScheduleForm, type ScheduleFormValues } from "./schedule-spec"

const NOW = new Date(2026, 8, 10).getTime()

function baseValues(patch: Partial<ScheduleFormValues>): ScheduleFormValues {
  return {
    name: "Morning review",
    promptText: "Review the latest commits",
    directory: "",
    kind: "daily",
    dateStr: "",
    timeHhMm: "",
    weekDays: [],
    cronExpr: "",
    ...patch,
  }
}

describe("scheduleSpecToFormValues", () => {
  test("maps daily specs and drops malformed times", () => {
    expect(scheduleSpecToFormValues({ kind: "daily", timeHhMm: "09:30" })).toEqual({
      kind: "daily",
      dateStr: "",
      timeHhMm: "09:30",
      weekDays: [],
      cronExpr: "",
    })
    expect(scheduleSpecToFormValues({ kind: "daily", timeHhMm: "9am" }).timeHhMm).toBe("")
  })

  test("maps weekly days onto a Sunday-first pill row", () => {
    const form = scheduleSpecToFormValues({ kind: "weekly", days: [3, 1], timeHhMm: "08:00" })
    expect(form.kind).toBe("weekly")
    expect(form.timeHhMm).toBe("08:00")
    expect(form.weekDays.map((selected) => Number(selected))).toEqual([0, 1, 0, 1, 0, 0, 0])
  })

  test("maps one-shot timestamps to local date and time strings", () => {
    const form = scheduleSpecToFormValues({ kind: "one_shot", atMs: new Date(2026, 4, 15, 9, 5).getTime() })
    expect(form.dateStr).toBe("2026-05-15")
    expect(form.timeHhMm).toBe("09:05")
  })

  test("coerces non-finite one-shot timestamps to empty fields", () => {
    const form = scheduleSpecToFormValues({ kind: "one_shot", atMs: Number.NaN } as ScheduleSpec)
    expect(form.dateStr).toBe("")
    expect(form.timeHhMm).toBe("")
  })

  test("passes cron expressions through unchanged", () => {
    expect(scheduleSpecToFormValues({ kind: "cron", expr: "0 9 * * 1-5" }).cronExpr).toBe("0 9 * * 1-5")
  })
})

describe("validateScheduleForm", () => {
  test("requires a name and a prompt before checking the spec", () => {
    expect(validateScheduleForm(baseValues({ name: "   " }), NOW).ok).toBe(false)
    const missingName = validateScheduleForm(baseValues({ name: "" }), NOW)
    expect(missingName.ok ? null : missingName.error).toBe("nameRequired")
    const missingPrompt = validateScheduleForm(baseValues({ promptText: "  ", kind: "daily", timeHhMm: "08:15" }), NOW)
    expect(missingPrompt.ok ? null : missingPrompt.error).toBe("promptRequired")
  })

  test("rejects daily specs without a valid time and accepts well-formed ones", () => {
    const invalid = validateScheduleForm(baseValues({ kind: "daily", timeHhMm: "" }), NOW)
    expect(invalid.ok ? null : invalid.error).toBe("timeRequired")
    expect(validateScheduleForm(baseValues({ kind: "daily", timeHhMm: "08:15" }), NOW)).toEqual({
      ok: true,
      spec: { kind: "daily", timeHhMm: "08:15" },
    })
  })

  test("builds weekly day lists in cron order and rejects empty selections", () => {
    const weekDays = [false, true, false, true, false, false, false]
    expect(validateScheduleForm(baseValues({ kind: "weekly", timeHhMm: "17:45", weekDays }), NOW)).toEqual({
      ok: true,
      spec: { kind: "weekly", days: [1, 3], timeHhMm: "17:45" },
    })
    const none = validateScheduleForm(
      baseValues({ kind: "weekly", timeHhMm: "17:45", weekDays: [false, false, false, false, false, false, false] }),
      NOW,
    )
    expect(none.ok ? null : none.error).toBe("daysRequired")
  })

  test("accepts future one-shot dates and rejects past ones", () => {
    const result = validateScheduleForm(baseValues({ kind: "one_shot", dateStr: "2999-01-01", timeHhMm: "12:00" }), NOW)
    expect(result).toEqual({ ok: true, spec: { kind: "one_shot", atMs: new Date(2999, 0, 1, 12, 0).getTime() } })
    const past = validateScheduleForm(baseValues({ kind: "one_shot", dateStr: "1999-01-01", timeHhMm: "12:00" }), NOW)
    expect(past.ok ? null : past.error).toBe("pastOneShot")
  })

  test("rejects malformed one-shot dates as missing time", () => {
    const result = validateScheduleForm(baseValues({ kind: "one_shot", dateStr: "2026-5-1", timeHhMm: "12:00" }), NOW)
    expect(result.ok ? null : result.error).toBe("timeRequired")
  })

  test("validates cron expressions and trims whitespace", () => {
    const valid = validateScheduleForm(baseValues({ kind: "cron", cronExpr: "  */5 * * * *  " }), NOW)
    expect(valid).toEqual({ ok: true, spec: { kind: "cron", expr: "*/5 * * * *" } })
    for (const expr of ["bogus", "", "61 * * * *"]) {
      const invalid = validateScheduleForm(baseValues({ kind: "cron", cronExpr: expr }), NOW)
      expect(invalid.ok ? null : invalid.error).toBe("cronInvalid")
    }
  })
})

describe("describeScheduleSpec", () => {
  test("sorts and sanitizes weekly days for display", () => {
    const descriptor = describeScheduleSpec({ kind: "weekly", days: [3, Number.NaN, 1], timeHhMm: "08:00" })
    if (descriptor.kind !== "weekly") throw new Error("expected weekly descriptor")
    expect(descriptor.days).toEqual([1, 3])
  })

  test("keeps cron expressions and times intact", () => {
    expect(describeScheduleSpec({ kind: "cron", expr: "0 9 * * MON-FRI" })).toEqual({ kind: "cron", expr: "0 9 * * MON-FRI" })
    expect(describeScheduleSpec({ kind: "daily", timeHhMm: "23:59" })).toEqual({ kind: "daily", timeHhMm: "23:59" })
  })

  test("falls back to zero for non-finite one-shot timestamps", () => {
    const descriptor = describeScheduleSpec({ kind: "one_shot", atMs: Number.NaN } as ScheduleSpec)
    if (descriptor.kind !== "one_shot") throw new Error("expected one-shot descriptor")
    expect(descriptor.ms).toBe(0)
  })
})
