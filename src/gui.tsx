// The scheduler's desktop-app UI: a "Scheduler" side panel in sessions, the same view as a Settings page,
// and a palette / slash command (/schedules) that opens the panel.
import { Command, MenuItem, Panel, Plugin, SettingsPage, Style, TitlebarItem, type Context } from "@opencode/plugin/gui"
import { createSignal, createResource, For, Show, onCleanup, createEffect, on } from "solid-js"
import { Scheduler } from "./rpc.js"
import css from "./gui.css?inline"

type Run = { at: number; trigger: string; status: "started" | "failed"; sessionID?: string; error?: string }
type Job = {
  id: string
  name: string
  schedule: string
  description?: string
  prompt: string
  directory: string
  agent?: string
  model?: string
  enabled: boolean
  nextRun?: number
  runs?: Run[]
}
type Draft = Partial<Job>
type ListOutput = { now: number; stateFile: string; jobs: Job[]; leader?: { pid: number; self: boolean; ts: number } }

const TAB = "jobs"

function relative(t: number | undefined, now: number) {
  if (!t) return "—"
  const s = Math.round((t - now) / 1000)
  const abs = Math.abs(s)
  const unit = abs < 60 ? [s, "second"] : abs < 3600 ? [Math.round(s / 60), "minute"] : abs < 86400 ? [Math.round(s / 3600), "hour"] : [Math.round(s / 86400), "day"]
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(unit[0] as number, unit[1] as Intl.RelativeTimeFormatUnit)
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
const message = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as any).message) : String(e))

const OFFLINE_NOTE =
  "Jobs only run while OpenCode is running (the background service or the desktop app). If a run is missed while it's off, the job runs once when OpenCode is back and then returns to its normal schedule."

