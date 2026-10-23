import {
  ClientError,
  OpenCode,
  isUnauthorizedError,
  type ScheduleListOutput,
  type ScheduleSpec,
} from "@opencode/client/promise"
import { Service, type Endpoint } from "@opencode/client/effect/service"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { errorMessage } from "../../util/error"

type Task = ScheduleListOutput[number]
type ListInput = Runtime.Input<typeof Commands.commands.schedule.commands.list>
type AddInput = Runtime.Input<typeof Commands.commands.schedule.commands.add>
type TaskIDInput = Runtime.Input<typeof Commands.commands.schedule.commands.enable>
type ConnectionInput = Pick<ListInput, "server" | "standalone" | "username" | "password">

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const DAY_ALIASES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

export const list = Runtime.handler(Commands.commands.schedule.commands.list, (input) =>
  Effect.gen(function* () {
    const server = yield* ServerConnection.resolve(connectionArgs(input))
    const sdk = createClient(server.endpoint)
    const tasks = yield* request(server.endpoint.url, (signal) => sdk.schedule.list({ signal }))
    if (tasks.length === 0 && input.format === "table") {
      write("No scheduled tasks.")
      return
    }
    write(input.format === "json" ? JSON.stringify(tasks, null, 2) : formatTaskTable(tasks))
  }).pipe(Effect.catch(report)),
)

