# OpenCode Scheduler (local plugin, OpenCode v2.2)

Runs prompts on a schedule. Each run starts a new session in the job's project directory and sends the prompt.

## Pieces
- `src/server.js`: the job store (`~/.local/state/opencode-scheduler/jobs.json`), the timer (checks every 20 s), the agent tools `schedule_job`, `list_scheduled_jobs`, `remove_scheduled_job` and `run_scheduled_job`, and the RPC the UI calls.
- `src/schedule.js`: the schedule parser. It accepts cron (`0 9 * * 1-5`), `@hourly`, `@daily`, `@weekly`, `@monthly`, `@weekdays`, `every 30m`/`2h`/`1d`, or `at 2026-11-09 09:00` for one run.
- `src/gui.tsx`: the desktop-app UI, built to `gui-experimental.cjs`. It adds:
  - a **titlebar button** (top right; hover shows "Scheduler · N active") that opens the job list in a dialog
  - a palette command, *Scheduler: Show scheduled jobs*, also available as `/schedules`, which opens the same dialog
  - a **Scheduler** side-panel tab in sessions, opened from the panel's + menu or *Scheduler: Open in side panel*
  - a **Settings › Scheduler** page

## Build and install
```bash
npm install
npm test
npm run install-plugin   # builds dist/ and copies it to ~/.config/opencode/plugins/scheduler
```
The config entry is `"plugins": [{ "package": "./plugins/scheduler" }]`. You can add options there: `stateDir`, `tickSeconds` and `history`.

## Notes
- Jobs only run while an OpenCode server is running (the background service or the desktop app). After a missed run, the job runs once and is then rescheduled.
- When several OpenCode processes load the plugin, only one fires jobs. That process holds `leader.json` in the state directory.
- The `gui-experimental` plugin API is marked experimental by OpenCode and may change between releases.
