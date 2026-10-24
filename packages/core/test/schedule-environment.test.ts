import { expect } from "bun:test"
import { LLM, LLMClient, type LLMRequest } from "@opencode/ai"
import { TestLLM } from "@opencode/ai/testing"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigVariable } from "@opencode/core/config/variable"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { EnvironmentVariables } from "@opencode/core/environment-variables"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { ScheduleTask } from "@opencode/core/schedule"
import { ScheduleRunTable, ScheduleTaskTable } from "@opencode/core/schedule/sql"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { ConfigProvider } from "@opencode/schema/config/provider"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Schedule } from "@opencode/schema/schedule"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Deferred, Effect, Layer, Ref, Schema } from "effect"
import { Headers } from "effect/http"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(TestLLM.testLayer())
const selection = { providerID: Provider.ID.make("schedule-gateway"), id: Model.ID.make("test-model") }
const keys = {
  inherited: "fixture-inherited-stale",
  first: "fixture-saved-first",
  rotated: "fixture-saved-rotated",
  restored: "fixture-saved-restored",
  readFailure: "fixture-read-failure-secret",
}

it.effect("tracks migrated credential fields and ignores legacy providers replaced by native configuration", () =>
  Effect.sync(() => {
    const legacy = {
      provider: {
        gateway: { options: { apiKey: "{env:OLD_KEY}", headers: { "x-api-key": "{env:OLD_HEADER}" } } },
      },
    }
    expect(ConfigVariable.credentialReferences(JSON.stringify(legacy), () => undefined)).toEqual([
      { providerID: "gateway", field: "settings.apiKey", variables: ["OLD_KEY"] },
      { providerID: "gateway", field: "headers.x-api-key", variables: ["OLD_HEADER"] },
    ])
    const native = { providers: { gateway: { settings: { apiKey: "fixture-native-key" } } } }
    for (const input of [
      { ...native, ...legacy },
      { ...legacy, ...native },
    ]) {
      expect(ConfigVariable.credentialReferences(JSON.stringify(input), () => undefined)).toEqual([
        { providerID: "gateway", field: "settings.apiKey", variables: [] },
      ])
    }
    expect(
      ConfigVariable.credentialReferences(
        `{
      "providers": {
        "gateway": {
          "settings": { "apiKey": "{env:OLD_KEY}" },
          "models": { "test": { "limit": { "context": {env:CONTEXT} } } }
        }
      }
    }`,
        (name) => (name === "CONTEXT" ? "200000" : undefined),
      ),
    ).toEqual([{ providerID: "gateway", field: "settings.apiKey", variables: ["OLD_KEY"] }])
  }),
)

