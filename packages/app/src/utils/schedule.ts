import { Schedule } from "@opencode-ai/schema/schedule"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials, withSignInRedirect } from "./server"

export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "ScheduleError"
  }
}

function messageFromBody(body: string): string {
  try {
    const data = JSON.parse(body) as { message?: unknown }
    if (typeof data.message === "string") return data.message
  } catch {
    // non-JSON body; callers fall back to their own copy
  }
  return ""
}

function request<T>(server: ServerConnection.HttpBase, method: string, path: string, body?: unknown): Promise<T | undefined> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (body !== undefined) headers["Content-Type"] = "application/json"
  if (server.password) {
    headers.Authorization = `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`
  }
  return withSignInRedirect(server, globalThis.fetch)(`${server.url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => {
    const text = await response.text()
    if (!response.ok) throw new ScheduleError(messageFromBody(text), response.status)
    return text ? (JSON.parse(text) as T) : undefined
  })
}

export function scheduleApi(server: ServerConnection.HttpBase) {
  return {
    list: () => request<Schedule.Info[]>(server, "GET", "/api/schedule"),
    create: (input: Schedule.CreateInput) => request<Schedule.Info>(server, "POST", "/api/schedule", input),
    update: (id: string, input: Schedule.UpdateInput) => request<Schedule.Info>(server, "PATCH", `/api/schedule/${id}`, input),
    remove: (id: string) => request<void>(server, "DELETE", `/api/schedule/${id}`),
    runNow: (id: string) => request<unknown>(server, "POST", `/api/schedule/${id}/run-now`),
  }
}

export function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

export function formatDateTime(value: number | undefined, locale?: string): string {
  if (value === undefined) return ""
  return Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
}

// Computes the next strictly-future run in local time. Returns undefined for
// one-time specs whose moment has passed and for cron expressions, which are
// evaluated server-side only.
export function nextRunAfter(spec: Schedule.Spec, nowMs: number): number | undefined {
  switch (spec.kind) {
    case "once":
      return spec.atMs > nowMs ? spec.atMs : undefined
    case "daily": {
      for (const offset of [0, 1]) {
        const candidate = new Date(nowMs)
        candidate.setDate(candidate.getDate() + offset)
        candidate.setHours(spec.hour, spec.minute, 0, 0)
        if (candidate.getTime() > nowMs) return candidate.getTime()
      }
      return undefined
    }
    case "weekly": {
      for (let offset = 0; offset < 8; offset++) {
        const candidate = new Date(nowMs)
        candidate.setDate(candidate.getDate() + offset)
        if (!spec.days.includes(candidate.getDay())) continue
        candidate.setHours(spec.hour, spec.minute, 0, 0)
        if (candidate.getTime() > nowMs) return candidate.getTime()
      }
      return undefined
    }
    case "cron":
      return undefined
  }
  return undefined
}

// Weekday numbers follow the JS convention (0 = Sunday). Labels come back in
// Monday-first order, matching how Western week grids are read.
export function weekdayLabels(days: readonly number[], locale?: string): string[] {
  const picked = days.filter((day) => day >= 0 && day <= 6)
  if (picked.length === 0) return []
  const reference = new Date(2024, 0, 1)
  return [1, 2, 3, 4, 5, 6, 0]
    .filter((day) => picked.includes(day))
    .map((day) => {
      const date = new Date(reference.getTime())
      date.setDate(reference.getDate() + ((day - 1 + 7) % 7))
      return Intl.DateTimeFormat(locale, { weekday: "short" }).format(date)
    })
}

const CRON_FIELD = "(?:\\*(?:/\\d+)?|\\d+(?:-\\d+)?(?:/\\d+)?)"
const CRON_PATTERN = new RegExp(`^${CRON_FIELD}(?:,${CRON_FIELD})*$`)

export function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every((field) => CRON_PATTERN.test(field))
}
