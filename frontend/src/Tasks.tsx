import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createCheckpoint,
  deleteCheckpoint,
  deleteFocusSession,
  deleteTask,
  listTaskFocusSessions,
  listTasks,
  patchCheckpoint,
  patchTask,
} from './api'
import { dayLabel, dueLabel } from './dates'
import { Expand } from './Expand'
import { strikeOut, useFlipList } from './motion'
import { Panel, usePanelState } from './Panel'
import type { FocusSession, TaskCheckpoint, TaskWithCheckpoints } from './types'

const DUE_STRIP_DAYS_BEFORE = 5
const DUE_STRIP_DAYS_AFTER = 16
// Has to outlast the longest of these, which is the done sweep at 1100ms -
// clearing the marker early strips the class mid-animation.
const CHANGE_MS = 1300

// What visibly happened to a sidequest, worked out by diffing the list against
// the one before it rather than reported by each caller. Everything that can
// change a task goes through the same refresh - a typed entry, a slash
// command, a drag between sections, the inline editor - so diffing here is the
// only place that catches all of them.
export type TaskChange =
  | { kind: 'done' }
  | { kind: 'reschedule'; from: string | null }
  | { kind: 'recategorize' }
  | { kind: 'note' }

function diffTask(before: TaskWithCheckpoints, after: TaskWithCheckpoints): TaskChange | null {
  if (before.status !== 'done' && after.status === 'done') return { kind: 'done' }
  if (before.due_date !== after.due_date) return { kind: 'reschedule', from: before.due_date }
  if (before.is_exam !== after.is_exam || before.category !== after.category) {
    return { kind: 'recategorize' }
  }
  if ((before.note ?? '') !== (after.note ?? '')) return { kind: 'note' }
  return null
}

