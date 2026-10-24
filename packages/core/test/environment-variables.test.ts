import { describe, expect } from "bun:test"
import { Effect, Ref, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { AppProcess } from "@opencode/util/process"
import { EnvironmentVariables } from "../src/environment-variables"
import { it } from "./lib/effect"

const processes = (run: AppProcess.Interface["run"]) =>
  AppProcess.Service.of({
    ...ChildProcessSpawner.make(() => Effect.die("Unexpected process spawn")),
    run,
    runStream: () => Stream.die("Unexpected process stream"),
  })

const result = (stdout: string, overrides: Partial<AppProcess.RunResult> = {}): AppProcess.RunResult => ({
  command: "fixed test command",
  exitCode: 0,
  stdout: Buffer.from(stdout, "utf8"),
  stderr: Buffer.alloc(0),
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
})

describe("EnvironmentVariables", () => {
  it.effect(
    "loads lazily, rotates saved values, and never revives removed inherited values",
    Effect.gen(function* () {
      const inherited = Object.freeze({ EXAMPLE: "inherited", PROCESS_ONLY: "local", EMPTY: "old" })
      const saved = yield* Ref.make<EnvironmentVariables.Persisted>({
        Machine: { EXAMPLE: "machine", MACHINE_ONLY: "system" },
        User: { EXAMPLE: "user", EMPTY: "" },
      })
      const reads = yield* Ref.make(0)
      const service = EnvironmentVariables.make({
        inherited,
        persisted: Ref.update(reads, (count) => count + 1).pipe(Effect.andThen(Ref.get(saved))),
      })
      expect(service.get("EXAMPLE")).toBe("inherited")
      expect(service.get("MACHINE_ONLY")).toBeUndefined()
      expect(yield* Ref.get(reads)).toBe(0)

      yield* service.refresh
      expect(service.get("EXAMPLE")).toBe("user")
      expect(service.get("MACHINE_ONLY")).toBe("system")
      expect(service.get("PROCESS_ONLY")).toBe("local")
      expect(service.get("EMPTY")).toBe("")

      yield* Ref.set(saved, { Machine: { EXAMPLE: "rotated" }, User: {} })
      yield* service.refresh
      expect(service.get("EXAMPLE")).toBe("rotated")
      expect(service.get("MACHINE_ONLY")).toBeUndefined()
      expect(service.get("EMPTY")).toBeUndefined()

      yield* Ref.set(saved, { Machine: {}, User: {} })
      yield* service.refresh
      yield* service.refresh
      expect(service.get("EXAMPLE")).toBeUndefined()
      expect(service.get("PROCESS_ONLY")).toBe("local")

      yield* Ref.set(saved, { Machine: {}, User: { EXAMPLE: "restored" } })
      yield* service.refresh
      expect(service.get("EXAMPLE")).toBe("restored")
      expect(inherited).toEqual({ EXAMPLE: "inherited", PROCESS_ONLY: "local", EMPTY: "old" })
      expect(yield* Ref.get(reads)).toBe(5)
    }),
  )

  it.effect(
    "matches Windows names case-insensitively and preserves Unicode and prototype-shaped names",
    Effect.gen(function* () {
      const saved = yield* Ref.make<EnvironmentVariables.Persisted>({
        Machine: { Mixed: "machine", Clé_日本: "machine Unicode" },
        User: { mIXED: "user", CLÉ_日本: "値 café 🌍", constructor: "ordinary value" },
      })
      const service = EnvironmentVariables.make({
        inherited: { MiXeD: "inherited", Clé_日本: "stale", ProcessOnly: "local" },
        persisted: Ref.get(saved),
      })
      expect(service.get("mixed")).toBe("inherited")
      yield* service.refresh
      expect(service.get("MIXED")).toBe("user")
      expect(service.get("clé_日本")).toBe("値 café 🌍")
      expect(service.get("processonly")).toBe("local")
      expect(service.get("CONSTRUCTOR")).toBe("ordinary value")
      expect(service.get("__proto__")).toBeUndefined()

      yield* Ref.set(saved, { Machine: {}, User: {} })
      yield* service.refresh
      expect(service.get("mixed")).toBeUndefined()
      expect(service.get("CLÉ_日本")).toBeUndefined()
    }),
  )

  it.effect(
    "keeps process-only construction case-sensitive and refresh a no-op",
    Effect.gen(function* () {
      const service = EnvironmentVariables.make({ inherited: { Example: "local", EMPTY: "", ABSENT: undefined } })
      yield* service.refresh
      expect(service.get("Example")).toBe("local")
      expect(service.get("EXAMPLE")).toBeUndefined()
      expect(service.get("EMPTY")).toBe("")
      expect(service.get("ABSENT")).toBeUndefined()
      expect(service.get("constructor")).toBeUndefined()
    }),
  )

  it.effect(
    "publishes independent snapshots without mutating inputs or process.env",
    Effect.gen(function* () {
      const inherited = { OPENCODE_ENVIRONMENT_VARIABLES_TEST_ONLY: "inherited fixture" }
      const saved = { Machine: {}, User: { OPENCODE_ENVIRONMENT_VARIABLES_TEST_ONLY: "saved fixture" } }
      const before = process.env.OPENCODE_ENVIRONMENT_VARIABLES_TEST_ONLY
      const service = EnvironmentVariables.make({ inherited, persisted: Effect.succeed(saved) })
      inherited.OPENCODE_ENVIRONMENT_VARIABLES_TEST_ONLY = "changed fixture"
      expect(service.get("OPENCODE_ENVIRONMENT_VARIABLES_TEST_ONLY")).toBe("inherited fixture")
      yield* service.refresh
      saved.User.OPENCODE_ENVIRONMENT_VARIABLES_TEST_ONLY = "changed source"
      expect(service.get("OPENCODE_ENVIRONMENT_VARIABLES_TEST_ONLY")).toBe("saved fixture")
      expect(process.env.OPENCODE_ENVIRONMENT_VARIABLES_TEST_ONLY === before).toBe(true)
      expect(inherited.OPENCODE_ENVIRONMENT_VARIABLES_TEST_ONLY).toBe("changed fixture")
    }),
  )

  it.effect(
    "sanitizes source failures and preserves the last successful snapshot",
    Effect.gen(function* () {
      const saved = yield* Ref.make<Effect.Effect<EnvironmentVariables.Persisted, unknown>>(
        Effect.succeed({ Machine: {}, User: { EXAMPLE: "saved" } }),
      )
      const service = EnvironmentVariables.make({
        inherited: { EXAMPLE: "inherited" },
        persisted: Ref.get(saved).pipe(Effect.flatten),
      })
      yield* service.refresh
      yield* Ref.set(saved, Effect.fail(new Error("synthetic sensitive fixture")))
      const error = yield* service.refresh.pipe(Effect.flip)
      expect(error).toBeInstanceOf(EnvironmentVariables.ReadError)
      expect(error.message).toBe("Could not read saved environment variables.")
      expect(JSON.stringify(error)).not.toContain("synthetic sensitive fixture")
      expect("cause" in error).toBe(false)
      expect(service.get("EXAMPLE")).toBe("saved")
    }),
  )

  it.effect(
    "reads both saved scopes in one bounded, noninteractive PowerShell call with UTF-8 output",
    Effect.gen(function* () {
      const calls: { command: ChildProcess.Command; options: AppProcess.RunOptions | undefined }[] = []
      const saved = { Machine: { Clé_日本: "machine" }, User: { clé_日本: "値 café 🌍" } }
      const source = processes((command, options) => {
        calls.push({ command, options })
        return Effect.succeed(result(JSON.stringify(saved)))
      })
      const service = EnvironmentVariables.make({
        inherited: {},
        persisted: EnvironmentVariables.readWindows({ systemroot: "D:\\Windows" }).pipe(
          Effect.provideService(AppProcess.Service, source),
        ),
      })
      expect(calls).toHaveLength(0)
      yield* service.refresh
      expect(calls).toHaveLength(1)
      const command = calls[0].command
      expect(command._tag).toBe("StandardCommand")
      if (command._tag !== "StandardCommand") return
      expect(command.command).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
      expect(command.args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
      expect(command.args[4]).toContain("UTF8Encoding")
      expect(command.args[4]).toContain("GetEnvironmentVariables($scope)")
      expect(command.args[4]).toContain("@('Machine', 'User')")
      expect(command.options).toMatchObject({ stdin: "ignore", windowsHide: true })
      expect(calls[0].options).toEqual({ timeout: "10 seconds", maxOutputBytes: 4 * 1024 * 1024, maxErrorBytes: 0 })
      expect(service.get("CLÉ_日本")).toBe("値 café 🌍")
    }),
  )

  it.effect(
    "uses the default Windows system root when it was not inherited",
    Effect.gen(function* () {
      const source = processes((command) => {
        expect(command._tag).toBe("StandardCommand")
        if (command._tag === "StandardCommand") {
          expect(command.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        }
        return Effect.succeed(result('{"Machine":{},"User":{}}'))
      })
      yield* EnvironmentVariables.readWindows({}).pipe(Effect.provideService(AppProcess.Service, source))
    }),
  )

  const failures = [
    [
      "nonzero exit",
      Effect.succeed(
        result("synthetic sensitive stdout", { exitCode: 1, stderr: Buffer.from("synthetic sensitive stderr") }),
      ),
    ],
    ["truncated output", Effect.succeed(result('{"Machine":{},"User":{}}', { stdoutTruncated: true }))],
    ["invalid JSON", Effect.succeed(result("synthetic sensitive invalid JSON"))],
    ["invalid shape", Effect.succeed(result('{"Machine":{},"User":{"EXAMPLE":123}}'))],
    ["missing scope", Effect.succeed(result('{"User":{}}'))],
    [
      "spawn failure",
      Effect.fail(
        new AppProcess.AppProcessError({
          command: "fixed",
          stderr: "synthetic sensitive stderr",
          cause: new Error("synthetic sensitive cause"),
        }),
      ),
    ],
    ["timeout", Effect.fail(new AppProcess.AppProcessError({ command: "fixed", cause: new Error("Timed out") }))],
  ] as const

  for (const [name, response] of failures) {
    it.effect(
      `returns a safe ReadError for ${name}`,
      Effect.gen(function* () {
        const error = yield* EnvironmentVariables.readWindows({}).pipe(
          Effect.provideService(
            AppProcess.Service,
            processes(() => response),
          ),
          Effect.flip,
        )
        expect(error).toBeInstanceOf(EnvironmentVariables.ReadError)
        expect(error._tag).toBe("EnvironmentVariables.ReadError")
        expect(error.message).toBe("Could not read saved environment variables.")
        expect(JSON.stringify(error)).not.toContain("synthetic sensitive")
        expect("cause" in error).toBe(false)
        expect("stdout" in error).toBe(false)
        expect("stderr" in error).toBe(false)
      }),
    )
  }
})
