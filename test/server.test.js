import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, mkdir, access, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/server.js"
import * as S from "../src/schedule.js"

process.env.OPENCODE_SERVICE_FILE = join(tmpdir(), "does-not-exist", "service.json") // never reach a real OpenCode service
const shared = globalThis[Symbol.for("local.scheduler")]

let n = 0
const t = async (name, fn) => {
  await fn()
  n++
  console.log("ok", name)
}
const exists = (p) => access(p).then(() => true, () => false)
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"))
const NY = "America/New_York"
const wallIn = (ms, tz = "UTC") => S.wallString(ms, tz)
const MIN = 60_000
const DAY = 86_400_000

// ---- a fake OpenCode context ----
async function setup(options = {}, before) {
  const stateDir = await mkdtemp(join(tmpdir(), "sched-state-"))
  if (before) await before(stateDir)
  const events = []
  const tools = {}
  const sessions = new Map()
  const waiters = new Map()
  const notifications = []
  const calls = { create: [], prompt: [] }
  let counter = 0
  const ctx = {
    options: { stateDir, desktopStateFile: join(stateDir, "no-desktop.sqlite"), tickSeconds: 3600, noAutoTick: true, pollSeconds: 0.01, retrySeconds: 0.01, ...options },
    location: { directory: "/proj" },
    tool: {
      transform: async (fn) => {
        fn({ add: (tool) => (tools[tool.name] = tool) })
        return { dispose: async () => {} }
      },
    },
    rpc: {
      register: async (_def, handlers) => {
        ctx.handlers = handlers
        return { events: { emit: async (name, data) => events.push({ name, data }) }, dispose: async () => {} }
      },
    },
    session: {
      create: async (input) => {
        calls.create.push(input)
        if (ctx.failCreate) throw new Error("model not found")
        const id = `ses_${++counter}`
        const info = { id, title: input.title, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now(), updated: Date.now() }, messages: [] }
        sessions.set(id, info)
        return info
      },
      prompt: async (input) => {
        calls.prompt.push(input)
        if (ctx.failPrompt) throw new Error("provider exploded")
        return {}
      },
      wait: options.noWait
        ? undefined
        : async ({ sessionID }) => {
            const info = sessions.get(sessionID)
            if (ctx.waitRejects) throw new Error("wait is broken")
            if (info?.outcome) return
            await new Promise((resolve) => waiters.set(sessionID, [...(waiters.get(sessionID) ?? []), resolve]))
          },
      get: async ({ sessionID }) => {
        const s = sessions.get(sessionID)
        if (!s) throw Object.assign(new Error("session not found"), { status: 404 })
        return s
      },
      context: async ({ sessionID }) => {
        if (ctx.contextFails) throw new Error("nope")
        return sessions.get(sessionID)?.messages ?? []
      },
    },
  }
  shared.notify = async (n) => void notifications.push(n)
  const cleanup = await plugin.setup(ctx)
  const rpcErr = (code, message) => ({ error: code, message })
  const c = { error: rpcErr, signal: new AbortController().signal }
  const h = ctx.handlers
  return {
    ctx, stateDir, events, tools, sessions, calls, notifications,
    rpc: Object.fromEntries(Object.keys(h).map((k) => [k, (input = {}) => h[k](input, c)])),
    finish(sessionID, outcome = "succeeded", extra = {}) {
      Object.assign(sessions.get(sessionID), {
        outcome,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } },
        cost: 0.0123,
        model: { providerID: "anthropic", id: "claude-x", variant: "high" },
        time: { created: 1, updated: 2, busy: 10, idle: 20 },
        ...extra,
      })
      for (const r of waiters.get(sessionID) ?? []) r()
      waiters.delete(sessionID)
    },
    names: (name) => events.filter((e) => e.name === name),
    jobsFile: join(stateDir, "jobs.json"),
    logPath: (id) => join(stateDir, "logs", `${id}.json`),
    async editStore(fn) {
      const data = await readJson(join(stateDir, "jobs.json"))
      fn(data.jobs)
      await writeFile(join(stateDir, "jobs.json"), JSON.stringify(data))
    },
    async teardown() {
      for (const [id, info] of sessions) if (!info.outcome && waiters.has(id)) this.finish(id)
      await shared.settled()
      await cleanup()
    },
  }
}

const future = (ms = DAY) => wallIn(Date.now() + ms)
const past = (ms = DAY) => wallIn(Date.now() - ms)
const job = (extra = {}, schedule = {}) => ({
  name: "Test",
  prompt: "do the thing",
  schedule: { start: future(), timezone: "UTC", repeat: "none", ...schedule },
  ...extra,
})
const save = async (e, j) => (await e.rpc.save({ job: j })).job

