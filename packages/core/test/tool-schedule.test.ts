import { expect } from "bun:test"
import path from "path"
import { LanguageModel, LLMClient } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { Config } from "@opencode/core/config"
import { Credential } from "@opencode/core/credential"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Location } from "@opencode/core/location"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { ScheduleTask } from "@opencode/core/schedule"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Tool } from "@opencode/core/tool"
import { ScheduleTools } from "@opencode/core/tool/plugin/schedule"
import { Worktree } from "@opencode/core/worktree"
import type { Context } from "@opencode/plugin/effect/plugin"
import { AbsolutePath } from "@opencode/schema/schema"
import { Schedule } from "@opencode/schema/schedule"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Clock, DateTime, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { offlineModels } from "./fixture/models"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { makePluginTestLayer, PluginTestLayer } from "./plugin/fixture"
import PROMPT from "../src/tool/schedule.txt"

const it = testEffect(PluginTestLayer)
const sessionID = Session.ID.make("ses_schedule_tool")
const messageID = SessionMessage.ID.make("msg_schedule_tool")
const providerID = Provider.ID.make("scheduler")
const modelID = Model.ID.make("reasoner")
const variant = Model.VariantID.make("deep")
const base = {
  prompt: "Prepare the report",
  spec: { kind: "daily", hour: 9, minute: 15 },
  timezone: "America/New_York",
}

const catalog = Effect.gen(function* () {
  const providers = yield* Provider.Service
  const agents = yield* Agent.Service
  yield* providers.transform((editor) => {
    editor.list().forEach((definition) => editor.remove(definition.provider.id))
    editor.add({
      info: { ...Provider.Info.empty(providerID), activation: "enabled" },
      models: [
        {
          ...Model.Info.default(providerID, modelID),
          name: "Careful Reasoner",
          variants: [{ id: variant, settings: {} }],
        },
        { ...Model.Info.default(providerID, Model.ID.make("fast")), name: "Quick Chat" },
      ],
    })
    editor.add({
      info: { ...Provider.Info.empty(Provider.ID.make("unavailable")), activation: "disabled" },
      models: [Model.Info.default(Provider.ID.make("unavailable"), modelID)],
    })
  })
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.name = Agent.Name.make("Builder")
      agent.mode = "primary"
    })
    editor.update(Agent.ID.make("both"), (agent) => {
      agent.mode = "all"
    })
    editor.update(Agent.ID.make("hidden"), (agent) => {
      agent.hidden = true
    })
    editor.update(Agent.ID.make("worker"), (agent) => {
      agent.mode = "subagent"
    })
  })
})

const setup = Effect.gen(function* () {
  const plugins = yield* Plugin.Service
  const ctx = yield* PluginHost.make(plugins)
  yield* catalog
  yield* ScheduleTools.Plugin.effect(ctx)
  const tools = yield* Tool.Service
  return { ctx, tools, tasks: yield* ScheduleTask.Service }
})

const invoke = (tools: Tool.Interface, name: "schedule_create" | "schedule_options", input: unknown) =>
  tools.snapshot().pipe(
    Effect.flatMap((snapshot) =>
      snapshot.execute({
        sessionID,
        agent: Agent.ID.make("build"),
        messageID,
        call: {
          type: "tool-call",
          id: "call_schedule",
          name: "execute",
          input: {
            code: `return await tools.opencode.${name}(${JSON.stringify(input)})`,
          },
        },
      }),
    ),
  )

const output = (result: Tool.NormalizedResult) => {
  const value = Schema.decodeUnknownSync(
    Schema.Struct({ output: Schema.String, error: Schema.optionalKey(Schema.Boolean) }),
  )(result.output)
  expect(value.error ? value.output : undefined).toBeUndefined()
  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(value.output)
}

const integration = testEffect(TestLLM.testLayer())

