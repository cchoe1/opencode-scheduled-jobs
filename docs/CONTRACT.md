# Scheduler v2: shared contract

The server half (`src/server.js` and friends) and the desktop UI (`src/gui.tsx` and `src/ui/*`) talk only through
the RPC in `src/rpc.js`. This file defines the data both sides use. If you need to change it, add fields;
never rename or remove one.

## Job

```ts
type Job = {
  id: string
  name: string
  prompt: string
  directory: string            // project the run's session opens in
  agent?: string
  model?: string               // "provider/model" or "provider/model#variant"
  enabled: boolean             // false = paused
  schedule: Schedule
  notify: Notify
  createdAt: number            // ms
  updatedAt: number            // ms
  // Derived by the server on every read; the UI never sends these back:
  status: "scheduled" | "paused" | "expired"
  nextRun?: number             // ms; undefined when expired
  lastRun?: RunSummary         // newest run, for the list
  description: string          // e.g. "Every 2 hours from 9:00 AM until Dec 1, 5:00 PM (America/Los_Angeles)"
}

type Schedule = {
  start: string                // wall-clock "YYYY-MM-DDTHH:MM" in `timezone`: first run (or the only one)
  timezone: string             // IANA zone, e.g. "America/Los_Angeles"; the UI defaults it to the system zone
  repeat: "none" | "minutes" | "hours" | "daily" | "weekly" | "monthly" | "cron"
  interval?: number            // for "minutes" (>= 1) and "hours" (>= 1): every N
  cron?: string                // for "cron": 5-field expression evaluated in `timezone` (advanced; agent tool / legacy jobs)
  end?: string | null          // wall-clock "YYYY-MM-DDTHH:MM" in `timezone`; no runs after it. Ignored when repeat = "none".
}
// Repeat meanings, all at the wall-clock time of `start` in `timezone` (DST-correct):
//   none     once at `start`
//   minutes  start, start + N min, ...
//   hours    start, start + N h, ...
//   daily    every day at start's time, from start's date
//   weekly   every week on start's weekday at start's time
//   monthly  the 1st of every month at start's time, the first one on or after start

type Notify = {
  enabled: boolean
  onStart: boolean
  onFinish: boolean
  showResult: boolean          // only meaningful when onFinish; include the run's final reply (truncated)
}
```

### Status rules
- `expired`: the schedule has no occurrence after now (a "none" job whose time has passed, or `end` has passed).
- `paused`: not expired and `enabled` is false.
- `scheduled`: otherwise.
- Editing a job recomputes `nextRun` from now immediately. If the new schedule has a future occurrence, an expired job
  becomes scheduled again (or paused if disabled). A job is never deleted when it expires.

### Legacy jobs
Jobs saved by v1 have `schedule` as a string (cron, `@daily`, `every 30m`, `at ...`). The server converts them on
load: `every Nm/Nh` → minutes/hours, `at <date>` → none, `@hourly` → hours/1, `@daily`/`@weekdays`/cron → cron
(`@daily` = `0 9 * * *`), all with the system timezone.

## Run log

Stored apart from the job list, one file per job, newest first, capped (default 200). Deleting a job deletes its log.
No model output is stored.

```ts
type Run = {
  id: string
  jobId: string
  trigger: "schedule" | "manual"
  scheduledFor?: number        // ms; the occurrence this run was for (schedule trigger)
  startedAt: number            // ms
  finishedAt?: number          // ms
  durationMs?: number
  status: "running" | "succeeded" | "failed" | "interrupted" | "failed_to_start"
  sessionID?: string
  sessionTitle?: string
  directory: string
  agent?: string
  model?: string               // as resolved for the session if known, else the job's setting
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  cost?: number
  error?: string
}
type RunSummary = Pick<Run, "id" | "startedAt" | "finishedAt" | "status" | "sessionID" | "error">
```

A run is `running` from session start until the session goes idle (`ctx.session.wait`), then the server reads the
session (`ctx.session.get`) for outcome, tokens and cost. Runs left `running` by a restarted server are checked
again on startup.

