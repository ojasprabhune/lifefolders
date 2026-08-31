import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { listLogs, listSleep, listTasks } from './api'
import { COUNTED, NONSENSE, pickNot } from './remarks'
import type { Category, SleepData } from './types'

// How far the drawer travels, and how much of that you have to pull before
// letting go commits to open. Short of it, it snaps back.
// The body's width: shut, it is exactly hidden behind the cabinet face.
const MAX_W = 270
const SNAP = 0.42
const PULLS_KEY = 'life_drawer_pulls'
// The leak is meant to be rare enough to be a surprise, so it is a coin the
// app flips every so often rather than a timer that always fires: roughly once
// every five minutes of the pointer staying out of the bottom half, never
// twice inside a couple of minutes, and eighteen seconds to slide all the way
// out once it does.
const LEAK_CHECK_MS = 30000
const LEAK_CHANCE = 0.1
const LEAK_COOLDOWN_MS = 120000
const LEAK_MS = 18000

const ROUTE_CATEGORY: { prefix: string; category: Category; label: string }[] = [
  { prefix: '#/music', category: 'music', label: 'music' },
  { prefix: '#/soma', category: 'workout', label: 'soma' },
  { prefix: '#/places', category: 'place', label: 'places' },
  { prefix: '#/travel', category: 'trip', label: 'travel' },
  { prefix: '#/learning', category: 'learning', label: 'learning' },
  { prefix: '#/cadences', category: 'cadence_completion', label: 'cadences' },
  { prefix: '#/wishlist', category: 'wishlist', label: 'the wishlist' },
]

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
}

// One true line about wherever you are. Null on any failure - the backend
// sleeps, and a drawer that says nothing is better than a drawer that errors.
async function factFor(route: string): Promise<string | null> {
  try {
    if (route.startsWith('#/tasks')) {
      const tasks = await listTasks()
      const open = tasks.filter((t) => t.status !== 'done')
      if (!open.length) return 'no open sidequests. suspicious.'
      const oldest = open.reduce((a, b) => (a.created_at < b.created_at ? a : b))
      const age = daysSince(oldest.created_at)
      if (age < 2) return `${open.length} sidequests open, all of them fresh.`
      return `${open.length} open. "${oldest.title}" has been waiting ${age} days.`
    }

    if (route.startsWith('#/sleep')) {
      const nights = await listSleep()
      const last = nights.find((l) => (l.data as SleepData).duration_min)
      if (!last) return 'no nights logged. bold.'
      const min = (last.data as SleepData).duration_min as number
      return `${Math.floor(min / 60)}h ${min % 60}m, the last night you told me about.`
    }

    const spot = ROUTE_CATEGORY.find((r) => route.startsWith(r.prefix))
    const logs = await listLogs(today(), spot ? spot.category : 'all')
    if (!logs.length) {
      return spot ? `nothing in ${spot.label} today.` : 'nothing logged today. the drawer matches.'
    }
    return `the last thing you told me: "${logs[0].raw_input}"`
  } catch {
    return null
  }
}

type Filling = { kind: 'line'; text: string } | { kind: 'empty' } | { kind: 'waiting' }

// Shut, creeping open on its own, or pulled open by you. The difference
// matters: a leak retreats the moment you come near it, a drawer you pulled
// stays where you put it.
type Mode = 'shut' | 'leaking' | 'pulled'

