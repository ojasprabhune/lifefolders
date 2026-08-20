import { useEffect, useState } from 'react'
import { listCadences, listTasks } from './api'
import type { Cadence, TaskWithCheckpoints } from './types'
import {
  beginFocusSession,
  extendFocus,
  getFocusSession,
  remainingSeconds,
  stopFocusSession,
  toggleFocusPause,
  type ActiveFocusSession,
  type FocusSummary,
} from './focusEngine'

const PRESETS = [25, 30, 45, 60]
const NEW_TASK = '__new__'

function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function preselectedTask(): string {
  const q = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(q).get('task') ?? ''
}

export function FocusTimer() {
  const [tasks, setTasks] = useState<TaskWithCheckpoints[]>([])
  const [cadences, setCadences] = useState<Cadence[]>([])
  const [target, setTarget] = useState<'task' | 'cadence'>('task')
  const [mode, setMode] = useState<'setup' | 'running' | 'done'>('setup')
  const [taskId, setTaskId] = useState<string>(NEW_TASK)
  const [cadenceId, setCadenceId] = useState<string>('')
  const [newTitle, setNewTitle] = useState('')
  const [minutes, setMinutes] = useState(25)
  const [custom, setCustom] = useState('')
  const [active, setActive] = useState<ActiveFocusSession | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [summary, setSummary] = useState<FocusSummary | null>(null)
  const [error, setError] = useState('')

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
    listCadences()
      .then((all) => {
        setCadences(all)
        if (all.length > 0) setCadenceId(all[0].id)
      })
      .catch(() => {})
  }, [])

  // A session already running (started here, or from the pill after
  // navigating away and back) should land on the running view, not setup.
  useEffect(() => {
    const s = getFocusSession()
    if (s) {
      setActive(s)
      setRemaining(remainingSeconds(s))
      setMode('running')
    }

    const onChange = (e: Event) => {
      const { session, summary: done } = (
        e as CustomEvent<{ session: ActiveFocusSession | null; summary: FocusSummary | null }>
      ).detail
      if (done) {
        setSummary(done)
        setMode('done')
        return
      }
      if (session) {
        setActive(session)
        setRemaining(remainingSeconds(session))
        setMode('running')
      }
    }
    window.addEventListener('life-focus-changed', onChange)
    return () => window.removeEventListener('life-focus-changed', onChange)
  }, [])

  // Mirrors the countdown into the browser tab title while this page is open.
  useEffect(() => {
    document.title =
      mode === 'running' && active
        ? active.pausedAtMs !== null
          ? `⏸ ${active.title}`
          : `${mmss(remaining)} · ${active.title}`
        : 'life'
  }, [mode, active, remaining])

  useEffect(() => () => {
    document.title = 'life'
  }, [])

  const start = async () => {
    setError('')
    const planned = minutes
    const body =
      target === 'cadence'
        ? { cadence_id: cadenceId, planned_minutes: planned }
        : taskId === NEW_TASK
          ? { new_task: { title: newTitle.trim() }, planned_minutes: planned }
          : { task_id: taskId, planned_minutes: planned }
    try {
      const s = await beginFocusSession(body)
      setActive(s)
      setRemaining(remainingSeconds(s))
      setMode('running')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not start')
    }
  }

  const reset = () => {
    setSummary(null)
    setActive(null)
    setMode('setup')
  }

  const canStart =
    target === 'cadence'
      ? cadenceId.length > 0
      : taskId === NEW_TASK
        ? newTitle.trim().length > 0
        : taskId.length > 0

  const paused = active !== null && active.pausedAtMs !== null

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
          <div className="focus-block">
            <span className="daily-label">focus on</span>
            <div className="status-buttons">
              <button
                className={`filter ${target === 'task' ? 'active' : ''}`}
                onClick={() => setTarget('task')}
              >
                sidequest
              </button>
              <button
                className={`filter ${target === 'cadence' ? 'active' : ''}`}
                onClick={() => setTarget('cadence')}
                disabled={cadences.length === 0}
              >
                cadence
              </button>
            </div>
          </div>

          {target === 'task' ? (
            <>
              <label className="focus-block">
                <span className="daily-label">sidequest</span>
                <select className="focus-select" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                  <option value={NEW_TASK}>+ new sidequest…</option>
                </select>
              </label>

              {taskId === NEW_TASK && (
                <input
                  className="entry-input"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="new sidequest title"
                  autoFocus
                />
              )}
            </>
          ) : (
            <label className="focus-block">
              <span className="daily-label">cadence</span>
              <select className="focus-select" value={cadenceId} onChange={(e) => setCadenceId(e.target.value)}>
                {cadences.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
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

      {mode === 'running' && active && (
        <div className="focus-running">
          <div className={`focus-clock ${paused ? 'paused' : ''}`}>{mmss(remaining)}</div>
          <div className="focus-task">{active.title}</div>
          <div className="focus-running-actions">
            <button className="focus-pause" onClick={() => void toggleFocusPause()}>
              {paused ? 'resume' : 'pause'}
            </button>
            <button className="focus-extend" onClick={() => void extendFocus(5)}>
              +5 min
            </button>
            <button className="focus-finish" onClick={() => void stopFocusSession(true)}>
              finished early
            </button>
            <button className="focus-stop" onClick={() => void stopFocusSession(false)}>
              stop
            </button>
          </div>
        </div>
      )}

      {mode === 'done' && summary && (
        <div className="focus-done">
          <div className={`focus-badge ${summary.completed ? 'complete' : 'stopped'}`}>
            {summary.completed ? 'completed' : 'stopped'}
          </div>
          <div className="focus-task">{summary.title}</div>
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
