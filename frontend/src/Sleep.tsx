import { useEffect, useMemo, useState } from 'react'
import { getSleepGoalMin, getSleepInsight, listSleep, setSleepGoalMin } from './api'
import { Panel, usePanelState } from './Panel'
import { formatDuration } from './Row'
import type { Log, SleepData } from './types'

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const SHORT_DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const GOAL_STEP_MIN = 30
const GOAL_MIN_BOUND = 240 // 4h
const GOAL_MAX_BOUND = 720 // 12h
const TREND_NIGHTS = 14

function dayName(dateStr: string): string {
  return DAY_NAMES[new Date(dateStr + 'T00:00').getDay()]
}

function shortDay(dateStr: string): string {
  return SHORT_DAY_NAMES[new Date(dateStr + 'T00:00').getDay()]
}

function timeShort(iso: string | null): string {
  if (!iso) return '?'
  return new Date(iso)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()
    .replace(' ', '')
}

export function Sleep({ open }: { open: boolean }) {
  const [nights, setNights] = useState<Log[]>([])
  const [insight, setInsight] = useState<string | null>(null)
  const [goalMin, setGoalMin] = useState(() => getSleepGoalMin())
  const [expandedId, setExpandedId] = useState<string | null>(null)
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

  const changeGoal = (min: number) => {
    const clamped = Math.min(GOAL_MAX_BOUND, Math.max(GOAL_MIN_BOUND, min))
    setGoalMin(clamped)
    setSleepGoalMin(clamped)
  }

  if (!mounted) return null

  return (
    <Panel closing={closing}>
      <header>
        <h1 className="brand">solace</h1>
        <a className="guide-link" href="#/">
          back
        </a>
      </header>

      <SolaceMetrics nights={nights} insight={insight} goalMin={goalMin} onChangeGoal={changeGoal} />

      <main className="list">
        {nights.map((night) => {
          const data = night.data as SleepData
          const isOpen = expandedId === night.id
          return (
            <div key={night.id} className={`row-wrap ${isOpen ? 'open' : ''}`}>
              <div
                className="row music-row"
                onClick={() => setExpandedId(isOpen ? null : night.id)}
              >
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
              <div className="expand">
                <div className="expand-inner">
                  {isOpen && (
                    <div className="editor">
                      <span className="workout-meta">
                        {timeShort(data.sleep_start)} to {timeShort(data.sleep_end)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
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
  vsGoal: number | null
  trend: { night_date: string; duration_min: number | null }[]
}

function computeMetrics(nights: Log[], goalMin: number): Metrics {
  // API returns newest first already; drop the still-in-progress night (no
  // duration yet) from anything that averages or streaks on duration.
  const closed = nights.map((n) => n.data as SleepData).filter((d) => d.duration_min !== null)

  const avg = (arr: SleepData[]): number | null =>
    arr.length ? arr.reduce((s, d) => s + (d.duration_min ?? 0), 0) / arr.length : null

  const last7 = closed.slice(0, 7)
  const last30 = closed.slice(0, 30)
  const avg7 = avg(last7)

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

  return { avg7, avg30: avg(last30), consistencyMin, weekdayAvg, weekendAvg, streak, vsGoal, trend }
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

function SolaceMetrics({
  nights,
  insight,
  goalMin,
  onChangeGoal,
}: {
  nights: Log[]
  insight: string | null
  goalMin: number
  onChangeGoal: (min: number) => void
}) {
  const metrics = useMemo(() => computeMetrics(nights, goalMin), [nights, goalMin])
  if (nights.length === 0) return null

  const trend = metrics.trend
  const max = Math.max(goalMin, ...trend.map((t) => t.duration_min ?? 0))
  const goalLinePct = (goalMin / max) * 100

  return (
    <div className="solace-metrics">
      <div className="solace-goal-row">
        <span className="solace-goal-label">goal</span>
        <div className="solace-goal-stepper">
          <button onClick={() => onChangeGoal(goalMin - GOAL_STEP_MIN)} aria-label="lower goal">
            −
          </button>
          <span>{formatDuration(goalMin)}</span>
          <button onClick={() => onChangeGoal(goalMin + GOAL_STEP_MIN)} aria-label="raise goal">
            +
          </button>
        </div>
      </div>

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
          <span className={`solace-stat-value ${metrics.vsGoal !== null && metrics.vsGoal < 0 ? 'behind' : 'ahead'}`}>
            {metrics.vsGoal !== null ? formatSigned(metrics.vsGoal) : '—'}
          </span>
          <span className="solace-stat-label">avg vs goal, 7d</span>
        </div>
      </div>

      {metrics.weekdayAvg !== null && metrics.weekendAvg !== null && (
        <div className="solace-split">
          <span>weekday {formatDuration(Math.round(metrics.weekdayAvg))}</span>
          <span>weekend {formatDuration(Math.round(metrics.weekendAvg))}</span>
        </div>
      )}

      {trend.length > 1 && (
        <div className="solace-trend-wrap">
          <div className="solace-trend">
            <div className="solace-goal-line" style={{ bottom: `${goalLinePct}%` }} />
            {trend.map((t, i) => (
              <div
                key={i}
                className={`solace-bar ${t.duration_min !== null && t.duration_min >= goalMin ? 'hit' : ''}`}
                style={{ height: `${Math.max(4, ((t.duration_min ?? 0) / max) * 100)}%` }}
                title={`${t.night_date}: ${t.duration_min !== null ? formatDuration(t.duration_min) : 'no data'}`}
              />
            ))}
          </div>
          <div className="solace-trend-labels">
            {trend.map((t, i) => (
              <span key={i} className="solace-trend-label">
                {shortDay(t.night_date)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
