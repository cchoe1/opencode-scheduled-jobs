import { createResource, For, Show } from "solid-js"
import { duration, fmt, statusClass, statusLabel } from "./time.js"
import { message, openSession } from "./rpc.js"
import type { Env, Job, Run } from "./types.js"

const n = (x: number) => x.toLocaleString()

function RunRow(props: { env: Env; run: Run }) {
  const { ui } = props.env.ctx
  const r = () => props.run
  const t = () => r().tokens
  return (
    <li class="sched-run">
      <div class="sched-run-top">
        <span class={`sched-badge ${statusClass(r().status)}`}>{statusLabel[r().status] ?? r().status}</span>
        <span class="sched-muted">{r().trigger === "manual" ? "Manual" : "Scheduled"}</span>
        <span class="sched-spacer" />
        <Show when={r().sessionID}>
          <ui.Button size="small" variant="ghost" icon="square-arrow-top-right" onClick={() => openSession(props.env, r().sessionID)}>
            Open session
          </ui.Button>
        </Show>
      </div>
      <div class="sched-run-grid">
        <span class="sched-k">Started</span>
        <span>{fmt(r().startedAt)}</span>
        <span class="sched-k">Finished</span>
        <span>{r().finishedAt ? fmt(r().finishedAt!) : "—"}</span>
        <span class="sched-k">Duration</span>
        <span>{duration(r().durationMs ?? (r().finishedAt ? r().finishedAt! - r().startedAt : undefined))}</span>
        <Show when={r().model}>
          <span class="sched-k">Model</span>
          <span>{r().model}</span>
        </Show>
        <Show when={t()}>
          {(tk) => (
            <>
              <span class="sched-k">Tokens</span>
              <span>
                {n(tk().input)} in · {n(tk().output)} out · {n(tk().reasoning)} reasoning · {n(tk().cacheRead)}/{n(tk().cacheWrite)} cache r/w
              </span>
            </>
          )}
        </Show>
        <Show when={r().cost !== undefined}>
          <span class="sched-k">Cost</span>
          <span>${r().cost!.toFixed(4)}</span>
        </Show>
      </div>
      <Show when={r().error}>
        <div class="sched-error sched-run-error">{r().error}</div>
      </Show>
    </li>
  )
}

export function openLogsDialog(env: Env, job: Job) {
  const { ctx } = env
  const ui = ctx.ui
  return ctx.dialogs.open((dialog) => {
    const [logs] = createResource(() => env.rpc.logs(job.id, 100))
    return (
      <ui.Dialog
        title={`Run history: ${job.name}`}
        description="When each run started, how it ended and what it used. Model output isn't stored here; open the session to read it."
        size="large"
        footer={
          <ui.Button variant="contrast" onClick={() => dialog.close()}>
            Close
          </ui.Button>
        }
      >
        <div class="sched-logs">
          <Show when={logs.loading}>
            <div class="sched-center">
              <ui.Loader />
            </div>
          </Show>
          <Show when={logs.error}>
            <div class="sched-error">Couldn't load the history: {message(logs.error)}</div>
          </Show>
          <Show when={logs()}>
            {(l) => (
              <Show when={l().runs.length} fallback={<div class="sched-empty">This job hasn't run yet.</div>}>
                <ul class="sched-runs">
                  <For each={l().runs}>{(run) => <RunRow env={env} run={run} />}</For>
                </ul>
              </Show>
            )}
          </Show>
        </div>
      </ui.Dialog>
    )
  })
}