const fire = (id: Schedule.ID) =>
  Effect.gen(function* () {
    const tasks = yield* ScheduleTask.Service
    const bus = yield* Bus.Service
    const execution = yield* SessionExecution.Service
    const before = yield* tasks.get(id)
    if (!before) throw new Error("Expected a saved schedule")
    const terminal = yield* Deferred.make<Schedule.Info>()
    const unsubscribe = yield* bus.listen((event) =>
      Schema.is(Schedule.Event.Changed)(event) &&
      event.data.info.id === id &&
      event.data.info.runCount === before.runCount + 1 &&
      event.data.info.recentRuns?.[0] !== undefined &&
      event.data.info.recentRuns?.[0]?.status !== "running"
        ? Deferred.succeed(terminal, event.data.info).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    expect(yield* tasks.runNow(id)).toBeDefined()
    const info = yield* Deferred.await(terminal).pipe(Effect.timeout("10 seconds"))
    // Completion is announced before the execution coordinator releases its busy flag.
    if (info.lastSessionId) yield* execution.awaitIdle(info.lastSessionId)
    return info
  }).pipe(Effect.scoped)

const assertBearer = (request: LLMRequest | undefined, key: string) =>
  Effect.gen(function* () {
    if (!request) throw new Error("Expected a model request")
    expect(request.model.route.id).toBe("openai-compatible-chat")
    expect(request.model.route.endpoint.baseURL).toBe("https://gateway.invalid/v1")
    expect(String(request.model.id)).toBe(selection.id)
    const headers = yield* request.model.route.auth.apply({
      request,
      method: "POST",
      url: "https://gateway.invalid/v1/chat/completions",
      body: "{}",
      headers: Headers.fromInput(request.model.route.defaults.headers),
    })
    expect(headers.authorization).toBe(`Bearer ${key}`)
  })

for (const input of [
  { mode: "reuse", auth: "interpolated" },
  { mode: "new", auth: "interpolated" },
  { mode: "reuse", auth: "env-only integration" },
] as const) {
  const mode = input.mode
  it.live(`scheduled ${mode} sessions refresh saved ${input.auth} credentials through the actual model resolver`, () =>
    Effect.gen(function* () {
      const llm = yield* TestLLM.Test
      const originalEnvironment = { ...process.env }
      const saved = yield* Ref.make<EnvironmentVariables.Persisted>({
        Machine: {},
        User: { SCHEDULE_TEST_KEY: keys.first },
      })
      const failRead = yield* Ref.make(false)
      const environment = EnvironmentVariables.make({
        inherited: { SCHEDULE_TEST_KEY: keys.inherited },
        persisted: Effect.gen(function* () {
          if (yield* Ref.get(failRead)) return yield* Effect.fail(new Error(keys.readFailure))
          return yield* Ref.get(saved)
        }),
      })
      expect(environment.get("SCHEDULE_TEST_KEY")).toBe(keys.inherited)

      return yield* Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const tasks = yield* ScheduleTask.Service
        const sessions = yield* Session.Service
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        const announcements: Schedule.Info[] = []
        const unsubscribe = yield* bus.listen((event) =>
          Effect.sync(() => {
            if (Schema.is(Schedule.Event.Changed)(event)) announcements.push(event.data.info)
          }),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        const task = yield* tasks.create({
          name: "Environment regression",
          prompt: "Confirm the scheduled check",
          directory: AbsolutePath.make(directory.path),
          session: mode,
          spec: { kind: "once", atMs: Date.UTC(2099, 0, 1) },
          timezone: "UTC",
          // Cover both the configured default and an explicit task model selection.
          ...(mode === "new" ? { model: selection } : {}),
        })
        // Script the response: this verifies scheduled execution and auth plumbing, not language interpretation.
        yield* llm.always(TestLLM.text("Scheduled check complete", "scheduled-check"))

        const first = yield* fire(task.id)
        expect(first.recentRuns?.[0]?.status).toBe("completed")
        expect(first.lastSessionId).toBeDefined()
        expect(yield* llm.requests()).toHaveLength(1)
        yield* assertBearer((yield* llm.requests())[0], keys.first)

        // Only the saved OS fixture changes; the graph, Location, config and service remain alive.
        yield* Ref.set(saved, { Machine: {}, User: { SCHEDULE_TEST_KEY: keys.rotated } })
        const rotated = yield* fire(task.id)
        expect(rotated.recentRuns?.[0]?.status).toBe("completed")
        expect(yield* llm.requests()).toHaveLength(2)
        yield* assertBearer((yield* llm.requests())[1], keys.rotated)
        if (mode === "reuse") expect(rotated.lastSessionId).toBe(first.lastSessionId)
        if (mode === "new") expect(rotated.lastSessionId).not.toBe(first.lastSessionId)

        // A deleted, previously observed saved key must not resurrect the stale inherited key.
        yield* Ref.set(saved, { Machine: {}, User: {} })
        const missing = yield* fire(task.id)
        expect(missing.recentRuns?.[0]?.status).toBe("failed")
        expect(missing.lastError).toBe(
          `Cannot initialize ${selection.providerID}/${selection.id}: Missing environment variable: SCHEDULE_TEST_KEY`,
        )
        expect(yield* llm.requests()).toHaveLength(2)

        yield* Ref.set(saved, { Machine: {}, User: { SCHEDULE_TEST_KEY: keys.restored } })
        const restored = yield* fire(task.id)
        expect(restored.recentRuns?.[0]?.status).toBe("completed")
        expect(restored.lastError).toBeUndefined()
        expect(yield* llm.requests()).toHaveLength(3)
        yield* assertBearer((yield* llm.requests())[2], keys.restored)
        if (mode === "reuse") expect(restored.lastSessionId).toBe(first.lastSessionId)

        yield* Ref.set(failRead, true)
        const failedRead = yield* fire(task.id)
        expect(failedRead.recentRuns?.[0]?.status).toBe("failed")
        expect(failedRead.lastError).toBe("Could not read saved environment variables.")
        expect(yield* llm.requests()).toHaveLength(3)
        if (mode === "reuse") expect(failedRead.lastSessionId).toBe(first.lastSessionId)

        const persisted = JSON.stringify({
          announcements,
          listed: yield* tasks.list(),
          fetched: yield* tasks.get(task.id),
          tasks: yield* database.db.select().from(ScheduleTaskTable).all().pipe(Effect.orDie),
          runs: yield* database.db.select().from(ScheduleRunTable).all().pipe(Effect.orDie),
        })
        Object.values(keys).forEach((key) => expect(persisted).not.toContain(key))
        expect(process.env).toEqual(originalEnvironment)
        expect((yield* sessions.list()).data).toHaveLength(mode === "reuse" ? 1 : 4)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([Session.node, SessionExecution.node, ScheduleTask.node, Bus.node, Database.node]),
            [
              Global.node.replace(tempGlobalLayer),
              offlineModels,
              Watcher.node.replace(Watcher.configured({ enabled: false })),
              EnvironmentVariables.node.replace(Layer.succeed(EnvironmentVariables.Service, environment)),
              Config.node.replace(
                Config.configured({
                  project: false,
                  global: false,
                  system: false,
                  content: JSON.stringify({
                    model: `${selection.providerID}/${selection.id}`,
                    providers: {
                      [selection.providerID]: {
                        package: "@opencode/ai/providers/openai-compatible",
                        ...(input.auth === "env-only integration" ? { env: ["SCHEDULE_TEST_KEY"] } : {}),
                        settings: {
                          ...(input.auth === "interpolated" ? { apiKey: "{env:SCHEDULE_TEST_KEY}" } : {}),
                          baseURL: "https://gateway.invalid/v1",
                        },
                        models: { [selection.id]: { limit: { context: 200_000, output: 8_192 } } },
                      },
                    },
                  }),
                }),
              ),
              InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: false, global: false })),
              llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
            ],
          ),
        ),
      )
    }),
  )
}

