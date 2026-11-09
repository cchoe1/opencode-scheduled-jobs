// Builds the plugin and copies dist/ into the OpenCode config's plugins directory.
//   node scripts/install.mjs [--dir <plugin directory>] [--server-only]
// Destination, first match wins:
//   --dir <path>               the plugin directory itself
//   $OPENCODE_CONFIG_DIR       the OpenCode config directory (the plugin goes in <it>/plugins/scheduler)
//   <home>/.config/opencode/plugins/scheduler   (on every OS)

import { cp, mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "./build.mjs"

export function destination(args = process.argv.slice(2), env = process.env) {
  const i = args.indexOf("--dir")
  if (i >= 0) {
    if (!args[i + 1]) throw new Error("--dir needs a path")
    return resolve(args[i + 1])
  }
  const config = env.OPENCODE_CONFIG_DIR ? resolve(env.OPENCODE_CONFIG_DIR) : join(homedir(), ".config", "opencode")
  return join(config, "plugins", "scheduler")
}

export async function install(args = process.argv.slice(2), env = process.env, buildOptions = {}) {
  const target = destination(args, env)
  const dist = await build({ serverOnly: args.includes("--server-only"), ...buildOptions })
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await cp(dist, target, { recursive: true })
  console.log(`\nInstalled to ${target}`)
  console.log('Make sure opencode.jsonc has:\n  "plugins": [{ "package": "./plugins/scheduler" }]')
  console.log("Options go next to it, e.g. { \"package\": \"./plugins/scheduler\", \"options\": { \"stateDir\": \"...\", \"history\": 200 } }")
  console.log("Restart OpenCode to load the new version.")
  return target
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  install().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