## RPC methods (`src/rpc.js`, id `local.scheduler`)

| method | input | output |
|---|---|---|
| `list` | `{}` | `{ now, timezone, stateDir, jobs: Job[], leader?: { pid, self, ts } }` |
| `save` | `{ job: Partial<Job> & { id?: string } }` | `{ job: Job }`, or error `invalid` with message |
| `remove` | `{ id }` | `{ removed: boolean }` (job and its log) |
| `run` | `{ id }` | `{ run: Run }`, or error `failed` |
| `preview` | `{ schedule: Schedule, count?: number }` | `{ ok: true, description, runs: number[] }` or `{ ok: false, error }` |
| `occurrences` | `{ from: number, to: number }` | `{ items: { jobId, name, at, status: "scheduled" \| "paused" }[], runs: (RunSummary & { jobId, name })[] }`; at most 500 future items |
| `logs` | `{ id, limit?: number }` | `{ runs: Run[] }` |
| `result` | `{ sessionID }` | `{ text: string }`, the session's final assistant reply, read on demand and never stored |
| `presence` | `{}` | `{ ok: true }`; the desktop UI calls it every 30 s (see Notifications) |
| `models` | `{}` | `{ models: { ref: "provider/model", provider, name, variants: string[] }[], default?: string }`: enabled chat models of the connected providers, sorted by provider then name; `default` is OpenCode's default model ref. Models the desktop app's model picker hides are left out (see Paths) |
| `agents` | `{}` | `{ agents: { id, name, description?, model? }[] }`: primary, non-hidden agents sorted by name; `model` is the agent's own model (`provider/model#variant`) when it sets one |

## RPC events

| event | data |
|---|---|
| `changed` | `{ id? }`: the job list changed |
| `runStarted` | `{ run: Run, job: { id, name, notify } }` |
| `runFinished` | `{ run: Run, job: { id, name, notify }, result?: string }`: `result` is the final reply truncated to 4000 characters, only when `notify.enabled && notify.onFinish && notify.showResult` |

## Notifications

There are two delivery paths:
1. **In the desktop app.** The UI listens to `runStarted` and `runFinished`. When the window has focus it shows a
   toast. Otherwise it shows a system notification through `ctx.attention.notify` (`id` = run id, so it shows once
   across windows), and clicking it opens the session. A finish toast with a result shows the first ~200 characters
   and a "Show full result" action. That action opens a dialog that renders the full reply with `ctx.ui.Markdown`
   (fetched with `result`), plus an "Open session" button.
2. **Operating-system notification from the server** (`src/notify.js`), used when no desktop UI has called `presence`
   in the last 75 seconds. That covers the CLI-only and background-service-only cases. It uses no dependencies:
   - macOS: `osascript` (`display notification`)
   - Linux: `notify-send`
   - Windows: a PowerShell toast through `Windows.UI.Notifications`

   Title and body are truncated (title 64, body 240 characters). Failures are logged and never throw.

## Paths (`src/paths.js`)
State dir: option `stateDir`, else
- `%LOCALAPPDATA%\opencode-scheduler` on Windows
- `$XDG_STATE_HOME/opencode-scheduler` on Linux and macOS, falling back to `~/.local/state/opencode-scheduler`

The desktop app's model visibility is read (read-only) from its `drafts.sqlite`, row `state(name = 'opencode.global.dat',
key = 'model')`, field `user[].visibility` (`show` / `hide`; a model with no entry counts as shown). Option
`desktopStateFile`, else `~/Library/Application Support/ai.opencode.desktop/drafts.sqlite` on macOS,
`%APPDATA%\ai.opencode.desktop\drafts.sqlite` on Windows, `$XDG_CONFIG_HOME/ai.opencode.desktop/drafts.sqlite`
(default `~/.config`) on Linux. It's the app's private storage: when it can't be read, every model is listed.

Files:
- `jobs.json`: the job list (version 2: `{ version: 2, jobs }`)
- `logs/<jobId>.json`: each job's run log
- `leader.json`: which process fires jobs