function JobsView(props: { ctx: Context; directory?: () => string | undefined; server?: () => string | undefined; hideTitle?: boolean }) {
  const { ctx } = props
  const ui = ctx.ui
  const rpc = () => {
    const dir = props.directory?.()
    const client = ctx.client.rpc(Scheduler as any) as any
    const opts = dir ? { location: { directory: dir } } : undefined
    return {
      list: () => client.list({}, opts) as Promise<ListOutput>,
      save: (job: Draft) => client.save({ job }, opts),
      remove: (id: string) => client.remove({ id }, opts),
      run: (id: string) => client.run({ id }, opts) as Promise<{ run: Run }>,
      preview: (schedule: string) => client.preview({ schedule }, opts) as Promise<{ ok: boolean; error?: string; description?: string; runs?: number[] }>,
      events: client.events,
    }
  }

  const [data, { refetch }] = createResource(() => rpc().list())
  const [now, setNow] = createSignal(Date.now())
  const [draft, setDraft] = createSignal<Draft | undefined>()
  const [saving, setSaving] = createSignal(false)
  const [busy, setBusy] = createSignal<string | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const [preview, setPreview] = createSignal<{ ok: boolean; error?: string; description?: string; runs?: number[] }>()

  const timer = setInterval(() => {
    setNow(Date.now())
    void refetch()
  }, 15_000)
  onCleanup(() => clearInterval(timer))

  // Live updates from the server half running in the app's own server.
  const abort = new AbortController()
  onCleanup(() => abort.abort())
  try {
    const events = rpc().events
    events.on("changed", () => void refetch(), { signal: abort.signal })
    events.on(
      "ran",
      (event: any) => {
        const d = event.data ?? {}
        const server = props.server?.()
        if (d.status === "failed") ctx.toast.show({ title: `"${d.name}" failed to start`, description: d.error, variant: "error" } as any)
        else
          void ctx.attention.notify({
            title: `Scheduled job started: ${d.name}`,
            id: `${d.id}:${d.at}`,
            ...(server && d.sessionID ? { session: { server, id: d.sessionID } } : {}),
          })
      },
      { signal: abort.signal },
    )
  } catch {
    // Events are a nicety; polling keeps the list current without them.
  }

  // Validate the schedule while typing.
  let previewSeq = 0
  createEffect(
    on(
      () => draft()?.schedule,
      (schedule) => {
        const seq = ++previewSeq
        if (!schedule?.trim()) return setPreview(undefined)
        const t = setTimeout(() => {
          rpc()
            .preview(schedule)
            .then((p) => seq === previewSeq && setPreview(p))
            .catch(() => {})
        }, 250)
        onCleanup(() => clearTimeout(t))
      },
    ),
  )

  const startNew = () => {
    setError(undefined)
    setDraft({ name: "", schedule: "@daily", prompt: "", directory: props.directory?.() ?? "", enabled: true })
  }
  const edit = (job: Job) => {
    setError(undefined)
    setDraft({ ...job })
  }
  const patch = (fields: Draft) => setDraft((d) => ({ ...d, ...fields }))

  async function save() {
    const d = draft()
    if (!d) return
    setSaving(true)
    setError(undefined)
    try {
      const { id, name, schedule, prompt, directory, agent, model, enabled } = d
      await rpc().save({ id, name, schedule, prompt, directory, agent, model, enabled })
      setDraft(undefined)
      await refetch()
    } catch (e) {
      setError(message(e))
    } finally {
      setSaving(false)
    }
  }

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id)
    setError(undefined)
    try {
      await fn()
      await refetch()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(undefined)
    }
  }

  const toggle = (job: Job, enabled: boolean) => act(job.id, () => rpc().save({ id: job.id, enabled }))
  const runNow = (job: Job) =>
    act(job.id, async () => {
      const { run } = await rpc().run(job.id)
      const server = props.server?.()
      if (server && run.sessionID) ctx.tabs.open({ server, id: run.sessionID }, { focus: true })
      else ctx.toast.show({ title: `Started "${job.name}"` } as any)
    })
  const remove = async (job: Job) => {
    if (!(await ctx.dialogs.confirm({ title: `Delete "${job.name}"?`, description: "Its schedule and run history are removed.", confirm: "Delete", danger: true })))
      return
    await act(job.id, () => rpc().remove(job.id))
  }
  const openRun = (run: Run) => {
    const server = props.server?.()
    if (server && run.sessionID) ctx.tabs.open({ server, id: run.sessionID }, { focus: true })
  }

  return (
    <div class="sched">
      <div class="sched-head">
        <div class="sched-title">
          <Show when={!props.hideTitle}>
            <ui.Icon name="task" />
            <span>Scheduled jobs</span>
          </Show>
        </div>
        <div class="sched-actions">
          <ui.IconButton icon="refresh" label="Refresh" onClick={() => void refetch()} />
          <ui.Button size="small" icon="plus" onClick={startNew} disabled={!!draft()}>
            New job
          </ui.Button>
        </div>
      </div>

      <Show when={error()}>
        <div class="sched-error">{error()}</div>
      </Show>

      <Show when={draft()}>
        {(d) => (
          <form
            class="sched-form"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <label>
              <span>Name</span>
              <ui.TextInput label="Name" value={d().name ?? ""} placeholder="Morning triage" onInput={(v) => patch({ name: v })} autofocus />
            </label>
            <label>
              <span>Schedule</span>
              <ui.TextInput
                label="Schedule"
                value={d().schedule ?? ""}
                placeholder="0 9 * * 1-5 · @daily · every 30m · at 2026-11-09 09:00"
                invalid={preview()?.ok === false}
                onInput={(v) => patch({ schedule: v })}
              />
              <span class="sched-hint">
                <Show when={preview()} fallback="Cron (min hour day month weekday), @hourly/@daily/@weekly/@weekdays, every 30m, or at <date>">
                  {(p) =>
                    p().ok ? `${p().description} — next: ${(p().runs ?? []).map(when).join(", ") || "none"}` : <span class="sched-bad">{p().error}</span>
                  }
                </Show>
              </span>
            </label>
            <label>
              <span>Prompt</span>
              <textarea
                class="sched-textarea"
                rows={5}
                value={d().prompt ?? ""}
                placeholder="What should the agent do each run? Each run starts a fresh session."
                onInput={(e) => patch({ prompt: e.currentTarget.value })}
              />
            </label>
            <label>
              <span>Project directory</span>
              <ui.TextInput label="Project directory" value={d().directory ?? ""} placeholder="/path/to/project" onInput={(v) => patch({ directory: v })} />
            </label>
            <div class="sched-row2">
              <label>
                <span>Agent (optional)</span>
                <ui.TextInput label="Agent" value={d().agent ?? ""} placeholder="build" onInput={(v) => patch({ agent: v })} />
              </label>
              <label>
                <span>Model (optional)</span>
                <ui.TextInput label="Model" value={d().model ?? ""} placeholder="provider/model#variant" onInput={(v) => patch({ model: v })} />
              </label>
            </div>
            <div class="sched-form-actions">
              <ui.Button variant="ghost" onClick={() => setDraft(undefined)}>
                Cancel
              </ui.Button>
              <ui.Button variant="contrast" type="submit" busy={saving()} disabled={!d().prompt?.trim() || preview()?.ok === false}>
                {d().id ? "Save" : "Create job"}
              </ui.Button>
            </div>
          </form>
        )}
      </Show>

      <Show when={data.error}>
        <div class="sched-error">Can't reach the scheduler: {message(data.error)}</div>
      </Show>

      <Show when={data()}>
        {(list) => (
          <>
            <Show when={list().jobs.length === 0 && !draft()}>
              <div class="sched-empty">
                No jobs yet. Create one here, or ask the agent: "schedule a job every weekday at 9 that summarizes open PRs".
              </div>
            </Show>
            <ul class="sched-list">
              <For each={list().jobs}>
                {(job) => {
                  const last = () => job.runs?.[0]
                  return (
                    <li class="sched-job" classList={{ "sched-paused": !job.enabled }}>
                      <div class="sched-job-top">
                        <div class="sched-job-name">
                          <strong>{job.name}</strong>
                          <span class="sched-muted">{job.description ?? job.schedule}</span>
                        </div>
                        <ui.Switch label="Enabled" hideLabel checked={job.enabled} disabled={busy() === job.id} onChange={(v) => void toggle(job, v)} />
                      </div>
                      <div class="sched-meta">
                        <span>
                          Next: <span title={job.nextRun ? when(job.nextRun) : ""}>{job.enabled ? relative(job.nextRun, now()) : "paused"}</span>
                        </span>
                        <span>
                          Last:{" "}
                          <Show when={last()} fallback="never">
                            {(r) => (
                              <a
                                href="#"
                                class={r().status === "failed" ? "sched-bad" : ""}
                                title={r().error ?? when(r().at)}
                                onClick={(e) => {
                                  e.preventDefault()
                                  openRun(r())
                                }}
                              >
                                {relative(r().at, now())}
                                {r().status === "failed" ? " (failed)" : ""}
                              </a>
                            )}
                          </Show>
                        </span>
                      </div>
                      <div class="sched-prompt">{job.prompt}</div>
                      <div class="sched-muted sched-dir" title={job.directory}>
                        {job.directory}
                        {job.agent ? ` · ${job.agent}` : ""}
                        {job.model ? ` · ${job.model}` : ""}
                      </div>
                      <div class="sched-job-actions">
                        <ui.Button size="small" busy={busy() === job.id} onClick={() => void runNow(job)}>
                          Run now
                        </ui.Button>
                        <ui.Button size="small" variant="ghost" icon="edit" onClick={() => edit(job)} disabled={!!draft()}>
                          Edit
                        </ui.Button>
                        <ui.Button size="small" variant="ghost" icon="trash" onClick={() => void remove(job)}>
                          Delete
                        </ui.Button>
                      </div>
                    </li>
                  )
                }}
              </For>
            </ul>
          </>
        )}
      </Show>

      <div class="sched-foot">
        <Show when={data()}>
          {(list) => (
            <div title={list().stateFile}>
              {list().leader ? `Runner: pid ${list().leader!.pid}${list().leader!.self ? " (this server)" : ""}` : "No runner yet"}
            </div>
          )}
        </Show>
        <div>{OFFLINE_NOTE}</div>
      </div>
    </div>
  )
}

