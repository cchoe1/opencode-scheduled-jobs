// scheduler: an OpenCode plugin that runs prompts on a schedule.
//
// Each job has a structured schedule (start, time zone, repeat, end), a prompt and a project directory. When a job is
// due, the plugin starts a new session in that directory and sends the prompt, so the run shows up in the session list
// like any other session. It then waits for the session to go idle and records the outcome, tokens and cost in the
// job's run log (never the model's output).
//
// Files (state directory, see src/paths.js): jobs.json (version 2), logs/<jobId>.json, leader.json, presence.json.
// Only one OpenCode process fires jobs at a time: the first to hold leader.json, refreshed every tick.
// Jobs only run while some OpenCode server is running (the background service or the desktop app).
//
// Options (opencode.jsonc: "plugins": [{ "package": "./plugins/scheduler", "options": { ... } }]):
//   stateDir     where the files live (default: see paths.js)
//   tickSeconds  how often due jobs are checked (default 20)
//   history      runs kept per job (default 200)

import { mkdir, readFile, rename, writeFile, rm, stat, copyFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { Scheduler, PLUGIN_ID } from "./rpc.js"
import * as Schedule from "./schedule.js"
import { notify } from "./notify.js"
import { resolveStateDir, jobsFile, leaderFile, presenceFile, logFile } from "./paths.js"

const log = (...args) => console.error(`[${PLUGIN_ID}]`, ...args)

// One scheduler loop per process, shared by every location (project) that loads the plugin.
const STATE = Symbol.for(PLUGIN_ID)
const shared = (globalThis[STATE] ??= {
  contexts: new Set(),
  registrations: new Set(),
  timer: undefined,
  busy: false,
  presenceAt: 0,
  statuses: new Map(),
  monitoring: new Set(),
  pending: new Set(),
  recovered: false,
  cache: new Map(),
})
// Hooks the tests use.
shared.tick = () => tick()
shared.settled = async () => {
  while (shared.pending.size) await Promise.allSettled([...shared.pending])
}

const PRESENCE_MS = 75_000
const RESULT_LIMIT = 4000

let config = { stateDir: resolveStateDir(), tickMs: 20_000, history: 200, pollMs: 5000, retryMs: 2000 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const unwrap = (r) => (r && typeof r === "object" && "data" in r && !("id" in r) ? r.data : r)
const items = (r) => {
  const v = unwrap(r)
  return Array.isArray(v) ? v : (v?.data ?? v?.items ?? [])
}
// RPC outputs must be plain JSON: drop undefined fields.
const json = (value) => JSON.parse(JSON.stringify(value))
const blank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "")

// ---- files ----

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (e) {
    if (e.code === "ENOENT") return fallback
    throw e
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n")
  await rename(tmp, path)
}

// Serializes every read-modify-write within this process.
let chain = Promise.resolve()
function locked(fn) {
  const run = chain.then(fn)
  chain = run.catch(() => {})
  return run
}

const DEFAULT_NOTIFY = { enabled: false, onStart: false, onFinish: true, showResult: false }

function cleanNotify(n) {
  const o = n && typeof n === "object" ? n : {}
  return {
    enabled: o.enabled === undefined ? DEFAULT_NOTIFY.enabled : Boolean(o.enabled),
    onStart: o.onStart === undefined ? DEFAULT_NOTIFY.onStart : Boolean(o.onStart),
    onFinish: o.onFinish === undefined ? DEFAULT_NOTIFY.onFinish : Boolean(o.onFinish),
    showResult: o.showResult === undefined ? DEFAULT_NOTIFY.showResult : Boolean(o.showResult),
  }
}

// ---- migrating v1 ----

function migrateJob(old, now) {
  const createdAt = Number(old.createdAt) || now
  let schedule
  let enabled = old.enabled !== false
  if (old.schedule && typeof old.schedule === "object") {
    schedule = Schedule.normalize(old.schedule)
  } else {
    try {
      schedule = Schedule.fromLegacy(old.schedule, { createdAt, lastRunAt: old.lastRunAt })
      // v1 turned an "at" job off after it ran; in v2 that is just an expired job.
      if (schedule.repeat === "none" && !enabled && old.lastRunAt) enabled = true
    } catch (e) {
      log(`job ${old.id}: can't convert schedule "${old.schedule}": ${e.message}; pausing it`)
      schedule = { start: Schedule.wallString(createdAt, Schedule.systemTimezone()), timezone: Schedule.systemTimezone(), repeat: "none" }
      enabled = false
    }
  }
  return {
    id: String(old.id),
    name: String(old.name ?? "").trim() || "Untitled job",
    prompt: String(old.prompt ?? ""),
    directory: old.directory,
    ...(old.agent ? { agent: old.agent } : {}),
    ...(old.model ? { model: old.model } : {}),
    enabled,
    schedule,
    notify: cleanNotify(old.notify),
    createdAt,
    updatedAt: Number(old.updatedAt) || createdAt,
    firedUpTo: Number(old.lastRunAt) || createdAt,
  }
}

function migrateRun(job, r, i) {
  const startedAt = Number(r.at) || Date.now()
  return {
    id: `v1-${job.id}-${startedAt}-${i}`,
    jobId: job.id,
    trigger: r.trigger === "manual" ? "manual" : "schedule",
    startedAt,
    status: r.status === "failed" ? "failed_to_start" : "succeeded",
    ...(r.sessionID ? { sessionID: r.sessionID } : {}),
    directory: job.directory,
    ...(job.agent ? { agent: job.agent } : {}),
    ...(job.model ? { model: job.model } : {}),
    ...(r.error ? { error: r.error } : {}),
  }
}

async function migrate(old) {
  const now = Date.now()
  const jobs = []
  for (const j of old.jobs ?? []) {
    const job = migrateJob(j, now)
    jobs.push(job)
    if (Array.isArray(j.runs) && j.runs.length) {
      const path = logFile(config.stateDir, job.id)
      const existing = await readJson(path, undefined).catch(() => undefined)
      if (!existing) await writeJson(path, { version: 1, runs: j.runs.slice(0, config.history).map((r, i) => migrateRun(job, r, i)) })
    }
  }
  await mkdir(config.stateDir, { recursive: true })
  await copyFile(jobsFile(config.stateDir), join(config.stateDir, "jobs.v1.json.bak")).catch(() => {})
  const data = { version: 2, jobs }
  await writeJson(jobsFile(config.stateDir), data)
  log(`migrated ${jobs.length} job(s) to the v2 format`)
  return data
}

// ---- the job store ----

async function readStore() {
  const data = await readJson(jobsFile(config.stateDir), undefined)
  if (!data) return { version: 2, jobs: [] }
  if (data.version === 2 && Array.isArray(data.jobs)) return data
  return migrate(data)
}

const load = () => locked(async () => (await readStore()).jobs)

function mutate(fn) {
  return locked(async () => {
    const data = await readStore()
    const result = await fn(data.jobs)
    await writeJson(jobsFile(config.stateDir), { version: 2, jobs: data.jobs })
    return result
  })
}

// ---- run logs ----

async function readLog(jobId) {
  const path = logFile(config.stateDir, jobId)
  let st
  try {
    st = await stat(path)
  } catch {
    shared.cache.delete(path)
    return []
  }
  const hit = shared.cache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.runs
  const runs = (await readJson(path, { runs: [] }).catch(() => ({ runs: [] }))).runs ?? []
  shared.cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, runs })
  return runs
}