export const add = Runtime.handler(Commands.commands.schedule.commands.add, (input: AddInput) =>
  Effect.gen(function* () {
    const prompt = input.prompt.trim()
    if (!prompt)
      return yield* Effect.fail(
        new Error('Missing <prompt>. Usage: opencode schedule add "Summarize the open PRs" --daily "09:30"'),
      )

    const spec = yield* Effect.try({
      try: () =>
        buildSpec({
          at: Option.getOrUndefined(input.at),
          daily: Option.getOrUndefined(input.daily),
          weekly: Option.getOrUndefined(input.weekly),
          cron: Option.getOrUndefined(input.cron),
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    })
    const server = yield* ServerConnection.resolve(connectionArgs(input))
    const sdk = createClient(server.endpoint)
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    const name = Option.getOrUndefined(input.name)?.trim()
    const agent = Option.getOrUndefined(input.agent)?.trim()
    const task = yield* request(server.endpoint.url, (signal) =>
      sdk.schedule.create(
        {
          prompt,
          spec,
          timezone,
          session: input.session,
          directory: process.cwd(),
          ...(name ? { name } : {}),
          ...(agent ? { agentId: agent } : {}),
        },
        { signal },
      ),
    )

    write(`Created ${task.id}`)
    write(
      task.nextRunAtMs === undefined
        ? summarize(task.spec, task.timezone)
        : `${summarize(task.spec, task.timezone)} — next run ${formatNextRun(task.nextRunAtMs, task.timezone)}`,
    )
  }).pipe(Effect.catch(report)),
)

export const remove = Runtime.handler(Commands.commands.schedule.commands.remove, (input) =>
  Effect.gen(function* () {
    const server = yield* ServerConnection.resolve(connectionArgs(input))
    const sdk = createClient(server.endpoint)
    const task = yield* request(server.endpoint.url, (signal) =>
      sdk.schedule.remove({ scheduleID: input.id }, { signal }),
    )
    write(`Removed ${task.id}`)
  }).pipe(Effect.catch(report)),
)

export const enable = Runtime.handler(Commands.commands.schedule.commands.enable, (input) =>
  toggle(input, true).pipe(Effect.catch(report)),
)

export const disable = Runtime.handler(Commands.commands.schedule.commands.disable, (input) =>
  toggle(input, false).pipe(Effect.catch(report)),
)

export const runNow = Runtime.handler(Commands.commands.schedule.commands["run-now"], (input) =>
  Effect.gen(function* () {
    const server = yield* ServerConnection.resolve(connectionArgs(input))
    const sdk = createClient(server.endpoint)
    const task = yield* request(server.endpoint.url, (signal) =>
      sdk.schedule.runNow({ scheduleID: input.id }, { signal }),
    )
    const run = task.recentRuns?.[0]
    if (run?.status === "failed") {
      process.stdout.write(`Run for ${task.id} failed:${EOL}${run.errorText ?? "Unknown error"}${EOL}`)
      return
    }
    if (run?.status === "skipped") {
      write(`Skipped run for ${task.id}: its session is still busy`)
      return
    }
    write(run?.status === "completed" ? `Completed run for ${task.id}` : `Started run for ${task.id}`)
  }).pipe(Effect.catch(report)),
)

function connectionArgs(input: ConnectionInput): ServerConnection.Args {
  return {
    server: Option.getOrUndefined(input.server),
    standalone: input.standalone,
    username: Option.getOrUndefined(input.username),
    password: Option.getOrUndefined(input.password),
  }
}

function createClient(endpoint: Endpoint) {
  return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
}

function request<A>(url: string, run: (signal: AbortSignal) => Promise<A>) {
  return Effect.tryPromise({
    try: (signal) => run(AbortSignal.any([signal, AbortSignal.timeout(15_000)])),
    catch: (cause) => requestError(url, cause),
  })
}

function requestError(url: string, cause: unknown) {
  if (isUnauthorizedError(cause)) {
    return new Error(`Authentication failed for ${url}. Set OPENCODE_PASSWORD or pass --username and --password.`, {
      cause,
    })
  }
  if (cause instanceof ClientError && cause.reason === "Transport")
    return new Error(`Could not reach server at ${url}`, { cause })
  if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError"))
    return new Error(`${url} did not respond in time. Is the OpenCode server running?`, { cause })
  return cause
}

function report(error: unknown) {
  return Effect.sync(() => {
    process.stderr.write(errorMessage(error) + EOL)
    process.exitCode = 1
  })
}

function write(value: string) {
  process.stdout.write(value + EOL)
}

function formatTaskTable(tasks: ReadonlyArray<Task>) {
  const rows = tasks.map((task) => ({
    id: task.id,
    name: (task.name ?? task.prompt).replace(/\s+/g, " ").trim(),
    spec: summarize(task.spec, task.timezone),
    session: task.session,
    next: task.nextRunAtMs === undefined ? "-" : formatNextRun(task.nextRunAtMs, task.timezone),
    status: task.enabled ? "enabled" : "disabled",
  }))
  const widths = {
    id: Math.max("Task ID".length, ...rows.map((row) => row.id.length)),
    name: Math.min(40, Math.max("Name".length, ...rows.map((row) => row.name.length))),
    spec: Math.min(52, Math.max("Schedule".length, ...rows.map((row) => row.spec.length))),
    session: Math.max("Session".length, ...rows.map((row) => row.session.length)),
    next: Math.min(32, Math.max("Next Run".length, ...rows.map((row) => row.next.length))),
  }
  const columns = (row: (typeof rows)[number]) =>
    [
      [row.id, widths.id],
      [row.name, widths.name],
      [row.spec, widths.spec],
      [row.session, widths.session],
      [row.next, widths.next],
      [row.status, "Status".length],
    ] as const
  const header = [
    ["Task ID", widths.id],
    ["Name", widths.name],
    ["Schedule", widths.spec],
    ["Session", widths.session],
    ["Next Run", widths.next],
    ["Status", "Status".length],
  ] as const
  return [
    header.map(([value, width]) => value.padEnd(width)).join("  "),
    "─".repeat(header.reduce((length, [value, width]) => length + Math.max(value.length, width) + 2, -2)),
    ...rows.map((row) =>
      columns(row)
        .map(([value, width]) => truncate(value, width).padEnd(width))
        .join("  "),
    ),
  ].join(EOL)
}

function summarize(spec: ScheduleSpec, timezone: string) {
  if (spec.kind === "once") return `Once at ${formatDateTime(spec.atMs, timezone)} (${timezone})`
  if (spec.kind === "daily") return `Daily at ${pad2(spec.hour)}:${pad2(spec.minute)} (${timezone})`
  if (spec.kind === "weekly") {
    const days = [...new Set(spec.days)]
      .sort((a, b) => a - b)
      .map((day) => DAY_NAMES[day % 7] ?? String(day))
      .join(", ")
    return `${days} at ${pad2(spec.hour)}:${pad2(spec.minute)} (${timezone})`
  }
  return `Cron ${spec.expr} (${timezone})`
}

function formatDateTime(value: number, timezone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value)
}

function formatNextRun(value: number, timezone: string) {
  const day = new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: "short" })
  if (day.format(value) === day.format(Date.now()))
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, timeStyle: "short" }).format(value)
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(value)
}

