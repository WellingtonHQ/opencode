import type { Argv } from "yargs"
import path from "path"
import { EOL } from "os"
import { Effect } from "effect"
import { ScheduleV2 } from "@opencode-ai/core/schedule/schedule"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const DAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}
const DAY_FULL_NAMES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function timeOfDay(hours: number, minutes: number): string {
  const suffix = hours < 12 ? "AM" : "PM"
  const hour = hours % 12 === 0 ? 12 : hours % 12
  return `${hour}:${String(minutes).padStart(2, "0")} ${suffix}`
}

function formatDateTime(ms: number): string {
  const date = new Date(ms)
  return `${date.toLocaleDateString()}, ${timeOfDay(date.getHours(), date.getMinutes())}`
}

function formatSpec(spec: ScheduleV2.ScheduleSpec): string {
  if (spec.kind === "one_shot") return `Once — ${formatDateTime(spec.atMs)}`
  if (spec.kind === "cron") return spec.expr
  const [hours, minutes] = spec.timeHhMm.split(":").map(Number)
  if (spec.kind !== "weekly") return `Daily at ${timeOfDay(hours, minutes)}`
  const days = [...spec.days].sort((a, b) => a - b).map((day) => WEEKDAYS[day]).join(",")
  return `Weekly ${days} at ${timeOfDay(hours, minutes)}`
}

function formatLast(run?: ScheduleV2.RunInfo): string {
  if (!run) return "-"
  return `${run.status} ${formatDateTime(run.startedAt)}`
}

function parseDay(token: string): number | undefined {
  const value = token.trim().toLowerCase()
  if (!value) return undefined
  if (/^\d+$/.test(value)) {
    const day = Number(value)
    return day <= 6 ? day : undefined
  }
  const short = DAY_NAMES[value]
  if (short !== undefined) return short
  return DAY_FULL_NAMES[value]
}

type AddArgs = {
  text?: (string | number)[]
  prompt?: string
  name?: string
  at?: string
  daily?: string
  weekly?: string
  cron?: string
  agent?: string
  model?: string
  dir?: string
}