await t("create: derived fields, defaults, input fields are never trusted", async () => {
  const e = await setup()
  const saved = await save(e, job({ status: "expired", nextRun: 1, description: "x", lastRun: { id: "zz" }, createdAt: 5, directory: undefined }))
  assert.equal(saved.status, "scheduled")
  assert.ok(saved.nextRun > Date.now())
  assert.match(saved.description, /^Once on .* \(UTC\)$/)
  assert.equal(saved.lastRun, undefined)
  assert.ok(saved.createdAt > 1000)
  assert.equal(saved.directory, "/proj")
  assert.equal(saved.enabled, true)
  assert.deepEqual(saved.notify, { enabled: false, onStart: false, onFinish: true, showResult: false })
  const stored = await readJson(e.jobsFile)
  assert.equal(stored.version, 2)
  assert.equal(stored.jobs[0].status, undefined)
  assert.equal(stored.jobs[0].nextRun, undefined)
  const list = await e.rpc.list()
  assert.equal(list.jobs.length, 1)
  assert.equal(list.stateDir, e.stateDir)
  assert.equal(typeof list.now, "number")
  assert.ok(list.timezone)
  assert.ok(e.names("changed").length >= 1)
  await e.teardown()
})

await t("validation errors are returned as invalid", async () => {
  const e = await setup()
  for (const bad of [
    job({ prompt: "  " }),
    job({}, { start: "tomorrow" }),
    job({}, { timezone: "Nowhere/Land" }),
    job({}, { repeat: "hours", interval: 0 }),
    job({}, { repeat: "cron", cron: "nope" }),
    job({ model: "no-slash" }),
    { name: "x", prompt: "p" },
    { id: "ghost", name: "x" },
  ]) {
    const r = await e.rpc.save({ job: bad })
    assert.equal(r.error, "invalid", JSON.stringify(bad))
    assert.ok(r.message)
  }
  assert.equal((await e.rpc.list()).jobs.length, 0)
  await e.teardown()
})

await t("edit: blank name, empty string clears optional fields, enabled is kept", async () => {
  const e = await setup()
  const a = await save(e, job({ name: "", prompt: "First line\nsecond line", agent: "plan", model: "anthropic/claude-x#high", enabled: false }, { repeat: "daily", end: future(5 * DAY) }))
  assert.equal(a.name, "First line")
  assert.equal(a.agent, "plan")
  assert.equal(a.model, "anthropic/claude-x#high")
  assert.equal(a.enabled, false)
  assert.equal(a.status, "paused")
  assert.ok(a.schedule.end)
  const b = await save(e, { id: a.id, agent: "", model: "", schedule: { end: "", cron: "" }, name: "Renamed" })
  assert.equal(b.agent, undefined)
  assert.equal(b.model, undefined)
  assert.equal(b.schedule.end, undefined)
  assert.equal(b.schedule.cron, undefined)
  assert.equal(b.name, "Renamed")
  assert.equal(b.enabled, false) // not sent, kept
  assert.equal(b.createdAt, a.createdAt)
  const c = await save(e, { id: a.id, enabled: true })
  assert.equal(c.status, "scheduled")
  assert.equal((await e.rpc.list()).jobs.length, 1)
  await e.teardown()
})

await t("expiry: past one-shot is expired, editing revives it, end passes", async () => {
  const e = await setup()
  const a = await save(e, job({}, { start: past() }))
  assert.equal(a.status, "expired")
  assert.equal(a.nextRun, undefined)
  assert.equal((await e.rpc.list()).jobs.length, 1)
  assert.equal(e.calls.create.length, 0) // an expired job created in the past never fires
  const b = await save(e, { id: a.id, schedule: { start: future(2 * DAY) } })
  assert.equal(b.status, "scheduled")
  assert.ok(b.nextRun > Date.now())
  const p = await save(e, { id: a.id, enabled: false, schedule: { start: past() } })
  assert.equal(p.status, "expired") // expired wins over paused
  const q = await save(e, { id: a.id, schedule: { start: future() } })
  assert.equal(q.status, "paused")
  const ended = await save(e, job({}, { start: past(3 * DAY), repeat: "daily", end: past(DAY) }))
  assert.equal(ended.status, "expired")
  const open = await save(e, { id: ended.id, schedule: { end: "" } })
  assert.equal(open.status, "scheduled")
  await e.teardown()
})

await t("a job turning expired emits changed on the next tick", async () => {
  const e = await setup()
  const a = await save(e, job({}, { start: future(10 * MIN) }))
  await shared.tick()
  const before = e.names("changed").length
  await e.editStore((jobs) => {
    jobs[0].schedule.start = past(DAY)
    jobs[0].firedUpTo = Date.now()
  })
  await shared.tick()
  assert.ok(e.names("changed").length > before)
  assert.deepEqual(e.names("changed").at(-1).data, { id: a.id })
  assert.equal(e.calls.create.length, 0)
  const before2 = e.names("changed").length
  await shared.tick()
  assert.equal(e.names("changed").length, before2) // only on the transition
  await e.teardown()
})

