import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

export const GlobalAutoApprove = Schema.Struct({ enabled: Schema.Boolean }).annotate({ identifier: "GlobalAutoApprove" })

export const GlobalGroup = HttpApiGroup.make("server.global")
  .add(
    HttpApiEndpoint.get("global.autoApprove.get", "/global/permissions/auto-approve", {
      success: GlobalAutoApprove,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "global.auto-approve.get",
          summary: "Get global permission auto-accept",
          description: "Read whether this server automatically accepts permission requests for all sessions.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("global.autoApprove.set", "/global/permissions/auto-approve", {
      payload: GlobalAutoApprove,
      success: GlobalAutoApprove,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "global.auto-approve.set",
          summary: "Set global permission auto-accept",
          description: "Enable or disable automatic permission acceptance for interactive and scheduled sessions on this server.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server settings." }))
