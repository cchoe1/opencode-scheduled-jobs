import assert from "node:assert/strict"
import * as S from "../src/schedule.js"

const Z = (s) => Date.parse(s)
const iso = (list) => list.map((t) => new Date(t).toISOString().slice(0, 16) + "Z")
let n = 0
const t = (name, fn) => (fn(), n++, console.log("ok", name))

const NY = "America/New_York"
const LON = "Europe/London"
const sched = (start, timezone, repeat, extra = {}) => ({ start, timezone, repeat, ...extra })
const occ = (s, from, to, limit) => iso(S.occurrences(s, Z(from), Z(to), limit))

t("none: once, strictly after", () => {
  const s = sched("2026-11-09T09:00", NY, "none")
  assert.equal(S.next(s, Z("2026-11-09T00:00:00Z")), Z("2026-11-09T14:00:00Z"))
  assert.equal(S.next(s, Z("2026-11-09T14:00:00Z")), undefined)
  assert.equal(S.next(s, Z("2026-12-09T14:00:00Z")), undefined)
})

t("none ignores end", () => {
  const s = sched("2026-11-09T09:00", NY, "none", { end: "2026-01-01T00:00" })
  assert.equal(S.validate(s), undefined)
  assert.equal(S.next(s, 0), Z("2026-11-09T14:00:00Z"))
})

t("minutes with interval", () => {
  const s = sched("2026-11-09T09:00", "Asia/Tokyo", "minutes", { interval: 45 })
  assert.deepEqual(occ(s, "2026-11-09T00:00:00Z", "2026-11-09T02:59:00Z"), [
    "2026-11-09T00:00Z",
    "2026-11-09T00:45Z",
    "2026-11-09T01:30Z",
    "2026-11-09T02:15Z",
  ])
  assert.equal(S.next(s, Z("2026-11-09T00:45:00Z")), Z("2026-11-09T01:30:00Z"))
  assert.equal(S.next(s, Z("2020-01-01T00:00:00Z")), Z("2026-11-09T00:00:00Z"))
})

t("hours step by elapsed time across DST", () => {
  const s = sched("2026-03-08T00:00", NY, "hours", { interval: 2 })
  assert.deepEqual(occ(s, "2026-03-08T00:00:00Z", "2026-03-08T10:00:00Z"), [
    "2026-03-08T05:00Z",
    "2026-03-08T07:00Z",
    "2026-03-08T09:00Z",
  ])
})

t("daily 09:00 stays 09:00 local across spring-forward (New York)", () => {
  const s = sched("2026-03-06T09:00", NY, "daily")
  assert.deepEqual(occ(s, "2026-03-01T00:00:00Z", "2026-03-10T00:00:00Z"), [
    "2026-03-06T14:00Z",
    "2026-03-07T14:00Z",
    "2026-03-08T13:00Z",
    "2026-03-09T13:00Z",
  ])
})

t("daily 09:00 stays 09:00 local across fall-back (New York)", () => {
  const s = sched("2026-10-31T09:00", NY, "daily")
  assert.deepEqual(occ(s, "2026-10-01T00:00:00Z", "2026-11-03T00:00:00Z"), [
    "2026-10-31T13:00Z",
    "2026-11-01T14:00Z",
    "2026-11-02T14:00Z",
  ])
})

t("daily across both London transitions", () => {
  const spring = sched("2026-03-27T09:00", LON, "daily")
  assert.deepEqual(occ(spring, "2026-03-27T00:00:00Z", "2026-03-30T23:00:00Z"), [
    "2026-03-27T09:00Z",
    "2026-03-28T09:00Z",
    "2026-03-29T08:00Z",
    "2026-03-30T08:00Z",
  ])
  const fall = sched("2026-10-24T09:00", LON, "daily")
  assert.deepEqual(occ(fall, "2026-10-24T00:00:00Z", "2026-10-26T23:00:00Z"), [
    "2026-10-24T08:00Z",
    "2026-10-25T09:00Z",
    "2026-10-26T09:00Z",
  ])
})

