import { useEffect, useRef, useState } from 'react'
import { listLogs, listSleep, listTasks } from './api'
import { COUNTED, NONSENSE, pickNot } from './remarks'
import type { Category, SleepData } from './types'

// How far the drawer travels, and how much of that you have to pull before
// letting go commits to open. Short of it, it snaps back.
const TRAVEL = 132
const SNAP = 0.42
const PULLS_KEY = 'life_drawer_pulls'
// How long the pointer has to stay out of the bottom half before the drawer
// starts sliding open by itself, and how long it takes to get all the way out.
const LEAK_DELAY_MS = 4000
const LEAK_MS = 18000

// The tab slides along the bottom edge from page to page - finding it is part
// of it. Nothing sits outside 26%-74%: the clock holds the bottom left corner
// and the focus pill the bottom right.
const SPOTS: { prefix: string; left: number }[] = [
  { prefix: '#/music', left: 62 },
  { prefix: '#/soma', left: 35 },
  { prefix: '#/places', left: 71 },
  { prefix: '#/travel', left: 29 },
  { prefix: '#/sleep', left: 47 },
  { prefix: '#/cadences', left: 66 },
  { prefix: '#/learning', left: 32 },
  { prefix: '#/tasks', left: 57 },
  { prefix: '#/search', left: 44 },
  { prefix: '#/wishlist', left: 69 },
  { prefix: '#/guide', left: 27 },
  { prefix: '#/focus', left: 74 },
]

function leftFor(route: string) {
  return (SPOTS.find((s) => route.startsWith(s.prefix)) ?? { left: 52 }).left
}

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
  const left = leftFor(route)
  const [mode, setMode] = useState<Mode>('shut')
  const [filling, setFilling] = useState<Filling>({ kind: 'empty' })
  const [pulls, setPulls] = useState(() => Number(localStorage.getItem(PULLS_KEY) ?? 0))
  const boxRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; from: number; moved: boolean } | null>(null)
  const lastLine = useRef<string | null>(null)
  const modeRef = useRef<Mode>('shut')
  const inBottom = useRef(false)
  const awaySince = useRef(Date.now())
  const open = mode !== 'shut'

  modeRef.current = mode

  // Moving the tab means finding it again, so a route change always closes it.
  useEffect(() => setMode('shut'), [route])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMode('shut')
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

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

  // The drawer does not sit still. Left alone it slides open over most of a
  // minute, and the moment the pointer enters the bottom half of the window it
  // is shut again - so you only ever catch it out of the corner of your eye.
  // The poll is what makes a pointer that never moves work: a cursor parked in
  // the top half is away, and away is what arms the leak.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const bottom = e.clientY > window.innerHeight * 0.52
      inBottom.current = bottom
      if (!bottom) return
      awaySince.current = Date.now()
      setMode((m) => (m === 'leaking' ? 'shut' : m))
    }
    window.addEventListener('pointermove', onMove)
    const tick = window.setInterval(() => {
      if (inBottom.current || modeRef.current !== 'shut') return
      if (Date.now() - awaySince.current < LEAK_DELAY_MS) return
      fill(pulls)
      setMode('leaking')
    }, 900)
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

  // Where the drawer actually is this frame, which during a leak is neither
  // open nor shut. Grabbing it has to start from there or it jumps.
  const currentOffset = () => {
    const box = boxRef.current
    if (!box) return TRAVEL
    const t = getComputedStyle(box).transform
    if (!t || t === 'none') return 0
    return new DOMMatrixReadOnly(t).m42
  }

  // The drag writes the transform straight to the box and turns the transition
  // off, so the drawer tracks the finger; the release hands it back to CSS,
  // which is what makes the snap a snap rather than a follow.
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, from: currentOffset(), moved: false }
  }

  const offsetFor = (d: { startY: number; from: number }, clientY: number) => {
    const pulled = d.startY - clientY
    // Rubber band: the further you pull, the less you get, so the drawer
    // stiffens toward the end of its travel instead of stopping dead.
    const give = TRAVEL * (1 - Math.exp(-Math.abs(pulled) / TRAVEL)) * Math.sign(pulled)
    return Math.max(0, Math.min(TRAVEL, d.from - give))
  }

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    const box = boxRef.current
    if (!d || !box) return
    if (!d.moved) {
      if (Math.abs(e.clientY - d.startY) < 4) return
      d.moved = true
      box.style.transition = 'none'
    }
    box.style.transform = `translateY(${offsetFor(d, e.clientY)}px)`
  }

  const onUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    const box = boxRef.current
    dragRef.current = null
    if (!d || !box) return
    box.style.transition = ''
    box.style.transform = ''
    if (!d.moved) {
      commit(!open)
      return
    }
    commit(offsetFor(d, e.clientY) < TRAVEL * (1 - SNAP))
  }

  const wear = pulls >= 100 ? 3 : pulls >= 50 ? 2 : pulls >= 10 ? 1 : 0

  return (
    <div
      className={`fidget ${mode}`}
      style={{
        left: `${left}%`,
        ['--travel' as string]: `${TRAVEL}px`,
        ['--leak' as string]: `${LEAK_MS}ms`,
      }}
      ref={boxRef}
    >
      <button
        className={`fidget-tab wear-${wear}`}
        aria-label={open ? 'close the drawer' : 'open the drawer'}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <div className="fidget-body">
        {filling.kind === 'line' ? (
          <p className="fidget-line">{filling.text}</p>
        ) : filling.kind === 'empty' ? (
          <p className="fidget-line dim">(empty)</p>
        ) : (
          <p className="fidget-line dim">…</p>
        )}
      </div>
    </div>
  )
}

export { leftFor }
