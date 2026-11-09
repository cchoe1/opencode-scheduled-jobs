// Upgrading or reloading the plugin inside a running OpenCode process: the shared state object left by an older
// version (v1 had fewer fields and its own loop timer) must not break the new version.
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const STATE = Symbol.for("local.scheduler")
let oldTicks = 0
const oldTimer = setInterval(() => oldTicks++, 5)
// What v1 left behind.
globalThis[STATE] = { contexts: new Set([{}]), registrations: new Set(), timer: oldTimer, busy: false }

const { default: plugin } = await import("../src/server.js")
const stateDir = await mkdtemp(join(tmpdir(), "sched-upgrade-"))
let handlers
const ctx = {
  options: { stateDir, tickSeconds: 3600, noAutoTick: true },
  location: { directory: "/proj" },
  tool: { transform: async () => ({ dispose: async () => {} }) },
  rpc: {
    register: async (_def, h) => {
      handlers = h
      return { events: { emit: async () => {} }, dispose: async () => {} }
    },
  },
  session: {},
}
const cleanup = await plugin.setup(ctx)

const shared = globalThis[STATE]
assert.ok(shared.statuses instanceof Map, "missing fields are filled in")
assert.ok(shared.cache instanceof Map)
assert.notEqual(shared.timer, oldTimer, "the old loop timer is replaced")
const before = oldTicks
await new Promise((r) => setTimeout(r, 30))
assert.equal(oldTicks, before, "the old loop no longer runs")

const err = (type, message) => ({ type, message })
const saved = await handlers.save(
  { job: { name: "x", prompt: "hi", schedule: { start: "2030-01-01T09:00", timezone: "UTC", repeat: "daily" } } },
  { error: err },
)
assert.equal(saved.job.status, "scheduled")
assert.equal((await handlers.list({})).jobs.length, 1)

await cleanup()
clearInterval(shared.timer)
console.log("upgrade: 1 passed")
