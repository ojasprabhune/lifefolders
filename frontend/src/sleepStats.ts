import { formatDuration } from './Row'
import type { Log, SleepData } from './types'

// Everything the solace panel and the solace wall both need to agree on. The
// two show the same nights side by side, so a metric computed twice would
// eventually disagree with itself.

export const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
export const SHORT_DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

// Clock times are measured from 6pm rather than midnight, so a 12:30am bedtime
// sits next to an 11:30pm one instead of 23 hours away. Everything downstream
// (the raster's x axis, the drift chart's y axis, the bedtime median) works in
// this frame; NIGHT_SPAN is 6pm to noon, which covers every plausible night.
export const NIGHT_ORIGIN_MIN = 18 * 60
export const NIGHT_SPAN_MIN = 18 * 60

export function dayName(dateStr: string): string {
  return DAY_NAMES[new Date(dateStr + 'T00:00').getDay()]
}

export function shortDay(dateStr: string): string {
  return SHORT_DAY_NAMES[new Date(dateStr + 'T00:00').getDay()]
}

export function timeShort(iso: string | null): string {
  if (!iso) return '?'
  return new Date(iso)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()
    .replace(' ', '')
}

export function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00')
  d.setDate(d.getDate() + days)
  return localDate(d)
}

export function localDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function stddev(arr: number[]): number {
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length)
}