await t("missed runs fire once; the next tick does not repeat them", async () => {
  const e = await setup()
  const a = await save(e, job({ agent: "plan", model: "anthropic/claude-x#high", directory: "/work" }, { start: past(3 * 3600_000), repeat: "minutes", interval: 1 }))
  await e.editStore((jobs) => (jobs[0].firedUpTo = Date.now() - 2 * 3600_000)) // two hours of minutes were missed
  await shared.tick()
  assert.equal(e.calls.create.length, 1)
  const c = e.calls.create[0]
  assert.deepEqual(c.location, { directory: "/work" })
  assert.equal(c.agent, "plan")
  assert.deepEqual(c.model, { providerID: "anthropic", id: "claude-x", variant: "high" })
  assert.equal(c.metadata.job, a.id)
  assert.match(c.title, /Test/)
  assert.deepEqual(e.calls.prompt[0], { sessionID: "ses_1", text: "do the thing" })
  const log = (await readJson(e.logPath(a.id))).runs
  assert.equal(log.length, 1)
  assert.equal(log[0].status, "running")
  assert.equal(log[0].trigger, "schedule")
  assert.ok(log[0].scheduledFor <= Date.now() && log[0].scheduledFor > Date.now() - 2 * MIN)
  assert.equal(log[0].sessionID, "ses_1")
  assert.equal(e.names("runStarted").length, 1)
  assert.equal(e.names("runStarted")[0].data.job.name, "Test")
  await shared.tick()
  assert.equal(e.calls.create.length, 1)
  e.finish("ses_1")
  await e.teardown()
})

await t("missed runs respect `end`: the last occurrence before it runs once, nothing after it does", async () => {
  const e = await setup()
  await save(e, job({}, { start: past(5 * DAY), repeat: "daily", end: past(2 * DAY) }))
  await e.editStore((jobs) => (jobs[0].firedUpTo = Date.now() - DAY)) // already caught up past the end
  await shared.tick()
  assert.equal(e.calls.create.length, 0)
  await e.editStore((jobs) => (jobs[0].firedUpTo = Date.now() - 6 * DAY))
  await shared.tick()
  assert.equal(e.calls.create.length, 1)
  const run = (await e.rpc.logs({ id: (await e.rpc.list()).jobs[0].id })).runs[0]
  assert.ok(run.scheduledFor <= Date.now() - 2 * DAY + MIN) // the occurrence at `end`, not a later one
  await shared.tick()
  assert.equal(e.calls.create.length, 1)
  e.finish("ses_1")
  await e.teardown()
})

await t("paused jobs do not run; a one-shot missed while off runs once", async () => {
  const e = await setup()
  await save(e, job({ enabled: false }, { start: past(2 * MIN), repeat: "minutes", interval: 1 }))
  await e.editStore((jobs) => (jobs[0].firedUpTo = Date.now() - DAY))
  await shared.tick()
  assert.equal(e.calls.create.length, 0)
  await e.editStore((jobs) => {
    jobs[0].enabled = true
    jobs[0].schedule = { start: past(3 * MIN), timezone: "UTC", repeat: "none" }
  })
  await shared.tick()
  assert.equal(e.calls.create.length, 1)
  await shared.tick()
  assert.equal(e.calls.create.length, 1)
  assert.equal((await e.rpc.list()).jobs[0].status, "expired")
  await e.teardown()
})

await t("run lifecycle: wait, outcome, tokens, cost, model, result, events", async () => {
  const e = await setup()
  const a = await save(e, job({ notify: { enabled: true, onStart: true, onFinish: true, showResult: true } }))
  const started = await e.rpc.run({ id: a.id })
  assert.equal(started.run.status, "running")
  assert.equal(started.run.trigger, "manual")
  assert.equal(started.run.sessionID, "ses_1")
  assert.equal(e.names("runStarted").length, 1)
  e.sessions.get("ses_1").messages = [
    { type: "user", content: [{ type: "text", text: "do the thing" }] },
    { type: "assistant", content: [{ type: "text", text: "Working on it." }, { type: "tool", name: "x" }] },
    { type: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "All " }, { type: "text", text: "done." }] },
  ]
  e.finish("ses_1")
  await shared.settled()
  const logged = (await e.rpc.logs({ id: a.id })).runs
  assert.equal(logged.length, 1)
  const r = logged[0]
  assert.equal(r.status, "succeeded")
  assert.deepEqual(r.tokens, { input: 100, output: 20, reasoning: 5, cacheRead: 7, cacheWrite: 3 })
  assert.equal(r.cost, 0.0123)
  assert.equal(r.model, "anthropic/claude-x#high")
  assert.ok(r.finishedAt >= r.startedAt)
  assert.equal(r.durationMs, r.finishedAt - r.startedAt)
  assert.ok(!JSON.stringify(r).includes("All done"))
  const fin = e.names("runFinished")
  assert.equal(fin.length, 1)
  assert.equal(fin[0].data.result, "All \n\ndone.")
  assert.deepEqual(fin[0].data.job, { id: a.id, name: "Test", notify: { enabled: true, onStart: true, onFinish: true, showResult: true } })
  assert.equal(fin[0].data.run.status, "succeeded")
  assert.equal((await e.rpc.result({ sessionID: "ses_1" })).text, "All \n\ndone.")
  // no presence: the server sends OS notifications for start and finish
  assert.equal(e.notifications.length, 2)
  assert.match(e.notifications[0].title, /Started/)
  assert.equal(e.notifications.at(-1).body, "All \n\ndone.")
  assert.equal((await e.rpc.list()).jobs[0].lastRun.status, "succeeded")
  await e.teardown()
})

