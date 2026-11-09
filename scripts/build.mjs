// Cross-platform build: copies the server-side files into dist/ and bundles the desktop UI with vite.
//   node scripts/build.mjs [--server-only]    (--server-only skips the vite step)

import { cp, mkdir, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const root = join(dirname(fileURLToPath(import.meta.url)), "..")
export const SERVER_FILES = ["server.js", "rpc.js", "schedule.js", "notify.js", "paths.js"]

export async function build({ serverOnly = false, quiet = false, outDir } = {}) {
  const dist = outDir ?? join(root, "dist")
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  for (const file of SERVER_FILES) await cp(join(root, "src", file), join(dist, file))
  if (!quiet) console.log(`copied ${SERVER_FILES.join(", ")} to dist/`)
  if (serverOnly) return dist

  const require = createRequire(join(root, "package.json"))
  let vite
  try {
    vite = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js")
  } catch {
    throw new Error("vite isn't installed; run `npm install` first")
  }
  const result = spawnSync(process.execPath, [vite, "build"], { cwd: root, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`vite build failed (exit ${result.status ?? result.signal})`)
  return dist
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build({ serverOnly: process.argv.includes("--server-only") }).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
