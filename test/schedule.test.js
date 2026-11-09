import assert from "node:assert/strict"
import * as S from "../src/schedule.js"

const at = (s) => new Date(s).getTime()
const iso = (t) => {
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
let n = 0
const t = (name, fn) => (fn(), n++, console.log("ok", name))

// Mon 2026-11-09 08:30 local
const base = at("2026-11-09T08:30:00")

t("weekday 9am", () => assert.equal(iso(S.next("0 9 * * 1-5", base)), "2026-11-09 09:00"))
t("after 9am rolls to tomorrow", () => assert.equal(iso(S.next("0 9 * * 1-5", at("2026-11-09T09:00:00"))), "2026-11-10 09:00"))
t("friday rolls to monday", () => assert.equal(iso(S.next("0 9 * * 1-5", at("2026-11-13T10:00:00"))), "2026-11-16 09:00"))
t("every 15 min", () => assert.equal(iso(S.next("*/15 * * * *", base)), "2026-11-09 08:45"))
t("list + names", () => assert.equal(iso(S.next("30 18 * * mon,wed", base)), "2026-11-09 18:30"))
t("dom or dow", () => assert.equal(iso(S.next("0 0 1 * sun", base)), "2026-11-15 00:00"))
t("@daily", () => assert.equal(iso(S.next("@daily", base)), "2026-11-09 09:00"))
t("sunday as 7", () => assert.equal(iso(S.next("0 12 * * 7", base)), "2026-11-15 12:00"))
t("every 30m from anchor", () => assert.equal(S.next("every 30m", base, base - 10 * 60_000), base + 20 * 60_000))
t("every skips missed", () => assert.equal(S.next("every 1h", base, base - 5.5 * 3_600_000), base + 0.5 * 3_600_000))
t("at future", () => assert.equal(iso(S.next("at 2026-11-10 07:15", base)), "2026-11-10 07:15"))
t("at past", () => assert.equal(S.next("at 2026-11-01 07:15", base), undefined))
t("invalid", () => {
  assert.match(S.validate("61 * * * *"), /out of range/)
  assert.match(S.validate("every 10s"), /1 minute/)
  assert.match(S.validate("hello"), /cron/)
  assert.equal(S.validate("0 9 * * 1-5"), undefined)
})
t("describe", () => assert.equal(S.describe("every 2h"), "every 2 hours"))
console.log(`${n} passed`)
