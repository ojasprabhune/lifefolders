import { useEffect, useMemo, useState } from 'react'
import { listWeights, listWorkouts } from './api'
import { Panel, usePanelState } from './Panel'
import { WorkoutBreakdown, workoutSummary, workoutVolume } from './Row'
import type { Log, WeightData, WorkoutData } from './types'

export function Soma({ open }: { open: boolean }) {
  const [workouts, setWorkouts] = useState<Log[]>([])
  const [weights, setWeights] = useState<Log[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const { mounted, closing } = usePanelState(open)

  useEffect(() => {
    if (!mounted) return
    listWorkouts().then(setWorkouts).catch(() => {})
    listWeights().then(setWeights).catch(() => {})
  }, [mounted])

  if (!mounted) return null

  return (
    <Panel closing={closing}>
      <header>
        <h1 className="brand">soma</h1>
        <a className="guide-link" href="#/">
          back
        </a>
      </header>

      <WeightTrend weights={weights} />

      <main className="list">
        {workouts.map((workout) => {
          const data = workout.data as WorkoutData
          const open = expandedId === workout.id
          return (
            <div key={workout.id} className={`row-wrap ${open ? 'open' : ''}`}>
              <div className="row" onClick={() => setExpandedId(open ? null : workout.id)}>
                <span className="row-time">{data.date.slice(5)}</span>
                <span className="row-main">{workoutSummary(data)}</span>
                <span className="row-right">{workoutVolume(data)}</span>
              </div>
              <div className="expand">
                <div className="expand-inner">
                  {open && (
                    <div className="editor">
                      <WorkoutBreakdown data={data} />
                      {data.note && <p className="workout-notes">{data.note}</p>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        {workouts.length === 0 && <div className="empty">no workouts logged</div>}
      </main>
    </Panel>
  )
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }).toLowerCase()
}

// listWeights returns newest first; the trend reads left-to-right oldest to
// newest, so chart against the reversed slice. Points are positioned along the
// x-axis by their actual timestamp (not evenly by index) so a gap of weeks
// between two logs reads as a gap, and the slope reflects real elapsed time.
function WeightTrend({ weights }: { weights: Log[] }) {
  const series = useMemo(
    () =>
      [...weights]
        .reverse()
        .map((w) => ({ t: new Date(w.created_at).getTime(), ...(w.data as WeightData) })),
    [weights],
  )
  if (series.length === 0) return null

  const latest = series[series.length - 1]
  const values = series.map((s) => s.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1

  const tMin = series[0].t
  const tMax = latest.t
  const tSpan = tMax - tMin || 1

  const W = 320
  const H = 56
  const pad = 4
  const x = (t: number) =>
    series.length === 1 ? W / 2 : pad + ((t - tMin) / tSpan) * (W - pad * 2)
  const y = (v: number) => pad + (1 - (v - min) / span) * (H - pad * 2)
  const path = series
    .map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(s.t).toFixed(1)} ${y(s.value).toFixed(1)}`)
    .join(' ')

  const delta = latest.value - series[0].value

  return (
    <div className="weight-trend">
      <div className="weight-head">
        <span className="weight-current">
          {latest.value}
          <span className="weight-unit"> {latest.unit}</span>
        </span>
        <span className="weight-label">
          {series.length > 1 && (
            <span className={`weight-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`}>
              {delta > 0 ? '+' : ''}
              {delta.toFixed(1)} {latest.unit}
            </span>
          )}
          {series.length > 1 ? ' · ' : ''}
          {series.length} log{series.length === 1 ? '' : 's'}
        </span>
      </div>
      <svg className="weight-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {series.length > 1 && <path d={path} fill="none" stroke="var(--gym)" strokeWidth="1.5" />}
        {series.map((s, i) => (
          <circle key={i} cx={x(s.t)} cy={y(s.value)} r={i === series.length - 1 ? 2.6 : 1.6} fill="var(--gym)" />
        ))}
        {/* Wider invisible hit targets layered on top - the visible dots are
            too small to hover reliably, but should stay that size visually. */}
        {series.map((s, i) => (
          <circle key={i} cx={x(s.t)} cy={y(s.value)} r={7} fill="transparent" className="weight-point-hit">
            <title>
              {shortDate(new Date(s.t).toISOString())} · {s.value} {s.unit}
            </title>
          </circle>
        ))}
      </svg>
      {series.length > 1 && (
        <div className="weight-axis">
          <span>{shortDate(new Date(tMin).toISOString())}</span>
          <span>{shortDate(new Date(tMax).toISOString())}</span>
        </div>
      )}
    </div>
  )
}
