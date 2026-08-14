import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { deleteTask, listTaskFocusSessions, listTasks, patchCheckpoint, patchTask } from './api'
import type { FocusSession, TaskWithCheckpoints } from './types'

const DUE_STRIP_DAYS_BEFORE = 5
const DUE_STRIP_DAYS_AFTER = 16

export function Tasks({ open }: { open: boolean }) {
  const [tasks, setTasks] = useState<TaskWithCheckpoints[]>([])
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)

  const refresh = useCallback(() => {
    listTasks().then(setTasks).catch(() => {})
  }, [])

  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
    } else if (mounted) {
      setClosing(true)
      const t = setTimeout(() => setMounted(false), 220)
      return () => clearTimeout(t)
    }
  }, [open, mounted])

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
    await patchCheckpoint(id, status).catch(() => {})
    refresh()
  }

  const remove = async (id: string) => {
    await deleteTask(id).catch(() => {})
    refresh()
  }

  const moveToCategory = async (id: string, category: string) => {
    await patchTask(id, { category }).catch(() => {})
    refresh()
  }

  const [dragOver, setDragOver] = useState<string | null>(null)

  const openTasks = tasks.filter((t) => t.status !== 'done')
  const grouped = useMemo(() => groupByCategory(openTasks), [openTasks])
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
    <>
      <div
        className={`panel-backdrop ${closing ? 'closing' : ''}`}
        onClick={() => { window.location.hash = '#/' }}
      />
      <div className={`tasks-panel ${closing ? 'closing' : ''}`}>
        <header>
          <h1 className="brand">sidequests</h1>
          <div className="header-nav">
            <button className="guide-link refresh-btn" onClick={refresh}>
              ↻
            </button>
            <a className="guide-link" href="#/">
              back
            </a>
          </div>
        </header>

        <DueStrip days={dayCounts} todayIndex={DUE_STRIP_DAYS_BEFORE} />

        <main className="list">
          {Object.entries(grouped).map(([category, items]) => (
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
                />
              ))}
            </section>
          ))}
          {openTasks.length === 0 && <div className="empty">nothing due</div>}

          {resolvedTasks.length > 0 && (
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
      </div>
    </>
  )
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

function TaskRow({
  task,
  onCycle,
  onCheckpoint,
  onDelete,
}: {
  task: TaskWithCheckpoints
  onCycle: () => void
  onCheckpoint: (id: string, status: 'todo' | 'done') => void
  onDelete: () => void
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

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next && sessions === null) {
      listTaskFocusSessions(task.id).then(setSessions).catch(() => setSessions([]))
    }
  }

  return (
    <div className={`task-row-wrap ${expanded ? 'open' : ''}`}>
      <div
        className="task-row"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', task.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
      >
        <button className={`task-status ${task.status}`} onClick={onCycle}>
          {task.status === 'done' ? '✓' : task.status === 'in_progress' ? '→' : '○'}
        </button>
        <div className="task-main" onClick={toggle}>
          <div className="task-title">{task.title}</div>
          {task.due_date && (
            <div className={`task-due ${isOverdue ? 'overdue' : isSoon ? 'soon' : ''}`}>
              {task.due_date}
              {task.due_time && ` · ${formatDueTime(task.due_time)}`}
            </div>
          )}
          {task.effort_minutes && <div className="task-effort">{task.effort_minutes} min</div>}
          {lastNote && <div className="task-note">{lastNote}</div>}
        </div>
        {task.is_exam && task.checkpoints.length > 0 && (
          <div className="checkpoints">
            {task.checkpoints.map((cp) => (
              <button
                key={cp.id}
                className={`checkpoint-pill ${cp.status}`}
                onClick={() => onCheckpoint(cp.id, cp.status === 'todo' ? 'done' : 'todo')}
              >
                {cp.offset_days}d
              </button>
            ))}
          </div>
        )}
        <a className="task-focus" href={`#/focus?task=${task.id}`} aria-label="focus on this sidequest">
          ▷
        </a>
        <button className="delete-btn" onClick={onDelete}>
          ✕
        </button>
      </div>
      {expanded && sessions !== null && (
        <div className="task-sessions">
          {sessions.length === 0 && <div className="task-session-empty">no focus sessions yet</div>}
          {sessions.map((s) => (
            <div key={s.id} className="task-session">
              <span>{s.started_at.slice(5, 10)}</span>
              <span>
                {s.actual_minutes ?? 0} / {s.planned_minutes}m
              </span>
              <span className={s.completed ? 'done' : 'stopped'}>{s.completed ? '✓' : '⊘'}</span>
            </div>
          ))}
        </div>
      )}
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
      <button className={`task-status ${task.status}`} onClick={onCycle}>
        ✓
      </button>
      <div className="task-main">
        <div className="task-title">{task.title}</div>
        {task.due_date && (
          <div className="task-due">
            {task.due_date}
            {task.due_time && ` · ${formatDueTime(task.due_time)}`}
          </div>
        )}
      </div>
      <button className="delete-btn" onClick={onDelete}>
        ✕
      </button>
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