t("nonexistent local time shifts forward", () => {
  const s = sched("2026-03-07T02:30", NY, "daily")
  assert.deepEqual(occ(s, "2026-03-07T00:00:00Z", "2026-03-09T23:00:00Z"), [
    "2026-03-07T07:30Z",
    "2026-03-08T07:30Z", // 02:30 does not exist on Mar 8: 03:30 EDT
    "2026-03-09T06:30Z",
  ])
  const l = sched("2026-03-29T01:30", LON, "none")
  assert.equal(S.next(l, 0), Z("2026-03-29T01:30:00Z")) // 01:30 GMT does not exist: 02:30 BST
})

t("ambiguous local time takes the first", () => {
  const s = sched("2026-10-31T01:30", NY, "daily")
  assert.deepEqual(occ(s, "2026-10-31T00:00:00Z", "2026-11-03T00:00:00Z"), [
    "2026-10-31T05:30Z",
    "2026-11-01T05:30Z", // first 01:30 (EDT)
    "2026-11-02T06:30Z",
  ])
})

t("weekly uses start's weekday", () => {
  const s = sched("2026-11-09T09:00", "Asia/Tokyo", "weekly") // a Monday
  assert.deepEqual(occ(s, "2026-11-09T00:00:00Z", "2026-11-29T00:00:00Z"), [
    "2026-11-09T00:00Z",
    "2026-11-16T00:00Z",
    "2026-11-23T00:00Z",
  ])
  assert.equal(S.next(s, Z("2026-11-10T00:00:00Z")), Z("2026-11-16T00:00:00Z"))
})

t("weekly keeps local time across DST", () => {
  const s = sched("2026-10-26T09:00", NY, "weekly")
  assert.deepEqual(occ(s, "2026-10-26T00:00:00Z", "2026-11-10T00:00:00Z"), [
    "2026-10-26T13:00Z",
    "2026-11-02T14:00Z",
    "2026-11-09T14:00Z",
  ])
})

t("monthly: the 1st at start's time, first one on or after start", () => {
  const mid = sched("2026-11-09T09:00", NY, "monthly")
  assert.deepEqual(occ(mid, "2026-11-01T00:00:00Z", "2027-03-01T00:00:00Z"), [
    "2026-12-01T14:00Z",
    "2027-01-01T14:00Z",
    "2027-02-01T14:00Z",
  ])
  const first = sched("2026-11-01T09:00", NY, "monthly")
  assert.equal(S.next(first, 0), Z("2026-11-01T14:00:00Z"))
  const earlier = sched("2026-11-01T08:00", NY, "monthly")
  assert.equal(S.next(earlier, 0), Z("2026-11-01T13:00:00Z"))
  const later = sched("2026-11-01T10:00", NY, "monthly")
  assert.equal(S.next(later, 0), Z("2026-11-01T15:00:00Z"))
  const dec = sched("2026-12-15T09:00", NY, "monthly")
  assert.equal(S.next(dec, 0), Z("2027-01-01T14:00:00Z"))
})

t("end is inclusive", () => {
  const s = sched("2026-11-09T09:00", NY, "daily", { end: "2026-11-11T09:00" })
  assert.deepEqual(occ(s, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"), [
    "2026-11-09T14:00Z",
    "2026-11-10T14:00Z",
    "2026-11-11T14:00Z",
  ])
  assert.equal(S.next(s, Z("2026-11-11T14:00:00Z")), undefined)
  const h = sched("2026-11-09T09:00", NY, "hours", { interval: 1, end: "2026-11-09T11:30" })
  assert.equal(S.occurrences(h, 0, Z("2030-01-01T00:00:00Z")).length, 3)
})

t("cron is evaluated in the job's time zone", () => {
  const s = sched("2026-11-09T00:00", NY, "cron", { cron: "0 9 * * 1-5" })
  assert.equal(S.next(s, Z("2026-11-09T00:00:00Z")), Z("2026-11-09T14:00:00Z"))
  assert.equal(S.next(s, Z("2026-11-13T14:00:00Z")), Z("2026-11-16T14:00:00Z"))
  const dst = sched("2026-03-05T00:00", NY, "cron", { cron: "0 9 * * 1-5" })
  assert.deepEqual(occ(dst, "2026-03-06T00:00:00Z", "2026-03-10T00:00:00Z"), ["2026-03-06T14:00Z", "2026-03-09T13:00Z"])
  const tokyo = sched("2026-11-09T00:00", "Asia/Tokyo", "cron", { cron: "*/15 9 * * *" })
  assert.deepEqual(occ(tokyo, "2026-11-09T00:00:00Z", "2026-11-09T01:00:00Z"), [
    "2026-11-09T00:00Z",
    "2026-11-09T00:15Z",
    "2026-11-09T00:30Z",
    "2026-11-09T00:45Z",
  ])
})

