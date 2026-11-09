// Schedule strings, in the server process's local time zone:
//   "*/15 9-17 * * 1-5"      a 5-field cron expression (minute hour day-of-month month day-of-week)
//   "@hourly" "@daily" "@weekly" "@monthly" "@weekdays"
//   "every 30m" "every 2h" "every 1d"   (s/m/h/d; minimum 1 minute)
//   "at 2026-11-09 09:00"    once, then the job turns itself off

const PRESETS = {
  "@hourly": "0 * * * *",
  "@daily": "0 9 * * *",
  "@weekly": "0 9 * * 1",
  "@monthly": "0 9 1 * *",
  "@weekdays": "0 9 * * 1-5",
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
]

const NAMES = {
  3: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
  4: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
}

function parseField(text, index) {
  const { name, min, max } = FIELDS[index]
  const values = new Set()
  const num = (s) => {
    const named = NAMES[index]?.indexOf(s.toLowerCase())
    if (named !== undefined && named >= 0) return named + (index === 3 ? 1 : 0)
    if (!/^\d+$/.test(s)) throw new Error(`bad ${name} value "${s}"`)
    const n = Number(s)
    if (n < min || n > max) throw new Error(`${name} ${n} is out of range ${min}-${max}`)
    return n
  }
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/")
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in ${name}: "${part}"`)
    let lo, hi
    if (range === "*") [lo, hi] = [min, max]
    else if (range.includes("-")) [lo, hi] = range.split("-").map(num)
    else {
      lo = num(range)
      hi = stepText === undefined ? lo : max
    }
    if (lo > hi) throw new Error(`bad range in ${name}: "${part}"`)
    for (let v = lo; v <= hi; v += step) values.add(index === 4 && v === 7 ? 0 : v)
  }
  return { values, any: text === "*" }
}

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Parses a schedule string. Throws an Error with a readable message when it is invalid. */
export function parse(input) {
  const text = String(input ?? "").trim()
  if (!text) throw new Error("schedule is empty")

  const every = text.match(/^every\s+(\d+)\s*(s|m|h|d)[a-z]*$/i)
  if (every) {
    const ms = Number(every[1]) * UNITS[every[2].toLowerCase()]
    if (ms < 60_000) throw new Error("the shortest interval is 1 minute")
    return { kind: "every", ms, text }
  }

  const at = text.match(/^at\s+(.+)$/i)
  if (at) {
    const when = new Date(at[1].trim().replace(" ", "T"))
    if (Number.isNaN(when.getTime())) throw new Error(`can't read the date "${at[1]}" (use YYYY-MM-DD HH:MM)`)
    return { kind: "at", at: when.getTime(), text }
  }

  const expr = PRESETS[text.toLowerCase()] ?? text
  const parts = expr.split(/\s+/)
  if (parts.length !== 5)
    throw new Error('use a 5-field cron expression ("0 9 * * 1-5"), a preset like "@daily", "every 30m", or "at 2026-11-09 09:00"')
  const fields = parts.map(parseField)
  return { kind: "cron", fields, text }
}

/** Checks a schedule string; returns an error message, or undefined when it is valid. */
export function validate(input) {
  try {
    parse(input)
    return undefined
  } catch (e) {
    return e.message
  }
}

function cronMatchesDay(fields, d) {
  const [, , dom, mon, dow] = fields
  if (!mon.values.has(d.getMonth() + 1)) return false
  const domOk = dom.values.has(d.getDate())
  const dowOk = dow.values.has(d.getDay())
  // Classic cron: when both day fields are restricted, either one matching is enough.
  if (!dom.any && !dow.any) return domOk || dowOk
  return domOk && dowOk
}

/**
 * The next run strictly after `after` (ms), or undefined when there is none.
 * For "every", the interval counts from `anchor` (the last run or the creation time).
 */
export function next(input, after = Date.now(), anchor = after) {
  const s = typeof input === "string" ? parse(input) : input
  if (s.kind === "at") return s.at > after ? s.at : undefined
  if (s.kind === "every") {
    if (anchor + s.ms > after) return anchor + s.ms
    const missed = Math.floor((after - anchor) / s.ms) + 1
    return anchor + missed * s.ms
  }
  const [min, hour] = s.fields
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const limit = after + 4 * 366 * 86_400_000
  while (d.getTime() < limit) {
    if (!cronMatchesDay(s.fields, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!hour.values.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!min.values.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1)
      continue
    }
    return d.getTime()
  }
  return undefined
}

/** A short English description of a schedule, for lists. */
export function describe(input) {
  let s
  try {
    s = parse(input)
  } catch {
    return String(input)
  }
  if (s.kind === "at") return `once at ${new Date(s.at).toLocaleString()}`
  if (s.kind === "every") {
    for (const [u, label] of [["d", "day"], ["h", "hour"], ["m", "minute"]]) {
      const n = s.ms / UNITS[u]
      if (Number.isInteger(n)) return n === 1 ? `every ${label}` : `every ${n} ${label}s`
    }
  }
  return s.text
}
