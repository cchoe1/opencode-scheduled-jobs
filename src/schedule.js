// Structured schedules, evaluated in an IANA time zone. See docs/CONTRACT.md.
//
//   { start: "2026-11-09T09:00", timezone: "America/New_York", repeat: "daily", interval?, cron?, end? }
//
// `start` and `end` are wall-clock times in `timezone`. Time-zone math uses Intl.DateTimeFormat only (no dependencies)
// and is DST-correct: a daily 09:00 job stays at 09:00 local time across clock changes, a wall-clock time that does not
// exist (spring forward) moves forward by the gap, and one that happens twice (fall back) takes the first occurrence.
// "minutes" and "hours" repeat by elapsed time from `start`.

export const REPEATS = ["none", "minutes", "hours", "daily", "weekly", "monthly", "cron"]

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const MAX_INTERVAL = 100_000

// ---- time zones ----

export function systemTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return validTimezone(tz) ? tz : "UTC"
  } catch {
    return "UTC"
  }
}

export function validTimezone(tz) {
  if (typeof tz !== "string" || !tz) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const formatters = new Map()
function formatter(tz) {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
    formatters.set(tz, f)
  }
  return f
}

/** The wall-clock fields of an instant in a time zone. */
export function zoneParts(ms, tz) {
  const o = {}
  for (const p of formatter(tz).formatToParts(ms)) if (p.type !== "literal") o[p.type] = Number(p.value)
  return { y: o.year, mo: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second }
}

function offsetAt(ms, tz) {
  const p = zoneParts(ms, tz)
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000
}

/** The instant (ms) at which a time zone's wall clock shows the given fields. */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  let best
  for (const o of new Set([offsetAt(wall - DAY, tz), offsetAt(wall + DAY, tz)])) {
    const t = wall - o
    const p = zoneParts(t, tz)
    if (p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi) best = best === undefined ? t : Math.min(best, t)
  }
  if (best !== undefined) return best
  // The wall-clock time falls in a spring-forward gap: use the offset from before the gap, which lands after it.
  return wall - offsetAt(wall - DAY, tz)
}

const pad = (n, w = 2) => String(n).padStart(w, "0")

