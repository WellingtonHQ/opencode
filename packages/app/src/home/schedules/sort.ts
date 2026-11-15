import type { ScheduleListOutput } from "@opencode/client/promise"

export type ScheduleSort = "name" | "lastRun" | "status"

export function sortSchedules(items: ScheduleListOutput, sort: ScheduleSort, locale: string) {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true })
  return items.toSorted((a, b) => {
    const name = collator.compare(a.name || a.prompt, b.name || b.prompt)
    if (sort === "status") return Number(b.enabled) - Number(a.enabled) || name
    // lastRunAtMs is a NonNegativeInt, so -1 sorts never-run tasks below every real run time.
    if (sort === "lastRun") return (b.lastRunAtMs ?? -1) - (a.lastRunAtMs ?? -1) || name
    return name
  })
}
