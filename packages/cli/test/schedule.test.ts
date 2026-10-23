import { describe, expect, test } from "bun:test"
import type { ScheduleListOutput } from "@opencode/client/promise"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { OPENCODE_VERSION } from "../src/version"
import { isolatedEnv } from "./fixture/environment"

describe("schedule command", () => {
  test("registers the scheduled-task commands and documents their options", async () => {
    // One spawn per help level: root, group, and one subcommand cover the flag documentation.
    await using root = await tmpdir("opencode-cli-schedule-")
    const results = await Promise.all(
      [["--help"], ["schedule", "--help"], ["schedule", "add", "--help"]].map((argv) => cli(argv, root.path)),
    )
    expect(results.every((result) => result.exitCode === 0)).toBe(true)
    expect(results[0]?.stdout).toContain("schedule")
    expect(results[1]?.stdout).toContain("Manage scheduled prompt tasks")
    expect(results[1]?.stdout).toContain("run-now")
    expect(results[2]?.stdout).toContain('"yyyy-MM-dd HH:mm"')
    expect(results[2]?.stdout).toContain("Days and local time")
    expect(results[2]?.stdout).toContain("--username")
    expect(results[2]?.stdout).toContain("--password")
  })

  test("creates tasks through the Promise client with local timezone and custom server auth", async () => {
    await using root = await tmpdir("opencode-cli-schedule-")
    const requests: Array<{ method: string; path: string; authorization: string | null; body?: unknown }> = []
    const timezone = "UTC"
    const nextRunAtMs = Date.UTC(2030, 0, 1, 18, 30)
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const body: unknown = request.method === "POST" ? await request.json() : undefined
        requests.push({
          method: request.method,
          path: url.pathname,
          authorization: request.headers.get("authorization"),
          ...(body === undefined ? {} : { body }),
        })
        if (request.headers.get("authorization") !== `Basic ${btoa("schedule-user:schedule-password")}`)
          return Response.json({ _tag: "UnauthorizedError", message: "Authentication required" }, { status: 401 })
        if (url.pathname === "/api/info")
          return Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [], paths: { tmp: "/tmp" } })
        if (url.pathname === "/api/schedule" && request.method === "POST")
          return Response.json({
            id: "task_cli_create",
            prompt: "Summarize the open PRs",
            spec: { kind: "daily", hour: 9, minute: 30 },
            timezone,
            directory: process.cwd(),
            enabled: true,
            nextRunAtMs,
            runCount: 0,
          } satisfies ScheduleListOutput[number])
        return new Response("Not found", { status: 404 })
      },
    })

    try {
      const result = await cli(
        [
          "schedule",
          "add",
          "Summarize the open PRs",
          "--daily",
          "09:30",
          "--server",
          server.url.toString(),
          "--username",
          "schedule-user",
          "--password",
          "schedule-password",
        ],
        root.path,
        { TZ: "UTC" },
      )
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
      expect(result.stdout).toContain("Created task_cli_create")
      expect(result.stdout).toContain(
        `next run ${new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: "short", timeStyle: "short" }).format(nextRunAtMs)}`,
      )
      expect(requests.map((request) => request.path)).toEqual(["/api/info", "/api/schedule"])
      expect(
        requests.every((request) => request.authorization === `Basic ${btoa("schedule-user:schedule-password")}`),
      ).toBe(true)
      expect(requests[1]?.body).toMatchObject({
        prompt: "Summarize the open PRs",
        spec: { kind: "daily", hour: 9, minute: 30 },
        timezone: "UTC",
        directory: process.cwd(),
      })
    } finally {
      await server.stop(true)
    }
  })

  test("formats listed tasks in each task's saved timezone", async () => {
    await using root = await tmpdir("opencode-cli-schedule-")
    const nextRunAtMs = Date.UTC(2030, 0, 1, 0, 30)
    const timezone = "America/Los_Angeles"
    const localTimezone = "UTC"
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/info")
          return Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [], paths: { tmp: "/tmp" } })
        if (url.pathname === "/api/schedule")
          return Response.json([
            {
              id: "task_cli_list",
              prompt: "Summarize the open PRs",
              spec: { kind: "daily", hour: 9, minute: 30 },
              timezone,
              directory: process.cwd(),
              enabled: true,
              nextRunAtMs,
              runCount: 0,
            } satisfies ScheduleListOutput[number],
          ])
        return new Response("Not found", { status: 404 })
      },
    })

    try {
      const result = await cli(["schedule", "list", "--server", server.url.toString()], root.path, {
        TZ: localTimezone,
      })
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
      expect(result.stdout).toContain(`Daily at 09:30 (${timezone})`)
      expect(result.stdout).toContain(
        new Intl.DateTimeFormat(undefined, {
          timeZone: timezone,
          dateStyle: "short",
          timeStyle: "short",
        }).format(nextRunAtMs),
      )
      expect(result.stdout).not.toContain(
        new Intl.DateTimeFormat(undefined, {
          timeZone: localTimezone,
          dateStyle: "short",
          timeStyle: "short",
        }).format(nextRunAtMs),
      )
    } finally {
      await server.stop(true)
    }
  })

  test("run-now reports the current run state instead of a previous task error", async () => {
    await using root = await tmpdir("opencode-cli-schedule-")
    const previousError = "previous attempt failed"
    const taskID = "task_cli_run"
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/info")
          return Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [], paths: { tmp: "/tmp" } })
        if (url.pathname === `/api/schedule/${taskID}/run-now`)
          return Response.json({
            id: taskID,
            prompt: "Summarize the open PRs",
            spec: { kind: "daily", hour: 9, minute: 30 },
            timezone: "UTC",
            directory: process.cwd(),
            enabled: true,
            runCount: 2,
            lastError: previousError,
            recentRuns: [{ taskID, status: "running", startedAtMs: Date.now() }],
          } satisfies ScheduleListOutput[number])
        return new Response("Not found", { status: 404 })
      },
    })

    try {
      const result = await cli(["schedule", "run-now", taskID, "--server", server.url.toString()], root.path)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
      expect(result.stdout).toContain(`Started run for ${taskID}`)
      expect(result.stdout).not.toContain(previousError)
    } finally {
      await server.stop(true)
    }
  })
})

async function cli(args: string[], root: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, { OPENCODE_DISABLE_AUTOUPDATE: "1", ...env }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}
