// scheduler: an OpenCode plugin that runs prompts on a schedule.
//
// Each job has a schedule (cron, "every 30m", or "at <date>"), a prompt, and a project directory. When a job is due,
// the plugin starts a new session in that directory and sends the prompt, so the run shows up in the session list
// like any other session.
//
// Jobs live in one JSON file (default ~/.local/state/opencode-scheduler/jobs.json), shared by every OpenCode process
// on this machine. Only one process fires jobs at a time: the first to hold leader.json, refreshed every tick.
// Jobs only run while some OpenCode server is running (the background service or the desktop app).
//
// Options (opencode.jsonc: "plugins": [{ "package": "./plugins/scheduler", "options": { ... } }]):
//   stateDir     where jobs.json and leader.json live
//   tickSeconds  how often due jobs are checked (default 20)
//   history      runs kept per job (default 20)

import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { Scheduler, PLUGIN_ID } from "./rpc.js"
import * as Schedule from "./schedule.js"

const log = (...args) => console.error(`[${PLUGIN_ID}]`, ...args)

// One scheduler loop per process, shared by every location (project) that loads the plugin.
const STATE = Symbol.for(PLUGIN_ID)
const shared = (globalThis[STATE] ??= { contexts: new Set(), registrations: new Set(), timer: undefined, busy: false })

let config = { stateDir: join(homedir(), ".local/state/opencode-scheduler"), tickMs: 20_000, history: 20 }
const files = () => ({ jobs: join(config.stateDir, "jobs.json"), leader: join(config.stateDir, "leader.json") })

// ---- the job file ----

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (e) {
    if (e.code === "ENOENT") return fallback
    throw e
  }
}

async function writeJson(path, value) {
  await mkdir(config.stateDir, { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n")
  await rename(tmp, path)
}

// Serializes read-modify-write cycles within this process.
let chain = Promise.resolve()
function update(fn) {
  const run = chain.then(async () => {
    const data = await readJson(files().jobs, { jobs: [] })
    const result = await fn(data.jobs)
    await writeJson(files().jobs, data)
    return result
  })
  chain = run.catch(() => {})
  return run
}

const load = async () => (await readJson(files().jobs, { jobs: [] })).jobs

function computeNext(job, now = Date.now()) {
  if (!job.enabled) return undefined
  const anchor = job.lastRunAt ?? job.createdAt ?? now
  return Schedule.next(job.schedule, now, anchor)
}

function normalize(input, existing, defaultDirectory) {
  const job = { ...existing, ...input }
  job.name = String(job.name ?? "").trim() || "Untitled job"
  job.prompt = String(job.prompt ?? "").trim()
  job.schedule = String(job.schedule ?? "").trim()
  job.directory = resolve(String(job.directory || defaultDirectory || homedir()))
  job.agent = job.agent ? String(job.agent).trim() || undefined : undefined
  job.model = job.model ? String(job.model).trim() || undefined : undefined
  job.enabled = job.enabled ?? true
  const problem = !job.prompt ? "the prompt is empty" : Schedule.validate(job.schedule)
  if (problem) throw Object.assign(new Error(problem), { invalid: true })
  return job
}

async function saveJob(input, defaultDirectory) {
  const job = await update((jobs) => {
    const i = input.id ? jobs.findIndex((j) => j.id === input.id) : -1
    if (input.id && i < 0) throw Object.assign(new Error(`no job with id ${input.id}`), { invalid: true })
    const existing = i >= 0 ? jobs[i] : { id: randomUUID().slice(0, 8), createdAt: Date.now(), runs: [] }
    const scheduleChanged = i >= 0 && existing.schedule !== input.schedule && input.schedule !== undefined
    const job = normalize(input, existing, defaultDirectory)
    // A new schedule counts from now, not from the last run under the old one.
    if (scheduleChanged) job.createdAt = Date.now(), delete job.lastRunAt
    job.nextRun = computeNext(job)
    if (i >= 0) jobs[i] = job
    else jobs.push(job)
    return job
  })
  emit("changed", { id: job.id })
  return job
}

async function removeJob(id) {
  const removed = await update((jobs) => {
    const i = jobs.findIndex((j) => j.id === id)
    return i >= 0 ? jobs.splice(i, 1)[0] : undefined
  })
  emit("changed", { id })
  return removed
}

// ---- running a job ----

function modelRef(text) {
  if (!text) return undefined
  const [ref, variant] = text.split("#")
  const slash = ref.indexOf("/")
  if (slash < 0) throw new Error(`model "${text}" should look like provider/model`)
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) }
}

function context() {
  return shared.contexts.values().next().value
}