function mutateLog(jobId, fn) {
  return locked(async () => {
    const path = logFile(config.stateDir, jobId)
    const runs = (await readJson(path, { runs: [] }).catch(() => ({ runs: [] }))).runs ?? []
    const result = await fn(runs)
    if (result === SKIP) return undefined
    await writeJson(path, { version: 1, runs: runs.slice(0, config.history) })
    shared.cache.delete(path)
    return result
  })
}
const SKIP = Symbol("skip")

const addRun = (run) =>
  mutateLog(run.jobId, (runs) => {
    runs.unshift(run)
  })

/** Patches a run that is still running (or any run when `force`); the log is never recreated for a deleted job. */
const patchRun = (jobId, runId, patch, { onlyRunning = true } = {}) =>
  mutateLog(jobId, (runs) => {
    const run = runs.find((r) => r.id === runId)
    if (!run || (onlyRunning && run.status !== "running")) return SKIP
    Object.assign(run, patch)
    return { ...run }
  })

const summary = (r) => ({ id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, status: r.status, sessionID: r.sessionID, error: r.error })

// ---- derived fields ----

function derive(job, now) {
  const next = Schedule.next(job.schedule, now)
  const status = next === undefined ? "expired" : job.enabled ? "scheduled" : "paused"
  return { status, nextRun: next }
}

async function present(job, now = Date.now()) {
  const { status, nextRun } = derive(job, now)
  const last = (await readLog(job.id))[0]
  return {
    id: job.id,
    name: job.name,
    prompt: job.prompt,
    directory: job.directory,
    agent: job.agent,
    model: job.model,
    enabled: job.enabled,
    schedule: job.schedule,
    notify: job.notify,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status,
    nextRun,
    lastRun: last ? summary(last) : undefined,
    description: Schedule.describe(job.schedule),
  }
}

// ---- saving ----

const invalid = (message) => Object.assign(new Error(message), { invalid: true })
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const minuteFloor = (ms) => Math.floor(ms / 60_000) * 60_000

function parseModel(text) {
  const [ref, variant] = String(text).split("#")
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) throw invalid(`model "${text}" should look like provider/model (optionally #variant)`)
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) }
}

