export type Cron = {
  readonly minutes: number[]
  readonly hours: number[]
  readonly daysOfMonth: number[]
  readonly months: number[]
  readonly daysOfWeek: number[]
  // True when the field does not literally start with "*"; drives vixie's DOM/DOW OR rule.
  readonly dayOfMonthRestricted: boolean
  readonly dayOfWeekRestricted: boolean
}

type ParseFieldResult = { ok: true; star: boolean; values: number[] } | { ok: false; message: string }

export type ParseResult = { ok: true; cron: Cron } | { ok: false; message: string }

const MINUTE_MS = 60_000
// Covers a full leap-year cycle so expressions like "0 0 29 2 *" can always find a slot.
const HORIZON_DAYS = 365 * 8 + 2
// The anchor is a leap-year start so rare day/month combinations resolve within the horizon.
const ANCHOR_MS = new Date(2000, 0, 1).getTime()

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
}

const DOW_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
}

function substituteNames(field: string, names: Record<string, number>): { ok: true; value: string } | { ok: false; message: string } {
  const value = field.replace(/[A-Za-z]+/g, (token) => {
    const mapped = names[token.toUpperCase()]
    return mapped === undefined ? token : String(mapped)
  })
  if (/[^0-9*,/-]/.test(value)) return { ok: false, message: `invalid characters in cron field "${field}"` }
  return { ok: true, value }
}

function parseField(field: string, min: number, max: number): ParseFieldResult {
  if (field.length === 0) return { ok: false, message: "empty cron field" }
  const found = new Set<number>()
  for (const item of field.split(",")) {
    const parts = item.split("/")
    if (parts.length > 2) return { ok: false, message: `invalid step in cron field "${item}"` }
    let step = 1
    if (parts.length === 2) {
      if (!/^[0-9]+$/.test(parts[1])) return { ok: false, message: `invalid step "${parts[1]}" in cron field "${item}"` }
      step = Number(parts[1])
      if (step < 1) return { ok: false, message: `step must be >= 1 in cron field "${item}"` }
    }
    const base = parts[0]
    let start: number
    let end: number
    if (base === "*") {
      start = min
      end = max
    } else if (/^[0-9]+$/.test(base)) {
      start = Number(base)
      if (start < min || start > max) return { ok: false, message: `value ${base} out of range in cron field "${item}"` }
      // A bare "N/step" extends to the field maximum, matching common vixie cron behavior.
      end = parts.length === 2 ? max : start
    } else if (/^[0-9]+-[0-9]+$/.test(base)) {
      const pieces = base.split("-")
      start = Number(pieces[0])
      end = Number(pieces[1])
      if (start > end) return { ok: false, message: `reversed range "${base}" in cron field "${item}"` }
    } else {
      return { ok: false, message: `invalid item "${item}" in cron field "${field}"` }
    }
    for (let value = start; value <= end; value += step) found.add(value)
  }
  const parts = field.split("/")
  // "*/n" still counts as an unrestricted day field for vixie's DOM/DOW rule even though its values are limited.
  const star = parts[0] === "*" && parts.length <= 2
  return { ok: true, star, values: Array.from(found).sort((a, b) => a - b) }
}

export function parseCron(expr: string): ParseResult {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return { ok: false, message: `expected 5 cron fields, got ${fields.length}` }
  const minutesRaw = substituteNames(fields[0], {})
  if (!minutesRaw.ok) return { ok: false, message: minutesRaw.message }
  const hoursRaw = substituteNames(fields[1], {})
  if (!hoursRaw.ok) return { ok: false, message: hoursRaw.message }
  const domRaw = substituteNames(fields[2], {})
  if (!domRaw.ok) return { ok: false, message: domRaw.message }
  const monthsRaw = substituteNames(fields[3], MONTH_NAMES)
  if (!monthsRaw.ok) return { ok: false, message: monthsRaw.message }
  const dowRawNamed = substituteNames(fields[4], DOW_NAMES)
  if (!dowRawNamed.ok) return { ok: false, message: dowRawNamed.message }

  const minutes = parseField(minutesRaw.value, 0, 59)
  if (!minutes.ok) return { ok: false, message: minutes.message }
  const hours = parseField(hoursRaw.value, 0, 23)
  if (!hours.ok) return { ok: false, message: hours.message }
  const daysOfMonth = parseField(domRaw.value, 1, 31)
  if (!daysOfMonth.ok) return { ok: false, message: daysOfMonth.message }
  const months = parseField(monthsRaw.value, 1, 12)
  if (!months.ok) return { ok: false, message: months.message }
  const dow = parseField(dowRawNamed.value, 0, 7)
  if (!dow.ok) return { ok: false, message: dow.message }

  // Day-of-week 7 is accepted as an alias for Sunday.
  const daysOfWeekSet = new Set<number>(dow.values.filter((value) => value !== 7))
  if (dow.values.includes(7)) daysOfWeekSet.add(0)

  const cron: Cron = {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    daysOfWeek: Array.from(daysOfWeekSet).sort((a, b) => a - b),
    dayOfMonthRestricted: !daysOfMonth.star,
    dayOfWeekRestricted: !dow.star,
  }

  // Reject expressions that never match instead of storing a task that can only record misses.
  if (nextSlot(cron, ANCHOR_MS) === undefined) return { ok: false, message: "cron expression never matches" }
  return { ok: true, cron }
}