t("cron honors start as a lower bound and end", () => {
  const s = sched("2026-11-10T10:00", "UTC", "cron", { cron: "0 9 * * *", end: "2026-11-12T09:00" })
  assert.deepEqual(occ(s, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"), ["2026-11-11T09:00Z", "2026-11-12T09:00Z"])
})

t("cron day-of-month or day-of-week, names, sunday as 7", () => {
  const s = sched("2026-11-09T08:30", "UTC", "cron", { cron: "0 0 1 * sun" })
  assert.equal(S.next(s, Z("2026-11-09T08:30:00Z")), Z("2026-11-15T00:00:00Z"))
  const sun = sched("2026-11-09T08:30", "UTC", "cron", { cron: "0 12 * * 7" })
  assert.equal(S.next(sun, Z("2026-11-09T08:30:00Z")), Z("2026-11-15T12:00:00Z"))
  const names = sched("2026-11-09T08:30", "UTC", "cron", { cron: "30 18 * * mon,wed" })
  assert.equal(S.next(names, Z("2026-11-09T08:30:00Z")), Z("2026-11-09T18:30:00Z"))
})

t("previous finds the latest run in a window", () => {
  const s = sched("2026-11-01T09:00", "UTC", "daily")
  assert.equal(S.previous(s, Z("2026-11-09T10:00:00Z")), Z("2026-11-09T09:00:00Z"))
  assert.equal(S.previous(s, Z("2026-11-09T10:00:00Z"), Z("2026-11-09T09:00:00Z")), undefined)
  assert.equal(S.previous(s, Z("2026-10-01T10:00:00Z")), undefined)
  const yearly = sched("2020-01-01T00:00", "UTC", "cron", { cron: "0 0 15 6 *" })
  assert.equal(S.previous(yearly, Z("2026-11-09T00:00:00Z")), Z("2026-06-15T00:00:00Z"))
  const none = sched("2026-11-09T09:00", "UTC", "none")
  assert.equal(S.previous(none, Z("2026-11-09T09:00:00Z")), Z("2026-11-09T09:00:00Z"))
  const ended = sched("2026-11-01T09:00", "UTC", "daily", { end: "2026-11-03T09:00" })
  assert.equal(S.previous(ended, Z("2026-11-09T10:00:00Z")), Z("2026-11-03T09:00:00Z"))
})

t("validate", () => {
  const ok = sched("2026-11-09T09:00", NY, "daily")
  assert.equal(S.validate(ok), undefined)
  assert.match(S.validate(null), /missing/)
  assert.match(S.validate({ ...ok, start: "tomorrow" }), /start time/)
  assert.match(S.validate({ ...ok, start: "2026-02-30T09:00" }), /start time/)
  assert.match(S.validate({ ...ok, timezone: "Mars/Base" }), /time zone/)
  assert.match(S.validate({ ...ok, repeat: "yearly" }), /repeat must be/)
  assert.match(S.validate({ ...ok, repeat: "minutes" }), /interval/)
  assert.match(S.validate({ ...ok, repeat: "hours", interval: 0 }), /interval/)
  assert.match(S.validate({ ...ok, repeat: "hours", interval: 1.5 }), /interval/)
  assert.match(S.validate({ ...ok, repeat: "cron" }), /cron/)
  assert.match(S.validate({ ...ok, repeat: "cron", cron: "61 * * * *" }), /out of range/)
  assert.match(S.validate({ ...ok, repeat: "cron", cron: "* * *" }), /5-field/)
  assert.match(S.validate({ ...ok, end: "2026-11-08T09:00" }), /before the start/)
  assert.match(S.validate({ ...ok, end: "soon" }), /end time/)
  assert.equal(S.validate({ ...ok, end: "" }), undefined)
  assert.equal(S.validate({ ...ok, end: null }), undefined)
})

t("normalize", () => {
  const s = S.normalize({ start: "2026-11-09 09:00", repeat: "Daily", interval: 5, cron: "x", end: "" })
  assert.deepEqual(s, { start: "2026-11-09T09:00", timezone: S.systemTimezone(), repeat: "daily" })
  assert.deepEqual(S.normalize({ start: "2026-11-09T09:00", timezone: NY, repeat: "hours", end: "2026-11-10 10:00" }), {
    start: "2026-11-09T09:00",
    timezone: NY,
    repeat: "hours",
    interval: 1,
    end: "2026-11-10T10:00",
  })
})

t("describe includes the time zone", () => {
  assert.equal(
    S.describe(sched("2026-11-09T09:00", NY, "hours", { interval: 2, end: "2026-12-01T17:00" })),
    "Every 2 hours from Nov 9, 2026, 9:00 AM until Dec 1, 2026, 5:00 PM (America/New_York)",
  )
  assert.equal(S.describe(sched("2026-11-09T09:00", NY, "none")), "Once on Nov 9, 2026 at 9:00 AM (America/New_York)")
  assert.match(S.describe(sched("2026-11-09T00:30", LON, "weekly")), /^Every Monday at 12:30 AM from Nov 9, 2026 \(Europe\/London\)$/)
  assert.match(S.describe(sched("2026-11-09T13:00", LON, "monthly")), /1st of every month at 1:00 PM/)
  assert.match(S.describe(sched("2026-11-09T09:00", LON, "daily")), /^Every day at 9:00 AM/)
  assert.match(S.describe(sched("2026-11-09T09:00", LON, "minutes", { interval: 1 })), /^Every minute from/)
  assert.match(S.describe(sched("2026-11-09T09:00", LON, "cron", { cron: "0 9 * * 1-5" })), /Cron "0 9 \* \* 1-5"/)
  assert.match(S.describe({ start: "x" }), /^Invalid schedule/)
})

t("legacy conversion", () => {
  const created = Z("2026-11-09T12:34:56Z")
  const o = { createdAt: created, timezone: "UTC" }
  assert.deepEqual(S.fromLegacy("every 30m", o), { start: "2026-11-09T12:34", timezone: "UTC", repeat: "minutes", interval: 30 })
  assert.deepEqual(S.fromLegacy("every 2h", { ...o, lastRunAt: Z("2026-11-09T13:00:00Z") }), {
    start: "2026-11-09T13:00",
    timezone: "UTC",
    repeat: "hours",
    interval: 2,
  })
  assert.deepEqual(S.fromLegacy("every 1d", o), { start: "2026-11-09T12:34", timezone: "UTC", repeat: "hours", interval: 24 })
  assert.deepEqual(S.fromLegacy("at 2026-11-20 07:15", o), { start: "2026-11-20T07:15", timezone: "UTC", repeat: "none" })
  assert.deepEqual(S.fromLegacy("@hourly", o), { start: "2026-11-09T12:00", timezone: "UTC", repeat: "hours", interval: 1 })
  assert.deepEqual(S.fromLegacy("@daily", o), { start: "2026-11-09T12:34", timezone: "UTC", repeat: "cron", cron: "0 9 * * *" })
  assert.equal(S.fromLegacy("@weekdays", o).cron, "0 9 * * 1-5")
  assert.equal(S.fromLegacy("*/5 * * * *", o).cron, "*/5 * * * *")
  assert.equal(S.fromLegacy("@daily").timezone, S.systemTimezone())
  for (const bad of ["every 10s", "nonsense", "at someday", "61 * * * *", ""]) assert.throws(() => S.fromLegacy(bad, o))
  assert.equal(S.validate(S.fromLegacy("@weekly", o)), undefined)
})

t("system time zone differs from the schedule's", () => {
  // Same absolute answers whatever TZ the process runs with (the runner repeats this file under several).
  const s = sched("2026-07-01T09:00", "Pacific/Auckland", "daily")
  assert.equal(S.next(s, Z("2026-06-30T00:00:00Z")), Z("2026-06-30T21:00:00Z"))
})

console.log(`schedule: ${n} passed (TZ=${process.env.TZ ?? "default"})`)
