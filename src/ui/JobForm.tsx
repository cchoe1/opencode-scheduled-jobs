import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { fmt, systemZone, wallClock, zones } from "./time.js"
import { message } from "./rpc.js"
import type { AgentsOutput, Env, Job, ModelsOutput, Preview, Repeat, Schedule } from "./types.js"

const REPEATS: { value: Repeat; label: string }[] = [
  { value: "none", label: "None (run once)" },
  { value: "minutes", label: "Every X minutes" },
  { value: "hours", label: "Every X hours" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "First day of the month" },
]

type Form = {
  name: string
  prompt: string
  directory: string
  agent: string
  model: string
  startDate: string
  startTime: string
  timezone: string
  repeat: Repeat
  interval: string
  cron: string
  hasEnd: boolean
  endDate: string
  endTime: string
  notify: boolean
  onStart: boolean
  onFinish: boolean
  showResult: boolean
}

function initial(env: Env, job?: Job): Form {
  if (job) {
    const s = job.schedule
    const [startDate, startTime] = (s.start ?? "").split("T")
    const [endDate, endTime] = (s.end ?? "").split("T")
    return {
      name: job.name,
      prompt: job.prompt,
      directory: job.directory,
      agent: job.agent ?? "",
      model: job.model ?? "",
      startDate: startDate ?? "",
      startTime: startTime ?? "",
      timezone: s.timezone || systemZone(),
      repeat: s.repeat,
      interval: String(s.interval ?? 1),
      cron: s.cron ?? "",
      hasEnd: !!s.end && s.repeat !== "none",
      endDate: endDate ?? "",
      endTime: endTime ?? "09:00",
      notify: job.notify.enabled,
      onStart: job.notify.onStart,
      onFinish: job.notify.onFinish,
      showResult: job.notify.showResult,
    }
  }
  const tz = systemZone()
  // Next full hour in the zone.
  const [startDate, startTime] = wallClock(Math.ceil((Date.now() + 60_000) / 3_600_000) * 3_600_000, tz).split("T")
  return {
    name: "",
    prompt: "",
    directory: env.directory() ?? "",
    agent: "",
    model: "",
    startDate,
    startTime,
    timezone: tz,
    repeat: "daily",
    interval: "1",
    cron: "",
    hasEnd: false,
    endDate: startDate,
    endTime: startTime,
    notify: false,
    onStart: false,
    onFinish: true,
    showResult: false,
  }
}

