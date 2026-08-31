import { useCallback, useEffect, useRef, useState } from 'react'
import { listLogs, listSleep, listTasks } from './api'
import { COUNTED, NONSENSE, pickNot } from './remarks'
import type { Category, SleepData } from './types'

// How far the drawer travels, and how much of that you have to pull before
// letting go commits to open. Short of it, it snaps back.
const TRAVEL = 132
const SNAP = 0.42
const PULLS_KEY = 'life_drawer_pulls'

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

type Filling =
  | { kind: 'line'; text: string }
  | { kind: 'toy' }
  | { kind: 'empty' }
  | { kind: 'waiting' }

// A bead on a rail. Position and velocity are written straight to the DOM,
// never through state - the whole point is that it keeps moving after you let
// go, and re-rendering the app at 60fps to slide one bead would be absurd.
function Bead() {
  const railRef = useRef<HTMLDivElement>(null)
  const beadRef = useRef<HTMLDivElement>(null)
  const st = useRef({ x: 0, v: 0, grabX: 0, lastT: 0, raf: 0 })

  const span = () => {
    const r = railRef.current
    const b = beadRef.current
    if (!r || !b) return 0
    return r.clientWidth - b.offsetWidth
  }

  const draw = () => {
    if (beadRef.current) beadRef.current.style.transform = `translateX(${st.current.x}px)`
  }

  useEffect(() => {
    st.current.x = span() / 2
    draw()
    const s = st.current
    return () => cancelAnimationFrame(s.raf)
  }, [])

  const step = useCallback((t: number) => {
    const s = st.current
    const dt = Math.min(32, t - s.lastT) / 1000
    s.lastT = t
    s.v *= Math.pow(0.04, dt)
    s.x += s.v * dt
    const max = span()
    if (s.x < 0) {
      s.x = 0
      s.v = -s.v * 0.55
    }
    if (s.x > max) {
      s.x = max
      s.v = -s.v * 0.55
    }
    draw()
    if (Math.abs(s.v) > 6) s.raf = requestAnimationFrame(step)
  }, [])

  return (
    <div className="fidget-rail" ref={railRef}>
      <div
        className="fidget-bead"
        ref={beadRef}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          const s = st.current
          cancelAnimationFrame(s.raf)
          s.v = 0
          s.grabX = e.clientX - s.x
          s.lastT = performance.now()
        }}
        onPointerMove={(e) => {
          const s = st.current
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
          const now = performance.now()
          const next = Math.max(0, Math.min(span(), e.clientX - s.grabX))
          const dt = Math.max(8, now - s.lastT)
          s.v = ((next - s.x) / dt) * 1000
          s.x = next
          s.lastT = now
          draw()
        }}
        onPointerUp={() => {
          const s = st.current
          s.lastT = performance.now()
          s.raf = requestAnimationFrame(step)
        }}
      />
    </div>
  )
}

export function Drawer({ route }: { route: string }) {
  const left = leftFor(route)
  const [open, setOpen] = useState(false)
  const [filling, setFilling] = useState<Filling>({ kind: 'empty' })
  const [pulls, setPulls] = useState(() => Number(localStorage.getItem(PULLS_KEY) ?? 0))
  const boxRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; from: number; moved: boolean } | null>(null)
  const lastLine = useRef<string | null>(null)

  // Moving the tab means finding it again, so a route change always closes it.
  useEffect(() => setOpen(false), [route])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
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
    if (roll < 0.08) {
      setFilling({ kind: 'empty' })
      return
    }
    if (roll < 0.3) {
      setFilling({ kind: 'toy' })
      return
    }
    if (roll < 0.62) {
      setFilling({ kind: 'waiting' })
      void factFor(route).then((line) =>
        setFilling({ kind: 'line', text: line ?? nonsense() }),
      )
      return
    }
    setFilling({ kind: 'line', text: nonsense() })
  }

  // Only a drawer that was all the way shut gets restocked. Nudging one that
  // is already open, or pulling it half out and letting it fall back, leaves
  // whatever is inside alone.
  const commit = (next: boolean) => {
    if (next === open) return
    setOpen(next)
    if (!next) return
    const n = pulls + 1
    setPulls(n)
    localStorage.setItem(PULLS_KEY, String(n))
    fill(n)
  }

  // The drag writes the transform straight to the box and turns the transition
  // off, so the drawer tracks the finger; the release hands it back to CSS,
  // which is what makes the snap a snap rather than a follow.
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, from: open ? 0 : TRAVEL, moved: false }
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
      className={`fidget${open ? ' open' : ''}`}
      style={{ left: `${left}%`, ['--travel' as string]: `${TRAVEL}px` }}
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
        {filling.kind === 'toy' ? (
          <Bead />
        ) : filling.kind === 'line' ? (
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
