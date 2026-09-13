import { isValidDayList, isTimeHhMm, parseCron } from "@opencode-ai/core/schedule/cron"
import type { ScheduleSpec } from "@opencode-ai/sdk/v2/client"

export type ScheduleFormKind = "one_shot" | "daily" | "weekly" | "cron"

export type ScheduleModelSelection = { providerID: string; modelID: string }

export interface ScheduleFormValues {
  name: string
  promptText: string
  directory: string
  model?: ScheduleModelSelection
  kind: ScheduleFormKind
  dateStr: string
  timeHhMm: string
  weekDays: boolean[]
  cronExpr: string
}

const pad2 = (value: number) => String(value).padStart(2, "0")

function finiteMs(value: number | string): number | undefined {
  const ms = typeof value === "number" ? value : Number(value)
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

export function scheduleSpecToFormValues(spec: ScheduleSpec): Pick<
  ScheduleFormValues,
  "kind" | "dateStr" | "timeHhMm" | "weekDays" | "cronExpr"
> {
  if (spec.kind === "one_shot") {
    const ms = finiteMs(spec.atMs)
    const date = ms !== undefined ? new Date(ms) : undefined
    return {
      kind: "one_shot",
      dateStr: date ? `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` : "",
      timeHhMm: date ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : "",
      weekDays: [],
      cronExpr: "",
    }
  }
  if (spec.kind === "daily") {
    const time = isTimeHhMm(spec.timeHhMm) ? spec.timeHhMm : ""
    return { kind: "daily", dateStr: "", timeHhMm: time, weekDays: [], cronExpr: "" }
  }
  if (spec.kind === "weekly") {
    const days = (Array.isArray(spec.days) ? spec.days : [])
      .map((day) => Number(day))
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    return {
      kind: "weekly",
      dateStr: "",
      timeHhMm: isTimeHhMm(spec.timeHhMm) ? spec.timeHhMm : "",
      weekDays: Array.from({ length: 7 }, (_, index) => days.includes(index)),
      cronExpr: "",
    }
  }
  return { kind: "cron", dateStr: "", timeHhMm: "", weekDays: [], cronExpr: spec.expr }
}

export type ScheduleFormErrorKey =
  | "nameRequired"
  | "promptRequired"
  | "timeRequired"
  | "daysRequired"
  | "pastOneShot"
  | "cronInvalid"

export interface ScheduleValidationFailure {
  ok: false
  error: ScheduleFormErrorKey
}

export type ScheduleValidationResult = { ok: true; spec: ScheduleSpec } | ScheduleValidationFailure

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function validateScheduleForm(values: ScheduleFormValues, nowMs: number): ScheduleValidationResult {
  if (!values.name.trim()) return { ok: false, error: "nameRequired" }
  if (!values.promptText.trim()) return { ok: false, error: "promptRequired" }
  if (values.kind === "one_shot") {
    if (!DATE_RE.test(values.dateStr) || !isTimeHhMm(values.timeHhMm)) return { ok: false, error: "timeRequired" }
    const [year, month, day] = values.dateStr.split("-").map(Number)
    const [hour, minute] = values.timeHhMm.split(":").map(Number)
    const ms = new Date(year, month - 1, day, hour, minute).getTime()
    if (!Number.isFinite(ms)) return { ok: false, error: "timeRequired" }
    if (ms <= nowMs) return { ok: false, error: "pastOneShot" }
    return { ok: true, spec: { kind: "one_shot", atMs: ms } }
  }
  if (values.kind === "daily") {
    if (!isTimeHhMm(values.timeHhMm)) return { ok: false, error: "timeRequired" }
    return { ok: true, spec: { kind: "daily", timeHhMm: values.timeHhMm } }
  }
  if (values.kind === "weekly") {
    if (!isTimeHhMm(values.timeHhMm)) return { ok: false, error: "timeRequired" }
    const days = values.weekDays.map((selected, index) => (selected ? index : -1)).filter((day) => day >= 0)
    if (!isValidDayList(days)) return { ok: false, error: "daysRequired" }
    return { ok: true, spec: { kind: "weekly", days, timeHhMm: values.timeHhMm } }
  }
  const expr = values.cronExpr.trim()
  if (!expr) return { ok: false, error: "cronInvalid" }
  const parsed = parseCron(expr)
  if (!parsed.ok) return { ok: false, error: "cronInvalid" }
  return { ok: true, spec: { kind: "cron", expr } }
}

export type ScheduleSpecDescriptor =
  | { kind: "one_shot"; ms: number }
  | { kind: "daily"; timeHhMm: string }
  | { kind: "weekly"; days: number[]; timeHhMm: string }
  | { kind: "cron"; expr: string }

export function describeScheduleSpec(spec: ScheduleSpec): ScheduleSpecDescriptor {
  if (spec.kind === "one_shot") {
    const ms = finiteMs(spec.atMs) ?? 0
    return { kind: "one_shot", ms }
  }
  if (spec.kind === "daily") {
    const timeHhMm = isTimeHhMm(spec.timeHhMm) ? spec.timeHhMm : ""
    return { kind: "daily", timeHhMm }
  }
  if (spec.kind === "weekly") {
    const days = (Array.isArray(spec.days) ? spec.days : [])
      .map((day) => Number(day))
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      .sort((a, b) => a - b)
    const timeHhMm = isTimeHhMm(spec.timeHhMm) ? spec.timeHhMm : ""
    return { kind: "weekly", days, timeHhMm }
  }
  return { kind: "cron", expr: spec.expr }
}
