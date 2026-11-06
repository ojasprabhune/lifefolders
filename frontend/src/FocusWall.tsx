import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { listFocusSessions } from './api'
import { formatDuration } from './Row'
import {
  clockLabel,
  localDate,
  median,
  minuteOfDay,
  shortDay,
  SHORT_DAY_NAMES,
} from './sleepStats'
import type { SessionHistory } from './types'
import { lastPanel } from './lastPanel'

const RASTER_DAYS = 24
const RASTER_START = 6 * 60
const TREND_WEEKS = 10
const CAL_MIN_WEEKS = 18
const CRUNCH_LABELS = ['week out', '4–6d', '2–3d', '1d', 'due day', 'late']
const LENGTH_LABELS = ['<15m', '15–24', '25–44', '45–59', '1h+']
const DIAL_C = 110
const DIAL_R0 = 38
const DIAL_R1 = 96

function prefersReduced(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function idx(i: number): React.CSSProperties {
  return { ['--i' as string]: i }
}

function dayKeyOf(iso: string): string {
  return localDate(new Date(iso))
}

function dayStart(key: string): Date {
  return new Date(key + 'T00:00')
}

function hourLabel(h: number): string {
  const hh = ((h % 24) + 24) % 24
  if (hh === 0) return '12am'
  if (hh < 12) return `${hh}am`
  if (hh === 12) return '12pm'
  return `${hh - 12}pm`
}

function windowLabel(h0: number): string {
  return `${hourLabel(h0)}–${hourLabel(h0 + 2)}`
}

function clampAt(v: number, max: number): number {
  return Math.max(0, Math.min(v, max))
}

export function FocusWall() {
  const [sessions, setSessions] = useState<SessionHistory[]>([])

  useEffect(() => {
    listFocusSessions().then(setSessions).catch(() => {})
  }, [])

  const rows = useMemo(
    () => sessions.filter((s) => s.ended_at !== null && (s.actual_minutes ?? 0) > 0),
    [sessions],
  )

  return (
    <div className="app wall">
      <header>
        <h1 className="brand">clarity</h1>
        <div className="header-nav">
          <a className="guide-link" href="#/focus">
            timer
          </a>
          <a className="guide-link" href={lastPanel()}>
            back
          </a>
        </div>
      </header>

      {rows.length < 3 ? (
        <div className="empty">
          run a few clarity sessions and this page fills in —{' '}
          <a href="#/focus">start one now</a>
        </div>
      ) : (
        <div className="clarity-wall" key={rows.length}>
          <StatStrip rows={rows} index={0} />
          <Dial rows={rows} index={1} />
          <Crunch rows={rows} index={2} />
          <Raster rows={rows} index={3} />
          <Trend rows={rows} index={4} />
          <Weekday rows={rows} index={5} />
          <Calendar rows={rows} index={6} />
          <PowerGrid rows={rows} index={7} />
          <Calibration rows={rows} index={8} />
          <Lengths rows={rows} index={9} />
        </div>
      )}
    </div>
  )
}

function Panel({
  title,
  note,
  wide,
  index,
  children,
}: {
  title: string
  note?: string
  wide?: boolean
  index: number
  children: React.ReactNode
}) {
  return (
    <section className={`clarity-panel ${wide ? 'wide' : ''}`} style={idx(index)}>
      <div className="clarity-panel-head">
        <h2>{title}</h2>
        {note && <span className="clarity-panel-note">{note}</span>}
      </div>
      {children}
    </section>
  )
}

const COUNT_MS = 650

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
    <span className="focus-stat-value" ref={ref}>
      {format(value)}
    </span>
  )
}

function StatStrip({ rows, index }: { rows: SessionHistory[]; index: number }) {
  const total = rows.reduce((s, r) => s + (r.actual_minutes ?? 0), 0)
  const done = rows.filter((r) => r.completed).length
  const active = new Set(rows.map((r) => dayKeyOf(r.started_at)))
  let streak = 0
  const cursor = new Date()
  if (!active.has(localDate(cursor))) cursor.setDate(cursor.getDate() - 1)
  for (;;) {
    if (!active.has(localDate(cursor))) break
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }

  const stats: { label: string; value: number; format: (v: number) => string }[] = [
    { label: 'hours counted', value: total / 60, format: (v) => `${v.toFixed(1)}h` },
    { label: 'sessions', value: rows.length, format: (v) => String(Math.round(v)) },
    {
      label: 'see it through',
      value: (done / rows.length) * 100,
      format: (v) => `${Math.round(v)}%`,
    },
    { label: 'day streak', value: streak, format: (v) => String(Math.round(v)) },
  ]
  return (
    <section className="clarity-panel wide focus-strip" style={idx(index)}>
      {stats.map((s) => (
        <div key={s.label} className="focus-stat">
          <CountUp value={s.value} format={s.format} />
          <span className="focus-stat-label">{s.label}</span>
        </div>
      ))}
    </section>
  )
}