await t("result is only attached when notify.enabled && onFinish && showResult, and is truncated", async () => {
  const e = await setup()
  const a = await save(e, job({ notify: { enabled: true, onFinish: true, showResult: false } }))
  await e.rpc.run({ id: a.id })
  e.finish("ses_1")
  await shared.settled()
  assert.equal(e.names("runFinished")[0].data.result, undefined)
  await save(e, { id: a.id, notify: { showResult: true } })
  await e.rpc.run({ id: a.id })
  e.sessions.get("ses_2").messages = [{ type: "assistant", content: [{ type: "text", text: "x".repeat(6000) }] }]
  e.finish("ses_2")
  await shared.settled()
  assert.equal(e.names("runFinished")[1].data.result.length, 4000)
  await e.teardown()
})

await t("presence suppresses OS notifications", async () => {
  const e = await setup()
  const a = await save(e, job({ notify: { enabled: true, onStart: true, onFinish: true } }))
  assert.deepEqual(await e.rpc.presence(), { ok: true })
  await e.rpc.run({ id: a.id })
  e.finish("ses_1")
  await shared.settled()
  assert.equal(e.notifications.length, 0)
  assert.equal(e.names("runFinished").length, 1)
  shared.presenceAt = Date.now() - 80_000 // stale; the file written by presence() is also checked
  await e.rpc.run({ id: a.id })
  e.finish("ses_2")
  await shared.settled()
  assert.equal(e.notifications.length, 0) // presence.json is still recent
  await e.teardown()
  const e2 = await setup()
  const b = await save(e2, job({ notify: { enabled: false, onStart: true, onFinish: true } }))
  await e2.rpc.run({ id: b.id })
  e2.finish("ses_1", "failed")
  await shared.settled()
  assert.equal(e2.notifications.length, 0) // notify.enabled is off
  await e2.teardown()
})

await t("failed and interrupted outcomes", async () => {
  const e = await setup()
  const a = await save(e, job())
  await e.rpc.run({ id: a.id })
  await e.rpc.run({ id: a.id })
  e.sessions.get("ses_1").messages = [{ type: "assistant", content: [], error: { message: "rate limited" } }]
  e.finish("ses_1", "failed")
  e.finish("ses_2", "interrupted")
  await shared.settled()
  const runs = (await e.rpc.logs({ id: a.id })).runs
  assert.equal(runs.length, 2)
  const by = Object.fromEntries(runs.map((r) => [r.sessionID, r]))
  assert.equal(by.ses_1.status, "failed")
  assert.equal(by.ses_1.error, "rate limited")
  assert.equal(by.ses_2.status, "interrupted")
  await e.teardown()
})

await t("failed to start: logged, rpc run returns error failed", async () => {
  const e = await setup()
  const a = await save(e, job())
  e.ctx.failCreate = true
  const r = await e.rpc.run({ id: a.id })
  assert.equal(r.error, "failed")
  assert.match(r.message, /model not found/)
  const runs = (await e.rpc.logs({ id: a.id })).runs
  assert.equal(runs[0].status, "failed_to_start")
  assert.match(runs[0].error, /model not found/)
  assert.equal(e.names("runFinished").length, 1)
  assert.equal((await e.rpc.run({ id: "ghost" })).error, "failed")
  await e.teardown()
})

await t("a rejected prompt marks the run failed", async () => {
  const e = await setup()
  const a = await save(e, job())
  e.ctx.failPrompt = true
  await e.rpc.run({ id: a.id })
  await new Promise((r) => setTimeout(r, 50))
  e.finish("ses_1") // too late: the failure was already recorded
  await shared.settled()
  const runs = (await e.rpc.logs({ id: a.id })).runs
  assert.equal(runs[0].status, "failed")
  assert.match(runs[0].error, /provider exploded/)
  await e.teardown()
})

