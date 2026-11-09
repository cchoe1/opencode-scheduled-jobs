// Data shapes from docs/CONTRACT.md.
import type { Context } from "@opencode/plugin/gui"
import type { Rpc } from "./rpc.js"

export type Repeat = "none" | "minutes" | "hours" | "daily" | "weekly" | "monthly" | "cron"
export type Schedule = {
  start: string
  timezone: string
  repeat: Repeat
  interval?: number
  cron?: string
  end?: string | null
}
export type Notify = { enabled: boolean; onStart: boolean; onFinish: boolean; showResult: boolean }
export type RunStatus = "running" | "succeeded" | "failed" | "interrupted" | "failed_to_start"
export type RunSummary = { id: string; startedAt: number; finishedAt?: number; status: RunStatus; sessionID?: string; error?: string }
export type Run = RunSummary & {
  jobId: string
  trigger: "schedule" | "manual"
  scheduledFor?: number
  durationMs?: number
  sessionTitle?: string
  directory: string
  agent?: string
  model?: string
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  cost?: number
}
export type Job = {
  id: string
  name: string
  prompt: string
  directory: string
  agent?: string
  model?: string
  enabled: boolean
  schedule: Schedule
  notify: Notify
  createdAt: number
  updatedAt: number
  status: "scheduled" | "paused" | "expired"
  nextRun?: number
  lastRun?: RunSummary
  description: string
}
export type ListOutput = {
  now: number
  timezone: string
  stateDir: string
  jobs: Job[]
  leader?: { pid: number; self: boolean; ts: number }
}
export type Preview = { ok: true; description: string; runs: number[] } | { ok: false; error: string }
export type Occurrences = {
  items: { jobId: string; name: string; at: number; status: "scheduled" | "paused" }[]
  runs: (RunSummary & { jobId: string; name: string })[]
}
export type ModelOption = { ref: string; provider: string; name: string; variants: string[] }
export type ModelsOutput = { models: ModelOption[]; default?: string }
export type AgentOption = { id: string; name: string; description?: string; model?: string }
export type AgentsOutput = { agents: AgentOption[] }
export type JobEventInfo = { id: string; name: string; notify: Notify }

/** Everything the UI modules need from the plugin. */
export type Env = {
  ctx: Context
  rpc: Rpc
  directory: () => string | undefined
  /** The server id sessions of this view live on. */
  server: () => string | undefined
}
export type Actions = {
  edit(job: Job): void
  logs(job: Job): void
  run(job: Job): void
  remove(job: Job): void
  toggle(job: Job, enabled: boolean): void
  busy(): string | undefined
}
