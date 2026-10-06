export * as PromptRunner from "./executor"

import { Context, Effect } from "effect"
import type { Agent } from "@opencode-ai/schema/agent"
import type { Model } from "@opencode-ai/schema/model"
import type { Session } from "@opencode-ai/schema/session"
import { LayerNode } from "../effect/layer-node"
import { Node } from "../effect/app-node"

export interface RunInput {
  readonly directory: string
  readonly title: string
  readonly promptText: string
  readonly agentId?: Agent.ID
  readonly model?: Model.Ref
}

export interface Interface {
  /**
   * Runs one scheduled prompt through the V1 session engine. Resolves to the created
   * session ID only after execution completes; core forks this effect so tick loops
   * are never blocked.
   */
  readonly run: (input: RunInput) => Effect.Effect<Session.ID, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SchedulePromptRunner") {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)
