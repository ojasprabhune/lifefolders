import { useEffect, useState } from 'react'
import { getFocusSession, remainingSeconds, type ActiveFocusSession } from './focusEngine'

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

  useEffect(() => {
    const onChange = (e: Event) => {
      const { session } = (e as CustomEvent<{ session: ActiveFocusSession | null }>).detail
      setActive(session)
    }
    window.addEventListener('life-focus-changed', onChange)
    return () => window.removeEventListener('life-focus-changed', onChange)
  }, [])

  if (!active || route.startsWith('#/focus')) return null

  const paused = active.pausedAtMs !== null

  return (
    <button className={`focus-pill ${paused ? 'paused' : ''}`} onClick={() => (window.location.hash = '#/focus')}>
      <span className="focus-pill-icon">{paused ? '⏸' : '⏵'}</span>
      <span className="focus-pill-time">{mmss(remainingSeconds(active))}</span>
      <span className="focus-pill-title">{active.title}</span>
    </button>
  )
}
