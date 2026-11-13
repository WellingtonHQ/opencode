import { expect, test } from "bun:test"
import type { ScheduleListOutput } from "@opencode/client/promise"
import { sortSchedules } from "./sort"

test("sorts schedules by name, latest run, or enabled status without changing the input", () => {
  const items = [
    { name: "Zulu", prompt: "", enabled: true, lastRunAtMs: 10 },
    { name: "Alpha", prompt: "", enabled: false, lastRunAtMs: 20 },
    { name: "Beta", prompt: "", enabled: true },
    { prompt: "Gamma", enabled: false, lastRunAtMs: 20 },
    { name: "Delta", prompt: "", enabled: false },
    { name: "Task 2", prompt: "", enabled: true, lastRunAtMs: 5 },
    { name: "Task 10", prompt: "", enabled: true, lastRunAtMs: 5 },
  ] as ScheduleListOutput
  const names = (sort: Parameters<typeof sortSchedules>[1]) =>
    sortSchedules(items, sort, "en").map((item) => item.name || item.prompt)

  expect(names("name")).toEqual(["Alpha", "Beta", "Delta", "Gamma", "Task 2", "Task 10", "Zulu"])
  expect(names("lastRun")).toEqual(["Alpha", "Gamma", "Zulu", "Task 2", "Task 10", "Beta", "Delta"])
  expect(names("status")).toEqual(["Beta", "Task 2", "Task 10", "Zulu", "Alpha", "Delta", "Gamma"])
  expect(items[0].name).toBe("Zulu")
})
