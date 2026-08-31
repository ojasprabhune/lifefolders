// Owns the one active focus session as module state (not React state) so it
// keeps running — countdown, pause math, natural completion, reload —
// regardless of which page is mounted. FocusTimer and FocusPill both just
// read getFocusSession() and listen for 'life-focus-changed' to reflect it;
// neither owns the timer.
import {
  endFocusSession,
  getActiveFocusSession,
  extendFocusSession,
  pauseFocusSession,
  resumeFocusSession,
  startFocusSession,
} from './api'

export type ActiveFocusSession = {
  id: string
  title: string
  planned: number
  startMs: number
  pausedSeconds: number
  pausedAtMs: number | null
}

export type FocusSummary = { title: string; planned: number; actual: number; completed: boolean }

const STORAGE_KEY = 'life_focus_session'

function load(): ActiveFocusSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ActiveFocusSession) : null
  } catch {
    return null
  }
}

let current: ActiveFocusSession | null = load()
let audio: AudioContext | null = null
let tickTimer: number | undefined
let ended = false

function persist() {
  if (current) localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  else localStorage.removeItem(STORAGE_KEY)
}

function broadcast(summary: FocusSummary | null = null) {
  window.dispatchEvent(
    new CustomEvent<{ session: ActiveFocusSession | null; summary: FocusSummary | null }>(
      'life-focus-changed',
      { detail: { session: current, summary } },
    ),
  )
}

export function getFocusSession(): ActiveFocusSession | null {
  return current
}

// Freezes automatically while paused: the growing (now - pausedAtMs) term
// cancels the growing (now - startMs) term, so no separate paused branch is
// needed in callers — this is just always "how much has actually elapsed".
export function elapsedActiveSeconds(s: ActiveFocusSession, now = Date.now()): number {
  const pausedNow = s.pausedAtMs !== null ? (now - s.pausedAtMs) / 1000 : 0
  return (now - s.startMs) / 1000 - s.pausedSeconds - pausedNow
}

export function remainingSeconds(s: ActiveFocusSession, now = Date.now()): number {
  return s.planned * 60 - elapsedActiveSeconds(s, now)
}

// Short two-tone chime via the Web Audio API — no external asset.
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

function scheduleTick() {
  window.clearInterval(tickTimer)
  tickTimer = window.setInterval(() => {
    if (!current) return
    if (current.pausedAtMs === null && remainingSeconds(current) <= 0) {
      void stopFocusSession(true)
      return
    }
    broadcast()
  }, 1000)
}

export async function beginFocusSession(body: {
  task_id?: string
  new_task?: { title: string; category?: string }
  cadence_id?: string
  planned_minutes: number
}): Promise<ActiveFocusSession> {
  // Created/resumed here, inside the click handler that calls this, so the
  // gesture requirement is satisfied even though the context outlives this
  // component if the tab navigates elsewhere before the chime fires.
  if (!audio) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    audio = new Ctx()
  }
  // Deliberately not awaited. A suspended AudioContext only resumes inside a
  // user gesture, and the day plan's play button starts a session from an
  // effect after navigating - the click is over by then, so awaiting this
  // hangs forever and the session never starts. The chime is worth less than
  // the timer; if the context stays suspended, a later gesture unblocks it.
  void audio.resume().catch(() => {})
  const s = await startFocusSession(body)
  current = {
    id: s.id,
    planned: body.planned_minutes,
    title: s.title,
    startMs: Date.parse(s.started_at),
    pausedSeconds: 0,
    pausedAtMs: null,
  }
  ended = false
  persist()
  scheduleTick()
  broadcast()
  return current
}

// Adopt a session the backend already created (a "/start 30 on X" command),
// instead of calling startFocusSession again and opening a second one. Same
// bookkeeping as beginFocusSession minus the create call. This always wins
// over whatever is in local state: the server only hands one back when it
// has no other session open, so a leftover entry here (a tab closed while
// offline, so the end never reported) is stale and must not shadow it.
export function adoptFocusSession(s: {
  id: string
  title: string
  planned_minutes: number
  started_at: string
  paused_at?: string | null
  paused_seconds?: number
}): ActiveFocusSession {
  if (!audio) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    audio = new Ctx()
  }
  void audio.resume()
  current = {
    id: s.id,
    planned: s.planned_minutes,
    title: s.title,
    startMs: Date.parse(s.started_at),
    pausedSeconds: s.paused_seconds ?? 0,
    pausedAtMs: s.paused_at ? Date.parse(s.paused_at) : null,
  }
  ended = false
  persist()
  scheduleTick()
  broadcast()
  return current
}

// Called once at startup. A reload fires the same unload events as closing the
// tab, so the page can't tell them apart - the server can, because the session
// is simply still open there. Whatever it says wins over local state: it hands
// back nothing if the session was properly stopped, and closes out one whose
// time ran out while nothing was watching.
export async function restoreFocusSession(): Promise<void> {
  let active: Awaited<ReturnType<typeof getActiveFocusSession>>
  try {
    active = await getActiveFocusSession()
  } catch {
    return // offline: keep ticking whatever localStorage had
  }
  if (!active) {
    if (!current) return
    window.clearInterval(tickTimer)
    current = null
    persist()
    broadcast()
    return
  }
  if (current?.id === active.id && current.pausedAtMs !== null) return
  adoptFocusSession({
    id: active.id,
    title: active.title,
    planned_minutes: active.planned_minutes,
    started_at: active.started_at,
    paused_at: active.paused_at,
    paused_seconds: active.paused_seconds,
  })
}

export async function toggleFocusPause(): Promise<void> {
  if (!current) return
  const now = Date.now()
  try {
    if (current.pausedAtMs === null) {
      await pauseFocusSession(current.id)
      current = { ...current, pausedAtMs: now }
    } else {
      await resumeFocusSession(current.id)
      current = {
        ...current,
        pausedSeconds: current.pausedSeconds + (now - current.pausedAtMs) / 1000,
        pausedAtMs: null,
      }
    }
  } catch {
    return // leave local state as-is; the buttons just don't toggle this time
  }
  persist()
  broadcast()
}

export async function extendFocus(minutes: number): Promise<void> {
  if (!current) return
  try {
    await extendFocusSession(current.id, minutes)
  } catch {
    return // leave the clock as-is if the request failed
  }
  current = { ...current, planned: current.planned + minutes }
  persist()
  broadcast()
}

export async function stopFocusSession(completed: boolean): Promise<void> {
  const s = current
  if (!s || ended) return
  ended = true
  window.clearInterval(tickTimer)
  const actual = Math.round(elapsedActiveSeconds(s) / 60)
  // A long-backgrounded tab can suspend the AudioContext; resume is a
  // no-op if it's already running, so this is safe to always call.
  if (completed && audio) void audio.resume().then(() => playChime(audio!))
  current = null
  persist()
  broadcast({ title: s.title, planned: s.planned, actual, completed })
  try {
    await endFocusSession(s.id, completed)
    window.dispatchEvent(new Event('life-log-created'))
  } catch {
    // the session is already ended locally; a failed report is non-fatal
  }
}

// Nothing is ended on unload any more. beforeunload/pagehide fire identically
// for a reload and for a real close, so ending there threw away a session
// every time the page was refreshed. Leaving it open costs nothing: the next
// load either adopts it (restoreFocusSession) or, if its planned time has
// since run out, the server closes it out capped at what was planned.

// Resume ticking immediately from localStorage so the countdown is right on
// the first frame; restoreFocusSession reconciles with the server just after.
if (current) scheduleTick()
