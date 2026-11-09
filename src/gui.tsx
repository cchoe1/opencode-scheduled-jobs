// The scheduler's desktop-app UI: a "Scheduler" side panel in sessions, the same view as a Settings page,
// a titlebar pill, and a palette / slash command (/schedules) that opens the view in a dialog.
import { Command, MenuItem, Panel, Plugin, SettingsPage, Style, TitlebarItem } from "@opencode/plugin/gui"
import { createSignal, onCleanup } from "solid-js"
import css from "./gui.css?inline"
import { JobsView } from "./ui/JobsView.js"
import { setupNotifications } from "./ui/notifications.js"
import { builtinServer, makeRpc } from "./ui/rpc.js"

const TAB = "jobs"

export default Plugin.define({
  setup(ctx) {
    ctx.add(Style, css)

    // Notifications and the presence heartbeat live here, not in a view, so each event is handled once per window.
    setupNotifications(ctx)

    const tab = { id: TAB, title: "Scheduler" }
    ctx.add(Panel, {
      id: TAB,
      region: "side",
      list: (input) => (input.open.includes(TAB) ? [tab] : []),
      render: (props) => <JobsView ctx={ctx} directory={() => props.session.directory} server={() => props.session.server.id} />,
    })

    ctx.add(SettingsPage, {
      id: "scheduler",
      title: "Scheduler",
      icon: "task",
      entries: [{ id: "scheduler", title: "Scheduled jobs", keywords: "cron schedule jobs timer recurring" }],
      render: () => (
        <ctx.ui.SettingsLayout title="Scheduler" description="Prompts that run on a schedule, each in a new session.">
          <JobsView ctx={ctx} directory={() => ctx.sessions.current()?.directory} server={() => ctx.sessions.current()?.server.id ?? builtinServer(ctx)} />
        </ctx.ui.SettingsLayout>
      ),
    })


    // The job list in a dialog, so it opens from anywhere: the titlebar, the palette, or /schedules.
    let dialog: { close(): void } | undefined
    const openDialog = () => {
      dialog?.close()
      dialog = ctx.dialogs.open(() => (
        <ctx.ui.Dialog title="Scheduler" description="Prompts that run on a schedule, each in a new session." size="x-large">
          <JobsView
            ctx={ctx}
            hideTitle
            directory={() => ctx.sessions.current()?.directory}
            server={() => ctx.sessions.current()?.server.id ?? builtinServer(ctx)}
          />
        </ctx.ui.Dialog>
      ))
    }

    // A count of active jobs for the titlebar pill, refreshed every 30 seconds.
    const [active, setActive] = createSignal<number | undefined>()
    const countRpc = makeRpc(ctx)
    const refreshCount = () =>
      countRpc
        .list()
        .then((r) => setActive(r.jobs.filter((j) => j.status === "scheduled").length))
        .catch(() => setActive(undefined))
    void refreshCount()
    const countTimer = setInterval(refreshCount, 30_000)
    onCleanup(() => clearInterval(countTimer))

    // The open command's effective keybind (the user can rebind it in Settings > Shortcuts), for the pill's tooltip.
    const shortcut = () => {
      const keys = ctx.keybinds.keybind(`${ctx.id}.open`)
      return keys.length ? ` (${keys.join("+")})` : ""
    }

    ctx.add(TitlebarItem, () => {
      const n = active()
      return {
        id: "scheduler",
        icon: "task" as const,
        label: n === undefined ? "Scheduler" : `Scheduler · ${n} active`,
        title: `Show scheduled jobs${shortcut()}`,
        run: openDialog,
      }
    })

    ctx.add(Command, {
      id: "open",
      title: "Scheduler: Show scheduled jobs",
      keywords: "cron schedule jobs timer",
      bind: "mod+shift+j",
      slash: { name: "schedules" },
      run: openDialog,
    })

    ctx.add(Command, {
      id: "panel",
      title: "Scheduler: Open in side panel",
      keywords: "cron schedule jobs timer",
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(`${ctx.id}:${TAB}`, session)
        else openDialog()
      },
    })

    // The side panel's + menu.
    ctx.add(MenuItem, {
      menu: "session.panel",
      id: "scheduler",
      title: "Scheduler",
      icon: "task",
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(`${ctx.id}:${TAB}`, session)
      },
    })
  },
})