/** Counted minutes, minute-accurately, into hour buckets — global and by
 * weekday. Paying every counted minute into its own hour is wrap-safe across
 * midnight and treats a two-hour sit as the two hours it was. */
function hourBuckets(rows: SessionHistory[]) {
  const global = Array.from({ length: 24 }, () => 0)
  const byWeekday = SHORT_DAY_NAMES.map(() => Array.from({ length: 24 }, () => 0))
  for (const s of rows) {
    const start = minuteOfDay(s.started_at)
    const m = Math.min(s.actual_minutes ?? 0, 12 * 60)
    const dow = dayStart(dayKeyOf(s.started_at)).getDay()
    for (let i = 0; i < m; i++) {
      const h = Math.floor((start + i) / 60) % 24
      global[h]++
      byWeekday[dow][h]++
    }
  }
  return { global, byWeekday }
}

function Dial({ rows, index }: { rows: SessionHistory[]; index: number }) {
  const { global } = useMemo(() => hourBuckets(rows), [rows])
  const firsts = useMemo(() => {
    const perDay = new Map<string, number>()
    for (const s of rows) {
      const day = dayKeyOf(s.started_at)
      perDay.set(day, Math.min(perDay.get(day) ?? 1440, minuteOfDay(s.started_at)))
    }
    return [...perDay.values()]
  }, [rows])

  const max = Math.max(...global)
  if (max === 0) return null

  let peak = 0
  for (let h = 0; h < 24; h++) {
    if (global[h] + global[(h + 1) % 24] > global[peak] + global[(peak + 1) % 24]) peak = h
  }
  const peakMin = global[peak] + global[(peak + 1) % 24]
  const share = Math.round((peakMin / Math.max(1, rows.reduce((s, r) => s + (r.actual_minutes ?? 0), 0))) * 100)

  const open = median(firsts)
  const wedge = (h: number, v: number) => {
    if (v <= 0) return null
    const r1 = DIAL_R0 + 6 + (v / max) * (DIAL_R1 - DIAL_R0 - 6)
    const a0 = h * 15 + 0.9
    const a1 = (h + 1) * 15 - 0.9
    const rad = (d: number) => ((d - 90) * Math.PI) / 180
    const pt = (r: number, a: number) =>
      `${(DIAL_C + r * Math.cos(rad(a))).toFixed(2)},${(DIAL_C + r * Math.sin(rad(a))).toFixed(2)}`
    return `M${pt(r1, a0)} A${r1} ${r1} 0 0 1 ${pt(r1, a1)} L${pt(DIAL_R0, a1)} A${DIAL_R0} ${DIAL_R0} 0 0 0 ${pt(DIAL_R0, a0)} Z`
  }

  return (
    <Panel title="the dial" note="counted minutes by the hour sat" index={index}>
      <div className="focus-dial-wrap">
        <svg viewBox="0 0 220 220" className="focus-dial">
          {[0, 6, 12, 18].map((h) => {
            const rad = ((h * 15 - 90) * Math.PI) / 180
            return (
              <line
                key={h}
                x1={DIAL_C + (DIAL_R1 + 2) * Math.cos(rad)}
                y1={DIAL_C + (DIAL_R1 + 2) * Math.sin(rad)}
                x2={DIAL_C + (DIAL_R1 + 7) * Math.cos(rad)}
                y2={DIAL_C + (DIAL_R1 + 7) * Math.sin(rad)}
                className="focus-axis"
              />
            )
          })}
          {global.map((v, h) => {
            const d = wedge(h, v)
            if (!d) return null
            return (
              <path
                key={h}
                d={d}
                className="focus-wedge"
                style={{ opacity: 0.35 + (0.65 * v) / max, ...idx(h) }}
              />
            )
          })}
        </svg>
        <div className="focus-dial-center">
          <span className="focus-dial-value">{windowLabel(peak)}</span>
          <span className="focus-dial-label">heaviest hours</span>
        </div>
      </div>
      <p className="focus-reason">
        {share}% of your counted time lands between {hourLabel(peak)} and{' '}
        {hourLabel(peak + 2)}
        {open !== null && <> — your day usually opens at {clockLabel(open)}</>}.
      </p>
      <div className="focus-legend">
        <span>12am top</span>
        <span>6am right</span>
        <span>12pm bottom</span>
        <span>6pm left, clockwise</span>
      </div>
    </Panel>
  )
}