await t("polling fallback when wait is missing or rejects", async () => {
  for (const mode of ["missing", "rejects"]) {
    const e = await setup(mode === "missing" ? { noWait: true } : {})
    if (mode === "rejects") e.ctx.waitRejects = true
    const a = await save(e, job())
    await e.rpc.run({ id: a.id })
    setTimeout(() => e.finish("ses_1"), 60)
    await shared.settled()
    assert.equal((await e.rpc.logs({ id: a.id })).runs[0].status, "succeeded", mode)
    await e.teardown()
  }
})

await t("a wait that returns before the session has an outcome is retried", async () => {
  const e = await setup()
  const a = await save(e, job())
  let early = 2
  const real = e.ctx.session.wait
  e.ctx.session.wait = async (input) => (early-- > 0 ? undefined : real(input))
  await e.rpc.run({ id: a.id })
  await new Promise((r) => setTimeout(r, 80))
  assert.equal((await e.rpc.logs({ id: a.id })).runs[0].status, "running")
  e.finish("ses_1")
  await shared.settled()
  assert.equal((await e.rpc.logs({ id: a.id })).runs[0].status, "succeeded")
  await e.teardown()
})

await t("run log is newest first and capped by `history`", async () => {
  const e = await setup({ history: 3 })
  const a = await save(e, job())
  for (let i = 1; i <= 5; i++) {
    const { run } = await e.rpc.run({ id: a.id })
    e.finish(run.sessionID)
    await shared.settled()
  }
  const runs = (await readJson(e.logPath(a.id))).runs
  assert.equal(runs.length, 3)
  assert.deepEqual(runs.map((r) => r.sessionID), ["ses_5", "ses_4", "ses_3"])
  assert.equal((await e.rpc.logs({ id: a.id, limit: 2 })).runs.length, 2)
  await e.teardown()
  const d = await setup()
  assert.equal(d.ctx.options.history, undefined) // the default (200) applies
  await d.teardown()
})

await t("deleting a job removes its log", async () => {
  const e = await setup()
  const a = await save(e, job())
  const keep = await save(e, job({ name: "Keep" }))
  await e.rpc.run({ id: a.id })
  await e.rpc.run({ id: keep.id })
  e.finish("ses_1")
  e.finish("ses_2")
  await shared.settled()
  assert.ok(await exists(e.logPath(a.id)))
  assert.deepEqual(await e.rpc.remove({ id: a.id }), { removed: true })
  assert.ok(!(await exists(e.logPath(a.id))))
  assert.ok(await exists(e.logPath(keep.id)))
  assert.deepEqual(await e.rpc.remove({ id: a.id }), { removed: false })
  assert.deepEqual((await e.rpc.list()).jobs.map((j) => j.id), [keep.id])
  await e.teardown()
})

await t("a run finishing after its job was deleted does not recreate the log", async () => {
  const e = await setup()
  const a = await save(e, job())
  await e.rpc.run({ id: a.id })
  await e.rpc.remove({ id: a.id })
  e.finish("ses_1")
  await shared.settled()
  assert.ok(!(await exists(e.logPath(a.id))))
  assert.equal(e.names("runFinished").length, 0)
  await e.teardown()
})

await t("v1 migration: schedules, runs moved to log files, backup kept", async () => {
  const created = Date.now() - 10 * DAY
  const e = await setup({}, async (dir) => {
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "jobs.json"),
      JSON.stringify({
        jobs: [
          {
            id: "old1", name: "Daily", prompt: "p1", schedule: "@daily", directory: "/d", enabled: true, createdAt: created,
            lastRunAt: Date.now() - 1000, nextRun: Date.now() + 1000, agent: "build",
            runs: [{ at: Date.now() - DAY, trigger: "schedule", status: "started", sessionID: "s9" }, { at: Date.now() - 2 * DAY, trigger: "manual", status: "failed", error: "boom" }],
          },
          { id: "old2", name: "Every", prompt: "p2", schedule: "every 30m", directory: "/d", enabled: false, createdAt: created, runs: [] },
          { id: "old3", name: "Once", prompt: "p3", schedule: "at 2020-01-01 09:00", directory: "/d", enabled: false, createdAt: created, lastRunAt: 1578000000000, runs: [] },
          { id: "old4", name: "Broken", prompt: "p4", schedule: "garbage", directory: "/d", enabled: true, createdAt: created },
        ],
      }),
    )
  })
  const { jobs } = await e.rpc.list()
  assert.equal(jobs.length, 4)
  const by = Object.fromEntries(jobs.map((j) => [j.id, j]))
  assert.equal(by.old1.schedule.repeat, "cron")
  assert.equal(by.old1.schedule.cron, "0 9 * * *")
  assert.equal(by.old1.agent, "build")
  assert.equal(by.old1.status, "scheduled")
  assert.equal(by.old1.lastRun.sessionID, "s9")
  assert.equal(by.old1.runs, undefined)
  assert.equal(by.old2.schedule.repeat, "minutes")
  assert.equal(by.old2.schedule.interval, 30)
  assert.equal(by.old2.status, "paused")
  assert.equal(by.old3.schedule.repeat, "none")
  assert.equal(by.old3.schedule.start, "2020-01-01T09:00")
  assert.equal(by.old3.status, "expired")
  assert.equal(by.old3.enabled, true)
  assert.equal(by.old4.enabled, false)
  const stored = await readJson(e.jobsFile)
  assert.equal(stored.version, 2)
  assert.ok(stored.jobs.every((j) => !("runs" in j) && typeof j.schedule === "object"))
  const log = (await readJson(e.logPath("old1"))).runs
  assert.equal(log.length, 2)
  assert.equal(log[0].status, "succeeded")
  assert.equal(log[1].status, "failed_to_start")
  assert.equal(log[1].error, "boom")
  assert.ok((await readdir(e.stateDir)).includes("jobs.v1.json.bak"))
  await shared.tick()
  assert.equal(e.calls.create.length, 0) // nothing was due
  await e.teardown()
})

