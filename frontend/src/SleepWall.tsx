import { useEffect, useMemo, useRef, useState } from 'react'
import { getSleepGoalMin, getSleepInsight, listSleep, setSleepGoalMin } from './api'
import { formatDuration } from './Row'
import { GOAL_MAX_BOUND, GOAL_MIN_BOUND, GOAL_STEP_MIN } from './Sleep'
import {
  bedtimeTarget,
  byWeekday,
  clockLabel,
  closedNights,
  computeMetrics,
  consistencyScore,
  histogram,
  localDate,
  longestStreak,
  medianBedMinute,
  medianWakeMinute,
  nightMinute,
  NIGHT_SPAN_MIN,
  shortDay,
  SHORT_DAY_NAMES,
  timeShort,
} from './sleepStats'
import type { Log, SleepData } from './types'

const RASTER_NIGHTS = 45
const DRIFT_NIGHTS = 60
const DRIFT_SMOOTH = 5
const HISTOGRAM_BUCKET_MIN = 60
const CALENDAR_MIN_WEEKS = 6
const TYPICAL_NIGHTS = 7

function prefersReduced(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Stagger index for the CSS keyframes; see `--i` in styles.css. */
function idx(i: number): React.CSSProperties {
  return { ['--i' as string]: i }
}

export function SleepWall() {
  const [nights, setNights] = useState<Log[]>([])
  const [insight, setInsight] = useState<string | null>(null)
  const [goalMin, setGoalMin] = useState(() => getSleepGoalMin())

  useEffect(() => {
    listSleep()
      .then(setNights)
      .catch(() => {})
  }, [])

  useEffect(() => {
    getSleepInsight(goalMin)
      .then((r) => setInsight(r.blurb))
      .catch(() => {})
  }, [goalMin])

  const changeGoal = (min: number) => {
    const clamped = Math.min(GOAL_MAX_BOUND, Math.max(GOAL_MIN_BOUND, min))
    setGoalMin(clamped)
    setSleepGoalMin(clamped)
  }

  const closed = useMemo(() => closedNights(nights), [nights])
  const metrics = useMemo(() => computeMetrics(nights, goalMin), [nights, goalMin])

  const wakeMedian = medianWakeMinute(closed, TYPICAL_NIGHTS)
  const bedMedian = medianBedMinute(closed, TYPICAL_NIGHTS)
  const target = wakeMedian !== null ? bedtimeTarget(wakeMedian, goalMin) : null

  return (
    <div className="app wall">
      <header>
        <h1 className="brand">solace</h1>
        <div className="header-nav">
          <div className="solace-goal-stepper">
            <button onClick={() => changeGoal(goalMin - GOAL_STEP_MIN)} aria-label="lower goal">
              −
            </button>
            <span>{formatDuration(goalMin)}</span>
            <button onClick={() => changeGoal(goalMin + GOAL_STEP_MIN)} aria-label="raise goal">
              +
            </button>
          </div>
          <a className="guide-link" href="#/sleep">
            panel
          </a>
          <a className="guide-link" href="#/">
            back
          </a>
        </div>
      </header>

      {closed.length < 3 ? (
        <div className="empty">log a few more nights and this page fills in</div>
      ) : (
        <div className="sleep-wall" key={`${closed.length}-${goalMin}`}>
          <StatStrip closed={closed} metrics={metrics} goalMin={goalMin} />
          <Tonight
            index={1}
            target={target}
            wakeMedian={wakeMedian}
            bedMedian={bedMedian}
            avg7={metrics.avg7}
            goalMin={goalMin}
            insight={insight}
          />
          <Calendar closed={closed} goalMin={goalMin} index={2} />
          <Raster closed={closed} goalMin={goalMin} index={3} />
          <Drift closed={closed} index={4} />
          <Weekday closed={closed} goalMin={goalMin} index={5} />
          <Distribution closed={closed} goalMin={goalMin} index={6} />
        </div>
      )}
    </div>
  )
}

function Panel({
  title,
  note,
  wide,
  index = 0,
  children,
}: {
  title: string
  note?: string
  wide?: boolean
  index?: number
  children: React.ReactNode
}) {
  return (
    <section className={`sleep-panel ${wide ? 'wide' : ''}`} style={idx(index)}>
      <div className="sleep-panel-head">
        <h2>{title}</h2>
        {note && <span className="sleep-panel-note">{note}</span>}
      </div>
      {children}
    </section>
  )
}

const COUNT_MS = 650

// Keyed on the value alone, with the formatter in a ref: `format` used to be a
// fresh closure every render and sat in the dep array, so every parent render
// restarted the count - which is what made the page animate twice on load,
// once when the nights arrived and again when the coach's blurb did.
function CountUp({ value, format }: { value: number; format: (v: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const formatRef = useRef(format)
  formatRef.current = format

  useEffect(() => {
    const el = ref.current
    if (!el || prefersReduced()) return
    let raf = 0
    const started = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / COUNT_MS)
      el.textContent = formatRef.current(value * (1 - Math.pow(1 - t, 4)))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])

  return (
    <span className="sleep-stat-value" ref={ref}>
      {format(value)}
    </span>
  )
}

function StatStrip({
  closed,
  metrics,
  goalMin,
}: {
  closed: SleepData[]
  metrics: ReturnType<typeof computeMetrics>
  goalMin: number
}) {
  const score = metrics.consistencyMin !== null ? consistencyScore(metrics.consistencyMin) : null
  const stats: { label: string; value: number; format: (v: number) => string }[] = [
    { label: 'nights logged', value: closed.length, format: (v) => String(Math.round(v)) },
    {
      label: 'average night',
      value: metrics.avg30 ?? 0,
      format: (v) => formatDuration(Math.round(v)),
    },
    { label: 'best run', value: longestStreak(closed, goalMin), format: (v) => String(Math.round(v)) },
  ]
  if (score !== null) {
    stats.push({ label: 'consistency', value: score, format: (v) => String(Math.round(v)) })
  }
  return (
    <section className="sleep-panel wide sleep-strip" style={idx(0)}>
      {stats.map((s) => (
        <div key={s.label} className="sleep-stat">
          <CountUp value={s.value} format={s.format} />
          <span className="sleep-stat-label">{s.label}</span>
        </div>
      ))}
    </section>
  )
}

const RING_R = 76

function Tonight({
  index,
  target,
  wakeMedian,
  bedMedian,
  avg7,
  goalMin,
  insight,
}: {
  index: number
  target: number | null
  wakeMedian: number | null
  bedMedian: number | null
  avg7: number | null
  goalMin: number
  insight: string | null
}) {
  const pct = avg7 !== null ? Math.min(1, avg7 / goalMin) : 0

  // How much earlier than usual tonight's ask is. Bedtimes wrap midnight, so
  // the comparison happens in the 6pm-origin frame, same as everywhere else.
  const earlier =
    bedMedian !== null && target !== null
      ? ((bedMedian - 18 * 60 + 1440) % 1440) - ((target - 18 * 60 + 1440) % 1440)
      : null

  return (
    <Panel title="tonight" note="ring: last 7 nights against goal" index={index}>
      <div className="sleep-ring-wrap">
        <svg viewBox="0 0 180 180" className="sleep-ring">
          <circle cx="90" cy="90" r={RING_R} className="sleep-ring-track" />
          <circle
            cx="90"
            cy="90"
            r={RING_R}
            className="sleep-ring-fill"
            pathLength={100}
            style={{ ['--dash' as string]: (pct * 100).toFixed(2) }}
          />
        </svg>
        <div className="sleep-ring-center">
          <span className="sleep-ring-value">{target !== null ? clockLabel(target) : '—'}</span>
          <span className="sleep-ring-label">asleep by</span>
        </div>
      </div>
      <p className="sleep-reason">
        {wakeMedian !== null ? (
          <>
            you're usually up at {clockLabel(wakeMedian)}
            {bedMedian !== null && <> and down at {clockLabel(bedMedian)}</>}
            {earlier !== null && earlier > 0 ? (
              <> — tonight's ask is {formatDuration(Math.round(earlier))} earlier</>
            ) : (
              <> — you already go down early enough for this</>
            )}
          </>
        ) : (
          'not enough wake times logged yet'
        )}
      </p>
      {insight && <p className="solace-insight">{insight}</p>}
    </Panel>
  )
}

// Clock-time gridlines, every two hours across the 6pm-to-noon window.
const RASTER_TICKS = [0, 2, 4, 6, 8, 10, 12, 14, 16].map((h) => ({
  h,
  pct: ((h * 60) / NIGHT_SPAN_MIN) * 100,
  label: clockLabel((18 * 60 + h * 60) % 1440),
}))

function Raster({ closed, goalMin, index }: { closed: SleepData[]; goalMin: number; index: number }) {
  const rows = closed.filter((d) => d.sleep_start !== null).slice(0, RASTER_NIGHTS)
  if (rows.length < 3) return null

  return (
    <Panel
      title="when you actually sleep"
      note="6pm to noon — each row is one night"
      wide
      index={index}
    >
      <div className="sleep-raster">
        <div className="sleep-raster-ticks">
          {RASTER_TICKS.map((t) => (
            <span key={t.h} className="sleep-tick" style={{ left: `${t.pct}%` }}>
              {t.label}
            </span>
          ))}
        </div>
        {rows.map((d, row) => {
          const start = nightMinute(d.sleep_start as string)
          const width = Math.min(d.duration_min ?? 0, NIGHT_SPAN_MIN - start)
          return (
            <div key={d.night_date} className="sleep-raster-row">
              <span className="sleep-raster-label">
                {shortDay(d.night_date)} {d.night_date.slice(5)}
              </span>
              <div className="sleep-raster-track">
                {RASTER_TICKS.map((t) => (
                  <span key={t.h} className="sleep-gridline" style={{ left: `${t.pct}%` }} />
                ))}
                <div
                  className={`sleep-raster-bar ${(d.duration_min ?? 0) >= goalMin ? 'hit' : ''}`}
                  style={{
                    left: `${(start / NIGHT_SPAN_MIN) * 100}%`,
                    width: `${Math.max(1, (width / NIGHT_SPAN_MIN) * 100)}%`,
                    ['--i' as string]: row,
                  }}
                  title={`${d.night_date}: ${timeShort(d.sleep_start)} to ${timeShort(d.sleep_end)}`}
                />
              </div>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

function rolling(values: (number | null)[], window: number): (number | null)[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1).filter((v): v is number => v !== null)
    return slice.length ? slice.reduce((s, v) => s + v, 0) / slice.length : null
  })
}

function Drift({ closed, index }: { closed: SleepData[]; index: number }) {
  const rows = [...closed]
    .filter((d) => d.sleep_start !== null && d.sleep_end !== null)
    .slice(0, DRIFT_NIGHTS)
    .reverse()
  if (rows.length < 8) return null

  const W = 1180
  const H = 300
  const pad = 18
  const x = (i: number) => pad + (i * (W - 2 * pad)) / Math.max(1, rows.length - 1)
  // Both series live on one axis in the 6pm-origin frame: bedtimes land near
  // the top, wake times near the bottom, and the gap between the lines is the
  // night itself.
  const beds = rows.map((d) => nightMinute(d.sleep_start as string))
  const wakes = rows.map((d) => nightMinute(d.sleep_end as string))
  // Cropped to the hours actually slept rather than the whole 6pm-to-noon
  // window: on a full axis every night's line is a flat band in the middle and
  // the drift this chart exists to show is invisible.
  const lo = Math.max(0, Math.min(...beds, ...wakes) - 45)
  const hi = Math.min(NIGHT_SPAN_MIN, Math.max(...beds, ...wakes) + 45)
  const y = (v: number) => pad + ((v - lo) / (hi - lo)) * (H - 2 * pad)
  const path = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v === null ? '' : `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`))
      .filter(Boolean)
      .join(' ')

  const step = hi - lo > 9 * 60 ? 2 : 1
  const ticks: { h: number; y: number; label: string }[] = []
  for (let h = Math.ceil(lo / 60); h * 60 <= hi; h += step) {
    ticks.push({ h, y: y(h * 60), label: clockLabel((18 * 60 + h * 60) % 1440) })
  }

  return (
    <Panel title="bedtime & wake drift" note={`last ${rows.length} nights, ${DRIFT_SMOOTH}-night trend`} wide index={index}>
      <svg viewBox={`0 0 ${W} ${H}`} className="sleep-chart tall">
        {ticks.map((t) => (
          <g key={t.h}>
            <line x1={pad} y1={t.y} x2={W - pad} y2={t.y} className="sleep-axis faint" />
            <text x={W - pad} y={t.y - 4} className="sleep-axis-label" textAnchor="end">
              {t.label}
            </text>
          </g>
        ))}
        <path
          d={path(rolling(beds, DRIFT_SMOOTH))}
          pathLength={1}
          className="sleep-line bed sleep-draw"
        />
        <path
          d={path(rolling(wakes, DRIFT_SMOOTH))}
          pathLength={1}
          className="sleep-line wake sleep-draw"
        />
        {beds.map((v, i) => (
          <circle key={`b${i}`} cx={x(i)} cy={y(v)} r="2.5" className="sleep-dot bed" style={idx(i)} />
        ))}
        {wakes.map((v, i) => (
          <circle key={`w${i}`} cx={x(i)} cy={y(v)} r="2.5" className="sleep-dot wake" style={idx(i)} />
        ))}
      </svg>
      <div className="sleep-legend">
        <span className="bed">bedtime</span>
        <span className="wake">wake</span>
      </div>
    </Panel>
  )
}

function Weekday({ closed, goalMin, index }: { closed: SleepData[]; goalMin: number; index: number }) {
  const days = byWeekday(closed)
  if (days.some((d) => d.count === 0)) return null
  const max = Math.max(goalMin, ...days.map((d) => d.avg ?? 0))

  return (
    <Panel title="by weekday" note="average per day, and how many nights it stands on" index={index}>
      <div className="sleep-bars with-goal">
        <div
          className="sleep-goal-line"
          style={{ bottom: `${28 + (goalMin / max) * 130}px` }}
        />
        {days.map((d, i) => (
          <div key={i} className="sleep-bar-col">
            <div className="sleep-bar-track">
              <div
                className={`sleep-vbar ${(d.avg ?? 0) >= goalMin ? 'hit' : ''}`}
                style={{ height: `${((d.avg ?? 0) / max) * 100}%`, ['--i' as string]: i }}
                title={`${SHORT_DAY_NAMES[i]}: ${formatDuration(Math.round(d.avg ?? 0))} over ${d.count} night${d.count === 1 ? '' : 's'}`}
              />
            </div>
            <span className="sleep-bar-label">{SHORT_DAY_NAMES[i]}</span>
            <span className="sleep-bar-sub">{formatDuration(Math.round(d.avg ?? 0))}</span>
            <span className="sleep-bar-sub faint">{d.count}n</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function Distribution({ closed, goalMin, index }: { closed: SleepData[]; goalMin: number; index: number }) {
  const buckets = histogram(closed, HISTOGRAM_BUCKET_MIN)
  if (closed.length < 8 || buckets.length < 2) return null
  const max = Math.max(...buckets.map((b) => b.count))

  return (
    <Panel title="how your nights cluster" note={`${HISTOGRAM_BUCKET_MIN / 60}-hour buckets`} index={index}>
      <div className="sleep-bars">
        {buckets.map((b, i) => (
          <div key={b.from} className="sleep-bar-col">
            <div className="sleep-bar-track">
              <div
                className={`sleep-vbar ${b.from >= goalMin ? 'hit' : ''}`}
                style={{ height: `${(b.count / max) * 100}%`, ['--i' as string]: i }}
                title={`${b.count} night${b.count === 1 ? '' : 's'} between ${formatDuration(b.from)} and ${formatDuration(b.from + HISTOGRAM_BUCKET_MIN)}`}
              />
            </div>
            <span className="sleep-bar-label">{b.from / 60}h</span>
            <span className="sleep-bar-sub">{b.count || ''}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function Calendar({ closed, goalMin, index }: { closed: SleepData[]; goalMin: number; index: number }) {
  const byDate = new Map(closed.map((d) => [d.night_date, d.duration_min ?? 0]))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const earliest = closed[closed.length - 1]?.night_date
  if (!earliest) return null

  // Sunday-aligned columns ending on the week containing today, stretched to a
  // minimum so a three-week history doesn't render as a stub.
  const thisSunday = new Date(today)
  thisSunday.setDate(thisSunday.getDate() - thisSunday.getDay())
  const spanDays = Math.ceil(
    (thisSunday.getTime() - new Date(earliest + 'T00:00').getTime()) / 86400000,
  )
  const weeks = Math.max(CALENDAR_MIN_WEEKS, Math.ceil(spanDays / 7) + 1)
  const dayHeads = SHORT_DAY_NAMES
  const start = new Date(thisSunday)
  start.setDate(start.getDate() - (weeks - 1) * 7)
  const todayStr = localDate(today)

  const level = (min: number | undefined) => {
    if (min === undefined) return 'blank'
    const ratio = min / goalMin
    if (ratio >= 1) return 'l4'
    if (ratio >= 0.9) return 'l3'
    if (ratio >= 0.75) return 'l2'
    return 'l1'
  }

  return (
    <Panel title="every night" note={`shaded by how close to your ${formatDuration(goalMin)} goal`} index={index}>
      <div className="sleep-cal">
        <div className="sleep-cal-week heads">
          {dayHeads.map((h, i) => (
            <span key={i} className="sleep-cal-head">
              {h}
            </span>
          ))}
        </div>
        {Array.from({ length: weeks }, (_, w) => (
          <div key={w} className="sleep-cal-week">
            {Array.from({ length: 7 }, (_, d) => {
              const cell = new Date(start)
              cell.setDate(cell.getDate() + w * 7 + d)
              const str = localDate(cell)
              const mins = byDate.get(str)
              return (
                <div
                  key={str}
                  style={idx(w * 7 + d)}
                  className={`sleep-cell ${str > todayStr ? 'future' : level(mins)}`}
                  title={mins === undefined ? `${str} · nothing logged` : `${str}: ${formatDuration(mins)}`}
                />
              )
            })}
          </div>
        ))}
      </div>
    </Panel>
  )
}
