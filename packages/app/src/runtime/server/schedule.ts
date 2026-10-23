import type { Schedule } from "@opencode/schema/schedule"

export function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

export function formatDateTime(value: number | undefined, locale?: string, timezone?: string): string {
  if (value === undefined) return ""
  return Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(new Date(value))
}

export function formatTimeZoneName(value: number, locale: string | undefined, timezone: string): string {
  return (
    Intl.DateTimeFormat(locale, { timeZone: timezone, timeZoneName: "short" })
      .formatToParts(new Date(value))
      .find((part) => part.type === "timeZoneName")?.value ?? timezone
  )
}

export function formatDateTimeLocal(value: number, timezone: string): string {
  const parts = dateParts(value, timezone)
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`
}

export function parseDateTimeLocal(value: string, timezone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return Number.NaN
  return localTimeToTimestamp(...match.slice(1).map(Number) as [number, number, number, number, number], timezone)
}

// Computes the next strictly-future run in the task's local time. Returns
// undefined for one-time specs whose moment has passed and cron expressions,
// which are evaluated server-side only.
export function nextRunAfter(
  spec: Schedule.Spec,
  nowMs: number,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
): number | undefined {
  switch (spec.kind) {
    case "once":
      return spec.atMs > nowMs ? spec.atMs : undefined
    case "daily": {
      const now = dateParts(nowMs, timezone)
      for (const offset of [0, 1]) {
        const day = new Date(Date.UTC(now.year, now.month - 1, now.day + offset))
        const candidate = localTimeToTimestamp(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), spec.hour, spec.minute, timezone)
        if (candidate > nowMs) return candidate
      }
      return undefined
    }
    case "weekly": {
      const now = dateParts(nowMs, timezone)
      for (let offset = 0; offset < 8; offset++) {
        const day = new Date(Date.UTC(now.year, now.month - 1, now.day + offset))
        if (!spec.days.includes(day.getUTCDay())) continue
        const candidate = localTimeToTimestamp(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), spec.hour, spec.minute, timezone)
        if (candidate > nowMs) return candidate
      }
      return undefined
    }
    case "cron":
      return undefined
  }
}

// Weekday numbers follow the JS convention (0 = Sunday). Labels come back in
// Monday-first order, matching how Western week grids are read.
export function weekdayLabels(days: readonly number[], locale?: string, timezone = "UTC"): string[] {
  const picked = days.filter((day) => day >= 0 && day <= 6)
  if (picked.length === 0) return []
  return [1, 2, 3, 4, 5, 6, 0]
    .filter((day) => picked.includes(day))
    .map((day) => {
      const reference = new Date(Date.UTC(2024, 0, 1 + ((day - 1 + 7) % 7)))
      const instant = localTimeToTimestamp(
        reference.getUTCFullYear(),
        reference.getUTCMonth() + 1,
        reference.getUTCDate(),
        12,
        0,
        timezone,
      )
      return Intl.DateTimeFormat(locale, { timeZone: timezone, weekday: "short" }).format(new Date(instant))
    })
}

const CRON_FIELD = "(?:\\*(?:/\\d+)?|\\d+(?:-\\d+)?(?:/\\d+)?)"
const CRON_PATTERN = new RegExp(`^${CRON_FIELD}(?:,${CRON_FIELD})*$`)

export function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every((field) => CRON_PATTERN.test(field))
}

function dateParts(value: number, timezone: string) {
  const parts = Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value))
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
    hour: Number(parts.find((part) => part.type === "hour")?.value),
    minute: Number(parts.find((part) => part.type === "minute")?.value),
  }
}

function localTimeToTimestamp(year: number, month: number, day: number, hour: number, minute: number, timezone: string) {
  const local = Date.UTC(year, month - 1, day, hour, minute)
  const dayMs = 24 * 60 * 60 * 1000
  const offsets = new Set(
    [local - 2 * dayMs, local - dayMs, local, local + dayMs, local + 2 * dayMs].map((instant) => {
      const parts = dateParts(instant, timezone)
      return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - instant
    }),
  )
  const candidates = Array.from(offsets, (offset) => {
    const instant = local - offset
    const parts = dateParts(instant, timezone)
    return { instant, local: Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) }
  })
  const exact = candidates.filter((candidate) => candidate.local === local).sort((a, b) => a.instant - b.instant)[0]
  if (exact) return exact.instant
  return (
    candidates
      .filter((candidate) => candidate.local > local)
      .sort((a, b) => a.local - b.local || a.instant - b.instant)[0]?.instant ?? Number.NaN
  )
}
