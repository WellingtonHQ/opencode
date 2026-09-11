import { DateTime } from "luxon"
import type { Schedule } from "@opencode-ai/schema/schedule"

// Computes the next run instant strictly after `anchorMs`. Returns null when the
// spec can never match again (past one-shot or impossible cron pattern). Cron
// patterns are wall-clock expressions evaluated in `zone` (default: server local
// zone). Nonexistent wall times during DST spring-forward are shifted forward to
// the next valid instant by Luxon; ambiguous fall-back times resolve to a single
// deterministic occurrence. Malformed cron expressions throw.
export async function nextRunAt(spec: Schedule.Spec, anchorMs: number, zone?: string): Promise<number | null> {
  if (spec.kind === "once") return spec.atMs > anchorMs ? spec.atMs : null
  if (spec.kind === "cron") return cronNextRun(spec.expr, anchorMs, zone)
  const weekdays =
    spec.kind === "weekly"
      ? new Set(spec.days.map((day) => dayToDateWeekday(day)))
      : undefined
  for (let offset = 0; offset < 7; offset++) {
    const candidate = DateTime.fromMillis(anchorMs, zone ? { zone } : undefined)
      .startOf("day")
      .plus({ days: offset })
      .set({ hour: spec.hour, minute: spec.minute, second: 0, millisecond: 0 })
    if (!candidate.isValid) continue
    if (weekdays && !weekdays.has(candidate.weekday)) continue
    const atMs = candidate.toMillis()
    if (atMs > anchorMs) return atMs
  }
  return null
}

function dayToDateWeekday(day: number) {
  // Cron uses 0=Sunday..6=Saturday, Luxon weekday is ISO 1=Monday..7=Sunday.
  return day === 0 ? 7 : day
}

async function cronNextRun(expr: string, anchorMs: number, zone?: string): Promise<number | null> {
  const { Cron } = await import("croner")
  const pattern = new Cron(
    expr,
    zone === undefined ? { mode: "5-part" } : { mode: "5-part", timezone: zone },
  )
  const next = pattern.nextRun(new Date(anchorMs))
  return next === null || next === undefined ? null : next.getTime()
}
