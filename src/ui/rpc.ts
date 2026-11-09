import type { Context } from "@opencode/plugin/gui"
import { Scheduler } from "../rpc.js"
import type { ListOutput, Job, Occurrences, Preview, Run, Schedule } from "./types.js"

export const message = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as any).message) : String(e))

export function builtinServer(ctx: Context): string | undefined {
  return ctx.servers
    .list()
    .map((id) => ctx.servers.get(id))
    .find((s) => s?.builtin)?.id
}

/** Typed wrapper over the scheduler RPC. `directory` routes calls to that project's server. */
export function makeRpc(ctx: Context, directory?: () => string | undefined) {
  const client = ctx.client.rpc(Scheduler as any) as any
  const opts = () => {
    const dir = directory?.()
    return dir ? { location: { directory: dir } } : undefined
  }
  return {
    events: client.events as { on(name: string, handler: (e: any) => void, opts?: { signal?: AbortSignal }): unknown },
    list: () => client.list({}, opts()) as Promise<ListOutput>,
    save: (job: Partial<Job> & { id?: string }) => client.save({ job }, opts()) as Promise<{ job: Job }>,
    remove: (id: string) => client.remove({ id }, opts()) as Promise<{ removed: boolean }>,
    run: (id: string) => client.run({ id }, opts()) as Promise<{ run: Run }>,
    preview: (schedule: Schedule, count = 5) => client.preview({ schedule, count }, opts()) as Promise<Preview>,
    occurrences: (from: number, to: number) => client.occurrences({ from, to }, opts()) as Promise<Occurrences>,
    logs: (id: string, limit?: number) => client.logs({ id, limit }, opts()) as Promise<{ runs: Run[] }>,
    result: (sessionID: string) => client.result({ sessionID }, opts()) as Promise<{ text: string }>,
    presence: () => client.presence({}, opts()) as Promise<{ ok: true }>,
  }
}
export type Rpc = ReturnType<typeof makeRpc>

export function openSession(env: { ctx: Context; server: () => string | undefined }, sessionID: string | undefined) {
  const server = env.server() ?? builtinServer(env.ctx)
  if (server && sessionID) env.ctx.tabs.open({ server, id: sessionID }, { focus: true })
}