integration.live("Session.command runs /schedule through the runner and Code Mode before confirming the saved task", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLM.Test
    const model = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "schedule-model", provider: "test", route: OpenAIChat.route }),
      {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 8_192 },
      },
    )
    return yield* Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const sessions = yield* Session.Service
      const execution = yield* SessionExecution.Service
      const tasks = yield* ScheduleTask.Service
      const bus = yield* Bus.Service
      const session = yield* sessions.create({
        title: "Schedule integration",
        location: { directory: AbsolutePath.make(directory.path) },
        agent: Agent.ID.make("build"),
        model: model.ref,
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      })
      const input = {
        name: "Report review",
        prompt: "Review the report",
        spec: { kind: "once", atMs: Date.UTC(2099, 0, 2, 14, 15) },
        timezone: "America/New_York",
        agentId: "plan",
        session: "new",
      }
      const request = [
        "[Schedule request context]",
        "Timezone: America/New_York",
        "Requested at: 2026-10-23T16:00:00.000Z",
        "[/Schedule request context]",
        "",
        "On January 2, 2099 at 9:15 AM, review the report. Name it Report review and use the plan agent in a fresh session.",
      ].join("\n")
      const confirmation =
        "Saved Report review for January 2, 2099 at 9:15 AM America/New_York in this project, using the plan agent and default model in a new session. You can edit it in Scheduled Prompts. The server must be running."
      // Script the model decision: this verifies routing and persistence, not natural-language interpretation.
      yield* llm.push(
        TestLLM.tool("call_schedule_integration", "execute", {
          code: `return await tools.opencode.schedule_create(${JSON.stringify(input)})`,
        }),
        TestLLM.text(confirmation, "schedule-confirmation"),
      )
      const terminal = yield* Deferred.make<string>()
      const unsubscribe = yield* bus.listen((event) =>
        (Schema.is(SessionEvent.Execution.Succeeded)(event) ||
          Schema.is(SessionEvent.Execution.Failed)(event) ||
          Schema.is(SessionEvent.Execution.Interrupted)(event)) &&
        event.data.sessionID === session.id
          ? Deferred.succeed(terminal, event.type).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      // The real command wakes SessionExecution itself; observe its terminal event instead of racing a second resume.
      yield* sessions.command({ sessionID: session.id, command: "schedule", text: request })
      expect(yield* Deferred.await(terminal).pipe(Effect.timeout("10 seconds"))).toBe("session.execution.succeeded")
      yield* execution.awaitIdle(session.id)

      const requests = yield* llm.requests()
      expect(requests).toHaveLength(2)
      const text = requests[0]?.messages
        .flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
        .join("\n")
      expect(text).toContain(PROMPT)
      expect(text).toContain(request)
      expect(text).toContain(`Default project directory: ${session.location.directory}`)
      expect(requests[0]?.tools).toContainEqual(expect.objectContaining({ name: "execute" }))
      const saved = yield* tasks.list()
      expect(saved).toHaveLength(1)
      const task = saved[0]
      if (!task) throw new Error("Expected a persisted schedule task")
      expect(task).toMatchObject({
        ...input,
        directory: session.location.directory,
        enabled: true,
        nextRunAtMs: input.spec.atMs,
        runCount: 0,
      })
      expect(task.model).toBeUndefined()
      expect(task.lastSessionId).toBeUndefined()
      expect(task.lastRunAtMs).toBeUndefined()
      expect(task.recentRuns).toBeUndefined()
      expect(yield* tasks.get(task.id)).toEqual(task)
      expect(JSON.stringify(requests[1]?.messages)).toContain(task.id)
      expect((yield* sessions.list()).data.map((entry) => entry.id)).toEqual([session.id])
      expect(yield* sessions.get(session.id)).toMatchObject({ agent: session.agent, model: session.model })
      const messages = yield* sessions.messages({ sessionID: session.id, order: "asc" })
      expect(messages.flatMap((message) => (message.type === "assistant" ? message.content : []))).toContainEqual(
        expect.objectContaining({
          type: "tool",
          name: "execute",
          state: expect.objectContaining({
            status: "completed",
            metadata: expect.objectContaining({
              toolCalls: [expect.objectContaining({ tool: "opencode.schedule_create", status: "completed" })],
            }),
          }),
        }),
      )
      expect(messages.findLast((message) => message.type === "assistant")).toMatchObject({
        type: "assistant",
        content: [{ type: "text", text: confirmation }],
      })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Session.node, SessionExecution.node, ScheduleTask.node, Bus.node]), [
          Global.node.replace(tempGlobalLayer),
          offlineModels,
          Watcher.node.replace(Watcher.configured({ enabled: false })),
          Config.node.replace(Config.configured({ project: false, global: false })),
          InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: false, global: false })),
          llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
          SessionRunnerModel.node.replace(
            Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) }),
          ),
        ]),
      ),
    )
  }),
)

