import type { Argv } from "yargs"
import { EOL } from "os"
import { Effect, Schema } from "effect"
import { Schedule } from "@opencode-ai/schema/schedule"
import { ServerAuth } from "@/server/auth"
import { Locale } from "@/util/locale"
import { cmd } from "./cmd"
import { effectCmd, fail, CliError } from "../effect-cmd"
import { UI } from "../ui"

type Spec = Schedule.Spec
type Task = Schedule.Info

const DEFAULT_SERVER_URL = "http://localhost:4096" // `opencode serve` binds this port first when none is given

export const ScheduleCommand = cmd({
  command: "schedule",
  describe: "manage scheduled prompt tasks",
  builder: (yargs: Argv) =>
    withServerOptions(yargs)
      .command(ScheduleListCommand)
      .command(ScheduleAddCommand)
      .command(ScheduleRemoveCommand)
      .command(ScheduleEnableCommand)
      .command(ScheduleDisableCommand)
      .command(ScheduleRunNowCommand)
      .demandCommand(),
  async handler() {},
})

function withServerOptions<T>(yargs: Argv<T>): Argv {
  return yargs
    .option("server", { type: "string", describe: "opencode server to manage", default: DEFAULT_SERVER_URL })
    .option("password", { alias: ["p"], type: "string", describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)" })
    .option("username", { alias: ["u"], type: "string", describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or opencode)" })
}

type Target = { base: string; auth?: Record<string, string> }

function serverTarget(args: Record<string, any>) {
  const url: string = args.server ?? DEFAULT_SERVER_URL
  if (!URL.canParse(url)) return fail(`Invalid --server URL "${url}". Expected a full address such as http://localhost:4096.`)
  const parsed = new URL(url)
  const base = parsed.pathname === "/" ? parsed.origin : parsed.toString()
  return Effect.succeed({ base, auth: ServerAuth.headers({ password: args.password, username: args.username }) } satisfies Target)
}

class ScheduleHttpError extends Schema.TaggedErrorClass<ScheduleHttpError>()("Cli.schedule.http", {
  status: Schema.Number,
  message: Schema.String,
}) {}

async function send<T>(target: Target, method: "GET" | "POST" | "PATCH" | "DELETE", urlPath: string, body?: unknown): Promise<T> {
  const root = target.base.endsWith("/") ? target.base.slice(0, -1) : target.base
  return fetch(root + urlPath, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...target.auth },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).then(async (response) => {
    if (response.ok) return response.json() as Promise<T>
    throw await httpFailure(response)
  })
}

async function httpFailure(response: Response): Promise<ScheduleHttpError> {
  const text = await response.text().catch(() => "")
  let message = `HTTP ${response.status}`
  try {
    const payload = JSON.parse(text) as { message?: unknown }
    if (typeof payload.message === "string" && payload.message) message = payload.message
  } catch {}
  return new ScheduleHttpError({ status: response.status, message })
}

const request = <T>(target: Target, operation: () => Promise<T>, id?: string) =>
  Effect.tryPromise({ try: operation, catch: (error) => error }).pipe(Effect.mapError((error) => toCliError(error, target.base, id)))

function toCliError(error: unknown, base: string, id?: string): CliError {
  if (error instanceof ScheduleHttpError) {
    if (error.status === 401 || error.status === 403) return new CliError({ message: `Authentication failed for ${base}. Set OPENCODE_SERVER_PASSWORD or pass --password.`, exitCode: 1 })
    if (error.status === 404 && id) return new CliError({ message: `Task not found: ${id}`, exitCode: 1 })
    if (error.status === 400 || error.status === 409) return new CliError({ message: error.message, exitCode: 1 })
    return new CliError({ message: `Server returned HTTP ${error.status}: ${error.message}`, exitCode: 1 })
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return new CliError({ message: `${base} did not respond in time. Is the opencode server running?`, exitCode: 1 })
  const cause = error instanceof Error ? typeof error.cause === "object" && error.cause !== null && (error.cause as { message?: unknown }).message : undefined
  return new CliError({
    message: `Could not reach opencode server at ${base}${typeof cause === "string" && cause ? ` (${cause})` : ""}. Start one with \`opencode serve\`, open OpenCode Desktop, or point at an existing instance with --server <url>.`,
    exitCode: 1,
  })
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const DAY_ALIASES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

function specSummary(spec: Spec): string {
  if (spec.kind === "once") return Locale.datetime(spec.atMs)
  if (spec.kind === "daily") return `Daily at ${pad2(spec.hour)}:${pad2(spec.minute)}`
  if (spec.kind === "weekly") {
    const days = [...new Set(spec.days)].sort((a, b) => a - b).map((day) => DAY_NAMES[day % 7] ?? String(day)).join(", ")
    return `${days} at ${pad2(spec.hour)}:${pad2(spec.minute)}`
  }
  return spec.expr
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0")
}

export const ScheduleListCommand = effectCmd({
  command: "list",
  describe: "list scheduled tasks on a running opencode server",
  instance: false,
  builder: (yargs) => yargs.option("format", { alias: ["f"], choices: ["table", "json"], default: "table", type: "string" }),
  handler: Effect.fn("Cli.schedule.list")(function* (args: Record<string, any>) {
    const target = yield* serverTarget(args)
    const tasks = yield* request(target, () => send<Task[]>(target, "GET", "/api/schedule"))
    if (tasks.length === 0 && args.format !== "json") return console.log("No scheduled tasks.")
    console.log(args.format === "json" ? JSON.stringify(tasks, null, 2) : formatTaskTable(tasks))
  }),
})

function formatTaskTable(tasks: Task[]): string {
  const rows = tasks.map((task) => ({
    id: task.id,
    name: (task.name ?? task.prompt).replace(/\s+/g, " ").trim(),
    spec: specSummary(task.spec),
    next: task.nextRunAtMs === undefined ? "-" : Locale.todayTimeOrDateTime(task.nextRunAtMs),
    status: task.enabled ? "enabled" : "disabled",
  }))

  const idWidth = Math.max("Task ID".length, ...rows.map((row) => row.id.length))
  const nameWidth = Math.max("Name".length, ...rows.map((row) => row.name.length))
  const specWidth = Math.max("Schedule".length, ...rows.map((row) => row.spec.length))
  const nextWidth = Math.max("Next Run".length, ...rows.map((row) => row.next.length))

  const lines: string[] = []
  const header = `Task ID${" ".repeat(idWidth - "Task ID".length)}  Name${" ".repeat(nameWidth - "Name".length)}  Schedule${" ".repeat(
    specWidth - "Schedule".length,
  )}  Next Run${" ".repeat(nextWidth - "Next Run".length)}  Status`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const row of rows) {
    lines.push(
      `${row.id.padEnd(idWidth)}  ${Locale.truncate(row.name, nameWidth).padEnd(nameWidth)}  ${Locale.truncate(row.spec, specWidth).padEnd(specWidth)}  ${
        Locale.truncate(row.next, nextWidth).padEnd(nextWidth)
      }  ${row.status}`,
    )
  }
  return lines.join(EOL)
}

export const ScheduleAddCommand = effectCmd({
  command: "add <prompt>",
  describe: "create a scheduled prompt task",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("prompt", { type: "string", describe: "prompt to run on schedule" })
      .option("name", { type: "string", describe: "human-readable task name" })
      .option("agent", { type: "string", describe: "agent to run the prompt with (defaults to the server's default agent)" })
      .option("at", { type: "string", describe: 'one-shot, local time — "yyyy-MM-dd HH:mm"' })
      .option("daily", { type: "string", describe: 'every day at a local "HH:mm" time' })
      .option("weekly", { array: true, describe: "given days and a local \"HH:mm\" time (e.g. mon,wed 14:00); days are sun..sat or 0-6" })
      .option("cron", { type: "string", describe: '5-field cron expression in the local timezone (e.g. "30 9 * * 1")' }),
  handler: Effect.fn("Cli.schedule.add")(function* (args: Record<string, any>) {
    const prompt = String(args.prompt ?? "").trim()
    if (!prompt) return yield* fail('Missing <prompt>. Usage: opencode schedule add "Summarize the open PRs" --daily "09:30"')

    const spec = yield* buildSpec(args)
    const input = {
      prompt,
      ...(typeof args.name === "string" && args.name.trim() ? { name: String(args.name).trim() } : {}),
      spec,
      ...(typeof args.agent === "string" && args.agent.trim() ? { agentId: String(args.agent).trim() } : {}),
      directory: process.cwd(),
    }

    const target = yield* serverTarget(args)
    const task = yield* request(target, () => send<Task>(target, "POST", "/api/schedule", input))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Created ${task.id}` + UI.Style.TEXT_NORMAL)
    if (task.nextRunAtMs !== undefined)
      UI.println(UI.Style.TEXT_DIM + `${specSummary(task.spec)} — next run ${Locale.todayTimeOrDateTime(task.nextRunAtMs)}` + UI.Style.TEXT_NORMAL)
  }),
})

function buildSpec(args: Record<string, any>): Effect.Effect<Spec, CliError> {
  const chosen = (["at", "daily", "weekly", "cron"] as const).filter((name) => {
    const value = args[name]
    if (Array.isArray(value)) return value.some((item) => String(item ?? "").trim().length > 0)
    return typeof value === "string" && value.trim().length > 0
  })

  if (chosen.length === 0)
    return fail(
      'No schedule given — use exactly one of: --at "yyyy-MM-dd HH:mm", --daily "HH:mm", --weekly "<days> <time>", or --cron "<expr>".',
    )
  if (chosen.length > 1) return fail(`Ambiguous schedule — use only one of: ${chosen.map((name) => `--${name}`).join(", ")}`)

  switch (chosen[0]) {
    case "at":
      return parseAt(String(args.at)).pipe(Effect.map((atMs): Spec => ({ kind: "once", atMs })))
    case "daily":
      return parseTimeOfDay(String(args.daily), "--daily").pipe(Effect.map((time): Spec => ({ kind: "daily", ...time })))
    case "weekly":
      return parseWeekly(args.weekly)
    case "cron":
      return Effect.succeed({ kind: "cron", expr: String(args.cron).trim() } satisfies Spec)
  }
}

function parseAt(value: string): Effect.Effect<number, CliError> {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return fail(`Invalid --at time "${value}" — expected "yyyy-MM-dd HH:mm" in the local timezone.`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  if (hour > 23 || minute > 59) return fail(`Invalid --at time "${value}" — expected "yyyy-MM-dd HH:mm" in the local timezone.`)
  const date = new Date(year, month - 1, day, hour, minute)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
    return fail(`Invalid --at time "${value}" — not a real calendar date.`)
  return Effect.succeed(date.getTime())
}

function parseTimeOfDay(value: string, flag: "--daily" | "--weekly"): Effect.Effect<{ hour: number; minute: number }, CliError> {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim())
  if (!match) return fail(`Invalid ${flag} time "${value}" — expected "HH:mm", e.g. "09:30".`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return fail(`Invalid ${flag} time "${value}" — expected "HH:mm" between 00:00 and 23:59.`)
  return Effect.succeed({ hour, minute })
}

function parseWeekly(raw: unknown): Effect.Effect<Spec, CliError> {
  return Effect.gen(function* () {
    // yargs array:true delivers a single quoted value as [value] and unquoted
    // tokens as [days, time], so normalize through the joined form first.
    const shown = Array.isArray(raw) ? raw.map((part) => String(part)).join(" ") : String(raw)
    const parts = shown.split(/\s+/).map((part) => part.trim()).filter((part) => part.length > 0)
    if (parts.length !== 2) return yield* fail(`Invalid --weekly "${shown}" — expected "<days> <time>", e.g. mon,wed 14:00.`)
    const days = yield* parseDays(parts[0])
    const time = yield* parseTimeOfDay(parts[1], "--weekly")
    return { kind: "weekly", days, ...time } satisfies Spec
  })
}

function parseDays(value: string): Effect.Effect<number[], CliError> {
  const tokens = value.split(",").map((token) => token.trim()).filter((token) => token.length > 0)
  if (tokens.length === 0) return fail(`Invalid --weekly days "${value}" — expected e.g. mon,wed.`)
  const isDay = (token: string): boolean => (/^\d$/.test(token) && Number(token) <= 6) || DAY_ALIASES.includes(token.toLowerCase())
  const invalid = tokens.find((token) => !isDay(token))
  if (invalid !== undefined) return fail(`Unknown --weekly day "${invalid}". Use sun,mon,tue,wed,thu,fri,sat or numbers 0-6.`)
  const toDay = (token: string): number => (/^\d$/.test(token) ? Number(token) : DAY_ALIASES.indexOf(token.toLowerCase()))
  return Effect.succeed([...new Set(tokens.map(toDay))].sort((a, b) => a - b))
}

export const ScheduleRemoveCommand = effectCmd({
  command: "remove <id>",
  describe: "remove a scheduled task",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", describe: "task ID to remove" }),
  handler: Effect.fn("Cli.schedule.remove")(function* (args: Record<string, any>) {
    const id = String(args.id ?? "")
    if (!id) return yield* fail("Missing <id> — run `opencode schedule list` to see task IDs.")
    const target = yield* serverTarget(args)
    const task = yield* request(target, () => send<Task>(target, "DELETE", `/api/schedule/${encodeURIComponent(id)}`), id)
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Removed ${task.id}` + UI.Style.TEXT_NORMAL)
  }),
})

const ScheduleEnableCommand = toggleCommand(true)
const ScheduleDisableCommand = toggleCommand(false)

function toggleCommand(enabled: boolean) {
  const name = enabled ? "enable" : "disable"
  return effectCmd({
    command: `${name} <id>`,
    describe: `${enabled ? "re-enable a paused scheduled task" : "pause a scheduled task without removing it"}`,
    instance: false,
    builder: (yargs) => yargs.positional("id", { type: "string", describe: `task ID to ${name}` }),
    handler: Effect.fn(`Cli.schedule.${name}`)(function* (args: Record<string, any>) {
      const id = String(args.id ?? "")
      if (!id) return yield* fail(`Missing <id> — run \`opencode schedule list\` to see task IDs.`)
      const target = yield* serverTarget(args)
      const task = yield* request(target, () => send<Task>(target, "PATCH", `/api/schedule/${encodeURIComponent(id)}`, { enabled }), id)
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `${enabled ? "Enabled" : "Disabled"} ${task.id}` + UI.Style.TEXT_NORMAL)
      if (enabled && task.nextRunAtMs !== undefined)
        UI.println(UI.Style.TEXT_DIM + `next run ${Locale.todayTimeOrDateTime(task.nextRunAtMs)}` + UI.Style.TEXT_NORMAL)
    }),
  })
}

export const ScheduleRunNowCommand = effectCmd({
  command: "run-now <id>",
  describe: "run a scheduled task immediately, ignoring its schedule and enabled state",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", describe: "task ID to run now" }),
  handler: Effect.fn("Cli.schedule.run-now")(function* (args: Record<string, any>) {
    const id = String(args.id ?? "")
    if (!id) return yield* fail(`Missing <id> — run \`opencode schedule list\` to see task IDs.`)
    const target = yield* serverTarget(args)
    const task = yield* request(target, () => send<Task>(target, "POST", `/api/schedule/${encodeURIComponent(id)}/run-now`, undefined), id)
    if (task.lastError) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + `Ran ${task.id}, but the run recorded an error:` + UI.Style.TEXT_NORMAL)
      UI.println(UI.Style.TEXT_DANGER + task.lastError + UI.Style.TEXT_NORMAL)
      return
    }
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Ran ${task.id}` + UI.Style.TEXT_NORMAL)
  }),
})
