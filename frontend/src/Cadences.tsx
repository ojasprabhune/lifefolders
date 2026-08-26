import { useCallback, useEffect, useMemo, useState } from 'react'
import { archiveCadence, createCadence, getCadenceCompletions, listCadences, patchCadence } from './api'
import { Panel, usePanelState } from './Panel'
import type { Cadence, CadenceCompletions, CadenceSchedule, IntervalUnit } from './types'

const WEEKS = 14
const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

// How a schedule reads in a sentence. Mirrors Schedule::label in cadences.rs;
// the two are shown in different places (chip vs. LLM prompt) and drifting
// apart would be confusing rather than broken.
function scheduleLabel(s: CadenceSchedule): string {
  const base =
    s.interval_n === 1
      ? s.interval_unit === 'week'
        ? 'weekly'
        : 'daily'
      : `every ${s.interval_n} ${s.interval_unit}s`
  if (s.interval_unit === 'week' && s.weekdays.length > 0) {
    const days = [...s.weekdays].sort((a, b) => a - b).map((d) => DAY_NAMES[d])
    return `${base} on ${days.join('/')}`
  }
  return base
}

function dateToStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// GitHub-style grid: columns are weeks (Sunday-aligned), rows are weekdays.
// The last column is the week containing today, so today's cell is always in
// the grid; days after today within that week render blank.
function buildWeeks(): Date[][] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const thisSunday = addDays(today, -today.getDay())
  const start = addDays(thisSunday, -(WEEKS - 1) * 7)
  const cols: Date[][] = []
  for (let w = 0; w < WEEKS; w++) {
    const col: Date[] = []
    for (let d = 0; d < 7; d++) col.push(addDays(start, w * 7 + d))
    cols.push(col)
  }
  return cols
}

