// Module-level singleton, same pattern as focusEngine.ts - this needs to
// keep polling and ticking regardless of which page is mounted, and there's
// exactly one backend to track, not per-component state.
import { checkHealth } from './api'

export type BackendState = { status: 'online' | 'waking'; secondsLeft: number }

let state: BackendState = { status: 'online', secondsLeft: 10 }
let tickTimer: number | undefined
let pollTimer: number | undefined
let checking = false

function broadcast() {
  window.dispatchEvent(new CustomEvent<BackendState>('life-backend-status-changed', { detail: state }))
}

export function getBackendState(): BackendState {
  return state
}

function stopWaking() {
  window.clearInterval(tickTimer)
  window.clearInterval(pollTimer)
  state = { status: 'online', secondsLeft: 10 }
  broadcast()
}

// Render's free tier sleeps the whole process after 15 min idle; a cold
// start is commonly 20-60s, not a fixed 10 - so the countdown loops back to
// 10 instead of freezing at 0 or counting into negative numbers if it runs
// long. It's a "still working on it" pulse, not a precise ETA.
function startWaking() {
  if (state.status === 'waking') return
  state = { status: 'waking', secondsLeft: 10 }
  broadcast()
  window.clearInterval(tickTimer)
  tickTimer = window.setInterval(() => {
    const next = state.secondsLeft - 1
    state = { status: 'waking', secondsLeft: next <= 0 ? 10 : next }
    broadcast()
  }, 1000)
  window.clearInterval(pollTimer)
  pollTimer = window.setInterval(() => void poll(), 2500)
  void poll()
}

async function poll() {
  if (checking) return
  checking = true
  const ok = await checkHealth()
  checking = false
  if (ok) stopWaking()
}

// Called both by the passive checks below and by anything that just hit a
// real API failure (Home's submit retry) - so the banner and countdown show
// up the moment something actually failed, not only on the next background
// health poll.
export async function checkBackendNow(): Promise<boolean> {
  const ok = await checkHealth()
  if (ok) {
    if (state.status !== 'online') stopWaking()
  } else {
    startWaking()
  }
  return ok
}

export function markBackendOffline() {
  startWaking()
}

// A real API call (not just the health probe) just succeeded, so the
// backend is provably up - skip the extra round trip a checkBackendNow()
// health fetch would otherwise cost.
export function markBackendOnline() {
  if (state.status !== 'online') stopWaking()
}

// Check as soon as the app's JS loads, and again whenever the tab becomes
// visible - covers both "just opened the app" and "came back after it sat
// idle long enough for Render to have gone back to sleep".
void checkBackendNow()
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void checkBackendNow()
})
