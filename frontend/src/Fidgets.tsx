import { useCallback, useEffect, useRef, useState } from 'react'
import { Drawer } from './Drawer'

// A bead of ink with weight. Fling it and it keeps going, bounces off the
// window and slows down; hit an edge hard enough and it leaves a splat that
// dries out. Sits somewhere different on each page.
const DROP = 18
const BALL_R = DROP / 2

// The paddle is always perpendicular to where the cursor is going, so a swipe
// upward presents a flat bar and knocks the ball up. It is out for as long as
// the ball is out of its box - the cursor becomes the paddle, and is hidden
// while it is - and it goes away the moment the ball is put back.
const PADDLE_W = 78
const PADDLE_H = 6
// Below this the bar counts as parked, and is a wall rather than a swing.
const PADDLE_STILL = 30

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

function InkDrop({
  route,
  boxRef,
}: {
  route: string
  boxRef: React.RefObject<HTMLDivElement | null>
}) {
  const ref = useRef<HTMLDivElement>(null)
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
    // Starts in its box: a ball loose on the page on every reload is clutter,
    // and taking it out is the whole gesture.
    parked: true,
    dragging: false,
    // the cursor, its smoothed velocity, and when it last said anything
    px: -999,
    py: -999,
    pvx: 0,
    pvy: 0,
    angle: 0,
    pointerAt: 0,
    lastHit: 0,
    // where the cursor was on the previous frame, so a swing that crosses the
    // ball between two frames still catches it
    prevPx: -999,
    prevPy: -999,
  })

  const draw = () => {
    if (ref.current) ref.current.style.transform = `translate(${st.current.x}px, ${st.current.y}px)`
  }

  // The paddle is out exactly when the ball is, and the real cursor is hidden
  // for as long as it is: two pointers on screen doing the same job reads as a
  // bug. Put the ball in its box and the cursor comes back.
  const showPaddle = () => {
    const s = st.current
    const on = !s.parked && !s.dragging
    padRef.current?.classList.toggle('up', on)
    document.documentElement.classList.toggle('paddle-out', on)
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
    showPaddle()
  }

  const unpark = () => {
    st.current.parked = false
    ref.current?.classList.remove('parked')
    boxRef.current?.classList.remove('full')
    showPaddle()
  }

  const stepRef = useRef<(t: number) => void>(() => {})

  const kick = useCallback(() => {
    const s = st.current
    if (s.raf) return
    s.lastT = performance.now()
    s.raf = requestAnimationFrame((t) => stepRef.current(t))
  }, [])

  // Worked out in the bar's own frame - how far along the bar the ball sits,
  // and how far off it - rather than as a rectangle overlap, because the bar
  // swings as you turn and a box would catch the ball on its wrong side.
  //
  // The off-the-bar test is swept, not instantaneous: a fast swipe moves the
  // cursor further between two frames than the ball is wide, and testing only
  // where the bar is now let it pass clean through. The slab from where the
  // bar was to where it is now is what gets tested instead.
  const paddleHit = (t: number) => {
    const s = st.current
    if (s.dragging || s.parked || t - s.lastHit < 60) return
    const bx = s.x + BALL_R
    const by = s.y + BALL_R
    const dx = Math.cos(s.angle)
    const dy = Math.sin(s.angle)
    const lateral = (bx - s.px) * dx + (by - s.py) * dy
    if (Math.abs(lateral) > PADDLE_W / 2 + BALL_R) return
    const reach = BALL_R + PADDLE_H / 2 + 2

    const speed = Math.hypot(s.pvx, s.pvy)
    if (speed > PADDLE_STILL) {
      const mx = s.pvx / speed
      const my = s.pvy / speed
      const ahead = (bx - s.px) * mx + (by - s.py) * my
      const step = Math.hypot(s.px - s.prevPx, s.py - s.prevPy)
      if (ahead > reach || ahead < -(step + reach)) return
      s.x = s.px + dx * lateral + mx * reach - BALL_R
      s.y = s.py + dy * lateral + my * reach - BALL_R
      // Kill whatever the ball was doing into the bar, then hand it the swing.
      const vn = s.vx * mx + s.vy * my
      if (vn < 0) {
        s.vx -= 2 * vn * mx
        s.vy -= 2 * vn * my
      }
      const push = Math.min(speed, 2800) * 0.85
      s.vx += mx * push
      s.vy += my * push
    } else {
      // A bar you are not moving is simply a wall to bounce off.
      const nx = -dy
      const ny = dx
      const along = (bx - s.px) * nx + (by - s.py) * ny
      if (Math.abs(along) > reach) return
      const side = along >= 0 ? 1 : -1
      s.x = s.px + dx * lateral + nx * side * reach - BALL_R
      s.y = s.py + dy * lateral + ny * side * reach - BALL_R
      const vn = s.vx * nx + s.vy * ny
      s.vx -= 1.6 * vn * nx
      s.vy -= 1.6 * vn * ny
    }
    s.lastHit = t
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

    // A cursor that stopped moving sends no more events, so its velocity has
    // to decay from in here or the bar keeps swinging at nothing.
    if (t - s.pointerAt > 200) {
      s.pvx = 0
      s.pvy = 0
    }

    paddleHit(t)
    draw()
    s.prevPx = s.px
    s.prevPy = s.py

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
        s.pvx = s.pvx * 0.74 + vx * 0.26
        s.pvy = s.pvy * 0.74 + vy * 0.26
      }
      s.px = e.clientX
      s.py = e.clientY
      s.pointerAt = now

      if (s.prevPx < -900) {
        s.prevPx = e.clientX
        s.prevPy = e.clientY
      }
      const speed = Math.hypot(s.pvx, s.pvy)
      if (speed > PADDLE_STILL) s.angle = Math.atan2(s.pvy, s.pvx) + Math.PI / 2
      padRef.current?.style.setProperty(
        'transform',
        `translate(${s.px - PADDLE_W / 2}px, ${s.py - PADDLE_H / 2}px) rotate(${s.angle}rad)`,
      )
      showPaddle()
      if (!s.parked && !s.dragging) kick()
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [kick])

  // Whatever happens, the cursor comes back when this unmounts. A hidden
  // cursor left behind by a teardown would be unfixable from the page.
  useEffect(() => () => document.documentElement.classList.remove('paddle-out'), [])

  // Clicking the box puts the ball back, which is also how you get the cursor
  // back without having to carry the ball there.
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onClick = () => {
      const r = box.getBoundingClientRect()
      if (!r.width) return
      const s = st.current
      cancelAnimationFrame(s.raf)
      s.raf = 0
      park({ x: r.left + r.width / 2 - BALL_R, y: r.bottom - DROP - 4 })
    }
    box.addEventListener('click', onClick)
    return () => box.removeEventListener('click', onClick)
  }, [boxRef])

  useEffect(() => {
    const s = st.current
    cancelAnimationFrame(s.raf)
    s.raf = 0
    s.vx = 0
    s.vy = 0
    const home = DROP_HOMES.find((h) => route.startsWith(h.prefix)) ?? { x: 0.94, y: 0.42 }
    const goHome = () => {
      s.x = (window.innerWidth - DROP) * home.x
      s.y = (window.innerHeight - DROP) * home.y
      draw()
    }
    showPaddle()
    if (s.parked) {
      // Waits a frame for the box to have laid out. A window too narrow for
      // the shelf has no box at all, and a ball parked in nothing would sit in
      // the top left corner, so that falls back to the page's own spot.
      requestAnimationFrame(() => {
        const at = boxRef.current?.getBoundingClientRect()
        if (at && at.width) park({ x: at.left + at.width / 2 - BALL_R, y: at.bottom - DROP - 4 })
        else {
          unpark()
          goHome()
        }
      })
      return () => cancelAnimationFrame(s.raf)
    }
    goHome()
    return () => cancelAnimationFrame(s.raf)
  }, [route])

  return (
    <>
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

// The shelf, bottom left, standing just above the clock - and in the same
// place whether the clock is shown or not, so it never moves under you. The
// books are the badge colours off the timeline. The drawer is the cabinet
// below the plank: shut, it sits exactly behind the face, and only its pull
// shows past the right edge.
const BOOKS: { domain: string; h: number; w: number; lean?: number }[] = [
  { domain: 'music', h: 24, w: 6 },
  { domain: 'task', h: 20, w: 5 },
  { domain: 'food', h: 26, w: 6 },
  { domain: 'gym', h: 18, w: 4 },
  { domain: 'trip', h: 23, w: 6 },
  { domain: 'learning', h: 19, w: 5, lean: -14 },
]

function Shelf({ route, boxRef }: { route: string; boxRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div className="shelf">
      <div className="shelf-top">
        {BOOKS.map((b, i) => (
          <span
            key={i}
            className={`book${b.lean ? ' leaning' : ''}`}
            style={{
              ['--c' as string]: `var(--${b.domain})`,
              height: `${b.h}px`,
              width: `${b.w}px`,
              ['--lean' as string]: `${b.lean ?? 0}deg`,
            }}
          />
        ))}
        <span className="plant">
          <i className="leaf a" />
          <i className="leaf b" />
          <i className="leaf c" />
          <i className="pot" />
        </span>
        <div className="ball-box" ref={boxRef} />
        <span className="shelf-gap" />
      </div>
      <div className="shelf-plank" />
      <div className="shelf-seam" />
      <Drawer route={route} />
    </div>
  )
}

export function Fidgets({ route }: { route: string }) {
  const boxRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <Shelf route={route} boxRef={boxRef} />
      <InkDrop route={route} boxRef={boxRef} />
    </>
  )
}
