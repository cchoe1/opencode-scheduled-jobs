// Where the scheduler keeps its files (see docs/CONTRACT.md, "Paths").

import { homedir } from "node:os"
import { join, resolve } from "node:path"

const NAME = "opencode-scheduler"

/** The default state directory for a platform. */
export function defaultStateDir(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), NAME)
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), NAME)
}

/** The state directory: the `stateDir` option (with a leading ~ expanded) or the default. */
export function resolveStateDir(option, env = process.env, platform = process.platform, home = homedir()) {
  if (option) return resolve(String(option).replace(/^~(?=[\\/]|$)/, home))
  return defaultStateDir(env, platform, home)
}

export const jobsFile = (dir) => join(dir, "jobs.json")
export const leaderFile = (dir) => join(dir, "leader.json")
export const presenceFile = (dir) => join(dir, "presence.json")
export const logsDir = (dir) => join(dir, "logs")
export const logFile = (dir, jobId) => join(logsDir(dir), `${String(jobId).replace(/[^\w.-]/g, "_")}.json`)