export default Plugin.define({
  setup(ctx) {
    ctx.add(Style, css)

    const tab = { id: TAB, title: "Scheduler" }
    ctx.add(Panel, {
      id: TAB,
      region: "side",
      list: (input) => (input.open.includes(TAB) ? [tab] : []),
      render: (props) => <JobsView ctx={ctx} directory={() => props.session.directory} server={() => props.session.server.id} />,
    })

    ctx.add(SettingsPage, {
      id: "scheduler",
      title: "Scheduler",
      icon: "task",
      entries: [{ id: "scheduler", title: "Scheduled jobs", keywords: "cron schedule jobs timer recurring" }],
      render: () => (
        <ctx.ui.SettingsLayout title="Scheduler" description="Prompts that run on a schedule, each in a new session.">
          <JobsView ctx={ctx} directory={() => ctx.sessions.current()?.directory} server={() => ctx.sessions.current()?.server.id ?? ctx.servers.list().map((id) => ctx.servers.get(id)).find((s) => s?.builtin)?.id} />
        </ctx.ui.SettingsLayout>
      ),
    })

    const builtinServer = () => ctx.servers.list().map((id) => ctx.servers.get(id)).find((s) => s?.builtin)?.id

    // The job list in a dialog, so it opens from anywhere: the titlebar, the palette, or /schedules.
    let dialog: { close(): void } | undefined
    const openDialog = () => {
      dialog?.close()
      dialog = ctx.dialogs.open(() => (
        <ctx.ui.Dialog title="Scheduler" description="Prompts that run on a schedule, each in a new session." size="x-large">
          <JobsView
            ctx={ctx}
            hideTitle
            directory={() => ctx.sessions.current()?.directory}
            server={() => ctx.sessions.current()?.server.id ?? builtinServer()}
          />
        </ctx.ui.Dialog>
      ))
    }

    // A count of active jobs for the titlebar pill, refreshed every 30 seconds.
    const [active, setActive] = createSignal<number | undefined>()
    const refreshCount = () =>
      (ctx.client.rpc(Scheduler as any) as any)
        .list({})
        .then((r: ListOutput) => setActive(r.jobs.filter((j) => j.enabled).length))
        .catch(() => setActive(undefined))
    void refreshCount()
    const countTimer = setInterval(refreshCount, 30_000)
    onCleanup(() => clearInterval(countTimer))

    ctx.add(TitlebarItem, () => {
      const n = active()
      return {
        id: "scheduler",
        icon: "task" as const,
        label: n === undefined ? "Scheduler" : `Scheduler · ${n} active`,
        title: "Show scheduled jobs",
        run: openDialog,
      }
    })

    ctx.add(Command, {
      id: "open",
      title: "Scheduler: Show scheduled jobs",
      keywords: "cron schedule jobs timer",
      slash: { name: "schedules" },
      run: openDialog,
    })

    ctx.add(Command, {
      id: "panel",
      title: "Scheduler: Open in side panel",
      keywords: "cron schedule jobs timer",
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(`${ctx.id}:${TAB}`, session)
        else openDialog()
      },
    })

    // The side panel's + menu.
    ctx.add(MenuItem, {
      menu: "session.panel",
      id: "scheduler",
      title: "Scheduler",
      icon: "task",
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(`${ctx.id}:${TAB}`, session)
      },
    })
  },
})