async function start(job, trigger) {
  const ctx = context()
  if (!ctx) throw new Error("no OpenCode location is loaded to run the job in")
  const stamp = new Date().toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
  const session = await ctx.session.create({
    title: `⏰ ${job.name} · ${stamp}`,
    location: { directory: job.directory },
    ...(job.agent ? { agent: job.agent } : {}),
    ...(job.model ? { model: modelRef(job.model) } : {}),
    metadata: { plugin: PLUGIN_ID, job: job.id, trigger },
  })
  const sessionID = session?.id ?? session?.data?.id
  if (!sessionID) throw new Error("the server didn't return a session id")
  // The prompt runs in the background; the session shows its progress.
  ctx.session.prompt({ sessionID, text: job.prompt }).catch((e) => log(`job ${job.id}: prompt failed:`, e?.message ?? e))
  return sessionID
}

async function runJob(id, trigger) {
  const now = Date.now()
  // Claim the run first: the next run is written before the session starts, so a crash never repeats it.
  const job = await update((jobs) => {
    const job = jobs.find((j) => j.id === id)
    if (!job) return undefined
    if (trigger === "schedule") {
      job.lastRunAt = now
      if (Schedule.parse(job.schedule).kind === "at") job.enabled = false
      job.nextRun = computeNext(job, now)
    }
    return { ...job }
  })
  if (!job) throw new Error(`no job with id ${id}`)

  const run = { at: now, trigger }
  try {
    run.sessionID = await start(job, trigger)
    run.status = "started"
  } catch (e) {
    run.status = "failed"
    run.error = e?.message ?? String(e)
    log(`job ${job.id} (${job.name}) failed to start:`, run.error)
  }
  await update((jobs) => {
    const j = jobs.find((j) => j.id === id)
    if (!j) return
    j.runs = [run, ...(j.runs ?? [])].slice(0, config.history)
  })
  emit("ran", { id: job.id, name: job.name, ...run, directory: job.directory })
  emit("changed", { id: job.id })
  return run
}

// ---- the loop, and which process runs it ----

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === "EPERM"
  }
}

async function lead() {
  const path = files().leader
  const me = { pid: process.pid, host: hostname() }
  const current = await readJson(path, undefined).catch(() => undefined)
  const stale =
    !current ||
    current.host !== me.host ||
    Date.now() - (current.ts ?? 0) > config.tickMs * 4 ||
    !alive(current.pid)
  if (current?.pid !== me.pid && !stale) return false
  await writeJson(path, { ...me, ts: Date.now() })
  // Another process may have written at the same moment; whoever's write landed leads.
  const check = await readJson(path, undefined).catch(() => undefined)
  return check?.pid === me.pid
}

async function tick() {
  if (shared.busy || shared.contexts.size === 0) return
  shared.busy = true
  try {
    if (!(await lead())) return
    const now = Date.now()
    const jobs = await load()
    for (const job of jobs) {
      if (!job.enabled) continue
      // Jobs saved by an older version, or whose next run was never computed.
      if (job.nextRun === undefined || job.nextRun === null) {
        await update((all) => {
          const j = all.find((x) => x.id === job.id)
          if (j) j.nextRun = computeNext(j, now)
        })
        continue
      }
      if (job.nextRun <= now) await runJob(job.id, "schedule").catch((e) => log("run failed:", e.message))
    }
  } catch (e) {
    log("tick failed:", e?.message ?? e)
  } finally {
    shared.busy = false
  }
}

function emit(name, data) {
  for (const reg of shared.registrations) reg.events.emit(name, data).catch(() => {})
}

// ---- RPC for the panel, and tools for the agent ----

async function listOutput() {
  const jobs = await load()
  const leader = await readJson(files().leader, undefined).catch(() => undefined)
  return {
    now: Date.now(),
    stateFile: files().jobs,
    leader: leader ? { pid: leader.pid, self: leader.pid === process.pid, ts: leader.ts } : undefined,
    jobs: jobs.map((j) => ({ ...j, description: Schedule.describe(j.schedule) })),
  }
}

function previewOutput(schedule) {
  const error = Schedule.validate(schedule)
  if (error) return { ok: false, error }
  const runs = []
  let t = Date.now()
  for (let i = 0; i < 3; i++) {
    const n = Schedule.next(schedule, t, i === 0 ? Date.now() : t)
    if (n === undefined) break
    runs.push(n)
    t = n
  }
  return { ok: true, description: Schedule.describe(schedule), runs }
}

const text = (content) => ({ content })
// RPC outputs must be plain JSON: drop undefined fields.
const json = (value) => JSON.parse(JSON.stringify(value))

