import { AppState } from "@opencode-ai/core/app-state"
import { EventV2 } from "@opencode-ai/core/event"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { PromptRunner } from "@opencode-ai/core/schedule/executor"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { InstanceStore } from "@/project/instance-store"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Effect, Layer } from "effect"
import * as Stream from "effect/Stream"

const layer = Layer.effect(
  PromptRunner.Service,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const permission = yield* Permission.Service
    const events = yield* EventV2.Service
    const appState = yield* AppState.Service

    // Replies "always" to every permission request raised by the given session until the surrounding scope closes.
    const autoApprove = Effect.fn("SchedulePromptRunner.autoApprove")(function* (sessionID) {
      yield* events
        .subscribe(PermissionV1.Event.Asked)
        .pipe(
          Stream.filter((event) => event.data.sessionID === sessionID),
          Stream.runForEach((event) =>
            permission.reply({ requestID: event.data.id, reply: "always" }).pipe(
              // A client may have answered first; the request is already resolved.
              Effect.catchTag("Permission.NotFoundError", () => Effect.void),
            ),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
    })

    const run = Effect.fn("SchedulePromptRunner.run")(function* (input) {
      // V1 services are instance-scoped; providing the task's directory loads its project and location.
      return yield* store.provide(
        { directory: input.directory },
        Effect.scoped(
          Effect.gen(function* () {
            const enabled = yield* appState.autoApprove()
            const session = yield* sessions.create({
              title: input.title,
              ...(input.agentId ? { agent: input.agentId } : {}),
              ...(input.model
                ? {
                    model: {
                      id: input.model.id,
                      providerID: input.model.providerID,
                      ...(input.model.variant ? { variant: input.model.variant } : {}),
                    },
                  }
                : {}),
            })
            if (enabled) yield* autoApprove(session.id)
            yield* prompts.prompt({
              sessionID: session.id,
              ...(input.agentId ? { agent: input.agentId } : {}),
              ...(input.model ? { model: { providerID: input.model.providerID, modelID: input.model.id } } : {}),
              parts: [{ type: "text", text: input.promptText }],
            })
            return session.id
          }),
        ),
      )
    })

    return PromptRunner.Service.of({ run })
  }),
)

export const node = makeGlobalNode({
  service: PromptRunner.Service,
  layer,
  deps: [InstanceStore.node, Session.node, SessionPrompt.node, Permission.node, EventV2.node, AppState.node],
})

export * as SchedulePromptRunner from "./prompt-runner"
