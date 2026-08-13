import { useCallback, useEffect, useRef, useState } from 'react'
import { beaconEndFocusSession, endFocusSession, listTasks, startFocusSession } from './api'
import type { TaskWithCheckpoints } from './types'

const PRESETS = [25, 30, 45, 60]
const NEW_TASK = '__new__'

function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

// Short two-tone chime via the Web Audio API — no external asset. The context
// is created on Start (a user gesture) so it's allowed to make sound later when
// the timer completes on its own.
function playChime(ctx: AudioContext) {
  const now = ctx.currentTime
  ;[880, 1320].forEach((freq, i) => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.connect(g)
    g.connect(ctx.destination)
    o.type = 'sine'
    o.frequency.value = freq
    const t = now + i * 0.18
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
    o.start(t)
    o.stop(t + 0.5)
  })
}

type Session = { id: string; planned: number; taskTitle: string; startMs: number }
type Summary = { taskTitle: string; planned: number; actual: number; completed: boolean }

function preselectedTask(): string {
  const q = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(q).get('task') ?? ''
}

export function FocusTimer() {
  const [tasks, setTasks] = useState<TaskWithCheckpoints[]>([])
  const [mode, setMode] = useState<'setup' | 'running' | 'done'>('setup')
  const [taskId, setTaskId] = useState<string>(NEW_TASK)
  const [newTitle, setNewTitle] = useState('')
  const [minutes, setMinutes] = useState(25)
  const [custom, setCustom] = useState('')
  const [remaining, setRemaining] = useState(0)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState('')

  const session = useRef<Session | null>(null)
  const audio = useRef<AudioContext | null>(null)
  const ended = useRef(false)
  const origTitle = useRef(document.title)

  useEffect(() => {
    listTasks()
      .then((all) => {
        const open = all.filter((t) => t.status !== 'done')
        setTasks(open)
        const pre = preselectedTask()
        if (pre && open.some((t) => t.id === pre)) setTaskId(pre)
        else if (open.length > 0) setTaskId(open[0].id)
      })
      .catch(() => {})
  }, [])

  const finish = useCallback(async (completed: boolean) => {
    const s = session.current
    if (!s || ended.current) return
    ended.current = true
    const actual = Math.round((Date.now() - s.startMs) / 60000)
    if (completed && audio.current) playChime(audio.current)
    document.title = origTitle.current
    setSummary({ taskTitle: s.taskTitle, planned: s.planned, actual, completed })
    setMode('done')
    try {
      await endFocusSession(s.id, completed)
      window.dispatchEvent(new Event('life-log-created'))
    } catch {
      // the session is already ended locally; a failed report is non-fatal
    }
  }, [])

  // Countdown loop + tab-title mirror. Derives remaining from the start time
  // (not a decrementing counter) so background-tab throttling can't drift it.
  useEffect(() => {
    if (mode !== 'running') return
    const tick = () => {
      const s = session.current
      if (!s) return
      const left = s.planned * 60 - (Date.now() - s.startMs) / 1000
      setRemaining(left)
      document.title = `${mmss(left)} · ${s.taskTitle}`
      if (left <= 0) void finish(true)
    }
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [mode, finish])

  // If the tab is closed or hidden mid-session, best-effort end it as a manual
  // stop so no session is left dangling open in the database.
  useEffect(() => {
    if (mode !== 'running') return
    const bail = () => {
      const s = session.current
      if (s && !ended.current) {
        ended.current = true
        beaconEndFocusSession(s.id, false)
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') bail()
    }
    window.addEventListener('beforeunload', bail)
    window.addEventListener('pagehide', bail)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('beforeunload', bail)
      window.removeEventListener('pagehide', bail)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [mode])

  useEffect(() => () => {
    document.title = origTitle.current
  }, [])

  const start = async () => {
    setError('')
    const planned = minutes
    const body =
      taskId === NEW_TASK
        ? { new_task: { title: newTitle.trim() }, planned_minutes: planned }
        : { task_id: taskId, planned_minutes: planned }
    try {
      if (!audio.current) {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        audio.current = new Ctx()
      }
      await audio.current.resume()
      const s = await startFocusSession(body)
      session.current = { id: s.id, planned, taskTitle: s.task_title, startMs: Date.parse(s.started_at) }
      ended.current = false
      setRemaining(planned * 60)
      setMode('running')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not start')
    }
  }

  const reset = () => {
    session.current = null
    setSummary(null)
    setMode('setup')
  }

  const canStart = taskId === NEW_TASK ? newTitle.trim().length > 0 : taskId.length > 0

  return (
    <div className="app">
      <header>
        <h1 className="brand">focus</h1>
        <a className="guide-link" href="#/">
          back
        </a>
      </header>

      {mode === 'setup' && (
        <div className="focus-setup">
          <label className="focus-block">
            <span className="daily-label">task</span>
            <select className="focus-select" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
              <option value={NEW_TASK}>+ new task…</option>
            </select>
          </label>

          {taskId === NEW_TASK && (
            <input
              className="entry-input"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="new task title"
              autoFocus
            />
          )}

          <div className="focus-block">
            <span className="daily-label">minutes</span>
            <div className="status-buttons">
              {PRESETS.map((m) => (
                <button
                  key={m}
                  className={`filter ${minutes === m && custom === '' ? 'active' : ''}`}
                  onClick={() => {
                    setMinutes(m)
                    setCustom('')
                  }}
                >
                  {m}
                </button>
              ))}
              <input
                className="focus-custom"
                inputMode="numeric"
                value={custom}
                placeholder="custom"
                onChange={(e) => {
                  setCustom(e.target.value)
                  const n = Number(e.target.value)
                  if (n > 0) setMinutes(Math.min(n, 600))
                }}
              />
            </div>
          </div>

          {error && <div className="focus-error">{error}</div>}
          <button className="focus-start" onClick={() => void start()} disabled={!canStart}>
            start {minutes}m
          </button>
        </div>
      )}

      {mode === 'running' && session.current && (
        <div className="focus-running">
          <div className="focus-clock">{mmss(remaining)}</div>
          <div className="focus-task">{session.current.taskTitle}</div>
          <button className="focus-stop" onClick={() => void finish(false)}>
            stop
          </button>
        </div>
      )}

      {mode === 'done' && summary && (
        <div className="focus-done">
          <div className={`focus-badge ${summary.completed ? 'complete' : 'stopped'}`}>
            {summary.completed ? 'completed' : 'stopped'}
          </div>
          <div className="focus-task">{summary.taskTitle}</div>
          <div className="focus-summary">
            {summary.actual} of {summary.planned} min
          </div>
          <button className="focus-start" onClick={reset}>
            new session
          </button>
        </div>
      )}
    </div>
  )
}
