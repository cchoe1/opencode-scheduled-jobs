import assert from "node:assert/strict"
import { mkdtemp, readdir, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build, SERVER_FILES } from "../scripts/build.mjs"
import { destination, install } from "../scripts/install.mjs"
import { defaultStateDir, resolveStateDir, logFile } from "../src/paths.js"

let n = 0
const t = async (name, fn) => (await fn(), n++, console.log("ok", name))

await t("build copies the server files", async () => {
  const out = join(await mkdtemp(join(tmpdir(), "sched-build-")), "dist")
  await build({ serverOnly: true, quiet: true, outDir: out })
  const files = (await readdir(out)).sort()
  assert.deepEqual(files, [...SERVER_FILES].sort())
  for (const f of ["server.js", "rpc.js", "schedule.js", "notify.js", "paths.js"]) assert.ok(files.includes(f))
})

await t("install destination", () => {
  assert.equal(destination(["--dir", "/x/y"], {}), "/x/y")
  assert.equal(destination([], { OPENCODE_CONFIG_DIR: "/cfg" }), join("/cfg", "plugins", "scheduler"))
  assert.match(destination([], {}), /\.config[\\/]opencode[\\/]plugins[\\/]scheduler$/)
})

await t("install replaces the old copy", async () => {
  const base = await mkdtemp(join(tmpdir(), "sched-install-"))
  const target = join(base, "plugins", "scheduler")
  await mkdir(target, { recursive: true })
  await writeFile(join(target, "stale.js"), "old")
  await install(["--dir", target, "--server-only"], {}, { outDir: join(base, "dist"), quiet: true })
  const files = await readdir(target)
  assert.ok(files.includes("server.js") && !files.includes("stale.js"))
})

await t("state dir paths", () => {
  assert.equal(defaultStateDir({ XDG_STATE_HOME: "/s" }, "linux", "/h"), join("/s", "opencode-scheduler"))
  assert.equal(defaultStateDir({}, "darwin", "/h"), join("/h", ".local", "state", "opencode-scheduler"))
  assert.equal(defaultStateDir({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\h"), join("C:\\L", "opencode-scheduler"))
  assert.equal(resolveStateDir("~/x", {}, "linux", "/h"), join("/h", "x"))
  assert.equal(resolveStateDir("/abs", {}, "linux", "/h"), "/abs")
  assert.equal(logFile("/s", "../evil"), join("/s", "logs", ".._evil.json"))
})

console.log(`scripts: ${n} passed`)