function build(input, existing, defaultDirectory, now) {
  const job = existing ? { ...existing } : { id: randomUUID().slice(0, 8), createdAt: now, enabled: true }
  if (input.prompt !== undefined) job.prompt = String(input.prompt ?? "").trim()
  if (input.name !== undefined) job.name = String(input.name ?? "").trim()
  if (input.directory !== undefined && !blank(input.directory)) job.directory = resolve(String(input.directory).replace(/^~(?=[\\/]|$)/, homedir()))
  if (!job.directory) job.directory = resolve(defaultDirectory || homedir())
  for (const key of ["agent", "model"]) {
    if (input[key] === undefined) continue
    if (blank(input[key])) delete job[key]
    else job[key] = String(input[key]).trim()
  }
  if (typeof input.enabled === "boolean") job.enabled = input.enabled
  job.enabled ??= true
  job.notify = cleanNotify({ ...(existing?.notify ?? {}), ...(input.notify && typeof input.notify === "object" ? input.notify : {}) })

  let schedule = existing?.schedule
  if (input.schedule !== undefined && input.schedule !== null) {
    if (typeof input.schedule === "string") {
      try {
        schedule = Schedule.fromLegacy(input.schedule, { createdAt: now })
      } catch (e) {
        throw invalid(e.message)
      }
    } else if (typeof input.schedule === "object" && !Array.isArray(input.schedule)) {
      schedule = { ...(existing?.schedule ?? {}), ...input.schedule }
    } else throw invalid("the schedule must be an object")
  }
  if (!schedule) throw invalid("a schedule is required")
  schedule = Schedule.normalize(schedule)
  const problem = Schedule.validate(schedule)
  if (problem) throw invalid(problem)
  job.schedule = schedule

  if (!job.prompt) throw invalid("the prompt is empty")
  if (!job.name) job.name = job.prompt.split(/\r?\n/)[0].trim().slice(0, 60) || "Untitled job"
  if (job.model) parseModel(job.model)

  // A changed schedule, or a job switched back on, counts from now, not from what it missed in between.
  const restart =
    !existing || !sameJson(Schedule.normalize(existing.schedule), schedule) || (existing.enabled === false && job.enabled)
  if (restart) job.firedUpTo = minuteFloor(now) - 1
  job.updatedAt = now
  return job
}

async function saveJob(input, defaultDirectory) {
  if (!input || typeof input !== "object") throw invalid("job is missing")
  const job = await mutate((jobs) => {
    const i = input.id ? jobs.findIndex((j) => j.id === input.id) : -1
    if (input.id && i < 0) throw invalid(`no job with id ${input.id}`)
    const job = build(input, i >= 0 ? jobs[i] : undefined, defaultDirectory, Date.now())
    if (i >= 0) jobs[i] = job
    else jobs.push(job)
    return job
  })
  shared.statuses.set(job.id, derive(job, Date.now()).status)
  emit("changed", { id: job.id })
  return present(job)
}

async function removeJob(id) {
  const removed = await mutate((jobs) => {
    const i = jobs.findIndex((j) => j.id === id)
    return i >= 0 ? jobs.splice(i, 1)[0] : undefined
  })
  if (removed) {
    await locked(() => rm(logFile(config.stateDir, id), { force: true })).catch(() => {})
    shared.cache.delete(logFile(config.stateDir, id))
    shared.statuses.delete(id)
  }
  emit("changed", { id })
  return removed
}

// ---- reading a session's final reply ----

function replyFrom(messages) {
  let text = ""
  let error
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.type !== "assistant") continue
    if (error === undefined && m.error) error = m.error.message ?? m.error.name ?? JSON.stringify(m.error)
    const t = (m.content ?? [])
      .filter((c) => c?.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n\n")
      .trim()
    if (t) {
      text = t
      break
    }
  }
  return { text, error }
}

async function serviceInfo() {
  const candidates = [join(homedir(), ".local/state/opencode/service.json")]
  if (process.env.OPENCODE_SERVICE_FILE) candidates.splice(0, 1, process.env.OPENCODE_SERVICE_FILE)
  else if (process.env.XDG_STATE_HOME) candidates.unshift(join(process.env.XDG_STATE_HOME, "opencode/service.json"))
  for (const path of candidates) {
    const state = await readJson(path, undefined).catch(() => undefined)
    if (state?.url) return state
  }
  throw new Error("the OpenCode service isn't running")
}