await t("runs left running by a previous server are recovered on startup", async () => {
  let jobId
  const e = await setup({}, null)
  const a = await save(e, job())
  jobId = a.id
  await e.teardown()
  // Simulate the old process: running entries in the log, and a new process with sessions in different states.
  const base = { jobId, trigger: "schedule", directory: "/proj" }
  await mkdir(join(e.stateDir, "logs"), { recursive: true })
  await writeFile(
    e.logPath(jobId),
    JSON.stringify({
      version: 1,
      runs: [
        { ...base, id: "r-done", startedAt: Date.now() - 5000, status: "running", sessionID: "gone-done" },
        { ...base, id: "r-gone", startedAt: Date.now() - 4000, status: "running", sessionID: "gone-missing" },
        { ...base, id: "r-nosession", startedAt: Date.now() - 3000, status: "running" },
        { ...base, id: "r-busy", startedAt: Date.now() - 2000, status: "running", sessionID: "gone-busy" },
        { ...base, id: "r-ok", startedAt: Date.now() - 1000, status: "succeeded", sessionID: "x" },
      ],
    }),
  )
  const f = await setup({ stateDir: e.stateDir })
  const mk = (id, extra = {}) =>
    f.sessions.set(id, { id, cost: 0, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, ...extra })
  mk("gone-done", { outcome: "failed", cost: 0.5 })
  mk("gone-busy", { time: { created: 1, updated: 1, busy: 5 } })
  await shared.tick() // the leader recovers on its first tick
  const byId = Object.fromEntries((await f.rpc.logs({ id: jobId })).runs.map((r) => [r.id, r]))
  assert.equal(byId["r-done"].status, "failed")
  assert.equal(byId["r-done"].cost, 0.5)
  assert.equal(byId["r-done"].tokens.output, 2)
  assert.ok(byId["r-done"].finishedAt)
  assert.equal(byId["r-gone"].status, "interrupted")
  assert.match(byId["r-gone"].error, /no longer exists/)
  assert.equal(byId["r-nosession"].status, "interrupted")
  assert.equal(byId["r-busy"].status, "running") // still working: watched again
  assert.equal(byId["r-ok"].status, "succeeded")
  f.finish("gone-busy")
  await shared.settled()
  assert.equal((await f.rpc.logs({ id: jobId })).runs.find((r) => r.id === "r-busy").status, "succeeded")
  await f.teardown()
})

await t("preview, occurrences", async () => {
  const e = await setup()
  const p = await e.rpc.preview({ schedule: { start: past(DAY), timezone: NY, repeat: "daily" }, count: 3 })
  assert.equal(p.ok, true)
  assert.equal(p.runs.length, 3)
  assert.ok(p.runs[0] > Date.now() && p.runs[1] - p.runs[0] === DAY)
  assert.match(p.description, /\(America\/New_York\)$/)
  const bad = await e.rpc.preview({ schedule: { start: "x", timezone: NY, repeat: "daily" } })
  assert.equal(bad.ok, false)
  assert.ok(bad.error)
  assert.equal((await e.rpc.preview({ schedule: { start: future(), timezone: "UTC", repeat: "none" } })).runs.length, 1)

  const a = await save(e, job({ name: "A" }, { start: future(DAY), repeat: "daily" }))
  const b = await save(e, job({ name: "B", enabled: false }, { start: future(DAY), repeat: "hours", interval: 6 }))
  await save(e, job({ name: "Dead" }, { start: past() }))
  await e.rpc.run({ id: a.id })
  e.finish("ses_1")
  await shared.settled()
  const now = Date.now()
  const o = await e.rpc.occurrences({ from: now - DAY, to: now + 3 * DAY })
  assert.ok(o.items.every((i) => i.at > now))
  assert.deepEqual([...new Set(o.items.map((i) => i.jobId))].sort(), [a.id, b.id].sort())
  assert.ok(o.items.filter((i) => i.jobId === b.id).every((i) => i.status === "paused"))
  assert.ok(o.items.filter((i) => i.jobId === a.id).every((i) => i.status === "scheduled"))
  assert.deepEqual(o.items.map((i) => i.at), [...o.items.map((i) => i.at)].sort((x, y) => x - y))
  assert.equal(o.runs.length, 1)
  assert.equal(o.runs[0].jobId, a.id)
  assert.equal(o.runs[0].name, "A")
  assert.equal(o.runs[0].status, "succeeded")
  const huge = await save(e, job({ name: "Minutely" }, { start: future(MIN), repeat: "minutes", interval: 1 }))
  const big = await e.rpc.occurrences({ from: now, to: now + 30 * DAY })
  assert.ok(big.items.length <= 500)
  assert.ok(big.items.some((i) => i.jobId === a.id))
  assert.ok(huge.id)
  await e.teardown()
})

