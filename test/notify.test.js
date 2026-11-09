import assert from "node:assert/strict"
import { clip, command, notify } from "../src/notify.js"

let n = 0
const t = (name, fn) => (fn(), n++, console.log("ok", name))

t("clip truncates and strips control characters", () => {
  assert.equal(clip("a".repeat(100), 64).length, 64)
  assert.ok(clip("a".repeat(100), 64).endsWith("…"))
  assert.equal(clip("short", 64), "short")
  assert.equal(clip("a\u0000b\u0007c", 10), "a b c")
  assert.equal(clip(undefined, 10), "")
})

t("text is passed as separate arguments, never spliced into a script", () => {
  const evil = `"; do shell script "rm -rf ~" --`
  const mac = command("darwin", evil, evil, true)
  assert.equal(mac.file, "osascript")
  assert.ok(mac.args.includes(evil))
  assert.ok(mac.args.filter((a) => a.includes("rm -rf")).length === 2) // only the two data arguments
  assert.ok(mac.args.some((a) => a.includes("sound name")))
  const linux = command("linux", evil, "body")
  assert.equal(linux.file, "notify-send")
  assert.deepEqual(linux.args.slice(-3), ["--", evil, "body"])
  const win = command("win32", evil, "body")
  assert.equal(win.file, "powershell.exe")
  assert.equal(win.env.SCHEDULER_TITLE, evil)
  const script = Buffer.from(win.args.at(-1), "base64").toString("utf16le")
  assert.ok(!script.includes("rm -rf"))
  assert.ok(script.includes("ToastText02") && script.includes("CreateToastNotifier"))
  assert.ok(win.env.SCHEDULER_APPID.includes("WindowsPowerShell"))
})

// With no PATH the command can't be found: notify() must resolve false (and show nothing).
if (process.platform !== "win32") {
  const saved = process.env.PATH
  process.env.PATH = ""
  const shown = await notify({ title: undefined, body: null })
  process.env.PATH = saved
  assert.equal(shown, false)
  n++
  console.log("ok notify never throws")
}

console.log(`notify: ${n} passed`)