async function httpMessages(sessionID) {
  const state = await serviceInfo()
  const url = `${state.url.replace(/\/$/, "")}/api/session/${encodeURIComponent(sessionID)}/message?order=desc&limit=30&type=assistant`
  const res = await fetch(url, {
    headers: { Authorization: "Basic " + Buffer.from(`opencode:${state.password ?? ""}`).toString("base64") },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return items(await res.json()).reverse() // newest first -> chronological
}

/** The session's last assistant reply: { text, error? }. Throws when no route works. */
async function readReply(sessionID) {
  const ctx = context()
  const failures = []
  if (ctx?.session?.context) {
    try {
      const r = replyFrom(items(await ctx.session.context({ sessionID })))
      if (r.text || r.error) return r
    } catch (e) {
      failures.push(`session.context: ${e?.message ?? e}`)
    }
  }
  try {
    return replyFrom(await httpMessages(sessionID))
  } catch (e) {
    failures.push(`http: ${e?.message ?? e}`)
  }
  throw new Error(failures.join("; ") || "no way to read the session's messages")
}

// ---- running a job ----

function modelRef(text) {
  return text ? parseModel(text) : undefined
}

const modelText = (m) => (m?.providerID && m?.id ? `${m.providerID}/${m.id}${m.variant ? `#${m.variant}` : ""}` : undefined)

function context() {
  return shared.contexts.values().next().value
}

const eventJob = (job) => ({ id: job.id, name: job.name, notify: job.notify })

function emit(name, data) {
  for (const reg of shared.registrations) reg.events.emit(name, data).catch(() => {})
}

async function hasPresence() {
  let at = shared.presenceAt
  if (Date.now() - at >= PRESENCE_MS) {
    const file = await readJson(presenceFile(config.stateDir), undefined).catch(() => undefined)
    at = Math.max(at, Number(file?.ts) || 0)
  }
  return Date.now() - at < PRESENCE_MS
}

async function osNotify(job, title, body) {
  try {
    if (await hasPresence()) return
    await (shared.notify ?? notify)({ title, body })
  } catch (e) {
    log("notify failed:", e?.message ?? e)
  }
}

const duration = (ms) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

async function startSession(job, trigger) {
  const ctx = context()
  if (!ctx) throw new Error("no OpenCode location is loaded to run the job in")
  const stamp = new Date().toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
  const session = unwrap(
    await ctx.session.create({
      title: `⏰ ${job.name} · ${stamp}`,
      location: { directory: job.directory },
      ...(job.agent ? { agent: job.agent } : {}),
      ...(job.model ? { model: modelRef(job.model) } : {}),
      metadata: { plugin: PLUGIN_ID, job: job.id, trigger },
    }),
  )
  const sessionID = session?.id
  if (!sessionID) throw new Error("the server didn't return a session id")
  return { ctx, sessionID, title: session.title ?? `⏰ ${job.name} · ${stamp}`, model: modelText(session.model) }
}

async function runJob(job, trigger, scheduledFor) {
  const run = {
    id: randomUUID().slice(0, 8),
    jobId: job.id,
    trigger,
    ...(scheduledFor !== undefined ? { scheduledFor } : {}),
    startedAt: Date.now(),
    status: "running",
    directory: job.directory,
    ...(job.agent ? { agent: job.agent } : {}),
    ...(job.model ? { model: job.model } : {}),
  }
  let started
  try {
    started = await startSession(job, trigger)
  } catch (e) {
    run.status = "failed_to_start"
    run.error = e?.message ?? String(e)
    run.finishedAt = Date.now()
    run.durationMs = run.finishedAt - run.startedAt
    log(`job ${job.id} (${job.name}) failed to start:`, run.error)
    await addRun(run).catch((err) => log("couldn't write the run log:", err.message))
    emit("runFinished", { run, job: eventJob(job) })
    emit("changed", { id: job.id })
    if (job.notify.enabled && job.notify.onFinish) await osNotify(job, `${job.name} couldn't start`, run.error)
    return run
  }
  run.sessionID = started.sessionID
  run.sessionTitle = started.title
  if (started.model) run.model = started.model
  await addRun(run)
  // The prompt runs in the background; the session shows its progress.
  Promise.resolve(started.ctx.session.prompt({ sessionID: started.sessionID, text: job.prompt })).catch((e) => {
    const error = e?.message ?? String(e)
    log(`job ${job.id}: prompt failed:`, error)
    finishRun(job, run, { status: "failed", error }).catch(() => {})
  })
  emit("runStarted", { run: { ...run }, job: eventJob(job) })
  emit("changed", { id: job.id })
  if (job.notify.enabled && job.notify.onStart) osNotify(job, `Started: ${job.name}`, job.prompt.split("\n")[0])
  track(run, () => watch(job, run))
  return { ...run }
}

function track(run, fn) {
  if (shared.monitoring.has(run.id)) return
  shared.monitoring.add(run.id)
  const p = fn()
    .catch((e) => log(`run ${run.id}: ${e?.message ?? e}`))
    .finally(() => {
      shared.monitoring.delete(run.id)
      shared.pending.delete(p)
    })
  shared.pending.add(p)
}

/** Waits until the session is idle with an outcome. Resolves { info, outcome }, or { missing: true }. */
async function settle(sessionID, startedAt) {
  const ctx = context()
  let waiting = typeof ctx?.session?.wait === "function"
  let quick = 0
  for (;;) {
    const began = Date.now()
    if (waiting) {
      try {
        await ctx.session.wait({ sessionID })
      } catch (e) {
        log(`session.wait failed (${e?.message ?? e}); polling instead`)
        waiting = false
      }
    }
    if (!waiting) await sleep(config.pollMs)
    let info
    try {
      info = unwrap(await ctx.session.get({ sessionID }))
    } catch (e) {
      if (/not.?found|404|no session/i.test(`${e?.name} ${e?.message} ${e?.status}`)) return { missing: true }
      log(`session.get failed: ${e?.message ?? e}`)
      await sleep(config.pollMs)
      continue
    }
    if (!info?.id) return { missing: true }
    const t = info.time ?? {}
    const outcome = info.outcome ?? (t.idle !== undefined && t.busy !== undefined && t.idle >= t.busy ? "succeeded" : undefined)
    if (outcome) return { info, outcome }
    // wait() returned but the session has no result yet (it hadn't started working, or went idle between turns).
    if (waiting && Date.now() - began < 1000 && ++quick > 60) throw new Error("the session never started working")
    if (t.busy === undefined && Date.now() - startedAt > 10 * 60_000) throw new Error("the session never started working")
    if (waiting) await sleep(config.retryMs)
  }
}

const tokensOf = (t) =>
  t ? { input: t.input ?? 0, output: t.output ?? 0, reasoning: t.reasoning ?? 0, cacheRead: t.cache?.read ?? 0, cacheWrite: t.cache?.write ?? 0 } : undefined

async function watch(job, run) {
  let result
  try {
    result = await settle(run.sessionID, run.startedAt)
  } catch (e) {
    await finishRun(job, run, { status: "failed", error: e?.message ?? String(e) })
    return
  }
  if (result.missing) {
    await finishRun(job, run, { status: "interrupted", error: "the session no longer exists" })
    return
  }
  await finishRun(job, run, fromInfo(result.info, result.outcome))
}

function fromInfo(info, outcome) {
  return {
    status: outcome === "failed" ? "failed" : outcome === "interrupted" ? "interrupted" : "succeeded",
    ...(tokensOf(info.tokens) ? { tokens: tokensOf(info.tokens) } : {}),
    ...(typeof info.cost === "number" ? { cost: info.cost } : {}),
    ...(modelText(info.model) ? { model: modelText(info.model) } : {}),
    ...(outcome === "failed" ? { error: "the session ended with an error" } : {}),
  }
}

async function finishRun(job, run, patch) {
  const finishedAt = Date.now()
  const wantsResult = job.notify.enabled && job.notify.onFinish && job.notify.showResult
  let result
  if (run.sessionID && (wantsResult || patch.status === "failed")) {
    try {
      const reply = await readReply(run.sessionID)
      if (wantsResult && reply.text) result = reply.text.slice(0, RESULT_LIMIT)
      if (patch.status === "failed" && reply.error) patch = { ...patch, error: String(reply.error).slice(0, 500) }
    } catch (e) {
      log(`run ${run.id}: couldn't read the reply: ${e.message}`)
    }
  }
  const saved = await patchRun(job.id, run.id, { ...patch, finishedAt, durationMs: finishedAt - run.startedAt })
  if (!saved) return undefined
  const current = (await load().catch(() => [])).find((j) => j.id === job.id) ?? job
  emit("runFinished", { run: saved, job: eventJob(current), ...(wantsResult && result ? { result } : {}) })
  emit("changed", { id: job.id })
  if (current.notify.enabled && current.notify.onFinish) {
    const ok = saved.status === "succeeded"
    const title = `${current.name}: ${ok ? "finished" : saved.status === "interrupted" ? "interrupted" : "failed"}`
    const body = result && current.notify.showResult ? result : (saved.error ?? `Took ${duration(saved.durationMs)}`)
    await osNotify(current, title, body)
  }
  return saved
}

/** Runs left "running" by an earlier server process: finish them from the session, or mark them interrupted. */
async function recover() {
  const ctx = context()
  if (!ctx) return
  for (const job of await load()) {
    for (const run of await readLog(job.id)) {
      if (run.status !== "running" || shared.monitoring.has(run.id)) continue
      if (!run.sessionID) {
        await finishRun(job, run, { status: "interrupted", error: "the server stopped before the session started" })
        continue
      }
      let info
      try {
        info = unwrap(await ctx.session.get({ sessionID: run.sessionID }))
      } catch {
        info = undefined
      }
      if (!info?.id) await finishRun(job, run, { status: "interrupted", error: "the session no longer exists" })
      else if (info.outcome) await finishRun(job, run, fromInfo(info, info.outcome))
      else track(run, () => watch(job, run))
    }
  }
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
  const path = leaderFile(config.stateDir)
  const me = { pid: process.pid, host: hostname() }
  const current = await readJson(path, undefined).catch(() => undefined)
  const stale =
    !current || current.host !== me.host || Date.now() - (current.ts ?? 0) > config.tickMs * 4 || !alive(current.pid)
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
    const now = Date.now()
    const jobs = await load()
    // Announce jobs that just ran out of occurrences.
    for (const job of jobs) {
      const status = derive(job, now).status
      const before = shared.statuses.get(job.id)
      shared.statuses.set(job.id, status)
      if (before && before !== "expired" && status === "expired") emit("changed", { id: job.id })
    }
    if (!(await lead())) return
    if (!shared.recovered) {
      shared.recovered = true
      await recover().catch((e) => log("recovery failed:", e?.message ?? e))
    }
    for (const job of jobs) {
      if (!job.enabled) continue
      try {
        const after = job.firedUpTo ?? job.createdAt ?? 0
        const first = Schedule.next(job.schedule, after)
        if (first === undefined || first > now) continue
        // Several occurrences may have passed (OpenCode was off): run once, for the most recent.
        const due = Schedule.previous(job.schedule, now, after)
        if (due === undefined) continue
        const claimed = await mutate((all) => {
          const j = all.find((x) => x.id === job.id)
          if (!j || (j.firedUpTo ?? j.createdAt ?? 0) !== after) return undefined
          j.firedUpTo = now
          return { ...j }
        })
        if (claimed) await runJob(claimed, "schedule", due)
      } catch (e) {
        log(`job ${job.id}: ${e?.message ?? e}`)
      }
    }
  } catch (e) {
    log("tick failed:", e?.message ?? e)
  } finally {
    shared.busy = false
  }
}

// ---- RPC for the panel ----

async function listOutput() {
  const jobs = await load()
  const leader = await readJson(leaderFile(config.stateDir), undefined).catch(() => undefined)
  const now = Date.now()
  return {
    now,
    timezone: Schedule.systemTimezone(),
    stateDir: config.stateDir,
    leader: leader ? { pid: leader.pid, self: leader.pid === process.pid, ts: leader.ts } : undefined,
    jobs: await Promise.all(jobs.map((j) => present(j, now))),
  }
}

function previewOutput(schedule, count) {
  const normalized = Schedule.normalize(schedule)
  const error = Schedule.validate(normalized)
  if (error) return { ok: false, error }
  const n = Math.min(50, Math.max(1, Math.floor(Number(count) || 5)))
  return {
    ok: true,
    description: Schedule.describe(normalized),
    runs: Schedule.occurrences(normalized, Date.now() + 1, Number.MAX_SAFE_INTEGER / 2, n),
  }
}

async function occurrencesOutput(from, to) {
  const now = Date.now()
  const jobs = await load()
  const perJob = Math.max(20, Math.floor(500 / Math.max(1, jobs.length)))
  const out = { items: [], runs: [] }
  for (const job of jobs) {
    const { status } = derive(job, now)
    if (status !== "expired") {
      for (const at of Schedule.occurrences(job.schedule, Math.max(from, now + 1), to, perJob)) {
        out.items.push({ jobId: job.id, name: job.name, at, status })
      }
    }
    for (const r of await readLog(job.id)) {
      if (r.startedAt >= from && r.startedAt <= to) out.runs.push({ ...summary(r), jobId: job.id, name: job.name })
    }
  }
  out.items.sort((a, b) => a.at - b.at)
  out.items = out.items.slice(0, 500)
  out.runs.sort((a, b) => a.startedAt - b.startedAt)
  return out
}

async function presence() {
  const now = Date.now()
  const throttled = now - shared.presenceAt < 10_000
  shared.presenceAt = now
  if (!throttled) await writeJson(presenceFile(config.stateDir), { ts: now, pid: process.pid }).catch(() => {})
  return { ok: true }
}

// ---- tools for the agent ----

const text = (content) => ({ content })
const when = (ms, tz) => (ms === undefined ? "-" : `${Schedule.wallString(ms, tz).replace("T", " ")} ${tz}`)

function formatJob(j) {
  const tz = j.schedule.timezone
  const last = j.lastRun ? `${when(j.lastRun.startedAt, tz)} (${j.lastRun.status})` : "never"
  const prompt = j.prompt.length > 160 ? j.prompt.slice(0, 160) + "…" : j.prompt
  return [
    `- ${j.name} [${j.id}] status: ${j.status}`,
    `  schedule: ${j.description}`,
    `  next: ${when(j.nextRun, tz)}; last: ${last}`,
    `  dir: ${j.directory}${j.agent ? `; agent: ${j.agent}` : ""}${j.model ? `; model: ${j.model}` : ""}`,
    `  notify: ${j.notify.enabled ? [j.notify.onStart && "on start", j.notify.onFinish && "on finish", j.notify.showResult && "with result"].filter(Boolean).join(", ") || "on" : "off"}`,
    `  prompt: ${prompt}`,
  ].join("\n")
}

function formatRun(r, tz) {
  const bits = [`${when(r.startedAt, tz)}`, r.status, r.trigger]
  if (r.durationMs !== undefined) bits.push(duration(r.durationMs))
  if (r.tokens) bits.push(`tokens in/out/reasoning ${r.tokens.input}/${r.tokens.output}/${r.tokens.reasoning}`)
  if (r.cost !== undefined) bits.push(`$${r.cost.toFixed(4)}`)
  if (r.model) bits.push(r.model)
  if (r.sessionID) bits.push(`session ${r.sessionID}`)
  if (r.error) bits.push(`error: ${r.error}`)
  return `- ${bits.join(" | ")}`
}

function tools(ctx) {
  const here = () => ctx.location?.directory
  const zone = Schedule.systemTimezone()
  return (editor) => {
    editor.add({
      name: "schedule_job",
      description:
        "Create or update a scheduled job. When a run is due, OpenCode starts a NEW session in `directory` and sends `prompt` to it, so the prompt must be self-contained. " +
        `Times are wall-clock in \`timezone\` (default: the user's system zone, ${zone}). Use the current date and time from the conversation to pick \`start\`. ` +
        '`start` is "YYYY-MM-DD HH:MM" or "YYYY-MM-DDTHH:MM" (24-hour): the first run, or the only run when repeat is "none". ' +
        '`repeat`: "none" (once, the default), "minutes" or "hours" (every `interval` of them from start), "daily" (every day at start\'s time), ' +
        '"weekly" (every week on start\'s weekday), "monthly" (the 1st of each month at start\'s time), or "cron" (advanced; give a 5-field `cron` expression such as "0 9 * * 1-5", evaluated in `timezone`; `start` may then be omitted and defaults to now). ' +
        "`end` (same format, optional) is the last moment a run may happen; it is ignored when repeat is none. " +
        "A job with no future run is shown as expired but stays in the list; update it with a new start/end to revive it. " +
        "Pass `id` to update an existing job: only the fields you give change (for schedule fields, the rest of the schedule is kept; pass an empty string to clear `end`, `agent` or `model`). " +
        "Set `notify` true to get an operating-system notification when a run starts and/or finishes (`notifyOnStart`, `notifyOnFinish`, `notifyShowResult` to include the final reply).",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing job id to update; omit to create a job." },
          name: { type: "string", description: "Short name for the job." },
          prompt: { type: "string", description: "The prompt each run sends. Make it self-contained: the run starts a fresh session." },
          start: { type: "string", description: 'First run, "YYYY-MM-DD HH:MM" or "YYYY-MM-DDTHH:MM", wall-clock in `timezone`.' },
          timezone: { type: "string", description: `IANA time zone such as America/New_York. Default: ${zone}.` },
          repeat: { type: "string", enum: Schedule.REPEATS, description: "none (once), minutes, hours, daily, weekly, monthly or cron." },
          interval: { type: "integer", minimum: 1, description: 'For repeat "minutes" or "hours": run every N of them.' },
          cron: { type: "string", description: 'For repeat "cron": a 5-field cron expression (minute hour day-of-month month day-of-week).' },
          end: { type: "string", description: 'No runs after this time ("YYYY-MM-DD HH:MM", in `timezone`). Empty string clears it.' },
          directory: { type: "string", description: "Project directory the session runs in. Defaults to the current project." },
          agent: { type: "string", description: "Agent to use (e.g. build, plan). Defaults to the default agent." },
          model: { type: "string", description: "provider/model, optionally #variant. Defaults to the default model." },
          enabled: { type: "boolean", description: "False pauses the job." },
          notify: { type: "boolean", description: "Send an operating-system notification for this job's runs." },
          notifyOnStart: { type: "boolean", description: "Notify when a run starts." },
          notifyOnFinish: { type: "boolean", description: "Notify when a run finishes (default when notify is on)." },
          notifyShowResult: { type: "boolean", description: "Include the run's final reply in the finish notification." },
          schedule: { type: "string", description: "Deprecated: a legacy schedule string (cron, @daily, every 30m, at YYYY-MM-DD HH:MM). Prefer start/repeat." },
        },
      },
      async execute(input) {
        const job = { ...input }
        for (const key of ["start", "timezone", "repeat", "interval", "cron", "end"]) delete job[key]
        delete job.notify
        delete job.notifyOnStart
        delete job.notifyOnFinish
        delete job.notifyShowResult
        const fields = {}
        for (const key of ["start", "timezone", "repeat", "interval", "cron", "end"]) if (input[key] !== undefined) fields[key] = input[key]
        if (Object.keys(fields).length) {
          if (input.schedule !== undefined) throw new Error("give either `schedule` or start/repeat, not both")
          if (!input.id && fields.start === undefined && (fields.repeat ?? "none") === "cron") fields.start = Schedule.wallString(Date.now(), fields.timezone || zone)
          if (!input.id && fields.start === undefined) throw new Error("a new job needs `start` (for example \"2026-11-09 09:00\")")
          job.schedule = fields
        }
        if (input.notify !== undefined || input.notifyOnStart !== undefined || input.notifyOnFinish !== undefined || input.notifyShowResult !== undefined) {
          job.notify = {
            ...(input.notify !== undefined ? { enabled: input.notify } : input.notifyOnStart || input.notifyOnFinish || input.notifyShowResult ? { enabled: true } : {}),
            ...(input.notifyOnStart !== undefined ? { onStart: input.notifyOnStart } : {}),
            ...(input.notifyOnFinish !== undefined ? { onFinish: input.notifyOnFinish } : {}),
            ...(input.notifyShowResult !== undefined ? { showResult: input.notifyShowResult } : {}),
          }
        }
        if (!input.id && (job.schedule === undefined || !input.prompt)) throw new Error("a new job needs `prompt` and `start`")
        let saved
        try {
          saved = await saveJob(job, here())
        } catch (e) {
          if (e.invalid) throw new Error(`Invalid job: ${e.message}`)
          throw e
        }
        return text(`Saved job:\n${formatJob(saved)}`)
      },
    })
    editor.add({
      name: "list_scheduled_jobs",
      description: "List scheduled jobs with their status (scheduled, paused or expired), schedule, next run, last run and notification settings.",
      input: { type: "object", properties: {} },
      async execute() {
        const { jobs, now } = await listOutput()
        const head = `Now: ${when(now, zone)}`
        return text(jobs.length ? `${head}\n${jobs.map(formatJob).join("\n")}` : `${head}\nNo scheduled jobs.`)
      },
    })
    editor.add({
      name: "remove_scheduled_job",
      description: "Delete a scheduled job and its run history, by id. This cannot be undone; to stop a job temporarily, use schedule_job with enabled=false instead.",
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async execute(input) {
        const removed = await removeJob(input.id)
        return text(removed ? `Removed "${removed.name}".` : `No job with id ${input.id}.`)
      },
    })
    editor.add({
      name: "run_scheduled_job",
      description: "Run a scheduled job right now, in a new session, without changing its schedule. Returns once the session has started, not when it finishes.",
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async execute(input) {
        const job = (await load()).find((j) => j.id === input.id)
        if (!job) throw new Error(`No job with id ${input.id}.`)
        const run = await runJob(job, "manual")
        return text(run.status === "failed_to_start" ? `Couldn't start: ${run.error}` : `Started session ${run.sessionID} (run ${run.id}).`)
      },
    })
    editor.add({
      name: "scheduled_job_logs",
      description:
        "Show a scheduled job's recent runs, newest first: start time, status, duration, token use, cost, model, session id and any error. The model's output is not stored; open the session to read it.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job id." },
          limit: { type: "integer", minimum: 1, description: "How many runs to show (default 10)." },
        },
        required: ["id"],
      },
      async execute(input) {
        const job = (await load()).find((j) => j.id === input.id)
        if (!job) throw new Error(`No job with id ${input.id}.`)
        const runs = (await readLog(job.id)).slice(0, Math.max(1, Math.floor(Number(input.limit) || 10)))
        return text(runs.length ? `Runs of "${job.name}":\n${runs.map((r) => formatRun(r, job.schedule.timezone)).join("\n")}` : `"${job.name}" has not run yet.`)
      },
    })
  }
}

