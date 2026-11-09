// The RPC contract between the scheduler's server half and its desktop-app UI. See docs/CONTRACT.md for the data
// shapes. Plain JSON Schema, so this file needs no imports and works in both processes. Schemas are loose on purpose:
// the server validates inputs itself and returns readable `invalid` errors.

export const PLUGIN_ID = "local.scheduler"

const obj = { type: "object" }
const id = { type: "object", properties: { id: { type: "string" } }, required: ["id"] }

export const Scheduler = {
  id: PLUGIN_ID,
  methods: {
    /** Every job, with derived status, next run and last run. */
    list: { input: obj, output: obj },
    /** Creates a job (no id) or updates one (with id; partial fields merge). Returns the saved job. */
    save: {
      input: { type: "object", properties: { job: obj }, required: ["job"] },
      output: obj,
      errors: { invalid: obj },
    },
    /** Deletes a job and its run log. */
    remove: { input: id, output: obj },
    /** Runs a job now, outside its schedule. */
    run: { input: id, output: obj, errors: { failed: obj } },
    /** Checks a Schedule and returns its description and next `count` (default 5) run times. */
    preview: {
      input: { type: "object", properties: { schedule: obj, count: { type: "number" } }, required: ["schedule"] },
      output: obj,
    },
    /** Future occurrences and past runs of every job between `from` and `to` (ms), for the calendar. */
    occurrences: {
      input: {
        type: "object",
        properties: { from: { type: "number" }, to: { type: "number" } },
        required: ["from", "to"],
      },
      output: obj,
    },
    /** A job's run log, newest first. */
    logs: {
      input: { type: "object", properties: { id: { type: "string" }, limit: { type: "number" } }, required: ["id"] },
      output: obj,
    },
    /** The final assistant reply of a run's session, read on demand (never stored). */
    result: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"] },
      output: obj,
      errors: { unavailable: obj },
    },
    /** The desktop UI's heartbeat: while one is recent, the server leaves notifications to the app. */
    presence: { input: obj, output: obj },
    /** Enabled chat models of the connected providers, for the job form's model picker. */
    models: { input: obj, output: obj },
    /** Primary, visible agents, for the job form's agent picker. */
    agents: { input: obj, output: obj },
  },
  events: {
    /** The job list changed (a save, removal, run, or expiry). */
    changed: { schema: obj },
    /** A run started: `{ run, job: { id, name, notify } }`. */
    runStarted: { schema: obj },
    /** A run finished: `{ run, job: { id, name, notify }, result? }`. */
    runFinished: { schema: obj },
  },
}

export default Scheduler
