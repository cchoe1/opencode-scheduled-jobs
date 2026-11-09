import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { dayKey, fmt, statusClass, statusLabel, timeOnly } from "./time.js"
import { message, openSession } from "./rpc.js"
import type { Actions, Env, Job, RunSummary } from "./types.js"

type Entry = {
  kind: "future" | "paused" | "run"
  at: number
  jobId: string
  name: string
  status?: RunSummary["status"]
  run?: RunSummary
}

function firstWeekday(locale: string): number {
  // Intl week info: 1 = Monday ... 7 = Sunday. JS getDay(): 0 = Sunday.
  try {
    const l = new Intl.Locale(locale) as any
    const info = l.getWeekInfo?.() ?? l.weekInfo
    if (info?.firstDay) return info.firstDay % 7
  } catch {}
  return 0
}

const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)

function openEntryDialog(env: Env, entry: Entry, job: Job | undefined, actions: Actions) {
  const { ctx } = env
  const ui = ctx.ui
  return ctx.dialogs.open((dialog) => (
    <ui.Dialog
      title={entry.name}
      description={fmt(entry.at)}
      size="normal"
      footer={
        <Show when={job}>
          {(j) => (
            <>
              <ui.Button
                size="small"
                onClick={() => {
                  dialog.close()
                  actions.run(j())
                }}
              >
                Run now
              </ui.Button>
              <ui.Button
                size="small"
                variant="ghost"
                icon="bullet-list"
                onClick={() => {
                  dialog.close()
                  actions.logs(j())
                }}
              >
                Logs
              </ui.Button>
              <ui.Button
                size="small"
                variant="contrast"
                icon="edit"
                onClick={() => {
                  dialog.close()
                  actions.edit(j())
                }}
              >
                Edit
              </ui.Button>
            </>
          )}
        </Show>
      }
    >
      <div class="sched-detail">
        <Show
          when={entry.kind === "run"}
          fallback={<span class="sched-badge sched-st-scheduled">{entry.kind === "paused" ? "Paused (won't run)" : "Scheduled"}</span>}
        >
          <span class={`sched-badge ${statusClass(entry.status ?? "")}`}>{statusLabel[entry.status ?? ""] ?? entry.status}</span>
        </Show>
        <Show when={job} fallback={<div class="sched-muted">This job no longer exists.</div>}>
          {(j) => (
            <>
              <div>{j().description}</div>
              <div class="sched-muted sched-dir" title={j().directory}>
                {j().directory}
              </div>
              <div class="sched-prompt">{j().prompt}</div>
            </>
          )}
        </Show>
        <Show when={entry.run?.error}>
          <div class="sched-error">{entry.run!.error}</div>
        </Show>
        <Show when={entry.run?.sessionID}>
          <div>
            <ui.Button size="small" variant="ghost" icon="square-arrow-top-right" onClick={() => openSession(env, entry.run!.sessionID)}>
              Open session
            </ui.Button>
          </div>
        </Show>
      </div>
    </ui.Dialog>
  ))
}