it.live(
  "schedule command submits instructions with intact request context, attachments, and delivery without creating tasks",
  () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const ctx = yield* PluginHost.make(plugins)
      const commands = yield* Command.Service
      const tasks = yield* ScheduleTask.Service
      const prompts: Parameters<Context["session"]["prompt"]>[0][] = []
      yield* ScheduleTools.Plugin.effect({
        ...ctx,
        session: {
          ...ctx.session,
          prompt: (input) =>
            Effect.sync(() => {
              prompts.push(input)
              return SessionInbox.User.make({
                id: messageID,
                sessionID,
                type: "user",
                delivery: input.delivery ?? "steer",
                time: { created: DateTime.makeUnsafe(0) },
                payload: { text: input.text },
              })
            }),
        },
      })
      expect(yield* commands.get("schedule")).toMatchObject({
        name: "schedule",
        description: expect.stringContaining("scheduled prompt"),
      })
      const request =
        "[Schedule request context]\nTimezone: Pacific/Auckland\nRequested at: 2026-10-23T10:15:00.000Z\n[/Schedule request context]\n\nTomorrow at 9, review $& $$ $` $'"
      const before = yield* Clock.currentTimeMillis
      yield* commands.execute({
        name: "schedule",
        invocation: {
          sessionID,
          prompt: { text: request, files: [{ uri: "file:///report.md" }] },
          delivery: "queue",
        },
      })
      yield* commands.execute({ name: "schedule", invocation: { sessionID, prompt: { text: "" }, delivery: "steer" } })
      const after = yield* Clock.currentTimeMillis
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toMatchObject({ sessionID, files: [{ uri: "file:///report.md" }], delivery: "queue" })
      expect(prompts[0]?.text).toStartWith(PROMPT)
      expect(prompts[0]?.text).toEndWith(`Schedule request:\n\n${request}`)
      expect(prompts[0]?.text).toContain(`Default project directory: ${ctx.location.directory}`)
      expect(prompts[0]?.text).toContain(
        `Fallback timezone (only if no desktop context is supplied): ${Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}`,
      )
      const timestamp = prompts[0]?.text.match(/Current server time: (.+)/)?.[1]
      expect(timestamp).toBeDefined()
      expect(Date.parse(timestamp ?? "")).toBeGreaterThanOrEqual(before)
      expect(Date.parse(timestamp ?? "")).toBeLessThanOrEqual(after)
      expect(prompts[1]).toMatchObject({ sessionID, delivery: "steer" })
      expect(prompts[1]?.text).toEndWith("Schedule request:\n\n")
      expect(yield* tasks.list()).toEqual([])
    }),
)

