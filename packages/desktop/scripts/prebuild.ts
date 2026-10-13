#!/usr/bin/env bun
import { $ } from "bun"

import { copyBuiltCliToResources, downloadCliToResources, getCurrentCli, resolveChannel } from "./utils"

const channel = resolveChannel()

if (channel === "prod" && !Bun.env.OPENCODE_CLI_DIST) {
  throw new Error("OPENCODE_CLI_DIST is required for production desktop builds")
}

await $`bun ./scripts/copy-icons.ts ${channel}`

await $`bun ./scripts/copy-metainfo.ts ${channel}`

if (Bun.env.OPENCODE_CLI_DIST) {
  await copyBuiltCliToResources(Bun.env.OPENCODE_CLI_DIST)
}

// Development desktop builds embed the local web UI in the CLI; release CLIs carry the same archive.
if (channel === "dev" && !Bun.env.OPENCODE_CLI_DIST) {
  const target = getCurrentCli().package.replace("@opencode/cli-", "opencode-")
  await $`bun run --cwd ../cli build ${`--target=${target}`} --skip-install`.env({
    ...process.env,
    OPENCODE_CHANNEL: channel,
  })
  await copyBuiltCliToResources("../cli/dist")
}

if (channel === "beta" && !Bun.env.OPENCODE_CLI_DIST) await downloadCliToResources("beta")
