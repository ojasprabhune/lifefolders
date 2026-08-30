import { useEffect, useMemo, useState } from 'react'
import { getSleepGoalMin, getSleepInsight, listSleep, setSleepGoalMin } from './api'
import { Expand } from './Expand'
import { Panel, usePanelState } from './Panel'
import { formatDuration } from './Row'
import { computeMetrics, dayName, formatSigned, shortDay, timeShort } from './sleepStats'
import type { Log, SleepData } from './types'
import { Quip } from './Quip'

export const GOAL_STEP_MIN = 30
export const GOAL_MIN_BOUND = 240 // 4h
export const GOAL_MAX_BOUND = 720 // 12h

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
  }, [mounted])

  // Refetched on a goal change too: the blurb talks about hitting or missing
  // the goal, so the server regenerates it rather than serving the old one.
  useEffect(() => {
    if (!mounted) return
    getSleepInsight(goalMin)
      .then((r) => setInsight(r.blurb))
      .catch(() => {})
  }, [mounted, goalMin])

  const changeGoal = (min: number) => {
    const clamped = Math.min(GOAL_MAX_BOUND, Math.max(GOAL_MIN_BOUND, min))
    setGoalMin(clamped)
    setSleepGoalMin(clamped)
  }

  if (!mounted) return null

  return (
    <Panel closing={closing}>
      <header>
        <h1 className="brand">
          solace
          <Quip domain="sleep" />
        </h1>
        <div className="header-nav">
          <a className="guide-link" href="#/sleep/all">
            fullscreen
          </a>
          <a className="guide-link" href="#/">
            back
          </a>
        </div>
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
              <Expand open={isOpen}>
                <div className="editor">
                  <span className="workout-meta">
                    {timeShort(data.sleep_start)} to {timeShort(data.sleep_end)}
                  </span>
                </div>
              </Expand>
            </div>
          )
        })}
        {nights.length === 0 && <div className="empty">no nights logged</div>}
      </main>
    </Panel>
  )
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