export function Drawer({ route }: { route: string }) {
  const [mode, setMode] = useState<Mode>('shut')
  const [filling, setFilling] = useState<Filling>({ kind: 'empty' })
  const [pulls, setPulls] = useState(() => Number(localStorage.getItem(PULLS_KEY) ?? 0))
  const [width, setWidth] = useState(0)
  const winRef = useRef<HTMLDivElement>(null)
  const slipRef = useRef<HTMLParagraphElement>(null)
  const dragRef = useRef<{ startX: number; from: number; moved: boolean } | null>(null)
  const lastLine = useRef<string | null>(null)
  const modeRef = useRef<Mode>('shut')
  const inBottom = useRef(false)
  const lastLeak = useRef(Date.now())
  const open = mode !== 'shut'

  modeRef.current = mode

  useEffect(() => setMode('shut'), [route])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMode('shut')
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // The slip sizes itself to its own text, up to MAX_W, and how far the drawer
  // opens is just that width. Measured rather than fixed: auto is not
  // animatable, and a one-line remark should not open a three-line drawer.
  useLayoutEffect(() => {
    setWidth(slipRef.current?.offsetWidth ?? 0)
  }, [filling])

  const nonsense = () => {
    const line = pickNot(NONSENSE, lastLine.current)
    lastLine.current = line
    return line
  }

  const fill = (n: number) => {
    // The count stays out of it until pulling this thing is clearly a habit.
    if (n >= 25 && Math.random() < 0.3) {
      setFilling({ kind: 'line', text: COUNTED[Math.floor(Math.random() * COUNTED.length)](n) })
      return
    }
    const roll = Math.random()
    if (roll < 0.1) {
      setFilling({ kind: 'empty' })
      return
    }
    if (roll < 0.55) {
      setFilling({ kind: 'waiting' })
      void factFor(route).then((line) => setFilling({ kind: 'line', text: line ?? nonsense() }))
      return
    }
    setFilling({ kind: 'line', text: nonsense() })
  }

  // The drawer does not sit still. Rarely - a one-in-ten chance each half
  // minute the pointer stays out of the bottom half, never twice inside two
  // minutes - it slides itself open, and the moment the pointer comes near it
  // is shut again. The poll is what makes a pointer that never moves work: a
  // cursor parked in the top half is away, and away is what arms the leak.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const bottom = e.clientY > window.innerHeight * 0.52
      inBottom.current = bottom
      if (!bottom) return
      lastLeak.current = Date.now()
      setMode((m) => (m === 'leaking' ? 'shut' : m))
    }
    window.addEventListener('pointermove', onMove)
    const tick = window.setInterval(() => {
      if (inBottom.current || modeRef.current !== 'shut') return
      if (Date.now() - lastLeak.current < LEAK_COOLDOWN_MS) return
      if (Math.random() > LEAK_CHANCE) return
      lastLeak.current = Date.now()
      fill(pulls)
      setMode('leaking')
    }, LEAK_CHECK_MS)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.clearInterval(tick)
    }
  })

  // Only a drawer that was all the way shut gets restocked, and only a pull
  // counts - a leak stocks itself but is not something you did.
  const commit = (next: boolean) => {
    const wasShut = mode === 'shut'
    setMode(next ? 'pulled' : 'shut')
    if (!next || !wasShut) return
    const n = pulls + 1
    setPulls(n)
    localStorage.setItem(PULLS_KEY, String(n))
    fill(n)
  }

  // How much of the slip is showing this frame, which during a leak is neither
  // all of it nor none. Grabbing it has to start from there or it jumps.
  const shown = () => winRef.current?.getBoundingClientRect().width ?? 0

  const shownFor = (d: { startX: number; from: number }, clientX: number) => {
    const pulled = clientX - d.startX
    // Rubber band: the further you pull the less you get, so it stiffens
    // toward the end of its travel instead of stopping dead.
    const give = width * (1 - Math.exp(-Math.abs(pulled) / Math.max(width, 1))) * Math.sign(pulled)
    return Math.max(0, Math.min(width, d.from + give))
  }

  // The drag writes the width straight to the window with the transition off,
  // so the drawer tracks the finger; the release hands it back to CSS, which
  // is what makes the snap a snap rather than a follow.
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, from: shown(), moved: false }
  }

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    const win = winRef.current
    if (!d || !win) return
    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) < 4) return
      d.moved = true
      win.style.transition = 'none'
    }
    win.style.width = `${shownFor(d, e.clientX)}px`
  }

  const onUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    const win = winRef.current
    dragRef.current = null
    if (!d || !win) return
    win.style.transition = ''
    win.style.width = ''
    if (!d.moved) {
      commit(!open)
      return
    }
    commit(shownFor(d, e.clientX) > width * SNAP)
  }

  const wear = pulls >= 100 ? 3 : pulls >= 50 ? 2 : pulls >= 10 ? 1 : 0
  const text =
    filling.kind === 'line' ? filling.text : filling.kind === 'empty' ? '(empty)' : '…'

  return (
    <div
      className={`fidget ${mode}`}
      style={{
        ['--w' as string]: `${width}px`,
        ['--maxw' as string]: `${MAX_W}px`,
        ['--leak' as string]: `${LEAK_MS}ms`,
      }}
    >
      <div className="fidget-window" ref={winRef}>
        <p className={`fidget-slip${filling.kind === 'line' ? '' : ' dim'}`} ref={slipRef}>
          {text}
        </p>
      </div>
      <button
        className={`fidget-pull wear-${wear}`}
        aria-label={open ? 'close the drawer' : 'open the drawer'}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
    </div>
  )
}
