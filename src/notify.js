// Operating-system notifications with no dependencies. notify() never throws.
//   macOS: osascript   Linux: notify-send   Windows: a PowerShell toast
// Text is passed as separate arguments or environment variables, never spliced into a script.

import { execFile } from "node:child_process"

const log = (...args) => console.error("[local.scheduler]", ...args)

/** Shortens text to `max` characters (with an ellipsis) and removes control characters. */
export function clip(text, max) {
  const s = String(text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim()
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

const APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$nodes = $xml.GetElementsByTagName('text')
$nodes.Item(0).AppendChild($xml.CreateTextNode($env:SCHEDULER_TITLE)) | Out-Null
$nodes.Item(1).AppendChild($xml.CreateTextNode($env:SCHEDULER_BODY)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:SCHEDULER_APPID).Show($toast)
`

function run(file, args, env) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000, windowsHide: true, env: env ? { ...process.env, ...env } : process.env }, (err) => {
      if (err) log(`notification via ${file} failed:`, err.message)
      resolve(!err)
    })
  })
}

/** The command line used for a notification on a platform (exported for tests). */
export function command(platform, title, body, sound) {
  if (platform === "darwin") {
    return {
      file: "osascript",
      args: [
        "-e", "on run argv",
        "-e", sound ? 'display notification (item 2 of argv) with title (item 1 of argv) sound name "default"' : "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run",
        title,
        body,
      ],
    }
  }
  if (platform === "win32") {
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64")],
      env: { SCHEDULER_TITLE: title, SCHEDULER_BODY: body, SCHEDULER_APPID: APP_ID },
    }
  }
  return { file: "notify-send", args: ["--app-name=OpenCode Scheduler", "--", title, body] }
}

/** Shows an operating-system notification. Resolves true when it was shown; failures are logged, never thrown. */
export async function notify({ title, body, sound } = {}) {
  try {
    const c = command(process.platform, clip(title, 64) || "OpenCode Scheduler", clip(body, 240), Boolean(sound))
    return await run(c.file, c.args, c.env)
  } catch (e) {
    log("notification failed:", e?.message ?? e)
    return false
  }
}
