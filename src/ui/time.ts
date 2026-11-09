export const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export function relative(t: number | undefined, now: number) {
  if (!t) return "—"
  const s = Math.round((t - now) / 1000)
  const abs = Math.abs(s)
  const unit: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60 ? [s, "second"] : abs < 3600 ? [Math.round(s / 60), "minute"] : abs < 86400 ? [Math.round(s / 3600), "hour"] : [Math.round(s / 86400), "day"]
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(unit[0], unit[1])
}

/** "Mon, Nov 9, 2026, 9:00 AM PST" in `tz` (system zone when omitted). */
export function fmt(t: number, tz?: string) {
  return new Date(t).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(tz ? { timeZone: tz } : {}),
  })
}
export const timeOnly = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

/** Wall-clock "YYYY-MM-DDTHH:MM" of an instant in a zone. */
export function wallClock(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ms))
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00"
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`
}

export function duration(ms: number | undefined) {
  if (ms === undefined) return "—"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function zones(extra: string[] = []): string[] {
  let list: string[] = []
  try {
    list = (Intl as any).supportedValuesOf("timeZone") as string[]
  } catch {}
  return [...new Set([...list, systemZone(), ...extra.filter(Boolean)])].sort()
}

export const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

export const statusLabel: Record<string, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  interrupted: "Interrupted",
  failed_to_start: "Failed to start",
}
export const statusClass = (s: string) => `sched-st-${s}`
