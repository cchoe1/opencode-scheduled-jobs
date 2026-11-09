import { createResource, createSignal, onCleanup, Show } from "solid-js"
import type { Context } from "@opencode/plugin/gui"
import { builtinServer, makeRpc, message, openSession } from "./rpc.js"
import { JobForm } from "./JobForm.js"
import { JobList } from "./JobList.js"
import { Calendar } from "./Calendar.js"
import { openLogsDialog } from "./LogsDialog.js"
import type { Actions, Env, Job } from "./types.js"

export const OFFLINE_NOTE =
  "Jobs only run while OpenCode is running (the background service or the desktop app). If a run is missed while it's off, the job runs once when OpenCode is back and then returns to its normal schedule."

type ViewMode = "list" | "calendar"
const VIEW_KEY = "local.scheduler.view"
const [view, setViewSignal] = createSignal<ViewMode>(
  (() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "calendar" ? "calendar" : "list"
    } catch {
      return "list"
    }
  })(),
)
const setView = (v: ViewMode) => {
  setViewSignal(v)
  try {
    localStorage.setItem(VIEW_KEY, v)
  } catch {}
}

export function JobsView(props: { ctx: Context; directory?: () => string | undefined; server?: () => string | undefined; hideTitle?: boolean }) {
  const { ctx } = props
  const ui = ctx.ui
  const env: Env = {
    ctx,
    rpc: makeRpc(ctx, props.directory),
    directory: () => props.directory?.(),
    server: () => props.server?.() ?? builtinServer(ctx),
  }

  const [data, { refetch }] = createResource(() => env.rpc.list())
  const [now, setNow] = createSignal(Date.now())
  const [tick, setTick] = createSignal(0)
  const [form, setForm] = createSignal<{ job?: Job } | undefined>()
  const [busy, setBusy] = createSignal<string | undefined>()
  const [error, setError] = createSignal<string | undefined>()

  const reload = () => {
    setTick((t) => t + 1)
    return refetch()
  }
  const timer = setInterval(() => {
    setNow(Date.now())
    void reload()
  }, 15_000)
  onCleanup(() => clearInterval(timer))

  const abort = new AbortController()
  onCleanup(() => abort.abort())
  try {
    env.rpc.events.on("changed", () => void reload(), { signal: abort.signal })
  } catch {
    // Polling keeps the list current without events.
  }

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id)
    setError(undefined)
    try {
      await fn()
      await reload()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(undefined)
    }
  }

  const actions: Actions = {
    busy,
    edit: (job) => {
      setError(undefined)
      setView("list")
      setForm({ job })
    },
    logs: (job) => void openLogsDialog(env, job),
    toggle: (job, enabled) => void act(job.id, () => env.rpc.save({ id: job.id, enabled })),
    run: (job) =>
      void act(job.id, async () => {
        const { run } = await env.rpc.run(job.id)
        if (run.sessionID) openSession(env, run.sessionID)
        else ctx.toast.show({ title: `Started "${job.name}"` })
      }),
    remove: async (job) => {
      const ok = await ctx.dialogs.confirm({
        title: `Delete "${job.name}"?`,
        description: "The job and its run history are deleted permanently. This can't be undone.",
        confirm: "Delete",
        danger: true,
      })
      if (ok) await act(job.id, () => env.rpc.remove(job.id))
    },
  }

  return (
    <div class="sched">
      <div class="sched-head">
        <div class="sched-title">
          <Show when={!props.hideTitle}>
            <ui.Icon name="task" />
            <span>Scheduled jobs</span>
          </Show>
          <div class="sched-seg" role="group" aria-label="View">
            <button type="button" classList={{ on: view() === "list" }} aria-pressed={view() === "list"} onClick={() => setView("list")}>
              List
            </button>
            <button type="button" classList={{ on: view() === "calendar" }} aria-pressed={view() === "calendar"} onClick={() => setView("calendar")}>
              Calendar
            </button>
          </div>
        </div>
        <div class="sched-actions">
          <ui.IconButton icon="refresh" label="Refresh" onClick={() => void reload()} />
          <ui.Button
            size="small"
            icon="plus"
            onClick={() => {
              setError(undefined)
              setView("list")
              setForm({})
            }}
            disabled={!!form()}
          >
            New job
          </ui.Button>
        </div>
      </div>

      <Show when={error()}>
        <div class="sched-error">{error()}</div>
      </Show>

      <Show when={form()}>
        {(f) => (
          <JobForm
            env={env}
            job={f().job}
            onCancel={() => setForm(undefined)}
            onSaved={() => {
              setForm(undefined)
              void reload()
            }}
          />
        )}
      </Show>

      <Show when={data.error}>
        <div class="sched-error">Can't reach the scheduler: {message(data.error)}</div>
      </Show>

      <Show when={data.latest}>
        {(list) => (
          <Show
            when={view() === "list"}
            fallback={<Calendar env={env} jobs={list().jobs} tick={tick()} actions={actions} />}
          >
            <Show when={list().jobs.length === 0 && !form()}>
              <div class="sched-empty">
                No jobs yet. Create one here, or ask the agent: "schedule a job every weekday at 9 that summarizes open PRs".
              </div>
            </Show>
            <JobList env={env} jobs={list().jobs} now={now()} actions={actions} formOpen={!!form()} />
          </Show>
        )}
      </Show>

      <div class="sched-foot">
        <Show when={data.latest}>
          {(list) => (
            <div title={list().stateDir}>
              {list().leader ? `Runner: pid ${list().leader!.pid}${list().leader!.self ? " (this server)" : ""}` : "No runner yet"}
            </div>
          )}
        </Show>
        <div>{OFFLINE_NOTE}</div>
      </div>
    </div>
  )
}
