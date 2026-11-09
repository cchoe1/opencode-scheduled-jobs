// The RPC contract between the scheduler's server half and its desktop-app panel.
// Plain JSON Schema, so this file needs no imports and works in both processes.

export const PLUGIN_ID = "local.scheduler"

const job = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    schedule: { type: "string" },
    prompt: { type: "string" },
    directory: { type: "string" },
    agent: { type: "string" },
    model: { type: "string" },
    enabled: { type: "boolean" },
  },
}

const ok = { type: "object" }

export const Scheduler = {
  id: PLUGIN_ID,
  methods: {
    /** Every job with its next run and recent runs. */
    list: { input: { type: "object" }, output: { type: "object" } },
    /** Creates a job (no id) or updates one (with id). Returns the saved job. */
    save: {
      input: { type: "object", properties: { job }, required: ["job"] },
      output: ok,
      errors: { invalid: { type: "object" } },
    },
    remove: { input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, output: ok },
    /** Runs a job now, outside its schedule. Returns the run. */
    run: {
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      output: ok,
      errors: { failed: { type: "object" } },
    },
    /** Checks a schedule string and previews its next runs. */
    preview: {
      input: { type: "object", properties: { schedule: { type: "string" } }, required: ["schedule"] },
      output: ok,
    },
  },
  events: {
    /** The job list changed in this process (a save, a removal, or a run). */
    changed: { schema: { type: "object" } },
    /** A job started a session. */
    ran: { schema: { type: "object" } },
  },
}

export default Scheduler