function formatJob(j) {
  const next = j.enabled && j.nextRun ? new Date(j.nextRun).toLocaleString() : "—"
  const last = j.runs?.[0] ? `${new Date(j.runs[0].at).toLocaleString()} (${j.runs[0].status})` : "never"
  return `- ${j.name} [${j.id}] ${j.enabled ? "" : "(paused) "}— ${Schedule.describe(j.schedule)}\n  next: ${next}; last: ${last}\n  dir: ${j.directory}\n  prompt: ${j.prompt.length > 160 ? j.prompt.slice(0, 160) + "…" : j.prompt}`
}

function tools(ctx) {
  const here = () => ctx.location?.directory
  return (editor) => {
    editor.add({
      name: "schedule_job",
      description:
        "Create or update a scheduled job. When it is due, OpenCode starts a new session in `directory` and sends `prompt`. " +
        'Schedule formats (local time): 5-field cron ("0 9 * * 1-5"), presets (@hourly, @daily = 9:00, @weekly = Mon 9:00, @monthly, @weekdays), ' +
        '"every 30m" / "every 2h" / "every 1d", or "at YYYY-MM-DD HH:MM" for a single run. Pass `id` to update an existing job.',
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing job id to update; omit to create a job." },
          name: { type: "string", description: "Short name for the job." },
          schedule: { type: "string", description: "When to run; see the formats above." },
          prompt: { type: "string", description: "The prompt each run sends. Make it self-contained: the run starts a fresh session." },
          directory: { type: "string", description: "Project directory the session runs in. Defaults to the current project." },
          agent: { type: "string", description: "Agent to use (e.g. build, plan). Defaults to the default agent." },
          model: { type: "string", description: "provider/model, optionally #variant. Defaults to the default model." },
          enabled: { type: "boolean", description: "False pauses the job." },
        },
      },
      async execute(input) {
        if (!input.id && (!input.schedule || !input.prompt)) throw new Error("a new job needs `schedule` and `prompt`")
        const job = await saveJob(input, here())
        return text(`Saved job:\n${formatJob(job)}`)
      },
    })
    editor.add({
      name: "list_scheduled_jobs",
      description: "List scheduled jobs with their schedules, next runs and last runs.",
      input: { type: "object", properties: {} },
      async execute() {
        const { jobs } = await listOutput()
        return text(jobs.length ? jobs.map(formatJob).join("\n") : "No scheduled jobs.")
      },
    })
    editor.add({
      name: "remove_scheduled_job",
      description: "Delete a scheduled job by id.",
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async execute(input) {
        const removed = await removeJob(input.id)
        return text(removed ? `Removed "${removed.name}".` : `No job with id ${input.id}.`)
      },
    })
    editor.add({
      name: "run_scheduled_job",
      description: "Run a scheduled job right now, in a new session, without changing its schedule.",
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async execute(input) {
        const run = await runJob(input.id, "manual")
        return text(run.status === "started" ? `Started session ${run.sessionID}.` : `Couldn't start: ${run.error}`)
      },
    })
  }
}

export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const opts = ctx.options ?? {}
    config = {
      stateDir: opts.stateDir ? resolve(String(opts.stateDir).replace(/^~(?=\/|$)/, homedir())) : config.stateDir,
      tickMs: Math.max(5, Number(opts.tickSeconds ?? 20)) * 1000,
      history: Math.max(1, Number(opts.history ?? 20)),
    }

    const registrations = []
    registrations.push(await ctx.tool.transform(tools(ctx)))
    const rpc = await ctx.rpc.register(Scheduler, {
      list: async () => json(await listOutput()),
      save: async (input, c) => {
        try {
          return json({ job: await saveJob(input.job, input.job?.directory || ctx.location?.directory) })
        } catch (e) {
          if (e.invalid) return c.error("invalid", e.message, {})
          throw e
        }
      },
      remove: async (input) => ({ removed: Boolean(await removeJob(input.id)) }),
      run: async (input, c) => {
        const run = await runJob(input.id, "manual")
        return run.status === "started" ? json({ run }) : c.error("failed", run.error ?? "couldn't start", {})
      },
      preview: async (input) => json(previewOutput(input.schedule)),
    })
    registrations.push(rpc)
    shared.registrations.add(rpc)
    shared.contexts.add(ctx)

    if (!shared.timer) {
      shared.timer = setInterval(tick, config.tickMs)
      shared.timer.unref?.()
      setTimeout(tick, 2000).unref?.()
      log("loaded; jobs in", files().jobs)
    }

    return async () => {
      shared.contexts.delete(ctx)
      shared.registrations.delete(rpc)
      for (const r of registrations) await r.dispose().catch(() => {})
      if (shared.contexts.size === 0 && shared.timer) {
        clearInterval(shared.timer)
        shared.timer = undefined
        const leader = await readJson(files().leader, undefined).catch(() => undefined)
        if (leader?.pid === process.pid) await rm(files().leader, { force: true }).catch(() => {})
      }
    }
  },
}