export function nextFire(
  expr: string,
  fromMs: number,
): { isValid: true; firesAt: number } | { isValid: false; message: string } {
  const parsed = parseCron(expr)
  if (!parsed.ok) return { isValid: false, message: parsed.message }
  const slot = nextSlot(parsed.cron, fromMs)
  if (slot === undefined) return { isValid: false, message: "cron expression has no fire time within the search horizon" }
  return { isValid: true, firesAt: slot }
}

function dayMatches(cron: Cron, year: number, month: number, day: number): boolean {
  if (!cron.months.includes(month + 1)) return false
  const domOk = cron.daysOfMonth.includes(day)
  const dowOk = cron.daysOfWeek.includes(new Date(year, month, day).getDay())
  // vixie cron: when both day fields are restricted either may match; otherwise all must.
  return !cron.dayOfMonthRestricted || !cron.dayOfWeekRestricted ? domOk && dowOk : domOk || dowOk
}

export function matches(cron: Cron, ms: number): boolean {
  const date = new Date(ms)
  if (!dayMatches(cron, date.getFullYear(), date.getMonth(), date.getDate())) return false
  return cron.hours.includes(date.getHours()) && cron.minutes.includes(date.getMinutes())
}

function dayStartMs(year: number, month: number, day: number): number {
  const date = new Date(year, month, day)
  date.setMinutes(0)
  date.setSeconds(0, 0)
  return date.getTime()
}

// Local wall-clock dates are rebuilt through the Date constructor so DST transitions normalize correctly;
// a cron minute inside a spring-forward gap lands on the shifted clock time.
export function nextSlot(cron: Cron, fromMs: number): number | undefined {
  const start = Math.ceil((fromMs + 1) / MINUTE_MS) * MINUTE_MS
  let cursor = new Date(start)
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const year = cursor.getFullYear()
    const month = cursor.getMonth()
    const day = cursor.getDate()
    if (dayMatches(cron, year, month, day)) {
      for (const hour of cron.hours) {
        for (const minute of cron.minutes) {
          const slot = new Date(year, month, day, hour, minute).getTime()
          if (slot >= start) return slot
        }
      }
    }
    cursor = new Date(year, month, day + 1)
  }
  return undefined
}

export function latestSlot(cron: Cron, nowMs: number, afterMs: number): number | undefined {
  let cursor = new Date(nowMs)
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const year = cursor.getFullYear()
    const month = cursor.getMonth()
    const day = cursor.getDate()
    if (dayStartMs(year, month, day) <= afterMs) return undefined
    let best: number | undefined
    if (dayMatches(cron, year, month, day)) {
      for (const hour of cron.hours) {
        for (const minute of cron.minutes) {
          const slot = new Date(year, month, day, hour, minute).getTime()
          if (slot <= nowMs && slot > afterMs) best = best === undefined ? slot : Math.max(best, slot)
        }
      }
    }
    if (best !== undefined) return best
    cursor = new Date(year, month, day - 1)
  }
  return undefined
}

export function minuteSlotOf(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS
}

const TIME_RE = /^(0?[0-9]|1[0-9]|2[0-3]):([0-5][0-9])$/

export function isTimeHhMm(value: string): boolean {
  return TIME_RE.test(value)
}

export function isValidDayList(days: readonly number[]): boolean {
  return days.length > 0 && days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
}
