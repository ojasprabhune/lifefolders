// Owns the one active focus session as module state (not React state) so it
// keeps running — countdown, pause math, natural completion, tab-close bail —
// regardless of which page is mounted. FocusTimer and FocusPill both just
// read getFocusSession() and listen for 'life-focus-changed' to reflect it;
// neither owns the timer.
import {
  beaconEndFocusSession,
  endFocusSession,
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
  await audio.resume()
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
// bookkeeping as beginFocusSession minus the create call; a session already
// in flight wins, so a command fired with a timer running is ignored rather
// than silently replacing it.
export function adoptFocusSession(s: {
  id: string
  title: string
  planned_minutes: number
  started_at: string
}): ActiveFocusSession | null {
  if (current) return current
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
    pausedSeconds: 0,
    pausedAtMs: null,
  }
  ended = false
  persist()
  scheduleTick()
  broadcast()
  return current
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

// If the tab is actually closed mid-session, best-effort end it as a manual
// stop so no session is left dangling open in the database. Lives at module
// scope (not tied to any component's mount) since the session itself now
// outlives whichever page started it.
function bail() {
  if (!current || ended) return
  ended = true
  window.clearInterval(tickTimer)
  beaconEndFocusSession(current.id, false)
  current = null
  persist()
}
window.addEventListener('beforeunload', bail)
window.addEventListener('pagehide', bail)

// Resume ticking on a fresh page load if a session was already running.
if (current) scheduleTick()