function Crunch({ rows, index }: { rows: SessionHistory[]; index: number }) {
  const dated = rows.filter((s) => s.task_id !== null && s.due_date !== null)
  if (dated.length < 8) return null
  const mins = CRUNCH_LABELS.map(() => 0)
  for (const s of dated) {
    const delta = Math.round(
      (dayStart(dayKeyOf(s.started_at)).getTime() - dayStart(s.due_date as string).getTime()) /
        86400000,
    )
    const b = delta >= 7 ? 0 : delta >= 4 ? 1 : delta >= 2 ? 2 : delta === 1 ? 3 : delta === 0 ? 4 : 5
    mins[b] += s.actual_minutes ?? 0
  }
  const total = mins.reduce((s, v) => s + v, 0)
  const max = Math.max(...mins)
  if (max === 0) return null
  const lastTwo = mins[2] + mins[3] + mins[4]
  const shareTwo = Math.round((lastTwo / total) * 100)
  const verdict =
    shareTwo >= 50
      ? `${shareTwo}% of dated work lands inside the two days before it's due`
      : mins[0] / total >= 0.4
        ? 'you mostly get to dated work a week out or earlier'
        : 'dated work spreads out — no real crunch pattern yet'

  return (
    <Panel title="the crunch" note="work vs its deadline" index={index}>
      <div className="focus-bars">
        {mins.map((v, i) => (
          <div key={i} className="focus-bar-col">
            <div className="focus-bar-track">
              <div
                className={`focus-vbar ${v === max ? 'hit' : ''}`}
                style={{ height: `${(v / max) * 100}%`, ...idx(i) }}
                title={`${CRUNCH_LABELS[i]}: ${formatDuration(v)} counted`}
              />
            </div>
            <span className="focus-bar-label">{CRUNCH_LABELS[i]}</span>
            <span className="focus-bar-sub">{v > 0 ? formatDuration(v) : ''}</span>
          </div>
        ))}
      </div>
      <p className="focus-reason">{verdict}.</p>
    </Panel>
  )
}

const RASTER_TICKS = [0, 3, 6, 9, 12, 15, 18, 21].map((h) => ({
  h,
  pct: ((h * 60) / 1440) * 100,
  label: clockLabel((RASTER_START + h * 60) % 1440),
}))

