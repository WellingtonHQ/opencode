import { expect } from "bun:test"
import { Schedule } from "@opencode/schema/schedule"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const AutoApprove = Schema.Struct({ enabled: Schema.Boolean })

it.live("serves scheduled prompts with time zones and the global auto-approve setting", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const send = (path: string, method = "GET", body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${path}`, {
            method,
            ...(body === undefined
              ? {}
              : {
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(body),
                }),
          }),
        ),
      )

    const globalPath = "/global/permissions/auto-approve"
    const initialSetting = yield* send(globalPath)
    expect(initialSetting.status).toBe(200)
    expect(Schema.decodeUnknownSync(AutoApprove)(yield* Effect.promise(() => initialSetting.json()))).toEqual({
      enabled: false,
    })

    const savedSetting = yield* send(globalPath, "PUT", { enabled: true })
    expect(savedSetting.status).toBe(200)
    expect(Schema.decodeUnknownSync(AutoApprove)(yield* Effect.promise(() => savedSetting.json()))).toEqual({
      enabled: true,
    })
    const reloadedSetting = yield* send(globalPath)
    expect(Schema.decodeUnknownSync(AutoApprove)(yield* Effect.promise(() => reloadedSetting.json()))).toEqual({
      enabled: true,
    })

    const schedulePath = "/api/schedule"
    const input = {
      prompt: "Check the project status",
      spec: { kind: "daily", hour: 9, minute: 30 },
      timezone: "America/Los_Angeles",
      directory: process.cwd(),
    }
    const createdResponse = yield* send(schedulePath, "POST", input)
    expect(createdResponse.status).toBe(200)
    const created = Schema.decodeUnknownSync(Schedule.Info)(yield* Effect.promise(() => createdResponse.json()))
    expect(created.timezone).toBe(input.timezone)
    expect(created.session).toBe("reuse")

    const readResponse = yield* send(`${schedulePath}/${created.id}`)
    expect(readResponse.status).toBe(200)
    expect(Schema.decodeUnknownSync(Schedule.Info)(yield* Effect.promise(() => readResponse.json())).timezone).toBe(
      input.timezone,
    )

    const updatedResponse = yield* send(`${schedulePath}/${created.id}`, "PATCH", { timezone: "Europe/London" })
    expect(updatedResponse.status).toBe(200)
    expect(
      Schema.decodeUnknownSync(Schedule.Info)(yield* Effect.promise(() => updatedResponse.json())).timezone,
    ).toBe("Europe/London")

    const sessionResponse = yield* send(`${schedulePath}/${created.id}`, "PATCH", { session: "new" })
    expect(sessionResponse.status).toBe(200)
    expect(Schema.decodeUnknownSync(Schedule.Info)(yield* Effect.promise(() => sessionResponse.json())).session).toBe(
      "new",
    )

    const listResponse = yield* send(schedulePath)
    expect(listResponse.status).toBe(200)
    expect(
      Schema.decodeUnknownSync(Schema.Array(Schedule.Info))(yield* Effect.promise(() => listResponse.json())).map(
        (info) => info.timezone,
      ),
    ).toEqual(["Europe/London"])

    const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    const localCreatedResponse = yield* send(schedulePath, "POST", {
      prompt: "Check local status",
      spec: { kind: "daily", hour: 9, minute: 30 },
      directory: process.cwd(),
    })
    expect(localCreatedResponse.status).toBe(200)
    const localCreated = Schema.decodeUnknownSync(Schedule.Info)(yield* Effect.promise(() => localCreatedResponse.json()))
    expect(localCreated.timezone).toBe(localTimeZone)

    const invalidZone = yield* send(schedulePath, "POST", { ...input, timezone: "Not/IANA" })
    expect(invalidZone.status).toBe(400)

    const missingRun = yield* send(`${schedulePath}/task_missing/run-now`, "POST")
    expect(missingRun.status).toBe(404)

    const removedResponse = yield* send(`${schedulePath}/${created.id}`, "DELETE")
    expect(removedResponse.status).toBe(200)
    expect(Schema.decodeUnknownSync(Schedule.Info)(yield* Effect.promise(() => removedResponse.json())).id).toBe(
      created.id,
    )
    const removedLocalResponse = yield* send(`${schedulePath}/${localCreated.id}`, "DELETE")
    expect(removedLocalResponse.status).toBe(200)
  }).pipe(Effect.scoped),
)
