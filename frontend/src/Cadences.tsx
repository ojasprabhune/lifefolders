import { useCallback, useEffect, useMemo, useState } from 'react'
import { archiveCadence, createCadence, getCadenceCompletions, listCadences, patchCadence } from './api'
import { Panel, usePanelState } from './Panel'
import type { Cadence, CadenceCompletions } from './types'

const WEEKS = 14

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
  const weeks = useMemo(buildWeeks, [])
  const today = dateToStr(new Date())
  const selected = cadences.find((h) => h.id === selectedId) ?? null
  const weekly = selected?.target_frequency === 'weekly'

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
                  <span className="stat-label">current streak{weekly ? ' (wks)' : ''}</span>
                </div>
                <div className="stat-tile">
                  <span className="stat-num">{completions?.longest_streak ?? 0}</span>
                  <span className="stat-label">longest streak{weekly ? ' (wks)' : ''}</span>
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
                    // A weekly cadence isn't meant to happen every day, so a
                    // per-day dot per day just reads as noise - one cell per
                    // week (hit anywhere in it, or not) matches the actual
                    // target and lines up with the streak now counting weeks.
                    if (weekly) {
                      const weekStr = dateToStr(col[0])
                      const future = weekStr > today
                      const lit = col.some((d) => done.has(dateToStr(d)))
                      return (
                        <div key={i} className="cadence-week">
                          <div
                            className={`cadence-cell weekly ${future ? 'future' : lit ? 'done' : ''}`}
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
                          return (
                            <div
                              key={str}
                              className={`cadence-cell ${future ? 'future' : lit ? 'done' : ''}`}
                              title={str}
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

function Manage({ cadences, onChange }: { cadences: Cadence[]; onChange: () => void }) {
  const [name, setName] = useState('')
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('daily')

  const add = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    await createCadence({ name: trimmed, target_frequency: frequency }).catch(() => {})
    setName('')
    onChange()
  }

  const remove = async (id: string) => {
    await archiveCadence(id).catch(() => {})
    onChange()
  }

  const rename = async (id: string, current: string, next: string) => {
    const trimmed = next.trim()
    if (!trimmed || trimmed === current) return
    await patchCadence(id, trimmed).catch(() => {})
    onChange()
  }

  return (
    <div className="cadence-manage">
      {cadences.map((h) => (
        <div key={h.id} className="cadence-manage-row">
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
            <span className="row-sub">{h.target_frequency}</span>
          </span>
          <button className="delete-btn" onClick={() => void remove(h.id)} aria-label="archive cadence">
            ✕
          </button>
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
        <div className="status-buttons">
          {(['daily', 'weekly'] as const).map((f) => (
            <button
              key={f}
              className={`filter ${frequency === f ? 'active' : ''}`}
              onClick={() => setFrequency(f)}
            >
              {f}
            </button>
          ))}
          <button className="action save" onClick={() => void add()} disabled={!name.trim()}>
            add
          </button>
        </div>
      </div>
    </div>
  )
}
