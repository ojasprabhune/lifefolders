import { useCallback, useEffect, useRef, useState } from 'react'
import { Drawer } from './Drawer'
import { PEELS, STAMP_WORDS, pickNot } from './remarks'

// The corner of the page, which you can lift. It is not drawn until your
// pointer comes near it - the only one of these you have to find rather than
// be handed. Lets go springy: it overshoots the fold and settles.
const PEEL_REST = 26
const PEEL_MAX = 210

function Peel() {
  const [near, setNear] = useState(false)
  const [line, setLine] = useState('')
  const elRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; from: number } | null>(null)
  const lastLine = useRef<string | null>(null)

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = Math.hypot(window.innerWidth - e.clientX, window.innerHeight - e.clientY)
      setNear((cur) => {
        // Hysteresis, or the dog-ear flickers as you graze the boundary.
        const limit = cur ? 230 : 150
        return d < limit
      })
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  const size = (e: { clientX: number; clientY: number }) => {
    const d = drag.current
    if (!d) return PEEL_REST
    const along = (d.x - e.clientX + (d.y - e.clientY)) * 0.62
    return Math.max(0, Math.min(PEEL_MAX, d.from + along))
  }

  return (
    <div
      className={`peel${near ? ' near' : ''}`}
      ref={elRef}
      style={{ ['--peel-size' as string]: `${near ? PEEL_REST : 0}px` }}
    >
      <div
        className="peel-curl"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, from: PEEL_REST }
          setLine((cur) => {
            const next = pickNot(PEELS, lastLine.current)
            lastLine.current = next
            return cur === next ? cur : next
          })
          if (elRef.current) elRef.current.style.transition = 'none'
        }}
        onPointerMove={(e) => {
          if (!drag.current || !elRef.current) return
          elRef.current.style.setProperty('--peel-size', `${size(e)}px`)
        }}
        onPointerUp={() => {
          drag.current = null
          if (!elRef.current) return
          elRef.current.style.transition = ''
          elRef.current.style.removeProperty('--peel-size')
        }}
      >
        <span className="peel-line">{line}</span>
      </div>
    </div>
  )
}

// The stamp. Same place on every page, unlike everything else here. Press it
// and it thunks down and leaves a crooked red mark that fades on its own.
type Mark = { id: number; word: string; dx: number; dy: number; rot: number }

function Stamp() {
  const [down, setDown] = useState(false)
  const [marks, setMarks] = useState<Mark[]>([])
  const lastWord = useRef<string | null>(null)
  const timers = useRef<number[]>([])

  useEffect(() => {
    const t = timers.current
    return () => t.forEach(clearTimeout)
  }, [])

  const press = () => {
    const word = pickNot(STAMP_WORDS, lastWord.current)
    lastWord.current = word
    const id = Date.now()
    setMarks((cur) => [
      ...cur,
      {
        id,
        word,
        dx: -90 - Math.random() * 90,
        dy: -46 + Math.random() * 92,
        rot: -9 + Math.random() * 18,
      },
    ])
    timers.current.push(
      window.setTimeout(() => setMarks((cur) => cur.filter((m) => m.id !== id)), 3800),
    )
  }

  return (
    <div className="stamp-spot">
      {marks.map((m) => (
        <span
          key={m.id}
          className="stamp-mark"
          style={{ left: `${m.dx}px`, top: `${m.dy}px`, ['--rot' as string]: `${m.rot}deg` }}
        >
          {m.word}
        </span>
      ))}
      <button
        className={`stamp${down ? ' down' : ''}`}
        aria-label="stamp the page"
        onPointerDown={() => setDown(true)}
        onPointerUp={() => {
          setDown(false)
          press()
        }}
        onPointerCancel={() => setDown(false)}
        onPointerLeave={() => setDown(false)}
      >
        <span className="stamp-grip" />
        <span className="stamp-plate" />
      </button>
    </div>
  )
}

// A bead of ink with weight. Fling it and it keeps going, bounces off the
// window and slows down; hit an edge hard enough and it leaves a splat that
// dries out. Sits somewhere different on each page.
const DROP = 18

