import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteFocusSession,
  deleteTask,
  listTaskFocusSessions,
  listTasks,
  patchCheckpoint,
  patchTask,
} from './api'
import { dayLabel, dueLabel } from './dates'
import { Panel, usePanelState } from './Panel'
import type { FocusSession, TaskWithCheckpoints } from './types'

const DUE_STRIP_DAYS_BEFORE = 5
const DUE_STRIP_DAYS_AFTER = 16

export function Tasks({ open }: { open: boolean }) {
  const [tasks, setTasks] = useState<TaskWithCheckpoints[]>([])
  const [todayOnly, setTodayOnly] = useState(false)
  const { mounted, closing } = usePanelState(open)

  const refresh = useCallback(() => {
    listTasks().then(setTasks).catch(() => {})
  }, [])

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

  const openTasks = tasks.filter((t) => t.status !== 'done')
  const grouped = useMemo(() => groupByCategory(openTasks), [openTasks])
  const dueToday = useMemo(() => {
    const today = dateToStr(new Date())
    // "due today" here means anything landing on today's plate: the task's
    // own due date, or one of its spaced-review checkpoints (7d/3d/1d out
    // from an exam) coming due - not just tasks due today themselves.
    return openTasks
      .filter(
        (t) =>
          t.due_date === today ||
          t.checkpoints.some((cp) => cp.status === 'todo' && cp.due_date === today),
      )
      .sort((a, b) => (a.due_time ?? '99:99').localeCompare(b.due_time ?? '99:99'))
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

      <main className="list">
        {todayOnly ? (
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
              />
            ))}
            {dueToday.length === 0 && <div className="empty">nothing due today</div>}
          </section>
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
  onRefresh,
}: {
  task: TaskWithCheckpoints
  onCycle: () => void
  onCheckpoint: (id: string, status: 'todo' | 'done') => void
  onDelete: () => void
  onRefresh: () => void
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
    <div className={`task-row-wrap ${expanded ? 'open' : ''}`}>
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
              {dueLabel(task.due_date)}
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
                className={`checkpoint-pill ${cp.status} ${cp.status === 'todo' && daysUntil(cp.due_date) <= 0 ? 'due' : ''}`}
                onClick={() => onCheckpoint(cp.id, cp.status === 'todo' ? 'done' : 'todo')}
              >
                {cp.offset_days}d
              </button>
            ))}
          </div>
        )}
        <a className="task-focus" href={`#/focus?task=${task.id}`} aria-label="clarity session for this sidequest">
          ▷
        </a>
        <button className="delete-btn" onClick={onDelete}>
          ✕
        </button>
      </div>
      {expanded && (
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
      )}
      {expanded && task.is_exam && task.due_date && (
        <div className="task-checkpoint-dates">
          {[7, 3, 1].map((offset) => {
            const due = shiftDateStr(task.due_date as string, -offset)
            const cp = task.checkpoints.find((c) => c.offset_days === offset)
            const isDue = (cp?.status ?? 'todo') === 'todo' && daysUntil(due) <= 0
            return (
              <div key={offset} className={`checkpoint-date-row ${isDue ? 'due' : ''} ${cp?.status ?? ''}`}>
                <span className="checkpoint-date-label">{offset}d</span>
                <span className="checkpoint-date-value" title={due}>
                  {cp?.status === 'done' ? dayLabel(due) : dueLabel(due)}
                </span>
                {cp?.status === 'done' && <span>✓</span>}
              </div>
            )
          })}
        </div>
      )}
      {expanded && sessions !== null && (
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

function shiftDateStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00')
  d.setDate(d.getDate() + days)
  return dateToStr(d)
}
