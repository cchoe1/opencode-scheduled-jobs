import { createResource, Show } from "solid-js"
import { message, openSession } from "./rpc.js"
import type { Env } from "./types.js"

/** The full final reply of a run, fetched on demand and rendered as Markdown. */
export function openResultDialog(env: Env, input: { jobName: string; sessionID: string }) {
  const { ctx } = env
  const ui = ctx.ui
  return ctx.dialogs.open((dialog) => {
    const [res] = createResource(() => env.rpc.result(input.sessionID))
    return (
      <ui.Dialog
        title={`Result: ${input.jobName}`}
        size="large"
        footer={
          <>
            <ui.Button
              variant="ghost"
              onClick={() => {
                openSession(env, input.sessionID)
                dialog.close()
              }}
            >
              Open session
            </ui.Button>
            <ui.Button variant="contrast" onClick={() => dialog.close()}>
              Close
            </ui.Button>
          </>
        }
      >
        <div class="sched-result">
          <Show when={res.loading}>
            <div class="sched-center">
              <ui.Loader />
            </div>
          </Show>
          <Show when={res.error}>
            <div class="sched-error">Couldn't load the result: {message(res.error)}</div>
          </Show>
          <Show when={res()}>
            {(r) => (
              <Show when={r().text?.trim()} fallback={<div class="sched-muted">The run produced no reply.</div>}>
                <ui.Markdown text={r().text} />
              </Show>
            )}
          </Show>
        </div>
      </ui.Dialog>
    )
  })
}