export function JobForm(props: { env: Env; job?: Job; onCancel(): void; onSaved(job: Job): void }) {
  const { env } = props
  const ui = env.ctx.ui
  const editing = !!props.job
  const wasCron = props.job?.schedule.repeat === "cron"
  const [f, setF] = createStore<Form>(initial(env, props.job))
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const [preview, setPreview] = createSignal<Preview>()
  const [checking, setChecking] = createSignal(false)

  // Model picker: the server's enabled models; falls back to free text when the list is unavailable or empty.
  const [models, setModels] = createSignal<ModelsOutput | "loading" | "failed">("loading")
  env.rpc
    .models()
    .then((m) => setModels(m?.models?.length ? m : "failed"))
    .catch(() => setModels("failed"))
  const baseModel = () => f.model.trim().split("#")[0]
  const variant = () => f.model.trim().split("#")[1] ?? ""
  const modelList = () => {
    const m = models()
    return typeof m === "object" ? m : undefined
  }
  const selected = () => modelList()?.models.find((m) => m.ref === baseModel())
  const modelOptions = () => {
    const m = modelList()
    if (!m) return []
    const def = m.default && m.models.find((x) => x.ref === m.default)
    const opts = [
      { value: "", label: def ? `Default (${def.provider} · ${def.name})` : "Default" },
      ...m.models.map((x) => ({ value: x.ref, label: `${x.provider} · ${x.name}` })),
    ]
    if (baseModel() && !selected()) opts.push({ value: baseModel(), label: `${baseModel()} (not available)` })
    return opts
  }
  const variantOptions = () => {
    const vs = selected()?.variants ?? []
    const opts = [{ value: "", label: "Default" }, ...vs.map((v) => ({ value: v, label: v }))]
    if (variant() && !vs.includes(variant())) opts.push({ value: variant(), label: `${variant()} (not available)` })
    return opts
  }
  const pickModel = (ref: string) => setF("model", ref)
  const pickVariant = (v: string) => setF("model", v ? `${baseModel()}#${v}` : baseModel())

  // Agent picker: the server's primary agents; falls back to free text when the list is unavailable or empty.
  const [agents, setAgents] = createSignal<AgentsOutput | "loading" | "failed">("loading")
  env.rpc
    .agents()
    .then((a) => setAgents(a?.agents?.length ? a : "failed"))
    .catch(() => setAgents("failed"))
  const agentList = () => {
    const a = agents()
    return typeof a === "object" ? a.agents : undefined
  }
  const selectedAgent = () => agentList()?.find((a) => a.id === f.agent.trim())
  const agentOptions = () => {
    const list = agentList()
    if (!list) return []
    const opts = [{ value: "", label: "Default" }, ...list.map((a) => ({ value: a.id, label: a.name }))]
    if (f.agent.trim() && !selectedAgent()) opts.push({ value: f.agent.trim(), label: `${f.agent.trim()} (not available)` })
    return opts
  }

  const tzOptions = zones([props.job?.schedule.timezone ?? ""]).map((z) => ({ value: z, label: z }))
  const repeatOptions = wasCron ? [...REPEATS, { value: "cron" as Repeat, label: "Custom (cron)" }] : REPEATS
  const timed = () => f.repeat === "minutes" || f.repeat === "hours"
  const canEnd = () => f.repeat !== "none"

  const schedule = createMemo<Schedule>(() => {
    const s: Schedule = {
      start: `${f.startDate}T${f.startTime}`,
      timezone: f.timezone,
      repeat: f.repeat,
    }
    if (timed()) s.interval = Math.floor(Number(f.interval))
    if (f.repeat === "cron") s.cron = f.cron.trim()
    s.end = canEnd() && f.hasEnd && f.endDate && f.endTime ? `${f.endDate}T${f.endTime}` : null
    return s
  })
  const complete = () =>
    !!f.startDate && !!f.startTime && (!timed() || Number(f.interval) >= 1) && (f.repeat !== "cron" || !!f.cron.trim()) && (!canEnd() || !f.hasEnd || (!!f.endDate && !!f.endTime))

  // Debounced live preview.
  let seq = 0
  createEffect(
    on(
      () => JSON.stringify(schedule()) + complete(),
      () => {
        const mine = ++seq
        if (!complete()) {
          setPreview(undefined)
          setChecking(false)
          return
        }
        setChecking(true)
        const sched = schedule()
        const t = setTimeout(() => {
          env.rpc
            .preview(sched, 5)
            .then((p) => mine === seq && setPreview(p))
            .catch((e) => mine === seq && setPreview({ ok: false, error: message(e) }))
            .finally(() => mine === seq && setChecking(false))
        }, 250)
        onCleanup(() => clearTimeout(t))
      },
    ),
  )

  const valid = () => !!f.prompt.trim() && complete() && !checking() && preview()?.ok === true

  async function save() {
    if (!valid()) return
    setSaving(true)
    setError(undefined)
    try {
      // On edit, send "" to clear optional text fields (the server merges partial updates).
      const opt = (v: string) => (v.trim() ? v.trim() : editing ? "" : undefined)
      const { job } = await env.rpc.save({
        id: props.job?.id,
        name: f.name.trim() || f.prompt.trim().split("\n")[0].slice(0, 48),
        prompt: f.prompt,
        directory: f.directory.trim(),
        agent: opt(f.agent),
        model: opt(f.model),
        ...(editing ? {} : { enabled: true }),
        schedule: schedule(),
        notify: {
          enabled: f.notify,
          onStart: f.notify && f.onStart,
          onFinish: f.notify && f.onFinish,
          showResult: f.notify && f.onFinish && f.showResult,
        },
      })
      props.onSaved(job)
    } catch (e) {
      setError(message(e))
    } finally {
      setSaving(false)
    }
  }

  const sys = systemZone()
  const field = (label: string, child: any, cls = "") => (
    <div class={`sched-field ${cls}`}>
      <span class="sched-label">{label}</span>
      {child}
    </div>
  )

  return (
    <form
      class="sched-form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div class="sched-form-title">{editing ? `Edit "${props.job!.name}"` : "New scheduled job"}</div>
      {field("Name", <ui.TextInput label="Name" value={f.name} placeholder="Morning triage" onInput={(v) => setF("name", v)} autofocus />)}
      {field(
        "Prompt",
        <textarea
          class="sched-textarea"
          rows={5}
          value={f.prompt}
          placeholder="What should the agent do each run? Each run starts a fresh session."
          onInput={(e) => setF("prompt", e.currentTarget.value)}
        />,
      )}
      {field("Project directory", <ui.TextInput label="Project directory" value={f.directory} placeholder="/path/to/project" onInput={(v) => setF("directory", v)} />)}
      <div class="sched-row2">
        {field(
          "Agent (optional)",
          <Show
            when={agents() !== "failed"}
            fallback={<ui.TextInput label="Agent" value={f.agent} placeholder="build" onInput={(v) => setF("agent", v)} />}
          >
            <ui.Select<string>
              label="Agent"
              options={agentOptions()}
              value={f.agent.trim()}
              placeholder="Loading agents…"
              disabled={agents() === "loading"}
              placement="bottom-start"
              onChange={(v) => setF("agent", v)}
            />
          </Show>,
        )}
        {field(
          "Model (optional)",
          <Show
            when={models() !== "failed"}
            fallback={<ui.TextInput label="Model" value={f.model} placeholder="provider/model#variant" onInput={(v) => setF("model", v)} />}
          >
            <ui.Select<string>
              label="Model"
              options={modelOptions()}
              value={baseModel()}
              placeholder="Loading models…"
              disabled={models() === "loading"}
              placement="bottom-start"
              onChange={pickModel}
            />
          </Show>,
        )}
      </div>
      <Show when={selectedAgent()?.description || (selectedAgent()?.model && !f.model.trim())}>
        <div class="sched-muted">
          {selectedAgent()?.description}
          {selectedAgent()?.model && !f.model.trim() ? `${selectedAgent()?.description ? " · " : ""}Uses ${selectedAgent()!.model} unless you pick a model.` : ""}
        </div>
      </Show>
      <Show when={models() !== "failed" && baseModel() && (selected()?.variants.length || variant())}>
        <div class="sched-row2">
          <div />
          {field(
            "Variant",
            <ui.Select<string> label="Variant" options={variantOptions()} value={variant()} placement="bottom-start" onChange={pickVariant} />,
          )}
        </div>
      </Show>

      <fieldset class="sched-group">
        <legend>Schedule</legend>
        <div class="sched-row2">
          {field(
            "Start date",
            <input class="sched-input" type="date" value={f.startDate} onInput={(e) => setF("startDate", e.currentTarget.value)} />,
          )}
          {field(
            "Start time",
            <input class="sched-input" type="time" value={f.startTime} onInput={(e) => setF("startTime", e.currentTarget.value)} />,
          )}
        </div>
        {field(
          "Timezone",
          <ui.Select<string> label="Timezone" options={tzOptions} value={f.timezone} onChange={(v) => setF("timezone", v)} />,
        )}
        <div class="sched-row2">
          {field(
            "Repeat",
            <ui.Select<string> label="Repeat" options={repeatOptions} value={f.repeat} onChange={(v) => setF("repeat", v as Repeat)} />,
          )}
          <Show when={timed()}>
            {field(
              f.repeat === "minutes" ? "Every (minutes)" : "Every (hours)",
              <input
                class="sched-input"
                type="number"
                min="1"
                step="1"
                value={f.interval}
                onInput={(e) => setF("interval", e.currentTarget.value)}
              />,
            )}
          </Show>
        </div>
        <Show when={f.repeat === "cron"}>
          {field(
            "Cron expression",
            <ui.TextInput label="Cron expression" value={f.cron} placeholder="0 9 * * 1-5" onInput={(v) => setF("cron", v)} />,
          )}
        </Show>

        <div class="sched-endgroup" classList={{ "sched-disabled": !canEnd() }}>
          <ui.Switch
            label="Has an end date"
            description={canEnd() ? undefined : "Only repeating jobs can end."}
            checked={canEnd() && f.hasEnd}
            disabled={!canEnd()}
            onChange={(v) => setF("hasEnd", v)}
          />
          <Show when={canEnd() && f.hasEnd}>
            <div class="sched-row2">
              {field(
                "End date",
                <input class="sched-input" type="date" value={f.endDate} onInput={(e) => setF("endDate", e.currentTarget.value)} />,
              )}
              {field(
                "End time",
                <input class="sched-input" type="time" value={f.endTime} onInput={(e) => setF("endTime", e.currentTarget.value)} />,
              )}
            </div>
          </Show>
        </div>

        <div class="sched-preview" classList={{ "sched-dim": checking() }}>
          <Show when={preview()} fallback={<span class="sched-muted">{complete() ? "Checking…" : "Fill in the schedule to see upcoming runs."}</span>}>
            {(p) => (
              <Show
                when={p().ok}
                fallback={<span class="sched-bad">{(p() as { ok: false; error: string }).error}</span>}
              >
                {(() => {
                  const ok = p() as Extract<Preview, { ok: true }>
                  return (
                    <>
                      <div class="sched-preview-desc">{ok.description}</div>
                      <Show when={ok.runs.length} fallback={<div class="sched-muted">No upcoming runs.</div>}>
                        <div class="sched-muted">Next runs ({f.timezone}
                          {f.timezone !== sys ? `, then your time` : ""}):</div>
                        <ol class="sched-preview-runs">
                          <For each={ok.runs}>
                            {(t) => (
                              <li>
                                {fmt(t, f.timezone)}
                                <Show when={f.timezone !== sys}>
                                  <span class="sched-muted"> · {fmt(t)}</span>
                                </Show>
                              </li>
                            )}
                          </For>
                        </ol>
                      </Show>
                    </>
                  )
                })()}
              </Show>
            )}
          </Show>
        </div>
      </fieldset>

      <fieldset class="sched-group">
        <legend>Notifications</legend>
        <ui.Switch label="Notify me" checked={f.notify} onChange={(v) => setF("notify", v)} />
        <Show when={f.notify}>
          <div class="sched-sub">
            <ui.Switch label="When it starts" checked={f.onStart} onChange={(v) => setF("onStart", v)} />
            <ui.Switch label="When it finishes" checked={f.onFinish} onChange={(v) => setF("onFinish", v)} />
            <ui.Switch
              label="Include the result"
              description="Shows the start of the final reply in the notification."
              checked={f.onFinish && f.showResult}
              disabled={!f.onFinish}
              onChange={(v) => setF("showResult", v)}
            />
          </div>
        </Show>
      </fieldset>

      <Show when={error()}>
        <div class="sched-error">{error()}</div>
      </Show>
      <div class="sched-form-actions">
        <ui.Button variant="ghost" onClick={props.onCancel}>
          Cancel
        </ui.Button>
        <ui.Button variant="contrast" type="submit" busy={saving()} disabled={!valid()}>
          {editing ? "Save" : "Create job"}
        </ui.Button>
      </div>
    </form>
  )
}
