import { useCallback, useEffect, useRef, useState } from 'react'
import { listSleep } from './api'
import type { SleepData } from './types'

// Nag window: midnight through this hour. Capped at dawn so a night you
// never log doesn't keep nagging you all day.
const NAG_END_HOUR = 6
const MIN_GAP_MIN = 5
const MAX_GAP_MIN = 10

function msUntilNextCheck(): number {
  const minutes = MIN_GAP_MIN + Math.random() * (MAX_GAP_MIN - MIN_GAP_MIN)
  return minutes * 60 * 1000
}

function msUntilMidnight(now: Date): number {
  const next = new Date(now)
  next.setHours(24, 0, 0, 0)
  return next.getTime() - now.getTime()
}

// Global toast rendered above every route (App.tsx) - checks in on a timer
// rather than a single setTimeout chain to midnight, so it self-corrects if
// the tab was backgrounded and the browser throttled/dropped a timer.
export function SleepReminder() {
  const [visible, setVisible] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const tick = useCallback(async () => {
    const now = new Date()
    if (now.getHours() >= NAG_END_HOUR) {
      setVisible(false)
      timer.current = window.setTimeout(tick, msUntilMidnight(now))
      return
    }
    try {
      const nights = await listSleep()
      const latest = nights[0]?.data as SleepData | undefined
      // No record yet tonight, or the last one already has a sleep_end (an
      // ended session, not one still in progress) - either way, sleep
      // hasn't started yet, so keep nagging.
      setVisible(!latest || latest.sleep_end !== null)
    } catch {
      setVisible(false)
    }
    timer.current = window.setTimeout(tick, msUntilNextCheck())
  }, [])

  useEffect(() => {
    tick()
    return () => window.clearTimeout(timer.current)
  }, [tick])

  if (!visible) return null

  return (
    <div className="sleep-nag">
      <span>🌙 past midnight — log tonight's sleep?</span>
      <button onClick={() => setVisible(false)} aria-label="dismiss">
        ✕
      </button>
    </div>
  )
}
