import { useCallback, useEffect, useMemo, useState } from 'react'
import { deleteTask, listTasks, patchCheckpoint, patchTask } from './api'
import type { TaskWithCheckpoints } from './types'

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

  const openTasks = tasks.filter((t) => t.status !== 'done')
  const grouped = useMemo(() => groupByCategory(openTasks), [openTasks])
  const dayCounts = useMemo(() => buildDayCounts(openTasks, 7), [openTasks])

  if (!mounted) return null

  return (
    <>
      <div
        className={`panel-backdrop ${closing ? 'closing' : ''}`}
        onClick={() => { window.location.hash = '#/' }}
      />
      <div className={`tasks-panel ${closing ? 'closing' : ''}`}>
        <header>
          <h1 className="brand">tasks</h1>
          <div className="header-nav">
            <button className="guide-link refresh-btn" onClick={refresh}>
              ↻
            </button>
            <a className="guide-link" href="#/">
              back
            </a>
          </div>
        </header>

        <DueStrip days={dayCounts} />

        <main className="list">
          {Object.entries(grouped).map(([category, items]) => (
            <section key={category} className="music-section">
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
        </main>
      </div>
    </>
  )
}

function groupByCategory(tasks: TaskWithCheckpoints[]): Record<string, TaskWithCheckpoints[]> {
  const groups: Record<string, TaskWithCheckpoints[]> = {}
  for (const t of tasks) {
    const cat = t.category || 'other'
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
  return Object.fromEntries(Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0])))
}

function buildDayCounts(tasks: TaskWithCheckpoints[], days: number): { date: string; count: number }[] {
  const today = new Date()
  const counts: Record<string, number> = {}
  for (let i = 0; i < days; i++) {
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

function DueStrip({ days }: { days: { date: string; count: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.count))
  return (
    <div className="due-strip">
      {days.map((d) => (
        <div key={d.date} className="due-col">
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

  return (
    <div className="task-row">
      <button className={`task-status ${task.status}`} onClick={onCycle}>
        {task.status === 'done' ? '✓' : task.status === 'in_progress' ? '→' : '○'}
      </button>
      <div className="task-main">
        <div className="task-title">{task.title}</div>
        {task.due_date && (
          <div className={`task-due ${isOverdue ? 'overdue' : isSoon ? 'soon' : ''}`}>
            {task.due_date}
          </div>
        )}
        {task.effort_minutes && <div className="task-effort">{task.effort_minutes} min</div>}
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
      <button className="delete-btn" onClick={onDelete}>
        ✕
      </button>
    </div>
  )
}

function daysUntil(dateStr: string): number {
  const d = new Date(dateStr + 'T00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.ceil((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}