function parseSpec(args: AddArgs): { error: string } | { spec: ScheduleV2.ScheduleSpec } {
  if (args.at !== undefined) {
    const atMs = Date.parse(args.at)
    if (Number.isNaN(atMs)) return { error: `Invalid --at value "${args.at}": expected an ISO 8601 datetime such as 2026-09-11T23:00:00` }
    return { spec: { kind: "one_shot", atMs } }
  }
  if (args.daily !== undefined) {
    if (!TIME_RE.test(args.daily)) return { error: `Invalid --daily time "${args.daily}": use 24-hour HH:mm, e.g. 09:30` }
    return { spec: { kind: "daily", timeHhMm: args.daily } }
  }
  if (args.weekly !== undefined) {
    const match = /^(.+)\s+((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(args.weekly.trim())
    if (!match) return { error: `Invalid --weekly value "${args.weekly}": expected "<days> HH:mm" such as "mon,wed 09:30"` }
    const days = new Set<number>()
    for (const token of match[1].split(",")) {
      const day = parseDay(token)
      if (day === undefined) return { error: `Unknown week day "${token}": use mon-sun, full names, or a number 0-6 with Sunday=0` }
      days.add(day)
    }
    return { spec: { kind: "weekly", days: [...days].sort((a, b) => a - b), timeHhMm: match[2] } }
  }
  if (args.cron !== undefined) return { spec: { kind: "cron", expr: args.cron } }
  return { error: 'Specify a schedule with --at <ISO-8601>, --daily HH:mm, --weekly "<days> HH:mm", or --cron "min hour day month weekday"' }
}

function parseAdd(args: AddArgs): { ok: true; input: ScheduleV2.CreateInput } | { ok: false; error: string } {
  const positional = (args.text ?? []).map(String).join(" ").trim()
  if (positional && args.prompt) return { ok: false, error: "Provide the prompt once: use either positional arguments or --prompt, not both" }
  const promptText = (args.prompt ?? positional).trim()
  if (!promptText) return { ok: false, error: "No prompt given: pass it as positional arguments or with --prompt/-p" }

  const specFlags = [
    args.at !== undefined ? "--at" : null,
    args.daily !== undefined ? "--daily" : null,
    args.weekly !== undefined ? "--weekly" : null,
    args.cron !== undefined ? "--cron" : null,
  ].filter((flag): flag is string => flag !== null)
  if (specFlags.length > 1) return { ok: false, error: `Only one of ${specFlags.join(", ")} may set the schedule` }

  const parsed = parseSpec(args)
  if ("error" in parsed) return { ok: false, error: parsed.error }

  let model: ScheduleV2.ModelSelection | undefined
  if (args.model !== undefined) {
    const [providerID, ...rest] = args.model.split("/")
    if (!providerID || rest.length === 0) return { ok: false, error: `Invalid --model "${args.model}": expected provider/model, e.g. openai/gpt-4o` }
    model = { id: rest.join("/"), providerID }
  }

  const name = args.name?.trim() || (promptText.length > 40 ? promptText.slice(0, 40).trimEnd() + "…" : promptText)
  return { ok: true, input: { name, promptText, spec: parsed.spec, directory: path.resolve(process.cwd(), args.dir ?? "."), agentId: args.agent, model } }
}

function formatTaskTable(tasks: ScheduleV2.TaskWithLatest[]): string {
  const nameW = Math.max(4, ...tasks.map((task) => task.name.length))
  const scheduleW = Math.max(8, ...tasks.map((task) => formatSpec(task.spec).length))
  const next = (task: ScheduleV2.TaskInfo) => (task.nextFireMs === undefined ? "-" : formatDateTime(task.nextFireMs))
  const nextW = Math.max(9, ...tasks.map((task) => next(task).length))
  const lastW = Math.max(4, ...tasks.map((task) => formatLast(task.latestRun).length))
  const lines: string[] = []
  const header = "Name".padEnd(nameW) + "  " + "Schedule".padEnd(scheduleW) + "  " + "Next run".padEnd(nextW) + "  " + "Last".padEnd(lastW) + "  Enabled"
  lines.push(header, "─".repeat(nameW + scheduleW + nextW + lastW + 7 + 8))
  for (const task of tasks) {
    const row = [task.name.padEnd(nameW), formatSpec(task.spec).padEnd(scheduleW), next(task).padEnd(nextW), formatLast(task.latestRun).padEnd(lastW), task.enabled ? "yes" : "no"]
    lines.push(row.join("  "))
  }
  return lines.join(EOL)
}

function formatShow(task: ScheduleV2.TaskInfo, runs: ScheduleV2.RunInfo[]): string {
  const fields: [string, string][] = []
  fields.push(["id", task.id], ["name", task.name], ["prompt", task.promptText], ["schedule", formatSpec(task.spec)])
  if (task.agentId) fields.push(["agent", task.agentId])
  if (task.model) fields.push(["model", `${task.model.providerID}/${task.model.id}`])
  fields.push(
    ["directory", task.directory],
    ["enabled", task.enabled ? "yes" : "no"],
    ...(task.nextFireMs !== undefined ? [["next run", formatDateTime(task.nextFireMs)] as [string, string]] : []),
    ["created", formatDateTime(task.timeCreated)],
    ["updated", formatDateTime(task.timeUpdated)],
  )
  const width = Math.max(...fields.map(([key]) => key.length))
  const indent = " ".repeat(width + 1)
  const lines = fields.map(([key, value]) => `${key.padEnd(width)} ${value.replace(/\r?\n/g, `\n${indent}`)}`)
  if (runs.length > 0) {
    lines.push("", `Last ${runs.length} run${runs.length === 1 ? "" : "s"}:`)
    for (const run of runs) {
      const line = `${run.status.padEnd(8)} ${formatDateTime(run.startedAt)}` + (run.sessionId ? `  session ${run.sessionId}` : "")
      lines.push(line)
      if (run.errorText) lines.push(`         ${run.errorText.replace(/\r?\n/g, "\n         ")}`)
    }
  }
  return lines.join(EOL)
}

const failNotFound = (error: ScheduleV2.ScheduleNotFoundError) => fail(`Schedule not found: ${error.id}`)
const failInvalidSpec = (error: ScheduleV2.InvalidSpecError) => fail(error.message)
const failPastOneShot = () => fail("Scheduled time is in the past")
const failRunFailed = (error: ScheduleV2.RunFailedError) => fail(`Scheduled run failed: ${error.message}`)

export const ScheduleAddCommand = effectCmd({
  command: "add [text..]",
  describe: "create a scheduled prompt",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("text", {
        describe: "prompt to run on the schedule",
        type: "string",
        array: true,
        default: [],
      })
      .option("prompt", {
        alias: "p",
        describe: "prompt text (alternative to positional arguments)",
        type: "string",
      })
      .option("name", {
        describe: "name for the scheduled prompt (defaults to a truncated prompt)",
        type: "string",
      })
      .option("at", {
        describe: "run once at an ISO 8601 datetime, e.g. 2026-09-11T23:00:00",
        type: "string",
      })
      .option("daily", {
        describe: "run daily at HH:mm (24-hour), e.g. 23:00",
        type: "string",
      })
      .option("weekly", {
        describe: 'run weekly on <days> at HH:mm, e.g., --weekly "mon,wed 09:30"',
        type: "string",
      })
      .option("cron", {
        describe: 'run on a 5-field cron expression, e.g. "0 9 * * 1-5"',
        type: "string",
      })
      .option("agent", {
        describe: "agent to run the prompt with",
        type: "string",
      })
      .option("model", {
        describe: "model to run the prompt with, in provider/model form",
        type: "string",
      })
      .option("dir", {
        describe: "directory for scheduled sessions (defaults to the current directory)",
        type: "string",
      }),
  handler: Effect.fn("Cli.schedule.add")(function* (args: AddArgs) {
    const schedule = yield* ScheduleV2.Service
    const parsed = parseAdd(args)
    if (!parsed.ok) return yield* fail(parsed.error)
    const task = yield* schedule.create(parsed.input).pipe(
      Effect.catchTag("Schedule.InvalidSpecError", failInvalidSpec),
      Effect.catchTag("Schedule.PastOneShotError", failPastOneShot),
    )
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Created "${task.name}" (${task.id})` + UI.Style.TEXT_NORMAL)
    UI.println(`schedule: ${formatSpec(task.spec)}`)
    if (task.nextFireMs !== undefined) UI.println(`next run: ${formatDateTime(task.nextFireMs)}`)
  }),
})

export const ScheduleListCommand = effectCmd({
  command: "list",
  describe: "list scheduled prompts",
  instance: false,
  builder: (yargs) =>
    yargs.option("format", {
      describe: "output format",
      type: "string",
      choices: ["table", "json"],
      default: "table",
    }),
  handler: Effect.fn("Cli.schedule.list")(function* (args: { format: string }) {
    const schedule = yield* ScheduleV2.Service
    const tasks = yield* schedule.list()
    if (tasks.length === 0) {
      UI.println(UI.Style.TEXT_DIM + "No scheduled prompts found" + UI.Style.TEXT_NORMAL)
      return
    }
    console.log(args.format === "json" ? JSON.stringify(tasks, null, 2) : formatTaskTable(tasks))
  }),
})

export const ScheduleShowCommand = effectCmd({
  command: "show <id>",
  describe: "show a scheduled prompt and its recent runs",
  instance: false,
  builder: (yargs) =>
    yargs.positional("id", {
      describe: "scheduled prompt ID",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.schedule.show")(function* (args: { id: string }) {
    const schedule = yield* ScheduleV2.Service
    const task = yield* schedule.get(args.id).pipe(Effect.catchTag("Schedule.NotFoundError", failNotFound))
    const runs = yield* schedule.listRuns(task.id, 10).pipe(Effect.catchTag("Schedule.NotFoundError", failNotFound))
    console.log(formatShow(task, runs))
  }),
})

export const ScheduleRemoveCommand = effectCmd({
  command: "remove <id>",
  aliases: ["rm"],
  describe: "delete a scheduled prompt and its run history",
  instance: false,
  builder: (yargs) =>
    yargs.positional("id", {
      describe: "scheduled prompt ID",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.schedule.remove")(function* (args: { id: string }) {
    const schedule = yield* ScheduleV2.Service
    const task = yield* schedule.get(args.id).pipe(Effect.catchTag("Schedule.NotFoundError", failNotFound))
    yield* schedule.delete(task.id).pipe(Effect.catchTag("Schedule.NotFoundError", failNotFound))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Deleted "${task.name}" (${task.id})` + UI.Style.TEXT_NORMAL)
  }),
})

export const ScheduleEnableCommand = effectCmd({
  command: "enable <id>",
  describe: "enable a scheduled prompt",
  instance: false,
  builder: (yargs) =>
    yargs.positional("id", {
      describe: "scheduled prompt ID",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.schedule.enable")(function* (args: { id: string }) {
    const schedule = yield* ScheduleV2.Service
    const task = yield* schedule.update(args.id, { enabled: true }).pipe(
      Effect.catchTag("Schedule.NotFoundError", failNotFound),
      Effect.catchTag("Schedule.InvalidSpecError", failInvalidSpec),
      Effect.catchTag("Schedule.PastOneShotError", failPastOneShot),
      Effect.catchTag("Schedule.RunFailedError", failRunFailed),
    )
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Enabled "${task.name}" (${task.id})` + UI.Style.TEXT_NORMAL)
  }),
})

export const ScheduleDisableCommand = effectCmd({
  command: "disable <id>",
  describe: "disable a scheduled prompt",
  instance: false,
  builder: (yargs) =>
    yargs.positional("id", {
      describe: "scheduled prompt ID",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.schedule.disable")(function* (args: { id: string }) {
    const schedule = yield* ScheduleV2.Service
    const task = yield* schedule.update(args.id, { enabled: false }).pipe(
      Effect.catchTag("Schedule.NotFoundError", failNotFound),
      Effect.catchTag("Schedule.InvalidSpecError", failInvalidSpec),
      Effect.catchTag("Schedule.PastOneShotError", failPastOneShot),
      Effect.catchTag("Schedule.RunFailedError", failRunFailed),
    )
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Disabled "${task.name}" (${task.id})` + UI.Style.TEXT_NORMAL)
  }),
})

export const ScheduleRunNowCommand = effectCmd({
  command: "run-now <id>",
  describe: "run a scheduled prompt now in a new session",
  instance: false,
  builder: (yargs) =>
    yargs.positional("id", {
      describe: "scheduled prompt ID",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.schedule.run-now")(function* (args: { id: string }) {
    const schedule = yield* ScheduleV2.Service
    const sessionID = yield* schedule.runNow(args.id).pipe(
      Effect.catchTag("Schedule.NotFoundError", failNotFound),
      Effect.catchTag("Schedule.RunFailedError", failRunFailed),
    )
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Started in new session ${sessionID}` + UI.Style.TEXT_NORMAL)
  }),
})

export const ScheduleCommand = effectCmd({
  command: "schedule",
  describe: "manage scheduled prompts",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(ScheduleAddCommand)
      .command(ScheduleListCommand)
      .command(ScheduleShowCommand)
      .command(ScheduleRemoveCommand)
      .command(ScheduleEnableCommand)
      .command(ScheduleDisableCommand)
      .command(ScheduleRunNowCommand)
      .demandCommand(),
  handler: Effect.fn("Cli.schedule")(function* () {}),
})
