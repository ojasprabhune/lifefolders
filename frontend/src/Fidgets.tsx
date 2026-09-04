import { useCallback, useEffect, useRef, useState } from 'react'
import { FallenBook, pageFor, type Fallen, type Phase } from './Book'
import { Carried, type Spot } from './Carried'
import { Clock, FallenClock } from './Clock'

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

// Thrown home. Gravity is exaggerated so the hop is short and reads as a toss
// across the room rather than a lob over a building.
const THROW_G = 2600

// The shelf is furniture, not scenery. The plank, the books, the pot and the
// clock all turn the ball back - softer than the window does, and a little of
// whatever it had along the surface goes with it.
const SOLID_BOUNCE = 0.52
const SOLID_RUB = 0.86
// Loud enough that the thing hit ought to react to it.
const KNOCK_SPEED = 240
// The shelf only moves when the window does, or when a book falls off it.
const SOLIDS_STALE_MS = 400

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

// An arc with a destination: solved once at the throw, then only read.
type Fly = {
  t0: number
  dur: number
  x0: number
  y0: number
  vx: number
  vy: number
  tx: number
  ty: number
}

function InkDrop({
  route,
  boxRef,
  spill,
  settle,
}: {
  route: string
  boxRef: React.RefObject<HTMLDivElement | null>
  spill: React.RefObject<(speed: number, what: Toppled) => void>
  settle: React.RefObject<() => void>
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
    // the throw home, and whether the cursor is over the box - where the
    // paddle gives way to a real pointer, because the box is a thing you click
    fly: null as Fly | null,
    atBox: false,
  })

  // The box's rect, cached. It is read on every pointer move to decide whether
  // the paddle is out, and measuring a fixed element sixty times a second is a
  // forced layout for something that only moves when the window does.
  const boxRect = useRef<DOMRect | null>(null)
  const syncBox = useCallback(() => {
    const r = boxRef.current?.getBoundingClientRect()
    boxRect.current = r && r.width ? r : null
  }, [boxRef])

  // Everything on the shelf the ball can hit. Found by selector rather than
  // handed down as refs: the book on the floor deliberately sits outside
  // .shelf - the shelf's stacking context would paint an open spread under the
  // ball - so there is no one element all of these live inside.
  const solids = useRef<{ el: Element; r: DOMRect }[]>([])
  const solidsAt = useRef(0)
  const syncSolids = useCallback(() => {
    solidsAt.current = performance.now()
    const found = document.querySelectorAll(
      '.shelf-plank, .shelf .book:not(.gone), .shelf .plant:not(.gone), .shelf .pst-clock:not(.gone), .book-fallen, .clock-fallen, .plant-fallen',
    )
    solids.current = Array.from(found)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((o) => o.r.width > 0)
  }, [])

  // A book landing on the ball leaves it inside a book, and the ball may have
  // come to rest, in which case nothing is running to push it out. The shelf
  // calls this once the books have finished falling; one frame sorts it out.
  settle.current = () => {
    syncSolids()
    if (!st.current.parked && !st.current.dragging) kick()
  }

  // The plank is left alone - it is what the books are standing on, and a
  // shelf that flinches out from under them shows daylight. So is the book on
  // the floor: its resting place is the end of its own falling animation, and
  // a second animation would throw that away.
  const knock = (el: Element) => {
    if (el.classList.contains('shelf-plank') || el.classList.contains('book-fallen')) return
    // The clock on the floor is where its own inline transform put it, and a
    // shudder keyframe would override that and stand it back on the shelf.
    if (el.classList.contains('clock-fallen')) return
    if (el.classList.contains('struck')) return
    el.classList.add('struck')
    window.setTimeout(() => el.classList.remove('struck'), 480)
  }

  const draw = () => {
    if (ref.current) ref.current.style.transform = `translate(${st.current.x}px, ${st.current.y}px)`
  }

  // The paddle is out exactly when the ball is, and the real cursor is hidden
  // for as long as it is: two pointers on screen doing the same job reads as a
  // bug. Put the ball in its box and the cursor comes back.
  const showPaddle = () => {
    const s = st.current
    const on = !s.parked && !s.dragging && !s.atBox
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
    s.fly = null
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

  // Where in the box a ball ends up. Null when there is no box on screen at
  // all, which is the narrow window where the shelf is hidden.
  const boxSpot = () => {
    const r = boxRef.current?.getBoundingClientRect()
    if (!r || !r.width) return null
    return { x: r.left + r.width / 2 - BALL_R, y: r.bottom - DROP - 4 }
  }

  const stepRef = useRef<(t: number) => void>(() => {})

  const kick = useCallback(() => {
    const s = st.current
    if (s.raf) return
    s.lastT = performance.now()
    s.raf = requestAnimationFrame((t) => stepRef.current(t))
  }, [])

  // Thrown home rather than teleported. The flight time is picked first and
  // the velocity that lands the ball in the box at the end of it falls out of
  // the arithmetic, so the arc ends on the box from wherever it started and
  // always comes down into it rather than up at it.
  const launch = () => {
    const s = st.current
    const at = boxSpot()
    if (!at || s.parked || s.dragging) return
    const dist = Math.hypot(at.x - s.x, at.y - s.y)
    let dur = Math.min(1.05, 0.42 + dist / 1400)
    let vy = (at.y - s.y) / dur - 0.5 * THROW_G * dur
    // Keep the top of the arc on screen: a ball that leaves the window reads
    // as deleted rather than thrown. A shorter flight is a flatter one.
    while (dur > 0.34 && vy < 0 && s.y - (vy * vy) / (2 * THROW_G) < 12) {
      dur -= 0.06
      vy = (at.y - s.y) / dur - 0.5 * THROW_G * dur
    }
    s.fly = {
      t0: performance.now(),
      dur,
      x0: s.x,
      y0: s.y,
      vx: (at.x - s.x) / dur,
      vy,
      tx: at.x,
      ty: at.y,
    }
    kick()
  }

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
    if (s.dragging || s.parked || s.fly || s.atBox || t - s.lastHit < 60) return
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

    // A throw ignores everything else - no drag, no walls, no paddle. It is
    // on rails to the box and the only question is whether it has landed.
    const f = s.fly
    if (f) {
      const e = (t - f.t0) / 1000
      if (e >= f.dur) {
        park({ x: f.tx, y: f.ty })
        boxRef.current?.classList.add('caught')
        window.setTimeout(() => boxRef.current?.classList.remove('caught'), 380)
        return
      }
      s.x = f.x0 + f.vx * e
      s.y = f.y0 + f.vy * e + 0.5 * THROW_G * e * e
      draw()
      kick()
      return
    }

    if (!s.dragging && !s.parked) {
      // Weighted: almost no drag, so it coasts and the bounces do the work.
      s.vx *= Math.pow(0.35, dt)
      s.vy *= Math.pow(0.35, dt)
      if (t - solidsAt.current > SOLIDS_STALE_MS) syncSolids()

      const maxX = window.innerWidth - DROP
      const maxY = window.innerHeight - DROP
      const walls = () => {
        let worst = 0
        if (s.x < 0) {
          s.x = 0
          worst = Math.abs(s.vx)
          s.vx = -s.vx * 0.62
        } else if (s.x > maxX) {
          s.x = maxX
          worst = Math.abs(s.vx)
          s.vx = -s.vx * 0.62
        }
        if (s.y < 0) {
          s.y = 0
          worst = Math.max(worst, Math.abs(s.vy))
          s.vy = -s.vy * 0.62
        } else if (s.y > maxY) {
          s.y = maxY
          worst = Math.max(worst, Math.abs(s.vy))
          s.vy = -s.vy * 0.62
        }
        return worst
      }

      // Pushed out along whichever side it is least far in. A spine is five
      // pixels wide, so which face it came through is not a question worth
      // asking - the nearest way out is the way it came.
      const furniture = () => {
        let worst = 0
        for (const o of solids.current) {
          const r = o.r
          if (s.x + DROP <= r.left || s.x >= r.right) continue
          if (s.y + DROP <= r.top || s.y >= r.bottom) continue
          const l = s.x + DROP - r.left
          const rt = r.right - s.x
          const u = s.y + DROP - r.top
          const d = r.bottom - s.y
          const least = Math.min(l, rt, u, d)
          let speed: number
          if (least === l || least === rt) {
            speed = Math.abs(s.vx)
            s.x = least === l ? r.left - DROP : r.right
            s.vx = (least === l ? -1 : 1) * speed * SOLID_BOUNCE
            s.vy *= SOLID_RUB
          } else {
            speed = Math.abs(s.vy)
            s.y = least === u ? r.top - DROP : r.bottom
            s.vy = (least === u ? -1 : 1) * speed * SOLID_BOUNCE
            s.vx *= SOLID_RUB
          }
          if (speed > KNOCK_SPEED) knock(o.el)
          if (o.el.classList.contains('book')) spill.current(speed, 'book')
          else if (o.el.classList.contains('pst-clock')) spill.current(speed, 'clock')
          else if (o.el.classList.contains('plant')) spill.current(speed, 'plant')
          worst = Math.max(worst, speed)
        }
        return worst
      }

      // Stepped fine enough that the ball cannot cross a book between two
      // frames: a swing hands it ninety pixels a frame, and a spine is five
      // pixels wide, so testing only where it ends up is a tunnel rather than
      // a collision.
      const n = Math.min(40, Math.max(1, Math.ceil((Math.hypot(s.vx, s.vy) * dt) / 4)))
      const h = dt / n
      let worst = 0
      for (let i = 0; i < n; i++) {
        s.x += s.vx * h
        s.y += s.vy * h
        worst = Math.max(worst, walls(), furniture())
      }
      if (worst > 900) splat(s.x, s.y, worst)
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
      // Over the box the paddle stands down and the real cursor comes back:
      // the box is something you click, and clicking needs a pointer to aim
      // with. Padded, so the swap happens just before you are on it.
      const r = boxRect.current
      s.atBox =
        !!r &&
        e.clientX > r.left - 8 &&
        e.clientX < r.right + 8 &&
        e.clientY > r.top - 10 &&
        e.clientY < r.bottom + 8

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

  // Clicking the box throws the ball into it from wherever it is, which is
  // also how you get the cursor back without having to carry it there.
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onClick = () => launch()
    box.addEventListener('click', onClick)
    return () => box.removeEventListener('click', onClick)
  }, [boxRef])

  // The cached box rect only goes stale when the window does.
  useEffect(() => {
    const sync = () => {
      syncBox()
      syncSolids()
    }
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [syncBox, syncSolids])

  useEffect(() => {
    const s = st.current
    cancelAnimationFrame(s.raf)
    s.raf = 0
    s.vx = 0
    s.vy = 0
    s.fly = null
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
        syncBox()
        const at = boxSpot()
        if (at) park(at)
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
          s.fly = null
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

// The shelf, bottom left. The clock is the alarm clock at the end of the
// plank, taking whatever width the books and the box leave it. The books are
// the badge colours off the timeline, and one of them falls off now and then.

// Every so often a book gives up and lands on the floor. Same shape as the
// drawer's leak this replaces: a coin flipped every ten seconds rather than a
// timer, so it is never on the beat, and never twice inside a minute.
const DROP_CHECK_MS = 10000
const DROP_CHANCE = 0.22
const DROP_COOLDOWN_MS = 60000
// Where a book lying on the floor rests, measured from the bottom of the
// window - the floor is the bottom edge, not the underside of the shelf.
const FLOOR = 16
const READS_KEY = 'life_books_read'
// Open, then held open, then shut. The whole visit is over in four seconds.
const OPEN_MS = 420
const HOLD_MS = 3000
const CLOSE_MS = 280
const RETURN_MS = 520
// How far a book tips into the gap left by the one that fell.
const TIP = 11
// How far past the end of the plank each of these lands, so they do not come
// down on top of each other or on the books.
const PLANT_OUT = 18
const CLOCK_OUT = 58
// Hit something harder than this and it goes over. Measured at the impact
// rather than at the release, and against pointer moves at a real mouse's
// rate: a lazy toss arrives at about 700, a flick you meant at about 1500.
const SPILL_SPEED = 1200
// How far apart books lie on the floor. Standing they are five pixels wide and
// eight apart; lying down they are the length of a book, and six of them
// dropped where they stood would be one pile.
const SPILL_GAP = 31

const BOOKS: { domain: string; h: number; w: number; lean?: number }[] = [
  { domain: 'music', h: 24, w: 6 },
  { domain: 'task', h: 20, w: 5 },
  { domain: 'food', h: 26, w: 6 },
  { domain: 'gym', h: 18, w: 4 },
  { domain: 'trip', h: 23, w: 6 },
  { domain: 'learning', h: 19, w: 5, lean: -14 },
]

type Down = Fallen & { phase: Phase }

type Toppled = 'book' | 'clock' | 'plant'

// The plant, twice: standing in its slot and lying on the floor.
const LEAVES = (
  <>
    <i className="leaf a" />
    <i className="leaf b" />
    <i className="leaf c" />
    <i className="pot" />
  </>
)

function Shelf({
  route,
  showClock,
  boxRef,
  spill,
  settle,
}: {
  route: string
  showClock: boolean
  boxRef: React.RefObject<HTMLDivElement | null>
  spill: React.RefObject<(speed: number, what: Toppled) => void>
  settle: React.RefObject<() => void>
}) {
  const [down, setDown] = useState<Down[]>([])
  const [clock, setClock] = useState<Spot | null>(null)
  const [plant, setPlant] = useState<Spot | null>(null)
  const bookRefs = useRef<(HTMLSpanElement | null)[]>([])
  const reads = useRef(Number(localStorage.getItem(READS_KEY) ?? 0))
  const lastDrop = useRef(Date.now())
  const timers = useRef<number[]>([])

  const gone = new Set(down.map((b) => b.i))

  // Knocking books onto the floor. One at a time it lands about where it
  // stood; a whole shelf has to be laid out along the floor, because lying
  // down a book is as long as it was tall and six of them dropped in place
  // would be a single pile.
  const fall = (idx: number[]) => {
    const found = idx
      .map((i) => ({ i, el: bookRefs.current[i] }))
      .filter((b): b is { i: number; el: HTMLSpanElement } => !!b.el)
      .map((b) => ({ ...b, r: b.el.getBoundingClientRect() }))
      .filter((b) => b.r.width > 0)
    if (!found.length) return
    lastDrop.current = Date.now()
    // Long enough for the last of them to have landed. A book that comes down
    // on the ball leaves it inside a book until something tells it to look.
    timers.current.push(window.setTimeout(() => settle.current(), 1500))
    const many = found.length > 1
    const base = found[0].r.left
    // The pages are worked out before the books fall, not when you open one:
    // the backend sleeps, and three seconds is not long enough to wait for it.
    void Promise.all(found.map(() => pageFor(route, reads.current))).then((texts) => {
      setDown((cur) => [
        ...cur,
        ...found.map((b, k) => ({
          i: b.i,
          order: k,
          phase: 'floor' as Phase,
          color: getComputedStyle(b.el).backgroundColor,
          left: b.r.left,
          top: b.r.top,
          w: b.r.width,
          h: b.r.height,
          dx: many
            ? base + k * SPILL_GAP - b.r.left + (Math.random() * 9 - 4)
            : 6 + Math.random() * 20,
          rot: 90 + (Math.random() * 8 - 4),
          // It keeps its standing geometry and is turned onto its side, so
          // where it lands is worked out against the centre it rotates about
          // rather than against its box, which is a different shape by the
          // time it stops.
          dy: window.innerHeight - FLOOR - (b.r.top + b.r.height / 2 + b.r.width / 2),
          text: texts[k],
        })),
      ])
    })
  }

  // Mounted once, through a ref. An effect with no dependency list tears its
  // own interval down on every render, and this renders more often than it
  // polls - which is how the drawer this replaces ended up never leaking.
  const dropRef = useRef(() => {})
  dropRef.current = () => {
    if (down.length) return
    if (Date.now() - lastDrop.current < DROP_COOLDOWN_MS) return
    if (Math.random() > DROP_CHANCE) return
    fall([Math.floor(Math.random() * BOOKS.length)])
  }

  // The ball, hitting something hard enough. Reassigned every render for the
  // same reason the poll is: it has to see what is still standing.
  spill.current = (speed: number, what: Toppled) => {
    if (speed < SPILL_SPEED) return
    if (what === 'clock') return clock ? undefined : knockOff('.shelf .pst-clock', CLOCK_OUT, 5 + Math.random() * 6, setClock)
    if (what === 'plant') return plant ? undefined : knockOff('.shelf .plant', PLANT_OUT, 82 + Math.random() * 16, setPlant)
    const standing = BOOKS.map((_, i) => i).filter((i) => !gone.has(i))
    if (standing.length < 2) return
    fall(standing)
  }

  // Off the end of the plank rather than straight down, and each to its own
  // spot, so a shelf that has lost everything is not one heap. The books lie
  // along the floor under where they stood, so both of these clear the shelf.
  const knockOff = (sel: string, out: number, rot: number, set: (s: Spot) => void) => {
    const el = document.querySelector(sel)
    const r = el?.getBoundingClientRect()
    if (!r || !r.width) return
    const shelf = el!.closest('.shelf')!.getBoundingClientRect()
    set({
      left: r.left,
      top: r.top,
      w: r.width,
      h: r.height,
      dx: shelf.right + out - r.left,
      // Turned onto its side, a tall thing is shorter than its box: without
      // this the plant lies hovering above the floor by half the difference.
      dy:
        window.innerHeight -
        FLOOR -
        (r.top + r.height) +
        (Math.abs(rot) > 45 ? (r.height - r.width) / 2 : 0),
      rot,
    })
    timers.current.push(window.setTimeout(() => settle.current(), 900))
  }

  useEffect(() => {
    const t = window.setInterval(() => dropRef.current(), DROP_CHECK_MS)
    return () => {
      window.clearInterval(t)
      timers.current.forEach(window.clearTimeout)
    }
  }, [])

  const open = (i: number) => {
    const n = reads.current + 1
    reads.current = n
    localStorage.setItem(READS_KEY, String(n))
    const set = (phase: Phase) => setDown((cur) => cur.map((b) => (b.i === i ? { ...b, phase } : b)))
    set('open')
    timers.current.push(
      window.setTimeout(() => set('closing'), OPEN_MS + HOLD_MS),
      window.setTimeout(() => set('back'), OPEN_MS + HOLD_MS + CLOSE_MS),
      window.setTimeout(
        () => setDown((cur) => cur.filter((b) => b.i !== i)),
        OPEN_MS + HOLD_MS + CLOSE_MS + RETURN_MS,
      ),
    )
  }

  // One spread at a time. Six books on the floor is an invitation to click
  // them all at once, and they all open in the same corner.
  const busy = down.some((b) => b.phase !== 'floor')

  // The gap stays open the whole time a book is away - its slot keeps its
  // width and only goes invisible - and whatever is standing beside it tips
  // in. A book with a gap on both sides has nothing to lean on and stays put.
  const tipOf = (idx: number) => {
    if (gone.has(idx)) return 0
    const right = gone.has(idx + 1)
    const left = gone.has(idx - 1)
    if (right === left) return 0
    return right ? TIP : -TIP
  }

  // The books leave the shelf in the DOM too, not just visually: .shelf sets a
  // z-index, and anything inside it is stuck in that stacking context - the
  // open spread would have been painted under the ball.
  return (
    <>
      <div className="shelf">
        <div className="shelf-top">
          {BOOKS.map((b, i) => (
            <span
              key={i}
              ref={(el) => {
                bookRefs.current[i] = el
              }}
              className={`book${gone.has(i) ? ' gone' : ''}`}
              style={{
                ['--c' as string]: `var(--${b.domain})`,
                height: `${b.h}px`,
                width: `${b.w}px`,
                ['--lean' as string]: `${(b.lean ?? 0) + tipOf(i)}deg`,
              }}
            />
          ))}
          <span className={`plant${plant ? ' gone' : ''}`}>{LEAVES}</span>
          <div className="ball-box" ref={boxRef} />
          {showClock && <Clock gone={!!clock} />}
        </div>
        <div className="shelf-plank" />
      </div>
      {down.map((b) => (
        <FallenBook key={b.i} fallen={b} phase={b.phase} onOpen={() => !busy && open(b.i)} />
      ))}
      {showClock && clock && <FallenClock spot={clock} onHome={() => setClock(null)} />}
      {plant && (
        <Carried
          spot={plant}
          className="plant plant-fallen"
          label="the plant is on the floor, drag it back onto the shelf"
          onHome={() => setPlant(null)}
        >
          {LEAVES}
        </Carried>
      )}
    </>
  )
}

// Has to stay in step with the shelf's own breakpoint in styles.css. Below it
// the shelf empties down to the clock, which means there is no box for the ball
// to sit in - and the ball, finding none, unparked itself and went to live
// loose on the page, with an invisible paddle chasing a cursor that phones do
// not have. The whole toy comes out instead.
const SHELF_HIDDEN = '(max-width: 540px)'

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(SHELF_HIDDEN).matches)
  useEffect(() => {
    const mq = window.matchMedia(SHELF_HIDDEN)
    const onChange = () => setNarrow(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return narrow
}

export function Fidgets({ route, showClock }: { route: string; showClock: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null)
  // The ball telling the shelf it hit a book hard. A ref rather than state:
  // these are siblings, and nothing about the hit belongs in a render.
  const spill = useRef<(speed: number, what: Toppled) => void>(() => {})
  // And the shelf telling the ball the floor has changed under it.
  const settle = useRef<() => void>(() => {})
  const narrow = useNarrow()
  return (
    <>
      <Shelf route={route} showClock={showClock} boxRef={boxRef} spill={spill} settle={settle} />
      {!narrow && <InkDrop route={route} boxRef={boxRef} spill={spill} settle={settle} />}
    </>
  )
}