export function Calendar(props: { env: Env; jobs: Job[]; tick: number; actions: Actions }) {
  const { ui } = props.env.ctx
  const locale = props.env.ctx.locale.locale()
  const [cursor, setCursor] = createSignal(startOfMonth(new Date()))
  const [selected, setSelected] = createSignal<string | undefined>()
  const [narrow, setNarrow] = createSignal(false)
  let root!: HTMLDivElement

  onMount(() => {
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 560))
    ro.observe(root)
    onCleanup(() => ro.disconnect())
  })

  const weekStart = firstWeekday(locale)
  const grid = createMemo(() => {
    const first = cursor()
    const offset = (first.getDay() - weekStart + 7) % 7
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
    const weeks = Math.ceil((offset + days) / 7)
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset)
    const cells = Array.from({ length: weeks * 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
    return { cells, from: cells[0].getTime(), to: new Date(start.getFullYear(), start.getMonth(), start.getDate() + weeks * 7).getTime() }
  })
  const weekdays = createMemo(() => {
    const f = new Intl.DateTimeFormat(locale, { weekday: "short" })
    // 2023-01-01 was a Sunday.
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(2023, 0, 1 + ((weekStart + i) % 7))))
  })

  const [occ] = createResource(
    () => ({ from: grid().from, to: grid().to, tick: props.tick }),
    (s) => props.env.rpc.occurrences(s.from, s.to),
  )
  // `latest` keeps showing the previous data while refetching.
  const data = () => occ.latest

  const byDay = createMemo(() => {
    const map = new Map<string, Entry[]>()
    const d = data()
    if (!d) return map
    const push = (e: Entry) => {
      const k = dayKey(new Date(e.at))
      const list = map.get(k) ?? []
      list.push(e)
      map.set(k, list)
    }
    for (const i of d.items ?? []) push({ kind: i.status === "paused" ? "paused" : "future", at: i.at, jobId: i.jobId, name: i.name })
    for (const r of d.runs ?? []) push({ kind: "run", at: r.startedAt, jobId: r.jobId, name: r.name, status: r.status, run: r })
    for (const list of map.values()) list.sort((a, b) => a.at - b.at)
    return map
  })

  const chipClass = (e: Entry) => (e.kind === "run" ? statusClass(e.status ?? "") : e.kind === "paused" ? "sched-st-paused" : "sched-st-scheduled")
  const open = (e: Entry) => openEntryDialog(props.env, e, props.jobs.find((j) => j.id === e.jobId), props.actions)

  const title = () => cursor().toLocaleDateString(locale, { month: "long", year: "numeric" })
  const move = (delta: number) => {
    setSelected(undefined)
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1))
  }
  const todayKey = () => dayKey(new Date())

  const Chip = (p: { e: Entry }) => (
    <button type="button" class={`sched-chip ${chipClass(p.e)}`} title={`${fmt(p.e.at)}\n${p.e.name}`} onClick={() => open(p.e)}>
      <span class="sched-chip-time">{timeOnly(p.e.at)}</span> <span class="sched-chip-name">{p.e.name}</span>
    </button>
  )

  const selectedEntries = () => (selected() ? byDay().get(selected()!) ?? [] : [])
  const selectedDate = () => grid().cells.find((c) => dayKey(c) === selected())

  return (
    <div class="sched-cal" ref={root} classList={{ "sched-cal-narrow": narrow() }}>
      <div class="sched-cal-head">
        <strong class="sched-cal-title">{title()}</strong>
        <div class="sched-actions">
          <ui.IconButton icon="chevron-left" label="Previous month" onClick={() => move(-1)} />
          <ui.Button
            size="small"
            variant="ghost"
            onClick={() => {
              setSelected(undefined)
              setCursor(startOfMonth(new Date()))
            }}
          >
            Today
          </ui.Button>
          <ui.IconButton icon="chevron-right" label="Next month" onClick={() => move(1)} />
        </div>
      </div>
      <Show when={occ.error}>
        <div class="sched-error">Couldn't load the calendar: {message(occ.error)}</div>
      </Show>
      <div class="sched-cal-grid" classList={{ "sched-dim": occ.loading }}>
        <For each={weekdays()}>{(w) => <div class="sched-cal-wd">{w}</div>}</For>
        <For each={grid().cells}>
          {(day) => {
            const key = dayKey(day)
            const entries = () => byDay().get(key) ?? []
            const outside = day.getMonth() !== cursor().getMonth()
            return (
              <div
                class="sched-cal-day"
                classList={{ "sched-outside": outside, "sched-today": key === todayKey(), "sched-selected": selected() === key }}
                onClick={() => narrow() && entries().length && setSelected(selected() === key ? undefined : key)}
              >
                <div class="sched-cal-num">{day.getDate()}</div>
                <Show
                  when={!narrow()}
                  fallback={
                    <Show when={entries().length}>
                      <div class="sched-dots">
                        <For each={entries().slice(0, 4)}>{(e) => <span class={`sched-dot ${chipClass(e)}`} />}</For>
                        <Show when={entries().length > 4}>
                          <span class="sched-dot-more">+{entries().length - 4}</span>
                        </Show>
                      </div>
                    </Show>
                  }
                >
                  <For each={entries().slice(0, 3)}>{(e) => <Chip e={e} />}</For>
                  <Show when={entries().length > 3}>
                    <button type="button" class="sched-more" onClick={() => setSelected(selected() === key ? undefined : key)}>
                      +{entries().length - 3} more
                    </button>
                  </Show>
                </Show>
              </div>
            )
          }}
        </For>
      </div>
      <Show when={selected() && selectedEntries().length}>
        <div class="sched-dayview">
          <div class="sched-dayview-head">
            <strong>{selectedDate()?.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" })}</strong>
            <ui.IconButton icon="close" label="Close" size="small" onClick={() => setSelected(undefined)} />
          </div>
          <For each={selectedEntries()}>{(e) => <Chip e={e} />}</For>
        </div>
      </Show>
      <div class="sched-legend sched-muted">
        <span class="sched-dot sched-st-scheduled" /> Scheduled <span class="sched-dot sched-st-paused" /> Paused{" "}
        <span class="sched-dot sched-st-succeeded" /> Succeeded <span class="sched-dot sched-st-failed" /> Failed
      </div>
    </div>
  )
}