export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const opts = ctx.options ?? {}
    config = {
      stateDir: resolveStateDir(opts.stateDir),
      tickMs: Math.max(0.05, Number(opts.tickSeconds ?? 20)) * 1000,
      history: Math.max(1, Math.floor(Number(opts.history ?? 200))),
      pollMs: Math.max(10, Number(opts.pollSeconds ?? 5) * 1000),
      retryMs: Math.max(10, Number(opts.retrySeconds ?? 2) * 1000),
    }

    const registrations = []
    registrations.push(await ctx.tool.transform(tools(ctx)))
    const rpc = await ctx.rpc.register(Scheduler, {
      list: async () => json(await listOutput()),
      save: async (input, c) => {
        try {
          return json({ job: await saveJob(input.job, ctx.location?.directory) })
        } catch (e) {
          if (e.invalid) return c.error("invalid", e.message, {})
          throw e
        }
      },
      remove: async (input) => ({ removed: Boolean(await removeJob(input.id)) }),
      run: async (input, c) => {
        try {
          const job = (await load()).find((j) => j.id === input.id)
          if (!job) return c.error("failed", `no job with id ${input.id}`, {})
          const run = await runJob(job, "manual")
          return run.status === "failed_to_start" ? c.error("failed", run.error ?? "couldn't start", {}) : json({ run })
        } catch (e) {
          return c.error("failed", e?.message ?? String(e), {})
        }
      },
      preview: async (input) => json(previewOutput(input.schedule, input.count)),
      occurrences: async (input) => json(await occurrencesOutput(Number(input.from), Number(input.to))),
      logs: async (input) => json({ runs: (await readLog(input.id)).slice(0, Math.max(1, Math.floor(Number(input.limit) || config.history))) }),
      result: async (input, c) => {
        try {
          const reply = await readReply(input.sessionID)
          return { text: reply.text }
        } catch (e) {
          return c.error("unavailable", e?.message ?? "couldn't read the session", {})
        }
      },
      presence: async () => presence(),
    })
    registrations.push(rpc)
    shared.registrations.add(rpc)
    shared.contexts.add(ctx)

    if (!shared.timer) {
      shared.timer = setInterval(tick, config.tickMs)
      shared.timer.unref?.()
      if (!opts.noAutoTick) setTimeout(tick, 2000).unref?.()
      log("loaded; state in", config.stateDir)
    }

    return async () => {
      shared.contexts.delete(ctx)
      shared.registrations.delete(rpc)
      for (const r of registrations) await r.dispose().catch(() => {})
      if (shared.contexts.size === 0 && shared.timer) {
        clearInterval(shared.timer)
        shared.timer = undefined
        shared.recovered = false
        shared.statuses.clear()
        shared.cache.clear()
        const leader = await readJson(leaderFile(config.stateDir), undefined).catch(() => undefined)
        if (leader?.pid === process.pid) await rm(leaderFile(config.stateDir), { force: true }).catch(() => {})
      }
    }
  },
}
