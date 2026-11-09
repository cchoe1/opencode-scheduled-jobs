// Runs every test file in its own process: the schedule tests under several process time zones, the rest once.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const dir = dirname(fileURLToPath(import.meta.url))
const jobs = [
  ["schedule.test.js", undefined],
  ["schedule.test.js", "UTC"],
  ["schedule.test.js", "Asia/Tokyo"],
  ["schedule.test.js", "America/Los_Angeles"],
  ["notify.test.js", undefined],
  ["server.test.js", undefined],
  ["server.test.js", "Asia/Tokyo"],
  ["scripts.test.js", undefined],
]
let failed = 0
for (const [file, tz] of jobs) {
  const env = { ...process.env }
  if (tz) env.TZ = tz
  const r = spawnSync(process.execPath, [join(dir, file)], { env, stdio: "inherit" })
  if (r.status !== 0) {
    failed++
    console.error(`FAILED: ${file}${tz ? ` (TZ=${tz})` : ""}`)
  }
}
console.log(failed ? `\n${failed} of ${jobs.length} test runs FAILED` : `\nAll ${jobs.length} test runs passed`)
process.exit(failed ? 1 : 0)