await t("result: unavailable when the messages can't be read", async () => {
  const e = await setup()
  e.ctx.contextFails = true
  const r = await e.rpc.result({ sessionID: "ses_nope" })
  assert.equal(r.error, "unavailable")
  await e.teardown()
})

await t("models: enabled chat models, sorted, with provider names, variants and the default", async () => {
  const e = await setup()
  try {
    assert.deepEqual(await e.rpc.models(), { models: [] }) // no model API: empty list, the form falls back to text
    e.ctx.model = {
      list: async () => ({
        location: {},
        data: [
          { providerID: "openai", id: "gpt-x", name: "GPT X", enabled: true, type: "chat", variants: [] },
          { providerID: "anthropic", id: "claude-b", name: "Claude B", enabled: true, variants: [{ id: "high" }, { id: "low" }] },
          { providerID: "anthropic", id: "claude-a", name: "Claude A", enabled: true, variants: [] },
          { providerID: "anthropic", id: "off", name: "Off", enabled: false, variants: [] },
          { providerID: "openai", id: "img", name: "Image", enabled: true, type: "image", variants: [] },
        ],
      }),
      default: async () => ({ location: {}, data: { providerID: "anthropic", id: "claude-b" } }),
    }
    e.ctx.provider = { list: async () => ({ location: {}, data: [{ id: "anthropic", name: "Anthropic" }] }) }
    const out = await e.rpc.models()
    assert.equal(out.default, "anthropic/claude-b")
    assert.deepEqual(out.models, [
      { ref: "anthropic/claude-a", provider: "Anthropic", name: "Claude A", variants: [] },
      { ref: "anthropic/claude-b", provider: "Anthropic", name: "Claude B", variants: ["high", "low"] },
      { ref: "openai/gpt-x", provider: "openai", name: "GPT X", variants: [] },
    ])
  } finally {
    await e.teardown()
  }
})

await t("models: leaves out models the desktop app's model picker hides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sched-desktop-"))
  const file = join(dir, "drafts.sqlite")
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(file)
  db.exec("create table state (name text not null, key text not null, value text not null, updated_at integer not null, primary key (name, key))")
  const user = [
    { providerID: "opencode", modelID: "shown-free", visibility: "show" },
    { providerID: "opencode", modelID: "hidden-free", visibility: "hide" },
    { providerID: "local", modelID: "off", visibility: "hide" },
  ]
  db.prepare("insert into state values ('opencode.global.dat', 'model', ?, 0)").run(JSON.stringify({ user, recent: [] }))
  db.close()
  const e = await setup({ desktopStateFile: file })
  try {
    e.ctx.model = {
      list: async () => ({
        location: {},
        data: [
          { providerID: "opencode", id: "shown-free", name: "Shown", enabled: true, variants: [] },
          { providerID: "opencode", id: "hidden-free", name: "Hidden", enabled: true, variants: [] },
          { providerID: "local", id: "off", name: "Off", enabled: true, variants: [] },
          { providerID: "local", id: "unlisted", name: "Unlisted", enabled: true, variants: [] },
        ],
      }),
    }
    const refs = (await e.rpc.models()).models.map((m) => m.ref)
    assert.deepEqual(refs, ["local/unlisted", "opencode/shown-free"]) // no entry = shown, as in the app
  } finally {
    await e.teardown()
  }
})

await t("agents: primary, visible agents sorted by name, with description and own model", async () => {
  const e = await setup()
  try {
    assert.deepEqual(await e.rpc.agents(), { agents: [] }) // no agent API: empty list, the form falls back to text
    e.ctx.agent = {
      list: async () => ({
        location: {},
        data: [
          { id: "plan", name: "Plan", mode: "primary", hidden: false, description: "Read-only planning" },
          { id: "build", name: "Build", mode: "all", hidden: false, model: { providerID: "anthropic", id: "claude-x", variant: "high" } },
          { id: "explore", name: "Explore", mode: "subagent", hidden: false },
          { id: "title", name: "Title", mode: "primary", hidden: true },
        ],
      }),
    }
    assert.deepEqual((await e.rpc.agents()).agents, [
      { id: "build", name: "Build", model: "anthropic/claude-x#high" },
      { id: "plan", name: "Plan", description: "Read-only planning" },
    ])
  } finally {
    await e.teardown()
  }
})