it.live(
  "schedule_create through Code Mode persists every dialog field and announces the saved task without executing it",
  () =>
    Effect.gen(function* () {
      const prepared = yield* setup
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service
      const events: (typeof Schedule.Event.Changed.Type)[] = []
      const unsubscribe = yield* bus.listen((event) =>
        Effect.sync(() => {
          if (Schema.is(Schedule.Event.Changed)(event)) events.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const input = {
        ...base,
        name: "Weekly report",
        directory: prepared.ctx.location.directory,
        spec: { kind: "weekly", days: [1, 3, 5], hour: 9, minute: 15 },
        session: "new",
        agentId: "build",
        model: { providerID, id: modelID, variant },
      }
      const result = yield* invoke(prepared.tools, "schedule_create", input)
      const info = Schema.decodeUnknownSync(Schedule.Info)(output(result))
      expect(info).toMatchObject({ ...input, enabled: true, runCount: 0 })
      expect(info.nextRunAtMs).toBeGreaterThan(Date.now())
      expect(info.lastSessionId).toBeUndefined()
      expect(info.lastRunAtMs).toBeUndefined()
      expect(info.recentRuns).toBeUndefined()
      expect(yield* prepared.tasks.get(info.id)).toEqual(info)
      expect(yield* prepared.tasks.list()).toEqual([info])
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: "schedule.changed",
        location: { directory: info.directory },
        data: { info },
      })
      expect((yield* sessions.list({})).data).toEqual([])
      expect(result.metadata).toMatchObject({ toolCalls: [{ tool: "opencode.schedule_create", status: "completed" }] })
    }),
)

it.live(
  "schedule_create defaults to the current project and task-owned reuse session without agent or model overrides",
  () =>
    Effect.gen(function* () {
      const prepared = yield* setup
      const info = Schema.decodeUnknownSync(Schedule.Info)(
        output(yield* invoke(prepared.tools, "schedule_create", base)),
      )
      expect(info).toMatchObject({
        ...base,
        directory: prepared.ctx.location.directory,
        session: "reuse",
        enabled: true,
        runCount: 0,
      })
      expect(info).not.toHaveProperty("agentId")
      expect(info).not.toHaveProperty("model")
      expect(info).not.toHaveProperty("lastSessionId")
      expect(yield* prepared.tasks.get(info.id)).toEqual(info)
    }),
)

it.live(
  "schedule_options lists eligible agents and available models and variants with case-insensitive multi-term matching",
  () =>
    Effect.gen(function* () {
      const prepared = yield* setup
      const all = {
        directory: prepared.ctx.location.directory,
        agents: [
          { id: "build", name: "Builder" },
          { id: "both", name: "both" },
        ],
        models: [
          { ref: { providerID, id: modelID }, name: "Careful Reasoner", variants: [variant] },
          { ref: { providerID, id: "fast" }, name: "Quick Chat", variants: [] },
        ],
      }
      expect(output(yield* invoke(prepared.tools, "schedule_options", {}))).toEqual(all)
      expect(output(yield* invoke(prepared.tools, "schedule_options", { query: "  SCHEDULER  careful " }))).toEqual({
        ...all,
        models: [all.models[0]],
      })
      expect(output(yield* invoke(prepared.tools, "schedule_options", { query: "FAST" }))).toEqual({
        ...all,
        models: [all.models[1]],
      })
      expect(output(yield* invoke(prepared.tools, "schedule_options", { query: "no such model" }))).toEqual({
        ...all,
        models: [],
      })
    }),
)

it.live("invalid schedule inputs and unavailable catalog selections never create a task", () =>
  Effect.gen(function* () {
    const prepared = yield* setup
    const cases = [
      { patch: { model: { providerID, id: "missing" } }, error: "not available" },
      { patch: { model: { providerID, id: modelID, variant: "missing" } }, error: "Variant" },
      { patch: { model: { providerID: "unavailable", id: modelID } }, error: "not available" },
      { patch: { agentId: "hidden" }, error: "not available" },
      { patch: { agentId: "worker" }, error: "not available" },
      { patch: { agentId: "missing" }, error: "not available" },
      { patch: { prompt: " \n\t " }, error: "" },
      { patch: { spec: { kind: "once", atMs: 1 } }, error: "already passed" },
      { patch: { spec: { kind: "cron", expr: "not a cron" } }, error: "" },
      { patch: { timezone: "Invalid/Timezone" }, error: "" },
      { patch: { timezone: undefined }, error: "timezone" },
      { patch: { directory: path.join(prepared.ctx.location.directory, "missing") }, error: "does not exist" },
    ]
    yield* Effect.forEach(cases, (scenario) =>
      Effect.gen(function* () {
        const result = yield* invoke(prepared.tools, "schedule_create", { ...base, ...scenario.patch })
        expect(result.output).toMatchObject({ error: true, output: expect.stringContaining(scenario.error) })
        expect(yield* prepared.tasks.list()).toEqual([])
      }),
    )
  }),
)

const denied = testEffect(
  makePluginTestLayer(
    Layer.mock(Permission.Service, {
      assert: (input) =>
        Effect.gen(function* () {
          expect(input).toMatchObject({
            action: "schedule",
            sessionID,
            agent: "build",
            resources: [expect.any(String)],
            save: input.resources,
            source: { type: "tool", messageID, id: "call_schedule" },
          })
          return yield* new Permission.BlockedError({ permission: "schedule", resources: ["*"], rules: [] })
        }),
    }),
  ),
)

denied.live("schedule_create enforces its leaf permission even when the tool is visible", () =>
  Effect.gen(function* () {
    const prepared = yield* setup
    const result = yield* invoke(prepared.tools, "schedule_create", base)
    expect(result.output).toMatchObject({ error: true, output: expect.stringContaining("Permission denied: schedule") })
    expect(yield* prepared.tasks.list()).toEqual([])
  }),
)

const projects = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Credential.node,
      KV.node,
      Session.node,
      PersistentPty.node,
      Worktree.node,
      ScheduleTask.node,
      LocationServiceMap.node,
      FSUtil.node,
    ]),
    [
      offlineModels,
      Watcher.node.replace(Watcher.testLayer),
      Permission.node.replace(Layer.mock(Permission.Service, { assert: () => Effect.void })),
    ],
  ),
)

