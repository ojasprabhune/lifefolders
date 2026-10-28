// Starts the focus session for a plan block when it begins, so the schedule
// drives the timer instead of a tap. Blocks linked to a sidequest time that
// sidequest; custom blocks get a session of their own, named by the block.
// It lives at module level, like the focus engine, so it works on every page,
// but only while the app is open in a tab, since there is no background process to run it.
import { getDayPlan, type DayPlan, type PlanBlock } from './api'
import { localDateStr } from './dates'
import { beginFocusSession, getFocusSession, stopFocusSession } from './focusEngine'

const STARTED_KEY = 'life_autostart_block'
const POLL_MS = 15_000
// A block that began longer ago than this is not "just started", it is
// a page opened halfway through the evening, and a timer should not appear.
const WINDOW_MS = 5 * 60_000
const RETRY_MS = 10 * 60_000

// The poll reads plans from here and almost never from the server. A plan only
// changes when it is edited, and edits made in this tab are handed over by the
// planner through rememberPlan, so the server is asked once per day and again
// when the tab comes back into view. This used to refetch every 45 seconds,
// which kept the backend and Neon's free compute awake for as long as a tab
// was open - a tab left open overnight spent the month's compute allowance.
const cache = new Map<string, DayPlan>()
const failedAt = new Map<string, number>()

export function rememberPlan(date: string, plan: DayPlan) {
  cache.set(date, plan)
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  cache.clear()
  failedAt.clear()
})

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

async function planFor(date: string): Promise<DayPlan | null> {
  const hit = cache.get(date)
  if (hit) return hit
  if (Date.now() - (failedAt.get(date) ?? 0) < RETRY_MS) return null
  try {
    const plan = await getDayPlan(date)
    cache.set(date, plan)
    return plan
  } catch {
    failedAt.set(date, Date.now())
    return null
  }
}

// Block times are clock strings, and an evening plan runs past midnight, so
// the day rolls over wherever the clock goes backwards.
function withAbsoluteTimes(date: string, plan: DayPlan): { block: PlanBlock; startMs: number; endMs: number; prev: PlanBlock | null }[] {
  const [y, mo, d] = date.split('-').map(Number)
  const midnight = new Date(y, mo - 1, d).getTime()
  let dayShift = 0
  let last = minutes(plan.starts_at)
  return plan.blocks.map((block, i) => {
    const m = minutes(block.start)
    if (m < last) dayShift += 1440
    last = m
    const startMs = midnight + (dayShift + m) * 60_000
    return { block, startMs, endMs: startMs + block.minutes * 60_000, prev: i > 0 ? plan.blocks[i - 1] : null }
  })
}

async function check() {
  const now = new Date()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  for (const date of [localDateStr(now), localDateStr(yesterday)]) {
    const plan = await planFor(date)
    if (!plan) continue
    const t = Date.now()
    for (const { block, startMs, endMs } of withAbsoluteTimes(date, plan)) {
      if (t < startMs || t >= endMs || t - startMs > WINDOW_MS) continue
      if (block.kind === 'break') continue
      if (localStorage.getItem(STARTED_KEY) === block.id) return
      localStorage.setItem(STARTED_KEY, block.id)
      // A session still running from the block before is that block's, so it
      // ends here. One started during this block (by hand) is left alone.
      const running = getFocusSession()
      if (running && running.startMs >= startMs - 60_000) return
      try {
        if (running) await stopFocusSession(true)
        await beginFocusSession({
          ...(block.task_id ? { task_id: block.task_id } : { label: block.label }),
          planned_minutes: Math.max(1, Math.ceil((endMs - t) / 60_000)),
        })
      } catch {
        // leave it; the play button on the block still works
      }
      return
    }
  }
}

export function startPlanAutostart(): () => void {
  const id = window.setInterval(() => void check(), POLL_MS)
  void check()
  return () => window.clearInterval(id)
}