/** "YYYY-MM-DDTHH:MM" for an instant, as seen in a time zone. */
export function wallString(ms, tz) {
  const p = zoneParts(ms, tz)
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`
}

function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

/** Reads "YYYY-MM-DDTHH:MM" (a space instead of T, and seconds, are tolerated). */
export function parseWall(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(text ?? "").trim())
  if (!m) return undefined
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  if (y < 1971 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59) return undefined
  return { y, mo, d, h, mi }
}

const wallText = (w) => `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`

function addDays(y, mo, d, n) {
  const t = new Date(Date.UTC(y, mo - 1, d + n))
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]
}

// ---- cron (evaluated in the schedule's time zone) ----

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

/** Parses a 5-field cron expression (or a preset such as @daily). Throws an Error with a readable message. */
export function parseCron(input) {
  const text = String(input ?? "").trim()
  if (!text) throw new Error("the cron expression is empty")
  const expr = PRESETS[text.toLowerCase()] ?? text
  const parts = expr.split(/\s+/)
  if (parts.length !== 5) throw new Error('use a 5-field cron expression such as "0 9 * * 1-5" (minute hour day-of-month month day-of-week)')
  return parts.map(parseField)
}

function cronMatchesDay(fields, w) {
  const [, , dom, mon, dow] = fields
  if (!mon.values.has(w.getUTCMonth() + 1)) return false
  const domOk = dom.values.has(w.getUTCDate())
  const dowOk = dow.values.has(w.getUTCDay())
  // Classic cron: when both day fields are restricted, either one matching is enough.
  if (!dom.any && !dow.any) return domOk || dowOk
  return domOk && dowOk
}

function cronNext(fields, tz, after, floor) {
  const [min, hour] = fields
  const p = zoneParts(Math.max(after, floor - MINUTE), tz)
  // `w` walks the wall clock; its UTC fields are the time zone's local fields.
  const w = new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi + 1))
  const limit = w.getTime() + 4 * 366 * DAY
  while (w.getTime() < limit) {
    if (!cronMatchesDay(fields, w)) {
      w.setTime(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() + 1))
      continue
    }
    if (!hour.values.has(w.getUTCHours())) {
      w.setUTCHours(w.getUTCHours() + 1, 0, 0, 0)
      continue
    }
    if (!min.values.has(w.getUTCMinutes())) {
      w.setUTCMinutes(w.getUTCMinutes() + 1)
      continue
    }
    const t = zonedToUtc(w.getUTCFullYear(), w.getUTCMonth() + 1, w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), tz)
    if (t > after && t >= floor) return t
    w.setUTCMinutes(w.getUTCMinutes() + 1)
  }
  return undefined
}

// ---- normalizing and validating ----

const blank = (v) => v === undefined || v === null || v === ""

/**
 * A clean copy of a schedule: trimmed strings, wall times as "YYYY-MM-DDTHH:MM", a time zone (the system's when missing),
 * and only the fields that matter for the repeat kind. It does not validate; call validate() on the result.
 */
export function normalize(schedule) {
  const s = schedule && typeof schedule === "object" ? schedule : {}
  const wall = (v) => {
    const w = parseWall(v)
    return w ? wallText(w) : String(v).trim()
  }
  const out = {
    start: blank(s.start) ? "" : wall(s.start),
    timezone: blank(s.timezone) ? systemTimezone() : String(s.timezone).trim(),
    repeat: blank(s.repeat) ? "none" : String(s.repeat).trim().toLowerCase(),
  }
  if (out.repeat === "minutes" || out.repeat === "hours") {
    out.interval = blank(s.interval) ? 1 : Number(s.interval)
  }
  if (out.repeat === "cron") out.cron = String(s.cron ?? "").trim()
  if (out.repeat !== "none" && !blank(s.end)) out.end = wall(s.end)
  return out
}

/** Checks a schedule; returns an error message, or undefined when it is valid. */
export function validate(schedule) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return "the schedule is missing"
  const startWall = parseWall(schedule.start)
  if (!startWall) return `the start time "${schedule.start ?? ""}" must look like 2026-11-09T09:00 (YYYY-MM-DDTHH:MM, in the schedule's time zone)`
  if (!validTimezone(schedule.timezone)) return `unknown time zone "${schedule.timezone ?? ""}" (use an IANA name such as America/New_York)`
  if (!REPEATS.includes(schedule.repeat)) return `repeat must be one of ${REPEATS.join(", ")}`
  if (schedule.repeat === "minutes" || schedule.repeat === "hours") {
    const n = schedule.interval
    if (!Number.isInteger(n) || n < 1 || n > MAX_INTERVAL) return `interval must be a whole number from 1 to ${MAX_INTERVAL}`
  }
  if (schedule.repeat === "cron") {
    try {
      parseCron(schedule.cron)
    } catch (e) {
      return e.message
    }
  }
  if (schedule.repeat !== "none" && !blank(schedule.end)) {
    const endWall = parseWall(schedule.end)
    if (!endWall) return `the end time "${schedule.end}" must look like 2026-12-01T17:00 (YYYY-MM-DDTHH:MM)`
    if (wallText(endWall) < wallText(startWall)) return "the end time is before the start time"
  }
  return undefined
}

// ---- occurrences ----

function compile(schedule) {
  const error = validate(schedule)
  if (error) throw new Error(error)
  const tz = schedule.timezone
  const w = parseWall(schedule.start)
  const startMs = zonedToUtc(w.y, w.mo, w.d, w.h, w.mi, tz)
  let endMs
  if (schedule.repeat !== "none" && !blank(schedule.end)) {
    const e = parseWall(schedule.end)
    endMs = zonedToUtc(e.y, e.mo, e.d, e.h, e.mi, tz)
  }

  let raw
  switch (schedule.repeat) {
    case "none":
      raw = (after) => (startMs > after ? startMs : undefined)
      break
    case "minutes":
    case "hours": {
      const step = schedule.interval * (schedule.repeat === "minutes" ? MINUTE : HOUR)
      raw = (after) => (after < startMs ? startMs : startMs + (Math.floor((after - startMs) / step) + 1) * step)
      break
    }
    case "daily":
    case "weekly": {
      const stepDays = schedule.repeat === "daily" ? 1 : 7
      const occ = (k) => {
        const [y, mo, d] = addDays(w.y, w.mo, w.d, k * stepDays)
        return zonedToUtc(y, mo, d, w.h, w.mi, tz)
      }
      raw = (after) => {
        if (after < startMs) return startMs
        const p = zoneParts(after, tz)
        const diff = Math.floor((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(w.y, w.mo - 1, w.d)) / DAY)
        let k = Math.max(0, Math.floor(diff / stepDays) - 1)
        while (occ(k) <= after) k++
        return occ(k)
      }
      break
    }
    case "monthly": {
      // The 1st of each month at start's time; the first one is on or after `start`.
      let base = w.y * 12 + (w.mo - 1)
      const at = (index) => zonedToUtc(Math.floor(index / 12), (index % 12) + 1, 1, w.h, w.mi, tz)
      if (at(base) < startMs) base++
      const occ = (k) => at(base + k)
      raw = (after) => {
        if (after < occ(0)) return occ(0)
        const p = zoneParts(after, tz)
        let k = Math.max(0, p.y * 12 + (p.mo - 1) - base - 1)
        while (occ(k) <= after) k++
        return occ(k)
      }
      break
    }
    case "cron": {
      const fields = parseCron(schedule.cron)
      raw = (after) => cronNext(fields, tz, after, startMs)
      break
    }
  }
  return {
    startMs,
    endMs,
    next(after) {
      const t = raw(after)
      return t !== undefined && (endMs === undefined || t <= endMs) ? t : undefined
    },
  }
}

/** The first run strictly after `afterMs`, or undefined when there is none. Throws if the schedule is invalid. */
export function next(schedule, afterMs = Date.now()) {
  return compile(schedule).next(afterMs)
}

/** Runs from `fromMs` to `toMs` inclusive, at most `limit`. */
export function occurrences(schedule, fromMs, toMs, limit = 500) {
  const c = compile(schedule)
  const out = []
  let t = fromMs - 1
  while (out.length < limit) {
    t = c.next(t)
    if (t === undefined || t > toMs) break
    out.push(t)
  }
  return out
}

/** The latest run in (afterMs, atOrBeforeMs], or undefined. Used to catch up on runs missed while nothing was running. */
export function previous(schedule, atOrBeforeMs, afterMs = -Infinity) {
  const c = compile(schedule)
  const floor = Math.max(afterMs, c.startMs - 1)
  if (atOrBeforeMs <= floor) return undefined
  let span = DAY
  for (;;) {
    const from = Math.max(floor, atOrBeforeMs - span)
    let last
    let t = from
    while ((t = c.next(t)) !== undefined && t <= atOrBeforeMs) last = t
    if (last !== undefined) return last
    if (from <= floor) return undefined
    span *= 2
  }
}

// ---- describing ----

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const fmtDate = (w) => `${MONTHS[w.mo - 1]} ${w.d}, ${w.y}`
const fmtTime = (w) => `${w.h % 12 || 12}:${pad(w.mi)} ${w.h < 12 ? "AM" : "PM"}`
const plural = (n, word) => (n === 1 ? word : `${word}s`)

/** A friendly English description, including the time zone. */
export function describe(schedule) {
  const error = validate(schedule)
  if (error) return `Invalid schedule: ${error}`
  const w = parseWall(schedule.start)
  const e = schedule.repeat !== "none" && !blank(schedule.end) ? parseWall(schedule.end) : undefined
  const until = e ? ` until ${fmtDate(e)}, ${fmtTime(e)}` : ""
  const zone = ` (${schedule.timezone})`
  const from = `from ${fmtDate(w)}`
  switch (schedule.repeat) {
    case "none":
      return `Once on ${fmtDate(w)} at ${fmtTime(w)}${zone}`
    case "minutes":
    case "hours": {
      const unit = schedule.repeat === "minutes" ? "minute" : "hour"
      const n = schedule.interval
      return `Every ${n === 1 ? unit : `${n} ${plural(n, unit)}`} from ${fmtDate(w)}, ${fmtTime(w)}${until}${zone}`
    }
    case "daily":
      return `Every day at ${fmtTime(w)} ${from}${until}${zone}`
    case "weekly":
      return `Every ${WEEKDAYS[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()]} at ${fmtTime(w)} ${from}${until}${zone}`
    case "monthly":
      return `On the 1st of every month at ${fmtTime(w)} ${from}${until}${zone}`
    default:
      return `Cron "${schedule.cron}" ${from}, ${fmtTime(w)}${until}${zone}`
  }
}

// ---- schedules saved by v1 (strings) ----

/**
 * Converts a v1 schedule string to a Schedule. Throws an Error with a readable message when it can't be read.
 * options: { createdAt, lastRunAt, timezone } (ms; the time zone defaults to the system's).
 */
export function fromLegacy(input, options = {}) {
  const text = String(input ?? "").trim()
  if (!text) throw new Error("schedule is empty")
  const timezone = options.timezone ?? systemTimezone()
  const created = options.createdAt ?? Date.now()

  const every = text.match(/^every\s+(\d+)\s*(s|m|h|d)[a-z]*$/i)
  if (every) {
    const n = Number(every[1])
    const unit = every[2].toLowerCase()
    const ms = n * { s: 1000, m: MINUTE, h: HOUR, d: DAY }[unit]
    if (ms < MINUTE) throw new Error("the shortest interval is 1 minute")
    const start = wallString(options.lastRunAt ?? created, timezone)
    if (unit === "h") return { start, timezone, repeat: "hours", interval: n }
    if (unit === "d") return { start, timezone, repeat: "hours", interval: n * 24 }
    return { start, timezone, repeat: "minutes", interval: Math.max(1, Math.round(ms / MINUTE)) }
  }

  const at = text.match(/^at\s+(.+)$/i)
  if (at) {
    const w = parseWall(at[1])
    if (!w) throw new Error(`can't read the date "${at[1]}" (use YYYY-MM-DD HH:MM)`)
    return { start: wallText(w), timezone, repeat: "none" }
  }

  if (text.toLowerCase() === "@hourly") {
    return { start: wallString(created, timezone).slice(0, 14) + "00", timezone, repeat: "hours", interval: 1 }
  }

  const cron = PRESETS[text.toLowerCase()] ?? text
  parseCron(cron)
  return { start: wallString(created, timezone), timezone, repeat: "cron", cron }
}