await t("agent tools", async () => {
  const e = await setup()
  assert.deepEqual(Object.keys(e.tools).sort(), ["list_scheduled_jobs", "remove_scheduled_job", "run_scheduled_job", "schedule_job", "scheduled_job_logs"])
  const text = (r) => r.content
  const created = text(await e.tools.schedule_job.execute({
    name: "Standup", prompt: "Summarize yesterday", start: `${future(DAY).slice(0, 10)} 09:00`, timezone: NY, repeat: "weekly",
    end: "", notify: true, notifyShowResult: true,
  }))
  assert.match(created, /Standup/)
  assert.match(created, /status: scheduled/)
  assert.match(created, /Every \w+day at 9:00 AM/)
  const { jobs } = await e.rpc.list()
  assert.equal(jobs.length, 1)
  const j = jobs[0]
  assert.equal(j.schedule.timezone, NY)
  assert.equal(j.schedule.repeat, "weekly")
  assert.equal(j.schedule.start.slice(11), "09:00")
  assert.deepEqual(j.notify, { enabled: true, onStart: false, onFinish: true, showResult: true })
  assert.equal(j.directory, "/proj")

  const updated = text(await e.tools.schedule_job.execute({ id: j.id, repeat: "hours", interval: 3, notifyOnStart: true }))
  assert.match(updated, /Every 3 hours/)
  assert.equal((await e.rpc.list()).jobs[0].notify.onStart, true)
  assert.equal((await e.rpc.list()).jobs[0].schedule.timezone, NY)

  await assert.rejects(e.tools.schedule_job.execute({ name: "x", prompt: "p" }), /start/)
  await assert.rejects(e.tools.schedule_job.execute({ prompt: "p", start: "nope" }), /Invalid job/)
  await assert.rejects(e.tools.schedule_job.execute({ prompt: "p", start: future(), repeat: "hours", interval: 0 }), /interval/)

  // cron without start; legacy string
  const cron = text(await e.tools.schedule_job.execute({ prompt: "p", repeat: "cron", cron: "0 9 * * 1-5", timezone: "Asia/Tokyo" }))
  assert.match(cron, /Cron "0 9 \* \* 1-5"/)
  const legacy = text(await e.tools.schedule_job.execute({ prompt: "legacy", schedule: "every 2h" }))
  assert.match(legacy, /Every 2 hours/)

  const listing = text(await e.tools.list_scheduled_jobs.execute({}))
  assert.match(listing, /Standup/)
  assert.match(listing, /next: /)
  assert.match(listing, /last: never/)

  assert.match(text(await e.tools.scheduled_job_logs.execute({ id: j.id })), /has not run yet/)
  assert.match(text(await e.tools.run_scheduled_job.execute({ id: j.id })), /Started session ses_1/)
  e.finish("ses_1")
  await shared.settled()
  const logs = text(await e.tools.scheduled_job_logs.execute({ id: j.id, limit: 5 }))
  assert.match(logs, /succeeded \| manual/)
  assert.match(logs, /tokens in\/out\/reasoning 100\/20\/5/)
  assert.match(logs, /session ses_1/)
  assert.match(text(await e.tools.list_scheduled_jobs.execute({})), /last: .*\(succeeded\)/)
  await assert.rejects(e.tools.run_scheduled_job.execute({ id: "ghost" }), /No job/)

  assert.match(text(await e.tools.remove_scheduled_job.execute({ id: j.id })), /Removed "Standup"/)
  assert.match(text(await e.tools.remove_scheduled_job.execute({ id: j.id })), /No job/)
  await e.teardown()
})

await t("only one process leads", async () => {
  const e = await setup()
  await save(e, job({}, { start: past(5 * MIN), repeat: "minutes", interval: 1 }))
  await e.editStore((jobs) => (jobs[0].firedUpTo = Date.now() - HOUR()))
  // Another live process holds the leader file.
  await writeFile(join(e.stateDir, "leader.json"), JSON.stringify({ pid: process.ppid, host: (await import("node:os")).hostname(), ts: Date.now() }))
  await shared.tick()
  assert.equal(e.calls.create.length, 0)
  await writeFile(join(e.stateDir, "leader.json"), JSON.stringify({ pid: 99999999, host: "elsewhere", ts: 1 }))
  await shared.tick()
  assert.equal(e.calls.create.length, 1)
  assert.equal((await e.rpc.list()).leader.self, true)
  e.finish("ses_1")
  await e.teardown()
})
function HOUR() {
  return 3600_000
}

console.log(`server: ${n} passed (TZ=${process.env.TZ ?? "default"})`)
process.exit(0)
