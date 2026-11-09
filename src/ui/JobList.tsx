import { createMemo, createSignal, For, Show } from "solid-js"
import { fmt, relative, statusClass, statusLabel } from "./time.js"
import type { Actions, Env, Job } from "./types.js"

function JobRow(props: { env: Env; job: Job; now: number; actions: Actions; formOpen: boolean }) {
  const { ui } = props.env.ctx
  const job = () => props.job
  const expired = () => job().status === "expired"
  const busy = () => props.actions.busy() === job().id
  return (
    <li class="sched-job" classList={{ "sched-paused": job().status === "paused", "sched-expired": expired() }}>
      <div class="sched-job-top">
        <div class="sched-job-name">
          <strong>{job().name}</strong>
          <span class="sched-muted">{job().description}</span>
        </div>
        <Show when={!expired()}>
          <ui.Switch label="Enabled" hideLabel checked={job().enabled} disabled={busy()} onChange={(v) => props.actions.toggle(job(), v)} />
        </Show>
      </div>
      <div class="sched-meta">
        <span>
          Next:{" "}
          <Show when={job().nextRun && job().status === "scheduled"} fallback={job().status === "paused" ? "paused" : "—"}>
            <span title={fmt(job().nextRun!)}>{relative(job().nextRun, props.now)}</span>
          </Show>
        </span>
        <span>
          Last:{" "}
          <Show when={job().lastRun} fallback="never">
            {(r) => (
              <span title={`${fmt(r().startedAt)}${r().error ? "\n" + r().error : ""}`}>
                <span class={`sched-badge ${statusClass(r().status)}`}>{statusLabel[r().status] ?? r().status}</span> {relative(r().startedAt, props.now)}
              </span>
            )}
          </Show>
        </span>
      </div>
      <div class="sched-muted sched-dir" title={job().directory}>
        {job().directory}
        {job().agent ? ` · ${job().agent}` : ""}
        {job().model ? ` · ${job().model}` : ""}
      </div>
      <div class="sched-job-actions">
        <ui.Button size="small" busy={busy()} onClick={() => props.actions.run(job())}>
          Run now
        </ui.Button>
        <ui.Button size="small" variant="ghost" icon="edit" onClick={() => props.actions.edit(job())} disabled={props.formOpen}>
          Edit
        </ui.Button>
        <ui.Button size="small" variant="ghost" icon="bullet-list" onClick={() => props.actions.logs(job())}>
          Logs
        </ui.Button>
        <ui.Button size="small" variant="ghost" icon="trash" onClick={() => props.actions.remove(job())}>
          Delete
        </ui.Button>
      </div>
    </li>
  )
}

export function JobList(props: { env: Env; jobs: Job[]; now: number; actions: Actions; formOpen: boolean }) {
  const { ui } = props.env.ctx
  const [showExpired, setShowExpired] = createSignal(false)
  const scheduled = createMemo(() =>
    props.jobs.filter((j) => j.status !== "expired").sort((a, b) => (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity)),
  )
  // Newest first: by the last run if there is one, else by when the job was last touched.
  const expiredSorted = createMemo(() =>
    [...props.jobs.filter((j) => j.status === "expired")].sort(
      (a, b) => (b.lastRun?.startedAt ?? b.updatedAt) - (a.lastRun?.startedAt ?? a.updatedAt),
    ),
  )

  return (
    <>
      <section class="sched-section">
        <h3 class="sched-h">Scheduled</h3>
        <Show when={scheduled().length} fallback={<div class="sched-empty">No scheduled jobs.</div>}>
          <ul class="sched-list">
            <For each={scheduled()}>{(job) => <JobRow env={props.env} job={job} now={props.now} actions={props.actions} formOpen={props.formOpen} />}</For>
          </ul>
        </Show>
      </section>
      <section class="sched-section">
        <button type="button" class="sched-h sched-toggle" aria-expanded={showExpired()} onClick={() => setShowExpired((v) => !v)}>
          <ui.Icon name={showExpired() ? "chevron-down" : "chevron-right"} size="small" />
          <span>Expired</span>
          <span class="sched-count">{expiredSorted().length}</span>
        </button>
        <Show when={showExpired()}>
          <Show when={expiredSorted().length} fallback={<div class="sched-empty">Nothing has expired.</div>}>
            <ul class="sched-list">
              <For each={expiredSorted()}>{(job) => <JobRow env={props.env} job={job} now={props.now} actions={props.actions} formOpen={props.formOpen} />}</For>
            </ul>
          </Show>
        </Show>
      </section>
    </>
  )
}