export function Tasks({ open }: { open: boolean }) {
  const [tasks, setTasks] = useState<TaskWithCheckpoints[]>([])
  const [todayOnly, setTodayOnly] = useState(false)
  const { mounted, closing } = usePanelState(open)
  const previous = useRef<Map<string, TaskWithCheckpoints>>(new Map())
  const [changes, setChanges] = useState<Map<string, TaskChange>>(new Map())
  // A task marked done leaves the open list immediately, which would yank the
  // row out from under its own strike-through. Its pre-done copy is held here
  // so it keeps rendering in place until the sweep has finished.
  const [leaving, setLeaving] = useState<TaskWithCheckpoints[]>([])
  const { ref: listRef, capture: captureRows } = useFlipList<HTMLElement>()

  const apply = useCallback(
    (next: TaskWithCheckpoints[]) => {
      const before = previous.current
      const found = new Map<string, TaskChange>()
      for (const t of next) {
        const was = before.get(t.id)
        const change = was && diffTask(was, t)
        if (change) found.set(t.id, change)
      }
      previous.current = new Map(next.map((t) => [t.id, t]))
      // Captured before the state change, while the old layout is still on
      // screen - a reschedule or a recategorize moves the row to a new place
      // in the sort, and the glide needs where it used to be.
      const moves = [...found.values()].some((c) => c.kind === 'reschedule' || c.kind === 'recategorize')
      if (moves) captureRows()
      setLeaving(
        [...found.entries()]
          .filter(([, c]) => c.kind === 'done')
          .map(([id]) => before.get(id))
          .flatMap((t) => (t ? [{ ...t, status: 'not_started' as const }] : [])),
      )
      setTasks(next)
      if (found.size > 0) setChanges(found)
    },
    [captureRows],
  )

  // One timer for the whole batch: the markers only drive entrance animations,
  // so clearing them together can't interrupt anything mid-flight.
  useEffect(() => {
    if (changes.size === 0) return
    const t = setTimeout(() => setChanges(new Map()), CHANGE_MS)
    return () => clearTimeout(t)
  }, [changes])

  const refresh = useCallback(() => {
    listTasks().then(apply).catch(() => {})
  }, [apply])

  useEffect(() => {
    if (!mounted) return
    refresh()
    window.addEventListener('life-log-created', refresh)
    return () => window.removeEventListener('life-log-created', refresh)
  }, [mounted, refresh])

  const cycleStatus = async (t: TaskWithCheckpoints) => {
    const next =
      t.status === 'not_started' ? 'in_progress' : t.status === 'in_progress' ? 'done' : 'not_started'
    await patchTask(t.id, { status: next }).catch(() => {})
    refresh()
  }

  const toggleCheckpoint = async (id: string, status: 'todo' | 'done') => {
    await patchCheckpoint(id, { status }).catch(() => {})
    refresh()
  }

  const remove = async (id: string) => {
    await deleteTask(id).catch(() => {})
    refresh()
  }

  // "exam" is a section, not a category - groupByCategory keys off is_exam
  // first, so patching only the category left anything the parser had flagged
  // as an exam stuck in that section wherever it was dropped. Dropping into
  // the section sets the flag (and keeps whatever category it already had);
  // dropping anywhere else clears it, which is also what takes its spaced
  // study checkpoints away.
  const moveToCategory = async (id: string, category: string) => {
    const patch = category === 'exam' ? { is_exam: true } : { category, is_exam: false }
    await patchTask(id, patch).catch(() => {})
    refresh()
  }

  const [dragOver, setDragOver] = useState<string | null>(null)

  // Substituted in place rather than appended: tasks sharing a due date are
  // ordered by their position in this array, so a held row pushed onto the end
  // visibly jumped down past its neighbours before it collapsed.
  const openTasks = useMemo(() => {
    const held = new Map(leaving.map((t) => [t.id, t]))
    return tasks.flatMap((t) => {
      const standIn = held.get(t.id)
      if (standIn) return [standIn]
      return t.status !== 'done' ? [t] : []
    })
  }, [tasks, leaving])
  const grouped = useMemo(() => groupByCategory(openTasks), [openTasks])
  // "today's plate" is the task's own due date or one of its spaced-review
  // checkpoints (7d/3d/1d out from an exam) coming due - not just tasks due
  // today themselves. Anything with such a date already behind us is overdue
  // and belongs on the same screen: a deadline you missed is still today's
  // problem, and hiding it here was the only place it could go unnoticed.
  const { overdue, dueToday } = useMemo(() => {
    const today = dateToStr(new Date())
    const late: TaskWithCheckpoints[] = []
    const now: TaskWithCheckpoints[] = []
    for (const t of openTasks) {
      const dates = plateDates(t)
      if (dates.includes(today)) now.push(t)
      else if (dates.some((d) => d < today)) late.push(t)
    }
    return {
      overdue: late.sort((a, b) => oldestPlateDate(a).localeCompare(oldestPlateDate(b))),
      dueToday: now.sort((a, b) => (a.due_time ?? '99:99').localeCompare(b.due_time ?? '99:99')),
    }
  }, [openTasks])
  const dayCounts = useMemo(
    () => buildDayCounts(openTasks, DUE_STRIP_DAYS_BEFORE, DUE_STRIP_DAYS_AFTER),
    [openTasks],
  )
  const resolvedTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.status === 'done')
        .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? '')),
    [tasks],
  )

  if (!mounted) return null

  return (
    <Panel closing={closing}>
      <header>
        <h1 className="brand">sidequests</h1>
        <div className="header-nav">
          <button
            className={`guide-link today-filter-btn ${todayOnly ? 'active' : ''}`}
            onClick={() => setTodayOnly((v) => !v)}
          >
            today
          </button>
          <button className="guide-link refresh-btn" onClick={refresh}>
            ↻
          </button>
          <a className="guide-link" href="#/">
            back
          </a>
        </div>
      </header>

      <DueStrip days={dayCounts} todayIndex={DUE_STRIP_DAYS_BEFORE} />

      <main className="list" ref={listRef}>
        {todayOnly ? (
          <>
            {overdue.length > 0 && (
              <section className="music-section task-section">
                <h2 className="section-title overdue-title">overdue ({overdue.length})</h2>
                {overdue.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    onCycle={() => void cycleStatus(t)}
                    onCheckpoint={toggleCheckpoint}
                    onDelete={() => void remove(t.id)}
                    onRefresh={refresh}
                    change={changes.get(t.id) ?? null}
                    onLeft={() => setLeaving((l) => l.filter((x) => x.id !== t.id))}
                  />
                ))}
              </section>
            )}
            <section className="music-section task-section">
              <h2 className="section-title">due today</h2>
              {dueToday.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onCycle={() => void cycleStatus(t)}
                  onCheckpoint={toggleCheckpoint}
                  onDelete={() => void remove(t.id)}
                  onRefresh={refresh}
                  change={changes.get(t.id) ?? null}
                  onLeft={() => setLeaving((l) => l.filter((x) => x.id !== t.id))}
                />
              ))}
              {dueToday.length === 0 && <div className="empty">nothing due today</div>}
            </section>
          </>
        ) : (
          Object.entries(grouped).map(([category, items]) => (
            <section
              key={category}
              className={`music-section task-section ${dragOver === category ? 'drag-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                if (dragOver !== category) setDragOver(category)
              }}
              onDragLeave={() => setDragOver((c) => (c === category ? null : c))}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(null)
                const id = e.dataTransfer.getData('text/plain')
                if (id) void moveToCategory(id, category)
              }}
            >
              <h2 className="section-title">{category}</h2>
              {items.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onCycle={() => void cycleStatus(t)}
                  onCheckpoint={toggleCheckpoint}
                  onDelete={() => void remove(t.id)}
                  onRefresh={refresh}
                  change={changes.get(t.id) ?? null}
                  onLeft={() => setLeaving((l) => l.filter((x) => x.id !== t.id))}
                />
              ))}
            </section>
          ))
        )}
        {!todayOnly && openTasks.length === 0 && <div className="empty">nothing due</div>}

        {!todayOnly && resolvedTasks.length > 0 && (
          <details className="resolved-section">
            <summary className="section-title">resolved ({resolvedTasks.length})</summary>
            <div className="resolved-list">
              {resolvedTasks.map((t) => (
                <ResolvedRow key={t.id} task={t} onCycle={() => void cycleStatus(t)} onDelete={() => void remove(t.id)} />
              ))}
            </div>
          </details>
        )}
      </main>
    </Panel>
  )
}

function plateDates(t: TaskWithCheckpoints): string[] {
  const dates = t.checkpoints.filter((cp) => cp.status === 'todo').map((cp) => cp.due_date)
  if (t.due_date) dates.push(t.due_date)
  return dates
}

function oldestPlateDate(t: TaskWithCheckpoints): string {
  return plateDates(t).sort()[0] ?? ''
}

function groupByCategory(tasks: TaskWithCheckpoints[]): Record<string, TaskWithCheckpoints[]> {
  const groups: Record<string, TaskWithCheckpoints[]> = {}
  for (const t of tasks) {
    // is_exam is a real, LLM-validated flag; category is free text the LLM
    // picks loosely (often "homework" for schoolwork in general, exams
    // included). Group on is_exam first so exams always get their own
    // section instead of blending into whatever category string landed.
    const cat = t.is_exam ? 'exam' : t.category || 'other'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(t)
  }
  for (const items of Object.values(groups)) {
    items.sort((a, b) => {
      if (a.due_date === null) return 1
      if (b.due_date === null) return -1
      return a.due_date.localeCompare(b.due_date)
    })
  }
  return Object.fromEntries(
    Object.entries(groups).sort((a, b) => {
      if (a[0] === 'exam') return -1
      if (b[0] === 'exam') return 1
      return a[0].localeCompare(b[0])
    }),
  )
}

function buildDayCounts(
  tasks: TaskWithCheckpoints[],
  daysBefore: number,
  daysAfter: number,
): { date: string; count: number }[] {
  const today = new Date()
  const counts: Record<string, number> = {}
  for (let i = -daysBefore; i < daysAfter; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() + i)
    const dateStr = dateToStr(d)
    counts[dateStr] = 0
  }
  for (const t of tasks) {
    if (t.due_date && counts[t.due_date] !== undefined) counts[t.due_date]++
    for (const cp of t.checkpoints) {
      if (cp.status === 'todo' && counts[cp.due_date] !== undefined) counts[cp.due_date]++
    }
  }
  return Object.entries(counts).map(([date, count]) => ({ date, count }))
}

function dateToStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function shortDayLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00')
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return days[d.getDay()]
}

function dayOfMonth(dateStr: string): number {
  return new Date(dateStr + 'T00:00').getDate()
}

function formatDueTime(timeStr: string): string {
  return new Date(`2000-01-01T${timeStr}`)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()
    .replace(' ', '')
}

function DueStrip({
  days,
  todayIndex,
}: {
  days: { date: string; count: number }[]
  todayIndex: number
}) {
  const max = Math.max(1, ...days.map((d) => d.count))
  const todayRef = useRef<HTMLDivElement>(null)

  // The strip spans a couple weeks each side of today so it scrolls left
  // (past) and right (future), but should still open with today in view
  // instead of the earliest past day.
  useEffect(() => {
    todayRef.current?.scrollIntoView({ inline: 'start', block: 'nearest' })
  }, [])

  return (
    <div className="due-strip">
      {days.map((d, i) => (
        <div
          key={d.date}
          ref={i === todayIndex ? todayRef : undefined}
          className={`due-col ${i === todayIndex ? 'today' : ''}`}
        >
          <span className="due-count">{d.count || ''}</span>
          <div className="due-bar" style={{ height: `${(d.count / max) * 100}%` }} />
          <span className="due-label">{shortDayLabel(d.date)}</span>
          <span className="due-date">{dayOfMonth(d.date)}</span>
        </div>
      ))}
    </div>
  )
}

function AddCheckpointPill({ taskId, onRefresh }: { taskId: string; onRefresh: () => void }) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = async () => {
    const offset = Number(draft)
    setDraft(null)
    if (!Number.isInteger(offset) || offset < 1 || offset > 90) return
    await createCheckpoint(taskId, offset).catch(() => {})
    onRefresh()
  }

  if (draft !== null) {
    return (
      <input
        className="checkpoint-pill-input"
        autoFocus
        placeholder="d"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 2))}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(null)
        }}
      />
    )
  }

  return (
    <button
      className="checkpoint-pill add"
      title="add a study reminder"
      onClick={() => setDraft('')}
    >
      +
    </button>
  )
}

function CheckpointPill({
  cp,
  onToggle,
  onRefresh,
}: {
  cp: TaskCheckpoint
  onToggle: () => void
  onRefresh: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  // One click toggles and two edit the offset, so the toggle has to wait long
  // enough to find out which it was - React fires onClick twice before
  // onDoubleClick, which would otherwise flip the checkpoint and flip it back.
  const clickTimer = useRef<number | null>(null)
  useEffect(() => () => window.clearTimeout(clickTimer.current ?? undefined), [])

  const commit = async () => {
    const offset = Number(draft)
    setDraft(null)
    if (!Number.isInteger(offset) || offset < 1 || offset > 90 || offset === cp.offset_days) return
    await patchCheckpoint(cp.id, { offset_days: offset }).catch(() => {})
    onRefresh()
  }

  if (draft !== null) {
    return (
      <input
        className="checkpoint-pill-input"
        autoFocus
        value={draft}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 2))}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(null)
        }}
      />
    )
  }

  return (
    <button
      className={`checkpoint-pill ${cp.status} ${cp.status === 'todo' && daysUntil(cp.due_date) <= 0 ? 'due' : ''}`}
      title="double-click to change how many days out"
      onClick={() => {
        if (clickTimer.current !== null) return
        clickTimer.current = window.setTimeout(() => {
          clickTimer.current = null
          onToggle()
        }, 220)
      }}
      onDoubleClick={() => {
        window.clearTimeout(clickTimer.current ?? undefined)
        clickTimer.current = null
        setDraft(String(cp.offset_days))
      }}
    >
      {cp.offset_days}d
    </button>
  )
}

function TaskRow({
  task,
  onCycle,
  onCheckpoint,
  onDelete,
  onRefresh,
  change,
  onLeft,
}: {
  task: TaskWithCheckpoints
  onCycle: () => void
  onCheckpoint: (id: string, status: 'todo' | 'done') => void
  onDelete: () => void
  onRefresh: () => void
  change: TaskChange | null
  onLeft: () => void
}) {
  const isOverdue = task.due_date && task.due_date < dateToStr(new Date())
  const isSoon = !isOverdue && task.due_date && daysUntil(task.due_date) <= 2
  const lastNote = task.note
    ?.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop()
  const [expanded, setExpanded] = useState(false)
  const [sessions, setSessions] = useState<FocusSession[] | null>(null)
  const [dragging, setDragging] = useState(false)
  const ghostRef = useRef<HTMLElement | null>(null)
  const [noteDraft, setNoteDraft] = useState(task.note ?? '')
  const [titleDraft, setTitleDraft] = useState(task.title)
  const wrapRef = useRef<HTMLDivElement>(null)

  // The strike-through is CSS on the title; the collapse that follows it has
  // to be measured, so it runs from here.
  useEffect(() => {
    if (change?.kind !== 'done') return
    strikeOut(wrapRef.current, onLeft)
    // onLeft is a fresh closure every render and re-running this would restart
    // the sweep; the marker changing is the only thing that should trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change])

  // Re-sync when the task changes underneath (a typed entry appended a line,
  // or the same note was edited from the timeline row), but never while it's
  // focused - that would yank the text out from under the cursor.
  useEffect(() => {
    setNoteDraft((d) => (d === '' || document.activeElement?.tagName !== 'TEXTAREA' ? task.note ?? '' : d))
  }, [task.note])

  useEffect(() => {
    setTitleDraft((d) => (document.activeElement?.tagName !== 'INPUT' ? task.title : d))
  }, [task.title])

  const saveNote = async () => {
    const next = noteDraft.trim()
    if (next === (task.note ?? '')) return
    await patchTask(task.id, { note: next }).catch(() => {})
    onRefresh()
  }

  // A sidequest with no name can't be found again, so an emptied box reverts
  // rather than saving.
  const saveTitle = async () => {
    const next = titleDraft.trim()
    if (!next) {
      setTitleDraft(task.title)
      return
    }
    if (next === task.title) return
    await patchTask(task.id, { title: next }).catch(() => {})
    onRefresh()
  }

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next && sessions === null) {
      listTaskFocusSessions(task.id).then(setSessions).catch(() => setSessions([]))
    }
  }

  return (
    <div
      className={`task-row-wrap ${expanded ? 'open' : ''} ${change ? `did-${change.kind}` : ''}`}
      ref={wrapRef}
      data-flip-id={task.id}
    >
      <div
        className={`task-row ${dragging ? 'dragging' : ''}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', task.id)
          e.dataTransfer.effectAllowed = 'move'
          setDragging(true)
          // The browser's own drag image comes back blank inside .side-panel,
          // whose panel-in animation puts the subtree on its own compositing
          // layer. Handing it an explicit off-screen clone sidesteps the
          // snapshot heuristic entirely, so the row tracks the cursor again.
          const row = e.currentTarget
          const rect = row.getBoundingClientRect()
          const ghost = row.cloneNode(true) as HTMLElement
          ghost.style.position = 'fixed'
          ghost.style.top = '-1000px'
          ghost.style.left = '0'
          ghost.style.width = `${rect.width}px`
          ghost.style.background = 'var(--bg)'
          ghost.style.pointerEvents = 'none'
          document.body.appendChild(ghost)
          ghostRef.current = ghost
          e.dataTransfer.setDragImage(ghost, e.clientX - rect.left, e.clientY - rect.top)
        }}
        onDragEnd={() => {
          setDragging(false)
          ghostRef.current?.remove()
          ghostRef.current = null
        }}
      >
        <button className={`task-status ${task.status}`} onClick={onCycle}>
          {task.status === 'done' ? '✓' : task.status === 'in_progress' ? '→' : '○'}
        </button>
        <div className="task-main" onClick={toggle}>
          <div className="task-title">{task.title}</div>
          {task.due_date && (
            <div
              className={`task-due ${isOverdue ? 'overdue' : isSoon ? 'soon' : ''}`}
              title={task.due_date}
            >
              {/* Both dates are on screen at once mid-roll, the old one
                  leaving upward and the new one arriving from below, so the
                  clip has to come from the wrapper rather than either span. */}
              <span className="task-due-now">
                {dueLabel(task.due_date)}
                {task.due_time && ` · ${formatDueTime(task.due_time)}`}
              </span>
              {change?.kind === 'reschedule' && change.from && (
                <span className="task-due-was" aria-hidden="true">
                  {dueLabel(change.from)}
                </span>
              )}
            </div>
          )}
          {task.effort_minutes && <div className="task-effort">{task.effort_minutes} min</div>}
          {lastNote && (
            <div className="task-note">
              <span>{lastNote}</span>
            </div>
          )}
        </div>
        {task.is_exam && task.due_date && (
          <div className="checkpoints">
            {task.checkpoints.map((cp) => (
              <CheckpointPill
                key={cp.id}
                cp={cp}
                onToggle={() => onCheckpoint(cp.id, cp.status === 'todo' ? 'done' : 'todo')}
                onRefresh={onRefresh}
              />
            ))}
            <AddCheckpointPill taskId={task.id} onRefresh={onRefresh} />
          </div>
        )}
        <a className="task-focus" href={`#/focus?task=${task.id}`} aria-label="clarity session for this sidequest">
          ▷
        </a>
        <button className="delete-btn" onClick={onDelete}>
          ✕
        </button>
      </div>
      <Expand open={expanded}>
        <div className="task-note-edit">
          <input
            className="task-title-input"
            value={titleDraft}
            placeholder="title"
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setTitleDraft(task.title)
                e.currentTarget.blur()
              }
            }}
          />
          <textarea
            rows={2}
            value={noteDraft}
            placeholder="note"
            onChange={(e) => setNoteDraft(e.target.value)}
            onBlur={() => void saveNote()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.blur()
            }}
          />
          {noteDraft !== (task.note ?? '') && <span className="task-note-hint">unsaved</span>}
        </div>
        {task.is_exam && task.checkpoints.length > 0 && (
          <div className="task-checkpoint-dates">
            {/* The checkpoints a task actually has, not the 7/3/1 it was born
                with: one made after its own mark never exists, and offsets are
                editable, so a fixed list invents rows that aren't there. */}
            {[...task.checkpoints]
              .sort((a, b) => b.offset_days - a.offset_days)
              .map((cp) => {
                const isDue = cp.status === 'todo' && daysUntil(cp.due_date) <= 0
                return (
                  <div key={cp.id} className={`checkpoint-date-row ${isDue ? 'due' : ''} ${cp.status}`}>
                    <span className="checkpoint-date-label">{cp.offset_days}d</span>
                    <span className="checkpoint-date-value" title={cp.due_date}>
                      {cp.status === 'done' ? dayLabel(cp.due_date) : dueLabel(cp.due_date)}
                    </span>
                    {cp.status === 'done' && <span>✓</span>}
                    <button
                      className="checkpoint-date-remove"
                      title="remove this reminder"
                      onClick={() => void deleteCheckpoint(cp.id).catch(() => {}).then(onRefresh)}
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
          </div>
        )}
        {sessions !== null && (
          <div className="task-sessions">
            {sessions.length === 0 && <div className="task-session-empty">no clarity sessions yet</div>}
            {sessions.length > 1 && (
              <div className="task-session-total">
                {sessions.reduce((sum, s) => sum + (s.actual_minutes ?? 0), 0)}m across{' '}
                {sessions.length} sessions
              </div>
            )}
            {sessions.map((s) => (
              <div key={s.id} className="task-session">
                <button
                  className="session-delete"
                  aria-label="remove this clarity session"
                  onClick={() => {
                    setSessions((cur) => (cur ?? []).filter((x) => x.id !== s.id))
                    deleteFocusSession(s.id).catch(() => {
                      listTaskFocusSessions(task.id).then(setSessions).catch(() => {})
                    })
                  }}
                >
                  ✕
                </button>
                <span>{s.started_at.slice(5, 10)}</span>
                <span>
                  {s.actual_minutes ?? 0} / {s.planned_minutes}m
                </span>
                <span className={s.completed ? 'done' : 'stopped'}>{s.completed ? '✓' : '⊘'}</span>
              </div>
            ))}
          </div>
        )}
      </Expand>
    </div>
  )
}

function ResolvedRow({
  task,
  onCycle,
  onDelete,
}: {
  task: TaskWithCheckpoints
  onCycle: () => void
  onDelete: () => void
}) {
  return (
    <div className="resolved-row">
      <div className="task-row">
        <button className={`task-status ${task.status}`} onClick={onCycle}>
          ✓
        </button>
        <div className="task-main">
          <div className="task-title">{task.title}</div>
          {task.due_date && (
            <div className="task-due" title={task.due_date}>
              {dayLabel(task.due_date)}
              {task.due_time && ` · ${formatDueTime(task.due_time)}`}
            </div>
          )}
        </div>
        <button className="delete-btn" onClick={onDelete}>
          ✕
        </button>
      </div>
      <span className={`badge resolved-tag ${task.is_exam ? 'exam' : 'task'}`}>
        {task.is_exam ? 'exam' : task.category}
      </span>
    </div>
  )
}

function daysUntil(dateStr: string): number {
  const d = new Date(dateStr + 'T00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.ceil((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