function buildSpec(input: { at?: string; daily?: string; weekly?: string; cron?: string }): ScheduleSpec {
  const chosen = [
    ...(input.at?.trim() ? [{ name: "at" as const, value: input.at }] : []),
    ...(input.daily?.trim() ? [{ name: "daily" as const, value: input.daily }] : []),
    ...(input.weekly?.trim() ? [{ name: "weekly" as const, value: input.weekly }] : []),
    ...(input.cron?.trim() ? [{ name: "cron" as const, value: input.cron }] : []),
  ]
  if (chosen.length === 0)
    throw new Error(
      'No schedule given — use exactly one of: --at "yyyy-MM-dd HH:mm", --daily "HH:mm", --weekly "<days> <time>", or --cron "<expr>".',
    )
  if (chosen.length > 1)
    throw new Error(`Ambiguous schedule — use only one of: ${chosen.map((item) => `--${item.name}`).join(", ")}`)

  const selected = chosen[0]
  if (!selected) throw new Error("Missing schedule")
  switch (selected.name) {
    case "at":
      return { kind: "once", atMs: parseAt(selected.value) }
    case "daily":
      return { kind: "daily", ...parseTimeOfDay(selected.value, "--daily") }
    case "weekly": {
      const parts = selected.value.trim().split(/\s+/)
      if (parts.length !== 2)
        throw new Error(`Invalid --weekly "${selected.value}" — expected "<days> <time>", e.g. mon,wed 14:00.`)
      return { kind: "weekly", days: parseDays(parts[0]), ...parseTimeOfDay(parts[1], "--weekly") }
    }
    case "cron":
      return { kind: "cron", expr: selected.value.trim() }
  }
}

function parseAt(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) throw new Error(`Invalid --at time "${value}" — expected "yyyy-MM-dd HH:mm" in the local timezone.`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  if (hour > 23 || minute > 59)
    throw new Error(`Invalid --at time "${value}" — expected "yyyy-MM-dd HH:mm" in the local timezone.`)
  const date = new Date(year, month - 1, day, hour, minute)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  )
    throw new Error(`Invalid --at time "${value}" — not a real local date and time.`)
  return date.getTime()
}

function parseTimeOfDay(value: string, flag: "--daily" | "--weekly") {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) throw new Error(`Invalid ${flag} time "${value}" — expected "HH:mm", e.g. "09:30".`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59)
    throw new Error(`Invalid ${flag} time "${value}" — expected "HH:mm" between 00:00 and 23:59.`)
  return { hour, minute }
}

function parseDays(value: string) {
  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
  if (tokens.length === 0) throw new Error(`Invalid --weekly days "${value}" — expected e.g. mon,wed.`)
  const isDay = (token: string) =>
    (/^\d$/.test(token) && Number(token) <= 6) || DAY_ALIASES.includes(token.toLowerCase())
  const invalid = tokens.find((token) => !isDay(token))
  if (invalid !== undefined)
    throw new Error(`Unknown --weekly day "${invalid}". Use sun,mon,tue,wed,thu,fri,sat or numbers 0-6.`)
  const toDay = (token: string) => (/^\d$/.test(token) ? Number(token) : DAY_ALIASES.indexOf(token.toLowerCase()))
  return [...new Set(tokens.map(toDay))].sort((a, b) => a - b)
}

function toggle(input: TaskIDInput, enabled: boolean) {
  return Effect.gen(function* () {
    const server = yield* ServerConnection.resolve(connectionArgs(input))
    const sdk = createClient(server.endpoint)
    const task = yield* request(server.endpoint.url, (signal) =>
      sdk.schedule.update({ scheduleID: input.id, enabled }, { signal }),
    )
    write(`${enabled ? "Enabled" : "Disabled"} ${task.id}`)
    if (enabled && task.nextRunAtMs !== undefined) write(`next run ${formatNextRun(task.nextRunAtMs, task.timezone)}`)
  })
}

function pad2(value: number) {
  return value.toString().padStart(2, "0")
}

function truncate(value: string, width: number) {
  return value.length <= width ? value : value.slice(0, Math.max(0, width - 1)) + "…"
}
