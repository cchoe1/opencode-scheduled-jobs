// In-app notifications and the presence heartbeat. Called once from plugin setup so events are handled once per
// window no matter how many views are mounted.
import { onCleanup } from "solid-js"
import type { Context } from "@opencode/plugin/gui"
import { builtinServer, makeRpc, openSession } from "./rpc.js"
import { openResultDialog } from "./ResultDialog.js"
import type { Env, JobEventInfo, Run } from "./types.js"

type RunEvent = { run: Run; job: JobEventInfo; result?: string }

export function setupNotifications(ctx: Context) {
  const rpc = makeRpc(ctx)
  const env: Env = {
    ctx,
    rpc,
    directory: () => ctx.sessions.current()?.directory,
    server: () => ctx.sessions.current()?.server.id ?? builtinServer(ctx),
  }

  // Heartbeat: tells the server a desktop UI is around, so it leaves notifications to us.
  const beat = () => void rpc.presence().catch(() => {})
  beat()
  const timer = setInterval(beat, 30_000)
  onCleanup(() => clearInterval(timer))

  const seen = new Set<string>()
  const once = (key: string) => {
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > 500) seen.delete(seen.values().next().value as string)
    return true
  }

  const abort = new AbortController()
  onCleanup(() => abort.abort())

  const payload = (e: any): RunEvent | undefined => {
    const d = e && typeof e === "object" && "data" in e ? e.data : e
    return d?.run && d?.job ? (d as RunEvent) : undefined
  }
  const sessionRef = (run: Run) => {
    const server = env.server()
    return server && run.sessionID ? { server, id: run.sessionID } : undefined
  }

  try {
    rpc.events.on(
      "runStarted",
      (e) => {
        const d = payload(e)
        if (!d || !d.job.notify?.enabled || !d.job.notify.onStart) return
        if (!once(`start:${d.run.id}`)) return
        const title = `Scheduled job started: ${d.job.name}`
        if (document.hasFocus()) {
          ctx.toast.show({
            title,
            actions: d.run.sessionID ? [{ label: "Open session", run: () => openSession(env, d.run.sessionID) }] : undefined,
          })
        } else {
          const session = sessionRef(d.run)
          void ctx.attention.notify({ title, id: `${d.run.id}:start`, ...(session ? { session } : {}) })
        }
      },
      { signal: abort.signal },
    )

    rpc.events.on(
      "runFinished",
      (e) => {
        const d = payload(e)
        if (!d || !d.job.notify?.enabled || !d.job.notify.onFinish) return
        if (!once(`finish:${d.run.id}`)) return
        const ok = d.run.status === "succeeded"
        const label = ok ? "finished" : d.run.status === "interrupted" ? "was interrupted" : "failed"
        const title = `Scheduled job ${label}: ${d.job.name}`
        const body = (d.result ?? "").trim()
        const preview = body ? (body.length > 200 ? body.slice(0, 200).trimEnd() + "…" : body) : d.run.error
        if (document.hasFocus()) {
          const actions: { label: string; run(): void }[] = []
          if (body && d.run.sessionID) {
            actions.push({ label: "Show full result", run: () => void openResultDialog(env, { jobName: d.job.name, sessionID: d.run.sessionID! }) })
          } else if (d.run.sessionID) {
            actions.push({ label: "Open session", run: () => openSession(env, d.run.sessionID) })
          }
          ctx.toast.show({ title, description: preview, variant: ok ? "success" : "error", actions })
        } else {
          const session = sessionRef(d.run)
          void ctx.attention.notify({
            title,
            message: preview,
            variant: ok ? "default" : "error",
            id: `${d.run.id}:finish`,
            ...(session ? { session } : {}),
          })
        }
      },
      { signal: abort.signal },
    )
  } catch {
    // The server half is optional; without events the list still polls.
  }
}
