import { useEffect, useMemo, useState } from 'react'
import { getSleepInsight, listSleep } from './api'
import { Panel, usePanelState } from './Panel'
import { formatDuration } from './Row'
import type { Log, SleepData } from './types'

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const GOAL_MIN = 480 // 8h default, not yet user-editable

function dayName(dateStr: string): string {
  return DAY_NAMES[new Date(dateStr + 'T00:00').getDay()]
}

export function Sleep({ open }: { open: boolean }) {
  const [nights, setNights] = useState<Log[]>([])
  const [insight, setInsight] = useState<string | null>(null)
  const { mounted, closing } = usePanelState(open)

  useEffect(() => {
    if (!mounted) return
    listSleep()
      .then(setNights)
      .catch(() => {})
    getSleepInsight()
      .then((r) => setInsight(r.blurb))
      .catch(() => {})
  }, [mounted])

  if (!mounted) return null

  return (
    <Panel closing={closing}>
      <header>
        <h1 className="brand">solace</h1>
        <a className="guide-link" href="#/">
          back
        </a>
      </header>

      <SolaceMetrics nights={nights} insight={insight} />

      <main className="list">
        {nights.map((night) => {
          const data = night.data as SleepData
          return (
            <div key={night.id} className="row music-row">
              <span className="row-time sleep-day">{dayName(data.night_date)}</span>
              <span className="row-main">{data.night_date}</span>
              <span className="row-right">
                {data.sleep_end === null
                  ? 'sleeping'
                  : data.duration_min !== null
                    ? formatDuration(data.duration_min)
                    : 'no start recorded'}
              </span>
            </div>
          )
        })}
        {nights.length === 0 && <div className="empty">no nights logged</div>}
      </main>
    </Panel>
  )
}

type Metrics = {
  avg7: number | null
  avg30: number | null
  consistencyMin: number | null
  weekdayAvg: number | null
  weekendAvg: number | null
  streak: number
  debtMin: number | null
  trend: { night_date: string; duration_min: number | null }[]
}

function computeMetrics(nights: Log[]): Metrics {
  // API returns newest first already; drop the still-in-progress night (no
  // duration yet) from anything that averages or streaks on duration.
  const closed = nights
    .map((n) => n.data as SleepData)
    .filter((d) => d.duration_min !== null)

  const avg = (arr: SleepData[]): number | null =>
    arr.length ? arr.reduce((s, d) => s + (d.duration_min ?? 0), 0) / arr.length : null

  const last7 = closed.slice(0, 7)
  const last30 = closed.slice(0, 30)

  // Bedtime consistency: minutes-of-day for sleep_start, with anything
  // before noon pushed a day forward so a 12:30am bedtime sits numerically
  // next to an 11:30pm one instead of 23 hours away.
  const bedtimeMinutes = closed
    .filter((d) => d.sleep_start !== null)
    .map((d) => {
      const t = new Date(d.sleep_start as string)
      const m = t.getHours() * 60 + t.getMinutes()
      return m < 12 * 60 ? m + 24 * 60 : m
    })
  const consistencyMin = bedtimeMinutes.length > 1 ? stddev(bedtimeMinutes) : null

  const isWeekend = (dateStr: string) => [0, 6].includes(new Date(dateStr + 'T00:00').getDay())
  const weekdayAvg = avg(closed.filter((d) => !isWeekend(d.night_date)))
  const weekendAvg = avg(closed.filter((d) => isWeekend(d.night_date)))

  // Streak: consecutive logged nights, no calendar gaps, each hitting the
  // goal, counted back from the most recent night.
  let streak = 0
  let cursor: string | null = null
  for (const d of closed) {
    if ((d.duration_min ?? 0) < GOAL_MIN) break
    if (cursor !== null && shiftDate(d.night_date, 1) !== cursor) break
    streak++
    cursor = d.night_date
  }

  const debtMin = last7.length ? last7.reduce((s, d) => s + ((d.duration_min ?? 0) - GOAL_MIN), 0) : null

  const trend = [...nights]
    .slice(0, 30)
    .map((n) => n.data as SleepData)
    .reverse()
    .map((d) => ({ night_date: d.night_date, duration_min: d.duration_min }))

  return { avg7: avg(last7), avg30: avg(last30), consistencyMin, weekdayAvg, weekendAvg, streak, debtMin, trend }
}

function stddev(arr: number[]): number {
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length
  return Math.sqrt(variance)
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00')
  d.setDate(d.getDate() + days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatSigned(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  return `${sign}${formatDuration(Math.abs(Math.round(minutes)))}`
}

function SolaceMetrics({ nights, insight }: { nights: Log[]; insight: string | null }) {
  const metrics = useMemo(() => computeMetrics(nights), [nights])
  if (nights.length === 0) return null

  const trend = metrics.trend
  const max = Math.max(GOAL_MIN, ...trend.map((t) => t.duration_min ?? 0))

  return (
    <div className="solace-metrics">
      {insight && <p className="solace-insight">{insight}</p>}
      <div className="solace-stats">
        <div className="solace-stat">
          <span className="solace-stat-value">{metrics.avg7 !== null ? formatDuration(Math.round(metrics.avg7)) : '—'}</span>
          <span className="solace-stat-label">avg, 7d</span>
        </div>
        <div className="solace-stat">
          <span className="solace-stat-value">{metrics.avg30 !== null ? formatDuration(Math.round(metrics.avg30)) : '—'}</span>
          <span className="solace-stat-label">avg, 30d</span>
        </div>
        <div className="solace-stat">
          <span className="solace-stat-value">
            {metrics.consistencyMin !== null ? `±${Math.round(metrics.consistencyMin)}m` : '—'}
          </span>
          <span className="solace-stat-label">bedtime swing</span>
        </div>
        <div className="solace-stat">
          <span className="solace-stat-value">{metrics.streak}</span>
          <span className="solace-stat-label">night streak</span>
        </div>
        <div className="solace-stat">
          <span className={`solace-stat-value ${metrics.debtMin !== null && metrics.debtMin < 0 ? 'behind' : 'ahead'}`}>
            {metrics.debtMin !== null ? formatSigned(metrics.debtMin) : '—'}
          </span>
          <span className="solace-stat-label">vs 8h goal, 7d</span>
        </div>
      </div>
      {metrics.weekdayAvg !== null && metrics.weekendAvg !== null && (
        <div className="solace-split">
          <span>weekday {formatDuration(Math.round(metrics.weekdayAvg))}</span>
          <span>weekend {formatDuration(Math.round(metrics.weekendAvg))}</span>
        </div>
      )}
      {trend.length > 1 && (
        <div className="solace-trend">
          {trend.map((t, i) => (
            <div
              key={i}
              className={`solace-bar ${t.duration_min !== null && t.duration_min >= GOAL_MIN ? 'hit' : ''}`}
              style={{ height: `${Math.max(4, ((t.duration_min ?? 0) / max) * 100)}%` }}
              title={`${t.night_date}: ${t.duration_min !== null ? formatDuration(t.duration_min) : 'no data'}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
