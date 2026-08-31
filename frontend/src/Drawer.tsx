import { useCallback, useEffect, useRef, useState } from 'react'
import { listLogs, listSleep, listTasks } from './api'
import type { Category, SleepData } from './types'

// How far the drawer travels, and how much of that you have to pull before
// letting go commits to open. Short of it, it snaps back.
const TRAVEL = 216
const SNAP = 0.42
const PULLS_KEY = 'life_drawer_pulls'

// The tab moves per page - finding it again is part of the toy. Nothing sits
// below 74% because the clock, the focus pill and the sleep nag all live along
// the bottom edge.
type Side = 'left' | 'right'
const SPOTS: { prefix: string; side: Side; top: number }[] = [
  { prefix: '#/music', side: 'right', top: 27 },
  { prefix: '#/soma', side: 'right', top: 63 },
  { prefix: '#/places', side: 'left', top: 31 },
  { prefix: '#/travel', side: 'right', top: 38 },
  { prefix: '#/sleep', side: 'right', top: 71 },
  { prefix: '#/cadences', side: 'left', top: 68 },
  { prefix: '#/learning', side: 'left', top: 58 },
  { prefix: '#/tasks', side: 'left', top: 36 },
  { prefix: '#/search', side: 'left', top: 47 },
  { prefix: '#/wishlist', side: 'right', top: 44 },
  { prefix: '#/guide', side: 'right', top: 54 },
  { prefix: '#/focus', side: 'left', top: 26 },
]

function spotFor(route: string) {
  return SPOTS.find((s) => route.startsWith(s.prefix)) ?? { side: 'right' as Side, top: 46 }
}

const NONSENSE = [
  'the drawer is empty. it was empty before you looked.',
  'a key. no idea what it opens.',
  "someone else's list: eggs, twine, a small hammer.",
  'one (1) spare hour. non-transferable.',
  'a button that came off something.',
  'half a thought. the other half is in the other drawer.',
  'there is no other drawer.',
  'a paperclip, straightened. someone was thinking hard.',
  'two AA batteries, probably dead.',
  'an olive pit. rude.',
  'a receipt for something you did not buy.',
  'your own handwriting, unreadable.',
  'the sound of a drawer opening, written down.',
  'IOU: one good night of sleep.',
  'a stamp for a country that no longer exists.',
  'lint, mostly.',
]

const COUNTED = [
  (n: number) => `that is ${n} pulls.`,
  (n: number) => `${n} times now. i do keep count.`,
  (n: number) => `${n}. you have other things to do.`,
  (n: number) => `pull ${n}. the drawer is holding up well.`,
  (n: number) => `${n} and nothing has changed in here.`,
]

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

type Filling = { kind: 'line'; text: string } | { kind: 'toy' } | { kind: 'waiting' }

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
  const { side, top } = spotFor(route)
  const [open, setOpen] = useState(false)
  const [filling, setFilling] = useState<Filling>({ kind: 'waiting' })
  const [pulls, setPulls] = useState(() => Number(localStorage.getItem(PULLS_KEY) ?? 0))
  const boxRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; from: number; moved: boolean } | null>(null)
  const lastLine = useRef('')

  const dir = side === 'right' ? 1 : -1

  // Moving the tab means finding it again, so a route change always closes it.
  useEffect(() => setOpen(false), [route])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const fill = (n: number) => {
    // The count stays out of it until pulling this thing is clearly a habit.
    if (n >= 25 && Math.random() < 0.34) {
      setFilling({ kind: 'line', text: COUNTED[Math.floor(Math.random() * COUNTED.length)](n) })
      return
    }
    const roll = Math.random()
    if (roll < 0.25) {
      setFilling({ kind: 'toy' })
      return
    }
    if (roll < 0.6) {
      setFilling({ kind: 'waiting' })
      void factFor(route).then((line) =>
        setFilling(line ? { kind: 'line', text: line } : { kind: 'line', text: nonsense() }),
      )
      return
    }
    setFilling({ kind: 'line', text: nonsense() })
  }

  const nonsense = () => {
    let line = lastLine.current
    while (line === lastLine.current) line = NONSENSE[Math.floor(Math.random() * NONSENSE.length)]
    lastLine.current = line
    return line
  }

  const commit = (next: boolean) => {
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
    dragRef.current = { startX: e.clientX, from: open ? 0 : TRAVEL, moved: false }
  }

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    const box = boxRef.current
    if (!d || !box) return
    const pulled = (e.clientX - d.startX) * -dir
    if (!d.moved) {
      if (Math.abs(pulled) < 4) return
      d.moved = true
      box.style.transition = 'none'
    }
    // Rubber band: the further you pull, the less you get, so the drawer
    // stiffens toward the end of its travel instead of stopping dead.
    const from = d.from
    const give = TRAVEL * (1 - Math.exp(-Math.abs(pulled) / TRAVEL)) * Math.sign(pulled)
    const offset = Math.max(0, Math.min(TRAVEL, from - give))
    box.style.transform = `translateX(${offset * dir}px)`
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
    const pulled = (e.clientX - d.startX) * -dir
    const give = TRAVEL * (1 - Math.exp(-Math.abs(pulled) / TRAVEL)) * Math.sign(pulled)
    const offset = Math.max(0, Math.min(TRAVEL, d.from - give))
    commit(offset < TRAVEL * (1 - SNAP))
  }

  const wear = pulls >= 100 ? 3 : pulls >= 50 ? 2 : pulls >= 10 ? 1 : 0

  return (
    <div
      className={`fidget ${side}${open ? ' open' : ''}`}
      style={{ top: `${top}%`, ['--travel' as string]: `${TRAVEL}px` }}
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
        ) : (
          <p className="fidget-line dim">…</p>
        )}
      </div>
    </div>
  )
}
