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
const PLAN_TTL_MS = 45_000
// A block that began longer ago than this is not "just started", it is
// a page opened halfway through the evening, and a timer should not appear.
const WINDOW_MS = 5 * 60_000

type Cached = { at: number; plan: DayPlan }
const cache = new Map<string, Cached>()

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

async function planFor(date: string): Promise<DayPlan | null> {
  const hit = cache.get(date)
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.plan
  try {
    const plan = await getDayPlan(date)
    cache.set(date, { at: Date.now(), plan })
    return plan
  } catch {
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