projects.live("PluginHost model.list uses the target project's catalog and waits for its pending activation", () =>
  Effect.gen(function* () {
    const current = yield* tmpdirScoped()
    const other = yield* tmpdirScoped()
    const locations = yield* LocationServiceMap.Service
    return yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const ctx = yield* PluginHost.make(plugins)
      const ref = Location.Ref.make({ directory: AbsolutePath.make(other.path) })
      const target = yield* locations.contextEffect(ref)
      const targetPlugins = yield* Plugin.Service.pipe(Effect.provideContext(target))
      const targetLocation = yield* Location.Service.pipe(Effect.provideContext(target))
      yield* targetPlugins.awaitActivation
      yield* catalog
      const release = yield* targetPlugins.hold()
      const completed = yield* Deferred.make<void>()
      const read = yield* ctx.model.list({ location: ref }).pipe(
        Effect.tap(() => Deferred.succeed(completed, undefined)),
        Effect.forkScoped({ startImmediately: true }),
      )
      expect(yield* Deferred.isDone(completed)).toBe(false)
      const providers = yield* Provider.Service.pipe(Effect.provideContext(target))
      yield* providers.transform((editor) => {
        editor.list().forEach((definition) => editor.remove(definition.provider.id))
        editor.add({
          info: { ...Provider.Info.empty(Provider.ID.make("target")), activation: "enabled" },
          models: [Model.Info.default(Provider.ID.make("target"), Model.ID.make("target-only"))],
        })
      })
      yield* release
      const result = yield* Fiber.join(read)
      expect(result.location.directory).toBe(targetLocation.directory)
      expect(result.data.map((model) => `${model.providerID}/${model.id}`)).toEqual(["target/target-only"])
      expect((yield* ctx.model.list()).data.map((model) => String(model.id))).toEqual([modelID, "fast"])
      yield* ScheduleTools.Plugin.effect(ctx)
      const tools = yield* Tool.Service
      expect(
        output(yield* invoke(tools, "schedule_options", { directory: ref.directory, query: "target" })),
      ).toMatchObject({
        directory: ref.directory,
        models: [{ ref: { providerID: "target", id: "target-only" }, variants: [] }],
      })
      const input = { ...base, directory: ref.directory, model: { providerID: "target", id: "target-only" } }
      const info = Schema.decodeUnknownSync(Schedule.Info)(output(yield* invoke(tools, "schedule_create", input)))
      expect(info).toMatchObject(input)
      expect(output(yield* invoke(tools, "schedule_options", { query: "target" }))).toMatchObject({ models: [] })
    }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(current.path) }))))
  }),
)
