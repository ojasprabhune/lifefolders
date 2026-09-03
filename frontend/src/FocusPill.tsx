import { useEffect, useRef, useState } from 'react'
import { getFocusSession, remainingSeconds, type ActiveFocusSession } from './focusEngine'
import { usePanelState } from './Panel'

function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

// A running (or paused) focus session keeps going no matter what page you're
// on — this pill is the only trace of it once you've navigated away from
// #/focus. Tap it to jump back.
export function FocusPill({ route }: { route: string }) {
  const [active, setActive] = useState<ActiveFocusSession | null>(getFocusSession())
  // The engine ticks with the *same* session object each second, so a plain
  // `remaining` number (not derived from `active` at render time) is what
  // actually forces a re-render every tick.
  const [remaining, setRemaining] = useState(() => (active ? remainingSeconds(active) : 0))

  useEffect(() => {
    const onChange = (e: Event) => {
      const { session } = (e as CustomEvent<{ session: ActiveFocusSession | null }>).detail
      setActive(session)
      setRemaining(session ? remainingSeconds(session) : 0)
    }
    window.addEventListener('life-focus-changed', onChange)
    return () => window.removeEventListener('life-focus-changed', onChange)
  }, [])

  // A session ending, or walking into #/focus, used to take the pill off the
  // screen on the spot. It is kept for one exit animation - and with it the
  // last thing it was showing, since there's no session left to read.
  const live = active !== null && !route.startsWith('#/focus')
  const { mounted, closing } = usePanelState(live, 200)
  const last = useRef(active)
  if (active) last.current = active
  const session = last.current
  if (!mounted || !session) return null

  const paused = session.pausedAtMs !== null

  return (
    <button
      className={`focus-pill ${paused ? 'paused' : ''} ${closing ? 'closing' : ''}`}
      onClick={() => (window.location.hash = '#/focus')}
    >
      <span className="focus-pill-icon">{paused ? '⏸' : '⏵'}</span>
      <span className="focus-pill-time">{mmss(remaining)}</span>
      <span className="focus-pill-title">{session.title}</span>
    </button>
  )
}
