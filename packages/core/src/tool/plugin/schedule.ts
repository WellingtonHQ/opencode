export * as ScheduleTools from "./schedule.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { AbsolutePath, optional } from "@opencode/schema/schema"
import { Schedule } from "@opencode/schema/schedule"
import { FSUtil } from "@opencode/util/fs-util"
import { Clock, Effect, Schema } from "effect"
import { Permission } from "../../permission.js"
import { ScheduleTask } from "../../schedule.js"
import PROMPT from "../schedule.txt"

const OptionsInput = Schema.Struct({
  directory: AbsolutePath.pipe(optional).annotate({ description: "Project directory. Defaults to the current project." }),
  query: Schema.String.pipe(optional).annotate({ description: "Filter model names and IDs. Omit to list all models." }),
})

const OptionsOutput = Schema.Struct({
  directory: AbsolutePath,
  agents: Schema.Array(Schema.Struct({ id: Agent.ID, name: Agent.Name })),
  models: Schema.Array(Schema.Struct({ ref: Model.Ref, name: Schema.String, variants: Schema.Array(Model.VariantID) })),
})

const CreateInput = Schema.Struct({
  ...Schedule.CreateInput.fields,
  prompt: Schema.Trim.check(Schema.isNonEmpty()).annotate({ description: "Instructions to execute later, not now." }),
  directory: AbsolutePath.pipe(optional).annotate({ description: "Project directory. Defaults to the current project." }),
  timezone: Schedule.TimeZone.annotate({ description: "Explicit IANA timezone from the request or desktop context." }),
})

export const Plugin = {
  id: "opencode.tool.schedule",
  effect: Effect.fn("ScheduleTools.Plugin")(function* (ctx: Context) {
    const tasks = yield* ScheduleTask.Service
    const permission = yield* Permission.Service
    const fs = yield* FSUtil.Service

    const catalog = Effect.fn("ScheduleTools.catalog")(function* (directory: AbsolutePath) {
      if (!(yield* fs.isDir(directory)))
        return yield* new ToolFailure({ message: `Project directory does not exist or is inaccessible: ${directory}` })
      const agents = yield* ctx.agent.list({ location: { directory } })
      const models = yield* ctx.model.list({ location: { directory } })
      return { agents: agents.data, models: models.data }
    })

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "schedule",
        description: "create a scheduled prompt from natural language",
        execute: (input) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            yield* ctx.session.prompt({
              ...input.prompt,
              sessionID: input.sessionID,
              text: [
                PROMPT,
                `Current server time: ${new Date(now).toISOString()}`,
                `Fallback timezone (only if no desktop context is supplied): ${Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}`,
                `Default project directory: ${ctx.location.directory}`,
                "Schedule request:",
                input.prompt.text,
              ].join("\n\n"),
              delivery: input.delivery,
            })
          }).pipe(Effect.asVoid),
      })
    })

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "schedule_options",
        options: { namespace: "opencode", codemode: true },
        description:
          "Look up exact agent IDs, model references, and model variants for a scheduled prompt's project. Never guess IDs.",
        input: OptionsInput,
        output: OptionsOutput,
        execute: (input) =>
          Effect.gen(function* () {
            const directory = input.directory ?? ctx.location.directory
            const available = yield* catalog(directory)
            const terms = input.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
            return {
              output: {
                directory,
                agents: available.agents
                  .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
                  .map((agent) => ({ id: agent.id, name: agent.name })),
                models: available.models
                  .filter((model) =>
                    terms.every((term) => `${model.providerID}/${model.id} ${model.name}`.toLowerCase().includes(term)),
                  )
                  .map((model) => ({
                    ref: { providerID: model.providerID, id: model.id },
                    name: model.name,
                    variants: model.variants.map((variant) => variant.id),
                  })),
              },
            }
          }).pipe(Effect.mapError(failure)),
      })
      editor.add({
        name: "schedule_create",
        options: { namespace: "opencode", codemode: true, permission: "schedule" },
        description:
          "Create and enable a scheduled prompt directly. Supports once, daily, weekly, or five-field cron schedules and every schedule-dialog option. Ask questions only for missing or ambiguous essentials; do not ask for an extra confirmation. This saves a task without running its prompt now. Returns the saved task including its next run time. Use schedule_options to resolve requested agents, models, and variants first. Omit agentId and model unless requested; reuse is the default session mode and means the task's own shared session, not the current conversation.",
        input: CreateInput,
        output: Schedule.Info,
        execute: (input, context) =>
          Effect.gen(function* () {
            const directory = input.directory ?? ctx.location.directory
            yield* permission.assert({
              action: "schedule",
              resources: [directory],
              save: [directory],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            const available = yield* catalog(directory)
            if (
              input.agentId !== undefined &&
              !available.agents.some((agent) => agent.id === input.agentId && agent.mode !== "subagent" && !agent.hidden)
            )
              return yield* new ToolFailure({
                message: `Agent "${input.agentId}" is not available for ${directory}. Use schedule_options.`,
              })
            if (input.model !== undefined) {
              const ref = input.model
              const model = available.models.find((model) => model.providerID === ref.providerID && model.id === ref.id)
              if (!model)
                return yield* new ToolFailure({
                  message: `Model "${ref.providerID}/${ref.id}" is not available for ${directory}. Use schedule_options.`,
                })
              if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant))
                return yield* new ToolFailure({
                  message: `Variant "${ref.variant}" is not available for ${ref.providerID}/${ref.id}. Use schedule_options.`,
                })
            }
            const output = yield* tasks.create({ ...input, directory })
            return { output }
          }).pipe(Effect.mapError(failure)),
      })
    })
  }),
}

function failure(error: unknown) {
  return new ToolFailure({ message: error instanceof Error ? error.message : "Unable to prepare scheduled prompt", error })
}