const DROP_HOMES: { prefix: string; x: number; y: number }[] = [
  { prefix: '#/music', x: 0.08, y: 0.34 },
  { prefix: '#/soma', x: 0.93, y: 0.28 },
  { prefix: '#/places', x: 0.06, y: 0.62 },
  { prefix: '#/travel', x: 0.9, y: 0.55 },
  { prefix: '#/sleep', x: 0.94, y: 0.7 },
  { prefix: '#/cadences', x: 0.07, y: 0.24 },
  { prefix: '#/learning', x: 0.91, y: 0.4 },
  { prefix: '#/tasks', x: 0.05, y: 0.45 },
  { prefix: '#/search', x: 0.95, y: 0.33 },
  { prefix: '#/wishlist', x: 0.09, y: 0.72 },
  { prefix: '#/guide', x: 0.92, y: 0.62 },
  { prefix: '#/focus', x: 0.06, y: 0.18 },
]

type Splat = { id: number; x: number; y: number; rot: number; scale: number }

function InkDrop({ route }: { route: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [splats, setSplats] = useState<Splat[]>([])
  const st = useRef({ x: 0, y: 0, vx: 0, vy: 0, gx: 0, gy: 0, lastT: 0, raf: 0 })

  const draw = () => {
    if (ref.current) ref.current.style.transform = `translate(${st.current.x}px, ${st.current.y}px)`
  }

  const splat = useCallback((x: number, y: number, speed: number) => {
    const id = Date.now() + Math.random()
    setSplats((cur) => [
      ...cur.slice(-4),
      { id, x, y, rot: Math.random() * 360, scale: 0.6 + Math.min(1.1, speed / 1600) },
    ])
    window.setTimeout(() => setSplats((cur) => cur.filter((s) => s.id !== id)), 1400)
  }, [])

  const step = useCallback(
    (t: number) => {
      const s = st.current
      const dt = Math.min(32, t - s.lastT) / 1000
      s.lastT = t
      // Weighted: almost no drag, so it coasts and the bounces do the work.
      s.vx *= Math.pow(0.35, dt)
      s.vy *= Math.pow(0.35, dt)
      s.x += s.vx * dt
      s.y += s.vy * dt
      const maxX = window.innerWidth - DROP
      const maxY = window.innerHeight - DROP
      const hit = (speed: number) => speed > 900 && splat(s.x, s.y, speed)
      if (s.x < 0) {
        s.x = 0
        hit(Math.abs(s.vx))
        s.vx = -s.vx * 0.62
      }
      if (s.x > maxX) {
        s.x = maxX
        hit(Math.abs(s.vx))
        s.vx = -s.vx * 0.62
      }
      if (s.y < 0) {
        s.y = 0
        hit(Math.abs(s.vy))
        s.vy = -s.vy * 0.62
      }
      if (s.y > maxY) {
        s.y = maxY
        hit(Math.abs(s.vy))
        s.vy = -s.vy * 0.62
      }
      draw()
      if (Math.hypot(s.vx, s.vy) > 12) s.raf = requestAnimationFrame(step)
    },
    [splat],
  )

  useEffect(() => {
    const home = DROP_HOMES.find((h) => route.startsWith(h.prefix)) ?? { x: 0.94, y: 0.42 }
    const s = st.current
    cancelAnimationFrame(s.raf)
    s.x = (window.innerWidth - DROP) * home.x
    s.y = (window.innerHeight - DROP) * home.y
    s.vx = 0
    s.vy = 0
    draw()
    return () => cancelAnimationFrame(s.raf)
  }, [route])

  return (
    <>
      {splats.map((s) => (
        <span
          key={s.id}
          className="ink-splat"
          style={{
            left: `${s.x}px`,
            top: `${s.y}px`,
            transform: `rotate(${s.rot}deg) scale(${s.scale})`,
          }}
        />
      ))}
      <div
        className="ink-drop"
        ref={ref}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          const s = st.current
          cancelAnimationFrame(s.raf)
          s.vx = 0
          s.vy = 0
          s.gx = e.clientX - s.x
          s.gy = e.clientY - s.y
          s.lastT = performance.now()
        }}
        onPointerMove={(e) => {
          const s = st.current
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
          const now = performance.now()
          const dt = Math.max(8, now - s.lastT)
          const nx = e.clientX - s.gx
          const ny = e.clientY - s.gy
          s.vx = ((nx - s.x) / dt) * 1000
          s.vy = ((ny - s.y) / dt) * 1000
          s.x = nx
          s.y = ny
          s.lastT = now
          draw()
        }}
        onPointerUp={() => {
          const s = st.current
          s.lastT = performance.now()
          s.raf = requestAnimationFrame(step)
        }}
      />
    </>
  )
}

export function Fidgets({ route }: { route: string }) {
  return (
    <>
      <Drawer route={route} />
      <Peel />
      <Stamp />
      <InkDrop route={route} />
    </>
  )
}