export function Cadences({ open }: { open: boolean }) {
  const [cadences, setCadences] = useState<Cadence[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [completions, setCompletions] = useState<CadenceCompletions | null>(null)
  const [managing, setManaging] = useState(false)
  const { mounted, closing } = usePanelState(open)

  const loadCadences = useCallback(async () => {
    const list = await listCadences().catch(() => [] as Cadence[])
    setCadences(list)
    setSelectedId((prev) => (prev && list.some((h) => h.id === prev) ? prev : (list[0]?.id ?? null)))
  }, [])

  useEffect(() => {
    if (!mounted) return
    void loadCadences()
    window.addEventListener('life-log-created', loadCadences)
    return () => window.removeEventListener('life-log-created', loadCadences)
  }, [mounted, loadCadences])

  const refreshCompletions = useCallback(() => {
    if (!selectedId) {
      setCompletions(null)
      return
    }
    getCadenceCompletions(selectedId, WEEKS * 7)
      .then(setCompletions)
      .catch(() => setCompletions(null))
  }, [selectedId])

  useEffect(() => {
    if (!mounted) return
    refreshCompletions()
    window.addEventListener('life-log-created', refreshCompletions)
    return () => window.removeEventListener('life-log-created', refreshCompletions)
  }, [mounted, refreshCompletions])

  const done = useMemo(() => new Set(completions?.dates ?? []), [completions])
  const due = useMemo(() => new Set(completions?.due_dates ?? []), [completions])
  const weeks = useMemo(buildWeeks, [])
  const today = dateToStr(new Date())
  const selected = cadences.find((h) => h.id === selectedId) ?? null
  // One cell per week only when the target really is "once this week, any
  // day" - picking specific weekdays makes the individual days meaningful
  // again, so those get the normal per-day grid with the off days shaded out.
  const byWeek = selected?.interval_unit === 'week' && selected.weekdays.length === 0

  if (!mounted) return null

  return (
    <Panel closing={closing}>
      <header>
        <h1 className="brand">cadence</h1>
        <div className="header-nav">
          <button className="guide-link" onClick={() => setManaging((m) => !m)}>
            {managing ? 'done' : 'manage'}
          </button>
          <a className="guide-link" href="#/">
            back
          </a>
        </div>
      </header>

      {managing && <Manage cadences={cadences} onChange={loadCadences} />}

      {cadences.length === 0 && !managing && (
        <div className="empty">
          no cadences yet — <button className="link-btn" onClick={() => setManaging(true)}>add one</button>
        </div>
      )}

      {cadences.length > 0 && (
        <>
          <div className="filters cadence-chips">
            {cadences.map((h) => (
              <button
                key={h.id}
                className={`filter ${h.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(h.id)}
              >
                {h.name.toLowerCase()}
              </button>
            ))}
          </div>

          {selected && (
            <div className="cadence-board">
              <div className="cadence-stats">
                <div className="stat-tile">
                  <span className="stat-num">{completions?.current_streak ?? 0}</span>
                  <span className="stat-label">current streak</span>
                </div>
                <div className="stat-tile">
                  <span className="stat-num">{completions?.longest_streak ?? 0}</span>
                  <span className="stat-label">longest streak</span>
                </div>
                <div className="stat-tile">
                  <span className="stat-num sched">{scheduleLabel(selected)}</span>
                  <span className="stat-label">repeats</span>
                </div>
              </div>

              <div className="cadence-grid">
                <div className="cadence-months">
                  {weeks.map((col, i) => {
                    const first = col[0]
                    const prevFirst = i > 0 ? weeks[i - 1][0] : null
                    const label =
                      !prevFirst || first.getMonth() !== prevFirst.getMonth()
                        ? MONTHS[first.getMonth()]
                        : ''
                    return (
                      <span key={i} className="cadence-month">
                        {label}
                      </span>
                    )
                  })}
                </div>
                <div className="cadence-weeks">
                  {weeks.map((col, i) => {
                    // "Once this week, any day" makes a per-day dot noise -
                    // one cell per week matches the actual target and lines
                    // up with the streak counting weeks.
                    if (byWeek) {
                      const weekStr = dateToStr(col[0])
                      const future = weekStr > today
                      const lit = col.some((d) => done.has(dateToStr(d)))
                      const owed = col.some((d) => due.has(dateToStr(d)))
                      return (
                        <div key={i} className="cadence-week">
                          <div
                            className={`cadence-cell weekly ${
                              future ? 'future' : lit ? 'done' : owed ? '' : 'off'
                            }`}
                            title={weekStr}
                          />
                        </div>
                      )
                    }
                    return (
                      <div key={i} className="cadence-week">
                        {col.map((d) => {
                          const str = dateToStr(d)
                          const future = str > today
                          const lit = done.has(str)
                          // A day it was never owed on is not a miss, so it
                          // reads as blank rather than as an empty slot.
                          const owed = due.has(str)
                          return (
                            <div
                              key={str}
                              className={`cadence-cell ${
                                future ? 'future' : lit ? 'done' : owed ? '' : 'off'
                              }`}
                              title={owed || lit ? str : `${str} · not due`}
                            />
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}

const DEFAULT_SCHEDULE: CadenceSchedule = { interval_unit: 'day', interval_n: 1, weekdays: [] }

// The repeat picker, shared by the add form and each row's edit panel. Reads
// as a sentence - "every [2] weeks / on [S M T W T F S]" - rather than as a
// fixed daily/weekly choice, so biweekly and mon/wed/fri are sayable.
function ScheduleEditor({
  value,
  onChange,
}: {
  value: CadenceSchedule
  onChange: (next: CadenceSchedule) => void
}) {
  const setUnit = (unit: IntervalUnit) =>
    onChange({ ...value, interval_unit: unit, weekdays: unit === 'week' ? value.weekdays : [] })

  const toggleDay = (d: number) =>
    onChange({
      ...value,
      weekdays: value.weekdays.includes(d)
        ? value.weekdays.filter((x) => x !== d)
        : [...value.weekdays, d].sort((a, b) => a - b),
    })

  return (
    <div className="sched-editor">
      <div className="sched-line">
        <span className="sched-word">every</span>
        <input
          className="sched-num"
          type="number"
          min={1}
          max={52}
          value={value.interval_n}
          onChange={(e) =>
            onChange({ ...value, interval_n: Math.min(52, Math.max(1, Number(e.target.value) || 1)) })
          }
        />
        <div className="status-buttons">
          {(['day', 'week'] as const).map((u) => (
            <button
              key={u}
              className={`filter ${value.interval_unit === u ? 'active' : ''}`}
              onClick={() => setUnit(u)}
            >
              {value.interval_n === 1 ? u : `${u}s`}
            </button>
          ))}
        </div>
      </div>
      {value.interval_unit === 'week' && (
        <div className="sched-line">
          <span className="sched-word">on</span>
          <div className="sched-days">
            {DAY_INITIALS.map((initial, d) => (
              <button
                key={d}
                className={`sched-day ${value.weekdays.includes(d) ? 'active' : ''}`}
                onClick={() => toggleDay(d)}
                aria-label={DAY_NAMES[d]}
              >
                {initial}
              </button>
            ))}
          </div>
        </div>
      )}
      <span className="sched-summary">
        {scheduleLabel(value)}
        {value.interval_unit === 'week' && value.weekdays.length === 0 && ' — any day that week'}
      </span>
    </div>
  )
}

function Manage({ cadences, onChange }: { cadences: Cadence[]; onChange: () => void }) {
  const [name, setName] = useState('')
  const [schedule, setSchedule] = useState<CadenceSchedule>(DEFAULT_SCHEDULE)
  const [editingId, setEditingId] = useState<string | null>(null)

  const add = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    await createCadence({ name: trimmed, ...schedule }).catch(() => {})
    setName('')
    setSchedule(DEFAULT_SCHEDULE)
    onChange()
  }

  const remove = async (id: string) => {
    await archiveCadence(id).catch(() => {})
    onChange()
  }

  const rename = async (id: string, current: string, next: string) => {
    const trimmed = next.trim()
    if (!trimmed || trimmed === current) return
    await patchCadence(id, { name: trimmed }).catch(() => {})
    onChange()
  }

  const reschedule = async (id: string, next: CadenceSchedule) => {
    await patchCadence(id, next).catch(() => {})
    onChange()
  }

  return (
    <div className="cadence-manage">
      {cadences.map((h) => (
        <div key={h.id}>
          <div className="cadence-manage-row">
            <span>
              <input
                className="cadence-name-input"
                defaultValue={h.name}
                size={Math.max(h.name.length, 1)}
                onBlur={(e) => void rename(h.id, h.name, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
              />{' '}
              <button
                className="row-sub link-btn"
                onClick={() => setEditingId((c) => (c === h.id ? null : h.id))}
              >
                {scheduleLabel(h)}
              </button>
            </span>
            <button
              className="delete-btn"
              onClick={() => void remove(h.id)}
              aria-label="archive cadence"
            >
              ✕
            </button>
          </div>
          {editingId === h.id && (
            <ScheduleEditor
              value={h}
              onChange={(next) => void reschedule(h.id, next)}
            />
          )}
        </div>
      ))}
      <div className="cadence-manage-add">
        <input
          className="entry-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
          placeholder="new cadence"
        />
        <ScheduleEditor value={schedule} onChange={setSchedule} />
        <div className="status-buttons">
          <button className="action save" onClick={() => void add()} disabled={!name.trim()}>
            add
          </button>
        </div>
      </div>
    </div>
  )
}