function Raster({ rows, index }: { rows: SessionHistory[]; index: number }) {
  const grouped = useMemo(() => {
    const m = new Map<string, SessionHistory[]>()
    for (const s of rows) {
      const day = dayKeyOf(s.started_at)
      if (!m.has(day)) m.set(day, [])
      m.get(day)!.push(s)
    }
    return m
  }, [rows])
  const days = [...grouped.keys()].sort().reverse().slice(0, RASTER_DAYS)
  if (days.length < 3) return null

  return (
    <Panel
      title="when you actually sit"
      note="6am to 6am — each bar one session"
      wide
      index={index}
    >
      <div className="focus-raster">
        <div className="focus-raster-ticks">
          {RASTER_TICKS.map((t) => (
            <span key={t.h} className="focus-tick" style={{ left: `${t.pct}%` }}>
              {t.label}
            </span>
          ))}
        </div>
        {days.map((day, row) => (
          <div key={day} className="focus-raster-row">
            <span className="focus-raster-label">
              {shortDay(day)} {day.slice(5)}
            </span>
            <div className="focus-raster-track">
              {RASTER_TICKS.map((t) => (
                <span key={t.h} className="focus-tickline" style={{ left: `${t.pct}%` }} />
              ))}
              {grouped.get(day)!.map((s, i) => {
                const start = ((minuteOfDay(s.started_at) - RASTER_START) % 1440 + 1440) % 1440
                const wall = s.ended_at
                  ? Math.max(1, (Date.parse(s.ended_at) - Date.parse(s.started_at)) / 60000)
                  : s.actual_minutes ?? 1
                const counted = Math.min(s.actual_minutes ?? 0, wall)
                const tail = clampAt(s.planned_minutes - counted, 120)
                return (
                  <Fragment key={s.id}>
                    <div
                      className="focus-raster-session"
                      style={{
                        left: `${Math.min(99, (start / 1440) * 100)}%`,
                        width: `${Math.max(0.6, (Math.min(wall, 1440 - start) / 1440) * 100)}%`,
                        ...idx(row * 4 + i),
                      }}
                      title={`${day}: ${clockLabel(minuteOfDay(s.started_at))} — ${formatDuration(counted)} counted of ${formatDuration(s.planned_minutes)} planned · ${s.title}`}
                    >
                      <span
                        className="focus-raster-fill"
                        style={{ width: `${(counted / wall) * 100}%` }}
                      />
                    </div>
                    {tail > 0 && (
                      <span
                        className="focus-raster-tail"
                        style={{
                          left: `${((Math.min(wall, 1440 - start) + start) / 1440) * 100}%`,
                          width: `${Math.max(0.5, (tail / 1440) * 100)}%`,
                        }}
                      />
                    )}
                  </Fragment>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="focus-legend">
        <span className="legend-solid">counted</span>
        <span className="legend-hatched">paused / afk</span>
        <span className="legend-void">planned but not sat</span>
      </div>
    </Panel>
  )
}

function Trend({ rows, index }: { rows: SessionHistory[]; index: number }) {
  const weeks = useMemo(() => {
    const byWeek = new Map<string, number>()
    for (const s of rows) {
      const d = dayStart(dayKeyOf(s.started_at))
      const sunday = new Date(d)
      sunday.setDate(sunday.getDate() - sunday.getDay())
      const key = localDate(sunday)
      byWeek.set(key, (byWeek.get(key) ?? 0) + (s.actual_minutes ?? 0))
    }
    const out: { start: string; minutes: number }[] = []
    const first = new Date()
    first.setDate(first.getDate() - first.getDay() - (TREND_WEEKS - 1) * 7)
    for (let w = 0; w < TREND_WEEKS; w++) {
      const key = localDate(first)
      out.push({ start: key, minutes: byWeek.get(key) ?? 0 })
      first.setDate(first.getDate() + 7)
    }
    return out
  }, [rows])
  if (weeks.every((w) => w.minutes === 0)) return null

  const W = 520
  const H = 190
  const pad = 16
  const max = Math.max(...weeks.map((w) => w.minutes), 1)
  const slot = (W - 2 * pad) / TREND_WEEKS
  const avg = weeks.map((_, i) => {
    const slice = weeks.slice(Math.max(0, i - 3), i + 1)
    return slice.reduce((s, w) => s + w.minutes, 0) / slice.length
  })
  const line = avg
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(pad + slot * (i + 0.5)).toFixed(1)},${(H - pad - (v / max) * (H - 2 * pad)).toFixed(1)}`)
    .join(' ')

  return (
    <Panel title="the last weeks" note="bar: week · line: 4-week drift" index={index}>
      <svg viewBox={`0 0 ${W} ${H}`} className="focus-trend">
        {weeks.map((w, i) => {
          const h = (w.minutes / max) * (H - 2 * pad)
          return (
            <rect
              key={w.start}
              x={pad + slot * i + 3}
              y={H - pad - h}
              width={Math.max(4, slot - 6)}
              height={Math.max(w.minutes > 0 ? 2 : 0, h)}
              className="focus-weekbar"
              style={idx(i)}
            >
              <title>
                {`week of ${w.start.slice(5)}: ${formatDuration(Math.round(w.minutes))}`}
              </title>
            </rect>
          )
        })}
        <path d={line} pathLength={1} className="focus-trendline focus-draw" />
        <text x={pad} y={H - 3} className="focus-axis-label">
          {weeks[0].start.slice(5)}
        </text>
        <text x={W - pad} y={H - 3} className="focus-axis-label" textAnchor="end">
          {weeks[TREND_WEEKS - 1].start.slice(5)}
        </text>
      </svg>
      <p className="focus-reason">
        {formatDuration(Math.round(weeks[TREND_WEEKS - 1].minutes))} this week vs{' '}
        {formatDuration(Math.round(avg[TREND_WEEKS - 2]))} a typical one.
      </p>
    </Panel>
  )
}

function Weekday({ rows, index }: { rows: SessionHistory[]; index: number }) {
  const days = useMemo(() => {
    const buckets = Array.from({ length: 7 }, () => ({ sum: 0, count: 0 }))
    for (const s of rows) {
      const d = dayStart(dayKeyOf(s.started_at)).getDay()
      buckets[d].sum += s.actual_minutes ?? 0
      buckets[d].count++
    }
    return buckets.map((b) => ({ avg: b.count ? b.sum / b.count : 0, count: b.count }))
  }, [rows])
  const max = Math.max(...days.map((d) => d.avg))
  if (max === 0) return null

  return (
    <Panel title="by weekday" note="average counted per day" index={index}>
      <div className="focus-bars">
        {days.map((d, i) => (
          <div key={i} className="focus-bar-col">
            <div className="focus-bar-track">
              <div
                className={`focus-vbar ${d.avg === max ? 'hit' : ''}`}
                style={{ height: `${(d.avg / max) * 100}%`, ...idx(i) }}
                title={`${SHORT_DAY_NAMES[i]}: ${formatDuration(Math.round(d.avg))} over ${d.count} day${d.count === 1 ? '' : 's'}`}
              />
            </div>
            <span className="focus-bar-label">{SHORT_DAY_NAMES[i]}</span>
            <span className="focus-bar-sub">{formatDuration(Math.round(d.avg))}</span>
            <span className="focus-bar-sub faint">{d.count}d</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function Calendar({ rows, index }: { rows: SessionHistory[]; index: number }) {
  const byDay = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of rows) {
      const day = dayKeyOf(s.started_at)
      m.set(day, (m.get(day) ?? 0) + (s.actual_minutes ?? 0))
    }
    return m
  }, [rows])
  const today = localDate(new Date())
  const earliest = [...byDay.keys()].sort()[0]
  if (!earliest) return null

  const activeMin = [...byDay.values()]
  const typical = median(activeMin) ?? 1
  const thisSunday = new Date()
  thisSunday.setDate(thisSunday.getDate() - thisSunday.getDay())
  const span = Math.ceil(
    (thisSunday.getTime() - dayStart(earliest).getTime()) / 86400000,
  )
  const weeks = Math.max(CAL_MIN_WEEKS, Math.ceil(span / 7) + 1)
  const start = new Date(thisSunday)
  start.setDate(start.getDate() - (weeks - 1) * 7)

  const level = (min: number) => {
    const r = min / typical
    if (r >= 1) return 'l4'
    if (r >= 0.66) return 'l3'
    if (r >= 0.33) return 'l2'
    return 'l1'
  }

  return (
    <Panel
      title="every day"
      note={`shaded against a typical ${formatDuration(Math.round(typical))} day`}
      wide
      index={index}
    >
      <div className="focus-cal-wrap">
        <div className="focus-cal-days">
          {SHORT_DAY_NAMES.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
        <div
          className="focus-cal"
          style={{
            gridTemplateRows: 'repeat(7, 18px)',
            gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: weeks * 7 }, (_, i) => {
            const w = Math.floor(i / 7)
            const cell = new Date(start)
            cell.setDate(cell.getDate() + w * 7 + (i % 7))
            const key = localDate(cell)
            const mins = byDay.get(key)
            const isFuture = key > today
            return (
              <div
                key={key}
                style={idx(i)}
                className={`focus-cal-cell ${isFuture ? 'future' : mins === undefined ? 'blank' : level(mins)}`}
                title={
                  mins === undefined
                    ? `${key} · nothing`
                    : `${key}: ${formatDuration(mins)}`
                }
              />
            )
          })}
        </div>
      </div>
      <div className="focus-legend">
        <span>
          weeks run left to right, from {start.toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </span>
      </div>
    </Panel>
  )
}

function PowerGrid({ rows, index }: { rows: SessionHistory[]; index: number }) {
  const { byWeekday } = useMemo(() => hourBuckets(rows), [rows])
  const max = Math.max(...byWeekday.flat())
  if (max === 0) return null
  const level = (v: number) => {
    const r = v / max
    if (r <= 0) return 'blank'
    if (r >= 0.66) return 'l4'
    if (r >= 0.33) return 'l3'
    return r >= 0.12 ? 'l2' : 'l1'
  }
  const order = [1, 2, 3, 4, 5, 6, 0]

  return (
    <Panel title="the power hours" note="hour × weekday, counted minutes" wide index={index}>
      <div className="focus-power">
        <span />
        {Array.from({ length: 24 }, (_, h) =>
          h % 3 === 0 ? (
            <span key={h} className="focus-power-hour">
              {hourLabel(h)}
            </span>
          ) : (
            <span key={h} />
          ),
        )}
        {order.map((dow, r) => (
          <Fragment key={dow}>
            <span className="focus-power-day">{SHORT_DAY_NAMES[dow]}</span>
            {byWeekday[dow].map((v, h) => (
              <span
                key={h}
                style={idx(r * 24 + h)}
                className={`focus-power-cell ${level(v)}`}
                title={`${SHORT_DAY_NAMES[dow]} ${hourLabel(h)}–${hourLabel(h + 1)}: ${formatDuration(v)}`}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </Panel>
  )
}

function Calibration({ rows, index }: { rows: SessionHistory[]; index: number }) {
  const points = useMemo(
    () =>
      rows
        .filter((s) => (s.actual_minutes ?? 0) > 0)
        .map((s) => ({ x: s.planned_minutes, y: s.actual_minutes as number, title: s.title })),
    [rows],
  )
  if (points.length < 5) return null
  const CAP = 75
  const W = 320
  const H = 250
  const pad = 30
  const at = (v: number, size: number) => pad + (clampAt(v, CAP) / CAP) * (size - 2 * pad)
  const ratio = median(points.filter((p) => p.x > 4).map((p) => p.y / p.x))

  return (
    <Panel title="plan vs reality" note="dashes: exactly on plan · dots clamp at 75m" index={index}>
      <svg viewBox={`0 0 ${W} ${H}`} className="focus-scatter">
        <line x1={pad} y1={H - pad} x2={W - pad} y2={pad} className="focus-axis faint" />
        <text x={W / 2} y={H - 6} className="focus-axis-label" textAnchor="middle">
          planned
        </text>
        <text
          x={10}
          y={H / 2}
          className="focus-axis-label"
          textAnchor="middle"
          transform={`rotate(-90 10 ${H / 2})`}
        >
          sat
        </text>
        {points.map((p, i) => (
          <circle
            key={i}
            cx={at(p.x, W)}
            cy={H - at(p.y, H)}
            r="3.2"
            className="focus-scatter-dot"
            style={idx(i)}
          >
            <title>{`${p.title}: planned ${p.x}m, sat ${p.y}m`}</title>
          </circle>
        ))}
      </svg>
      {ratio !== null && (
        <p className="focus-reason">
          you sit about {ratio.toFixed(1)}× what you plan — above the dashes runs long, below stops
          early.
        </p>
      )}
    </Panel>
  )
}

function Lengths({ rows, index }: { rows: SessionHistory[]; index: number }) {
  const edges = [0, 15, 25, 45, 60, Infinity]
  const counts = LENGTH_LABELS.map(
    (_, b) => rows.filter((s) => (s.actual_minutes ?? 0) >= edges[b] && (s.actual_minutes ?? 0) < edges[b + 1]).length,
  )
  const max = Math.max(...counts)
  if (max === 0) return null

  return (
    <Panel title="session lengths" note="by counted minutes" index={index}>
      <div className="focus-bars">
        {counts.map((v, i) => (
          <div key={i} className="focus-bar-col">
            <div className="focus-bar-track">
              <div
                className={`focus-vbar ${v === max ? 'hit' : ''}`}
                style={{ height: `${(v / max) * 100}%`, ...idx(i) }}
                title={`${LENGTH_LABELS[i]}: ${v} session${v === 1 ? '' : 's'}`}
              />
            </div>
            <span className="focus-bar-label">{LENGTH_LABELS[i]}</span>
            <span className="focus-bar-sub">{v || ''}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}