export function median(arr: number[]): number | null {
  if (arr.length === 0) return null
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export function formatSigned(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  return `${sign}${formatDuration(Math.abs(Math.round(minutes)))}`
}

/** Minutes past midnight, local. */
export function minuteOfDay(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

/** Minutes past 6pm — see NIGHT_ORIGIN_MIN. */
export function nightMinute(iso: string): number {
  return (minuteOfDay(iso) - NIGHT_ORIGIN_MIN + 1440) % 1440
}

export function clockLabel(minuteOfDayValue: number): string {
  const m = ((minuteOfDayValue % 1440) + 1440) % 1440
  const h24 = Math.floor(m / 60)
  const hour = h24 % 12 === 0 ? 12 : h24 % 12
  return `${hour}:${String(m % 60).padStart(2, '0')}${h24 < 12 ? 'am' : 'pm'}`
}

/** Newest first, only nights that actually finished. */
export function closedNights(logs: Log[]): SleepData[] {
  return logs.map((n) => n.data as SleepData).filter((d) => d.duration_min !== null)
}

export function medianWakeMinute(nights: SleepData[], count: number): number | null {
  return median(
    nights
      .slice(0, count)
      .filter((d) => d.sleep_end !== null)
      .map((d) => minuteOfDay(d.sleep_end as string)),
  )
}

export function medianBedMinute(nights: SleepData[], count: number): number | null {
  const inFrame = median(
    nights
      .slice(0, count)
      .filter((d) => d.sleep_start !== null)
      .map((d) => nightMinute(d.sleep_start as string)),
  )
  return inFrame === null ? null : (inFrame + NIGHT_ORIGIN_MIN) % 1440
}

/** The time to be asleep to hit the goal and still get up when you usually do. */
export function bedtimeTarget(wakeMinute: number, goalMin: number): number {
  return ((wakeMinute - goalMin) % 1440 + 1440) % 1440
}

/** Running total of minutes over/under goal, oldest first. */
export function debtSeries(nights: SleepData[], goalMin: number): { date: string; cum: number }[] {
  let cum = 0
  return [...nights].reverse().map((d) => {
    cum += (d.duration_min ?? 0) - goalMin
    return { date: d.night_date, cum }
  })
}

export function byWeekday(nights: SleepData[]): { avg: number | null; count: number }[] {
  const buckets: number[][] = Array.from({ length: 7 }, () => [])
  for (const d of nights) {
    buckets[new Date(d.night_date + 'T00:00').getDay()].push(d.duration_min ?? 0)
  }
  return buckets.map((v) => ({
    avg: v.length ? v.reduce((s, x) => s + x, 0) / v.length : null,
    count: v.length,
  }))
}

/** Buckets spanning only the range actually slept, so there are no empty ends. */
export function histogram(
  nights: SleepData[],
  bucketMin: number,
): { from: number; count: number }[] {
  const mins = nights.map((d) => d.duration_min ?? 0)
  if (mins.length === 0) return []
  const lo = Math.floor(Math.min(...mins) / bucketMin) * bucketMin
  const hi = Math.floor(Math.max(...mins) / bucketMin) * bucketMin
  const out: { from: number; count: number }[] = []
  for (let from = lo; from <= hi; from += bucketMin) {
    out.push({ from, count: mins.filter((m) => m >= from && m < from + bucketMin).length })
  }
  return out
}

/** 100 at a metronome bedtime, 0 once it swings by three hours. */
export function consistencyScore(stddevMin: number): number {
  return Math.max(0, Math.round(100 - stddevMin / 1.8))
}

export type Metrics = {
  avg7: number | null
  avg30: number | null
  consistencyMin: number | null
  weekdayAvg: number | null
  weekendAvg: number | null
  streak: number
  vsGoal: number | null
  trend: { night_date: string; duration_min: number | null }[]
}

const TREND_NIGHTS = 14

export function computeMetrics(nights: Log[], goalMin: number): Metrics {
  // API returns newest first already; drop the still-in-progress night (no
  // duration yet) from anything that averages or streaks on duration.
  const closed = closedNights(nights)

  const avg = (arr: SleepData[]): number | null =>
    arr.length ? arr.reduce((s, d) => s + (d.duration_min ?? 0), 0) / arr.length : null

  const avg7 = avg(closed.slice(0, 7))

  const bedtimeMinutes = closed
    .filter((d) => d.sleep_start !== null)
    .map((d) => nightMinute(d.sleep_start as string))
  const consistencyMin = bedtimeMinutes.length > 1 ? stddev(bedtimeMinutes) : null

  const isWeekend = (dateStr: string) => [0, 6].includes(new Date(dateStr + 'T00:00').getDay())
  const weekdayAvg = avg(closed.filter((d) => !isWeekend(d.night_date)))
  const weekendAvg = avg(closed.filter((d) => isWeekend(d.night_date)))

  // Streak: consecutive logged nights, no calendar gaps, each hitting the
  // goal, counted back from the most recent night.
  let streak = 0
  let cursor: string | null = null
  for (const d of closed) {
    if ((d.duration_min ?? 0) < goalMin) break
    if (cursor !== null && shiftDate(d.night_date, 1) !== cursor) break
    streak++
    cursor = d.night_date
  }

  // Average per-night gap to goal over the last week - deliberately an
  // average, not a 7-night sum, so it reads against the same scale as avg7
  // right next to it instead of looking like a single scary total.
  const vsGoal = avg7 !== null ? avg7 - goalMin : null

  const trend = [...nights]
    .slice(0, TREND_NIGHTS)
    .map((n) => n.data as SleepData)
    .reverse()
    .map((d) => ({ night_date: d.night_date, duration_min: d.duration_min }))

  return { avg7, avg30: avg(closed.slice(0, 30)), consistencyMin, weekdayAvg, weekendAvg, streak, vsGoal, trend }
}

/** Longest run of consecutive goal-hitting nights anywhere in the history. */
export function longestStreak(nights: SleepData[], goalMin: number): number {
  let best = 0
  let run = 0
  let cursor: string | null = null
  for (const d of [...nights].reverse()) {
    const hit = (d.duration_min ?? 0) >= goalMin
    const adjacent = cursor !== null && shiftDate(cursor, 1) === d.night_date
    run = hit ? (adjacent ? run + 1 : 1) : 0
    best = Math.max(best, run)
    cursor = d.night_date
  }
  return best
}