it.live("resolves only effective credential references across documents, models and selected variants", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const saved = yield* Ref.make<EnvironmentVariables.Persisted>({
      Machine: {},
      User: { SCHEDULE_EMPTY_KEY: "", SCHEDULE_REFRESH_KEY: keys.first },
    })
    const environment = EnvironmentVariables.make({ inherited: {}, persisted: Ref.get(saved) })
    yield* environment.refresh
    const cases: {
      name: string
      provider: ConfigProvider.Info
      lower?: ConfigProvider.Info
      variant?: Model.VariantID
      missing?: string
      authorization?: string
      apiKeyHeader?: string
      configuredHeaders?: Record<string, string>
    }[] = [
      {
        name: "prefixed-missing-key",
        provider: { settings: { apiKey: "prefix-{env:MISSING_KEY}" } },
        missing: "MISSING_KEY",
      },
      {
        name: "missing-header-with-valid-key",
        provider: { settings: { apiKey: keys.first }, headers: { "x-api-key": "{env:MISSING_HEADER}" } },
        missing: "MISSING_HEADER",
      },
      {
        name: "literal-header-in-later-document",
        lower: { headers: { Authorization: "Bearer {env:MISSING_HEADER}" } },
        provider: { settings: { apiKey: keys.first }, headers: { authorization: "Bearer fixture-literal" } },
        authorization: `Bearer ${keys.first}`,
        configuredHeaders: { authorization: "Bearer fixture-literal" },
      },
      {
        name: "model-overrides-provider-key",
        provider: {
          settings: { apiKey: "{env:MISSING_PROVIDER_KEY}" },
          models: { [selection.id]: { settings: { apiKey: keys.first } } },
        },
        authorization: `Bearer ${keys.first}`,
      },
      {
        name: "model-overrides-provider-header",
        provider: {
          settings: { apiKey: keys.first },
          headers: { "X-API-Key": "{env:MISSING_PROVIDER_HEADER}" },
          models: { [selection.id]: { headers: { "x-api-key": "fixture-model-header" } } },
        },
        authorization: `Bearer ${keys.first}`,
        apiKeyHeader: "fixture-model-header",
      },
      {
        name: "variant-overrides-model-key",
        provider: {
          settings: { apiKey: keys.first },
          models: {
            [selection.id]: {
              settings: { apiKey: "{env:MISSING_MODEL_KEY}" },
              variants: [{ id: Model.VariantID.make("selected"), settings: { apiKey: keys.rotated } }],
            },
          },
        },
        variant: Model.VariantID.make("selected"),
        authorization: `Bearer ${keys.rotated}`,
      },
      {
        name: "variant-overrides-model-header",
        provider: {
          settings: { apiKey: keys.first },
          models: {
            [selection.id]: {
              headers: { Authorization: "Bearer {env:MISSING_MODEL_HEADER}" },
              variants: [
                { id: Model.VariantID.make("selected"), headers: { authorization: "Bearer fixture-variant" } },
              ],
            },
          },
        },
        variant: Model.VariantID.make("selected"),
        authorization: `Bearer ${keys.first}`,
        configuredHeaders: { authorization: "Bearer fixture-variant" },
      },
      {
        name: "unselected-variant-does-not-poison-default",
        provider: {
          settings: { apiKey: keys.first },
          models: {
            [selection.id]: {
              variants: [
                {
                  id: Model.VariantID.make("unrelated"),
                  settings: { apiKey: "{env:MISSING_VARIANT_KEY}" },
                  headers: { "x-api-key": "{env:MISSING_VARIANT_HEADER}" },
                },
              ],
            },
          },
        },
        authorization: `Bearer ${keys.first}`,
      },
      {
        name: "empty-variable-is-missing",
        provider: { settings: { apiKey: "prefix-{env:SCHEDULE_EMPTY_KEY}" } },
        missing: "SCHEDULE_EMPTY_KEY",
      },
      {
        name: "unchanged-config-reference-metadata",
        provider: { env: ["SCHEDULE_REFRESH_KEY"] },
        authorization: `Bearer ${keys.first}`,
      },
    ]
    const file = `${directory.path}/lower.json`
    yield* Effect.promise(() =>
      Bun.write(
        file,
        JSON.stringify({
          providers: Object.fromEntries(cases.filter((item) => item.lower).map((item) => [item.name, item.lower])),
        }),
      ),
    )
    return yield* Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      return yield* Effect.gen(function* () {
        yield* Plugin.awaitActivation
        const resolver = yield* ModelResolver.Service
        const config = yield* Config.Service
        const before = yield* config.entries()
        yield* Effect.forEach(cases, (item) =>
          Effect.gen(function* () {
            const ref = { providerID: Provider.ID.make(item.name), id: selection.id, variant: item.variant }
            if (item.missing) {
              const failure = yield* resolver.resolve(ref).pipe(Effect.flip)
              expect(failure).toBeInstanceOf(ModelResolver.ModelConfigurationError)
              expect(failure.message).toBe(
                `Cannot initialize ${item.name}/${selection.id}: Missing environment variable: ${item.missing}`,
              )
              return
            }
            const resolved = yield* resolver.resolve(ref)
            if (!resolved) throw new Error(`Expected model for ${item.name}`)
            if (item.configuredHeaders)
              expect(Headers.fromInput(resolved.model.route.defaults.headers)).toMatchObject(item.configuredHeaders)
            const headers = yield* resolved.model.route.auth.apply({
              request: LLM.request({ model: resolved.model, prompt: "Check credential precedence" }),
              method: "POST",
              url: "https://gateway.invalid/v1/chat/completions",
              body: "{}",
              headers: Headers.fromInput(resolved.model.route.defaults.headers),
            })
            if (!item.authorization) throw new Error(`Expected authorization fixture for ${item.name}`)
            expect(headers.authorization).toBe(item.authorization)
            if (item.apiKeyHeader !== undefined) expect(headers["x-api-key"]).toBe(item.apiKeyHeader)
            if (item.apiKeyHeader === undefined) expect(headers["x-api-key"]).toBeUndefined()
          }),
        )

        // No interpolated value changes: only the reference metadata and env integration availability do.
        yield* Ref.set(saved, { Machine: {}, User: {} })
        yield* environment.refresh
        if (!config.refreshEnvironment) throw new Error("Expected real Config refresh")
        yield* config.refreshEnvironment()
        expect(yield* config.entries()).toEqual(before)
        yield* Effect.forEach(
          [
            { providerID: "empty-variable-is-missing", variable: "SCHEDULE_EMPTY_KEY" },
            { providerID: "unchanged-config-reference-metadata", variable: "SCHEDULE_REFRESH_KEY" },
          ],
          (item) =>
            Effect.gen(function* () {
              expect(config.missingEnvironment?.(item.providerID, selection.id)).toEqual([item.variable])
              const failure = yield* resolver
                .resolve({ providerID: Provider.ID.make(item.providerID), id: selection.id })
                .pipe(Effect.flip)
              expect(failure).toBeInstanceOf(ModelResolver.ModelConfigurationError)
              expect(failure.message).toBe(
                `Cannot initialize ${item.providerID}/${selection.id}: Missing environment variable: ${item.variable}`,
              )
            }),
        )
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))))
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LocationServiceMap.node, [
          Global.node.replace(tempGlobalLayer),
          offlineModels,
          Watcher.node.replace(Watcher.configured({ enabled: false })),
          EnvironmentVariables.node.replace(Layer.succeed(EnvironmentVariables.Service, environment)),
          Config.node.replace(
            Config.configured({
              project: false,
              global: false,
              system: false,
              file,
              content: JSON.stringify({
                providers: Object.fromEntries(
                  cases.map((item) => [
                    item.name,
                    {
                      ...item.provider,
                      package: "@opencode/ai/providers/openai-compatible",
                      settings: { baseURL: "https://gateway.invalid/v1", ...item.provider.settings },
                      models: { [selection.id]: {}, ...item.provider.models },
                    },
                  ]),
                ),
              }),
            }),
          ),
          InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: false, global: false })),
        ]),
      ),
    )
  }),
)
