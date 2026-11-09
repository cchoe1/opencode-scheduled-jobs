# OpenCode Scheduled Jobs

A plugin for [OpenCode](https://opencode.ai) 2.2+ that runs prompts on a schedule. When a job is due, it starts a new
session in the job's project and sends the job's prompt, so each run is an ordinary session you can open, read and
continue.

- **Friendly scheduling:** a start date and time in any timezone (defaults to your system zone), plus a repeat of none,
  every N minutes, every N hours, daily, weekly, or the first day of the month, with an optional end date. A preview
  shows the next runs as you edit.
- **Desktop app UI:**
  - **Where to find it:** a titlebar button, the `/schedules` command, the `Cmd/Ctrl+Shift+J` shortcut (change it in
    Settings > Shortcuts), a side-panel tab, and a page under Settings.
  - **Layout:** a list (Scheduled and Expired sections) or a month calendar.
  - **Actions per job:** run now, edit, view logs, delete.
- **Notifications** when a run starts or finishes, optionally with the start of the reply. In the desktop app, "Show
  full result" opens the whole reply. Without the app, the plugin sends an operating-system notification
  (macOS, Windows, Linux).
- **Run logs:** start and finish times, duration, status, token usage, cost and model for each run. Model output is
  not stored.
- **Agent tools:** ask the agent to *"schedule a job every weekday at 9 that summarizes open PRs"*. The tools are
  `schedule_job`, `list_scheduled_jobs`, `run_scheduled_job`, `scheduled_job_logs` and `remove_scheduled_job`.

## Install

You need OpenCode 2.2 or newer, Node.js 20+ and git.

```bash
git clone https://github.com/cchoe1/opencode-scheduled-jobs.git
cd opencode-scheduled-jobs
npm install
npm run install-plugin
```

`install-plugin` builds the plugin and copies it to `~/.config/opencode/plugins/scheduler`. On Windows that is
`%USERPROFILE%\.config\opencode\plugins\scheduler`. To install elsewhere:
- Set `OPENCODE_CONFIG_DIR` to your OpenCode config folder, or
- Pass `--dir <plugin folder>`: `npm run install-plugin -- --dir <path>`.

Then add the plugin to your OpenCode config (`opencode.jsonc` in the same config folder):

```jsonc
{
  "plugins": [{ "package": "./plugins/scheduler" }]
}
```

Restart OpenCode (or the background service: `opencode service restart`). Then open the scheduler from the
titlebar button or type `/schedules` in the desktop app. In the terminal, just ask the agent to schedule something.

To update, `git pull` and run `npm run install-plugin` again.

### Options

```jsonc
{ "package": "./plugins/scheduler", "options": { "history": 200, "tickSeconds": 20, "stateDir": "~/somewhere" } }
```

| option | default | meaning |
|---|---|---|
| `history` | 200 | runs kept in each job's log |
| `tickSeconds` | 20 | how often due jobs are checked |
| `stateDir` | see below | where jobs and logs are stored |

## Good to know

- **Jobs only run while OpenCode is running** (the background service or the desktop app). If a run is missed while
  it's off, the job runs once when OpenCode is back and then returns to its normal schedule.
- When several OpenCode processes are open, only one of them fires jobs, so nothing runs twice.
- Jobs and logs live in `$XDG_STATE_HOME/opencode-scheduler` (default `~/.local/state/opencode-scheduler`) on macOS
  and Linux, and in `%LOCALAPPDATA%\opencode-scheduler` on Windows.
- Linux notifications use `notify-send` (package `libnotify-bin` or `libnotify`).
- Windows notifications are sent through PowerShell and show as coming from "Windows PowerShell".
- The desktop UI uses OpenCode's experimental GUI plugin API, which may change between OpenCode releases.

## Development

```bash
npm test               # schedule math in several time zones, server logic, notifications, scripts
npm run build          # writes dist/
npx tsc -p .           # typechecks the UI
```

The code is laid out as follows; `docs/CONTRACT.md` describes the data and RPC shared by the server and the UI.
- `src/server.js`, `src/schedule.js`, `src/notify.js`, `src/paths.js`: the server half
- `src/rpc.js`: the RPC contract
- `src/gui.tsx` and `src/ui/`: the desktop UI (SolidJS)

## License

MIT. See [LICENSE](LICENSE).
