#!/usr/bin/env bun
import { $ } from "bun"
import { exists } from "node:fs/promises"
import path from "node:path"
import { copyBuiltCliToResources, downloadCliToResources, getCurrentCli, resolveChannel } from "./utils"
import { verifyBundles } from "./verify-bundles"

// Prepares resources/ (icons, metainfo, the bundled CLI) for OPENCODE_CHANNEL and builds the app into out/.
// The CLI comes from OPENCODE_CLI_DIST or ../cli/dist. Dev builds a missing local CLI so the embedded web UI
// matches this checkout; beta can download its published CLI, while prod requires a built CLI.
const dir = path.resolve(import.meta.dir, "..")

const cli = path.resolve(dir, Bun.env.OPENCODE_CLI_DIST ?? "../cli/dist")

const channel = resolveChannel()

process.chdir(dir)

await $`bun ./script/copy-icons.ts ${channel}`

await $`bun ./script/copy-metainfo.ts ${channel}`

if (channel === "dev" && !Bun.env.OPENCODE_CLI_DIST && !(await exists(path.join(cli, getCurrentCli().package.replace("@opencode/", ""))))) {
  const target = getCurrentCli().package.replace("@opencode/cli-", "opencode-")
  await $`bun run --cwd ../cli build ${`--target=${target}`} --skip-install`.env({
    ...process.env,
    OPENCODE_CHANNEL: channel,
  })
}

const built = await exists(path.join(cli, getCurrentCli().package.replace("@opencode/", "")))

if ((channel === "prod" || Bun.env.OPENCODE_CLI_DIST) && !built)
  throw new Error(`Desktop build requires the CLI from ${cli}; build it first`)

if (built) await copyBuiltCliToResources(cli)

if (!built) await downloadCliToResources(channel === "beta" ? "beta" : undefined)

await $`bunx electron-vite build`

await verifyBundles(path.join(dir, "out"))
