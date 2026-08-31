import { useCallback, useEffect, useRef, useState } from 'react'
import { Drawer, leftFor } from './Drawer'

// A bead of ink with weight. Fling it and it keeps going, bounces off the
// window and slows down; hit an edge hard enough and it leaves a splat that
// dries out. Sits somewhere different on each page.
const DROP = 18
const BALL_R = DROP / 2

// The paddle is always perpendicular to where the cursor is going, so a swipe
// upward presents a flat bar and knocks the ball up. It only shows near the
// ball and only while you are actually moving - a bar trailing the cursor
// across the whole app would be unbearable.
const PADDLE_W = 78
const PADDLE_H = 6
const PADDLE_REACH = 210
const PADDLE_WAKE = 40

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
  const boxRef = useRef<HTMLDivElement>(null)
  const padRef = useRef<HTMLDivElement>(null)
  const [splats, setSplats] = useState<Splat[]>([])
  const st = useRef({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    gx: 0,
    gy: 0,
    lastT: 0,
    raf: 0,
    parked: false,
    dragging: false,
    // the cursor, its smoothed velocity, and when it last said anything
    px: -999,
    py: -999,
    pvx: 0,
    pvy: 0,
    angle: 0,
    pointerAt: 0,
    lastHit: 0,
  })

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

  // Whether the drop is sitting over the box, and where it would land. Both
  // are read off live rects rather than kept in state: this runs every frame
  // of a drag, and the only thing that has to change is a class.
  const overBox = () => {
    const box = boxRef.current
    if (!box) return null
    const r = box.getBoundingClientRect()
    const cx = st.current.x + BALL_R
    const cy = st.current.y + BALL_R
    if (cx < r.left - 14 || cx > r.right + 14 || cy < r.top - 22 || cy > r.bottom + 14) return null
    return { x: r.left + r.width / 2 - BALL_R, y: r.bottom - DROP - 4 }
  }

  const park = (at: { x: number; y: number }) => {
    const s = st.current
    s.x = at.x
    s.y = at.y
    s.vx = 0
    s.vy = 0
    s.parked = true
    ref.current?.classList.add('parked')
    boxRef.current?.classList.add('full')
    boxRef.current?.classList.remove('over')
    draw()
  }

  const unpark = () => {
    st.current.parked = false
    ref.current?.classList.remove('parked')
    boxRef.current?.classList.remove('full')
  }

  const stepRef = useRef<(t: number) => void>(() => {})

  const kick = useCallback(() => {
    const s = st.current
    if (s.raf) return
    s.lastT = performance.now()
    s.raf = requestAnimationFrame((t) => stepRef.current(t))
  }, [])

  // A hit is decided in the bar's own frame - how far along the bar the ball
  // sits, and how far off it - rather than by rectangle overlap, because the
  // bar swings as you turn and a box would catch the ball on its wrong side.
  const paddleHit = (t: number) => {
    const s = st.current
    if (s.dragging || t - s.lastHit < 90) return
    const speed = Math.hypot(s.pvx, s.pvy)
    if (speed < PADDLE_WAKE) return
    const bx = s.x + BALL_R
    const by = s.y + BALL_R
    if (Math.hypot(bx - s.px, by - s.py) > PADDLE_REACH) return

    const dx = Math.cos(s.angle)
    const dy = Math.sin(s.angle)
    const nx = -dy
    const ny = dx
    const rx = bx - s.px
    const ry = by - s.py
    const lateral = rx * dx + ry * dy
    const along = rx * nx + ry * ny
    const reach = BALL_R + PADDLE_H / 2 + 4
    if (Math.abs(lateral) > PADDLE_W / 2 + BALL_R || Math.abs(along) > reach) return

    const side = along >= 0 ? 1 : -1
    s.x = s.px + dx * lateral + nx * side * reach - BALL_R
    s.y = s.py + dy * lateral + ny * side * reach - BALL_R
    // Reflect what the ball was already doing, then hand it the swing. That
    // second term is why a fast swipe sends it and a slow one only nudges.
    const vn = s.vx * nx + s.vy * ny
    s.vx -= 1.5 * vn * nx
    s.vy -= 1.5 * vn * ny
    const push = Math.min(speed, 2800) * 0.85
    s.vx += (s.pvx / speed) * push
    s.vy += (s.pvy / speed) * push
    s.lastHit = t
    if (s.parked) unpark()
  }

  stepRef.current = (t: number) => {
    const s = st.current
    s.raf = 0
    const dt = Math.min(32, t - s.lastT) / 1000
    s.lastT = t

    if (!s.dragging && !s.parked) {
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
    }

    // A cursor that stopped moving sends no more events, so the bar has to be
    // put away from in here or it hangs on screen wherever it was left.
    if (t - s.pointerAt > 220) {
      s.pvx = 0
      s.pvy = 0
      padRef.current?.classList.remove('up')
    }

    paddleHit(t)
    draw()

    // Keep going while the ball has somewhere to be, or while the cursor is
    // still swinging at it. Idle costs nothing - the loop simply stops.
    if (Math.hypot(s.vx, s.vy) > 12 || t - s.pointerAt < 400) kick()
  }

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const s = st.current
      const now = performance.now()
      const dt = Math.max(8, now - s.pointerAt)
      if (s.px > -900) {
        // Smoothed, or the bar snaps through a right angle every time the
        // cursor jitters between two frames.
        const vx = ((e.clientX - s.px) / dt) * 1000
        const vy = ((e.clientY - s.py) / dt) * 1000
        s.pvx = s.pvx * 0.55 + vx * 0.45
        s.pvy = s.pvy * 0.55 + vy * 0.45
      }
      s.px = e.clientX
      s.py = e.clientY
      s.pointerAt = now

      const speed = Math.hypot(s.pvx, s.pvy)
      if (speed > PADDLE_WAKE) s.angle = Math.atan2(s.pvy, s.pvx) + Math.PI / 2
      const near =
        !s.dragging &&
        speed > PADDLE_WAKE &&
        Math.hypot(s.x + BALL_R - s.px, s.y + BALL_R - s.py) < PADDLE_REACH
      const pad = padRef.current
      if (pad) {
        pad.style.transform = `translate(${s.px - PADDLE_W / 2}px, ${s.py - PADDLE_H / 2}px) rotate(${s.angle}rad)`
        pad.classList.toggle('up', near)
      }
      if (near) kick()
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [kick])

  useEffect(() => {
    const s = st.current
    cancelAnimationFrame(s.raf)
    s.raf = 0
    s.vx = 0
    s.vy = 0
    if (s.parked) {
      // The box sits beside the drawer, which moves from page to page, so a
      // parked drop has to be put back into it once the new one has laid out.
      requestAnimationFrame(() => {
        const at = boxRef.current?.getBoundingClientRect()
        if (at) park({ x: at.left + at.width / 2 - BALL_R, y: at.bottom - DROP - 4 })
      })
      return () => cancelAnimationFrame(s.raf)
    }
    const home = DROP_HOMES.find((h) => route.startsWith(h.prefix)) ?? { x: 0.94, y: 0.42 }
    s.x = (window.innerWidth - DROP) * home.x
    s.y = (window.innerHeight - DROP) * home.y
    draw()
    return () => cancelAnimationFrame(s.raf)
  }, [route])

  return (
    <>
      <div className="ball-box" ref={boxRef} style={{ left: `calc(${leftFor(route)}% - 158px)` }} />
      <div className="paddle" ref={padRef} />
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
          // Without this the drag selects whatever text it passes over.
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          const s = st.current
          cancelAnimationFrame(s.raf)
          s.raf = 0
          s.vx = 0
          s.vy = 0
          s.dragging = true
          s.gx = e.clientX - s.x
          s.gy = e.clientY - s.y
          s.lastT = performance.now()
          unpark()
          padRef.current?.classList.remove('up')
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
          boxRef.current?.classList.toggle('over', overBox() !== null)
        }}
        onPointerUp={() => {
          const s = st.current
          s.dragging = false
          const at = overBox()
          if (at) {
            park(at)
            return
          }
          boxRef.current?.classList.remove('over')
          kick()
        }}
      />
    </>
  )
}

export function Fidgets({ route }: { route: string }) {
  return (
    <>
      <Drawer route={route} />
      <InkDrop route={route} />
    </>
  )
}
