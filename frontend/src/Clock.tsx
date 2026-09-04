import { useEffect, useRef, useState } from 'react'

const FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

// hour12 still forces an AM/PM marker onto the formatted string by default -
// pull the hour/minute parts out directly instead of formatting to a string,
// so it reads as a plain "2:07" with no AM/PM.
function pstTime(): string {
  const parts = FORMAT.formatToParts(new Date())
  const hour = parts.find((p) => p.type === 'hour')!.value
  const minute = parts.find((p) => p.type === 'minute')!.value
  return `${hour}:${minute}`
}

function useClockTime(): string {
  const [time, setTime] = useState(pstTime)
  useEffect(() => {
    const id = setInterval(() => setTime(pstTime()), 1000)
    return () => clearInterval(id)
  }, [])
  return time
}

// Each character is keyed by its position and value, so React only remounts
// the digits that actually changed minute-to-minute (or on the hour flip) -
// that remount is what triggers the per-character fade, the same way the
// iPhone lock screen clock only animates the digit that ticked over. The colon
// is its own case: it blinks on a two-second cycle, which is most of what
// makes a clock read as one.
function Face({ time }: { time: string }) {
  return (
    <>
      <i className="pst-clock-buttons" />
      <div className="pst-clock-screen">
        {[...time].map((ch, i) => (
          <span key={`${i}-${ch}`} className={`pst-clock-char${ch === ':' ? ' colon' : ''}`}>
            {ch === ' ' ? ' ' : ch}
          </span>
        ))}
      </div>
    </>
  )
}

// The alarm clock on the shelf: a case with buttons on top and feet on the
// plank, and a lit screen inside it. Knocked off, its slot stays where it was
// and only goes invisible, the same as a book's - the clock takes whatever
// width the rest of the shelf leaves, so a slot that closed up would move
// everything else along with it.
export function Clock({ gone }: { gone?: boolean }) {
  const time = useClockTime()
  return (
    <div className={`pst-clock${gone ? ' gone' : ''}`} aria-label={`${time} Pacific time`}>
      <Face time={time} />
    </div>
  )
}

export type ClockSpot = {
  left: number
  top: number
  w: number
  h: number
  dx: number
  dy: number
  rot: number
}

const DROP_MS = 330
const SETTLE_MS = 220
const SNAP_MS = 280
// How near its slot you have to let go for it to count as putting it back.
const SNAP_NEAR = 110

// The clock on the floor, and the drag that puts it back. Everything about
// where it is lives in one inline transform written by hand rather than in
// state: this is a drag, and a clock that re-rendered on every pointer move
// would re-render its own ticking face sixty times a second.
export function FallenClock({ spot, onHome }: { spot: ClockSpot; onHome: () => void }) {
  const time = useClockTime()
  const ref = useRef<HTMLDivElement>(null)
  const st = useRef({ x: 0, y: 0, gx: 0, gy: 0, dragging: false })

  const put = (x: number, y: number, rot: number, ms: number, ease: string) => {
    const el = ref.current
    if (!el) return
    st.current.x = x
    st.current.y = y
    el.style.transition = ms ? `transform ${ms}ms ${ease}` : 'none'
    el.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg)`
  }

  // The fall, in two moves: down fast, then a short settle onto the floor.
  // Transitions rather than keyframes, because the drag takes the transform
  // over the moment it lands and a finished animation would go on overriding
  // whatever the drag writes.
  useEffect(() => {
    const a = requestAnimationFrame(() =>
      put(spot.dx, spot.dy + 3, spot.rot * 1.7, DROP_MS, 'cubic-bezier(.45,0,.95,.5)'),
    )
    const b = window.setTimeout(
      () => put(spot.dx, spot.dy, spot.rot, SETTLE_MS, 'cubic-bezier(.3,1.4,.5,1)'),
      DROP_MS,
    )
    return () => {
      cancelAnimationFrame(a)
      window.clearTimeout(b)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={ref}
      className="pst-clock clock-fallen"
      style={{ left: spot.left, top: spot.top, width: spot.w, height: spot.h }}
      aria-label={`${time} Pacific time - the clock is on the floor, drag it back onto the shelf`}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        const s = st.current
        s.dragging = true
        s.gx = e.clientX - s.x
        s.gy = e.clientY - s.y
        e.currentTarget.classList.add('held')
        // It levels out in your hand rather than staying at the angle it fell.
        put(s.x, s.y, 0, 150, 'ease-out')
      }}
      onPointerMove={(e) => {
        const s = st.current
        if (!s.dragging) return
        put(e.clientX - s.gx, e.clientY - s.gy, 0, 0, '')
      }}
      onPointerUp={(e) => {
        const s = st.current
        if (!s.dragging) return
        s.dragging = false
        e.currentTarget.classList.remove('held')
        // Its slot is where its own transform is zero, so how far it is from
        // home is just how far it has been carried.
        if (Math.hypot(s.x, s.y) < SNAP_NEAR) {
          put(0, 0, 0, SNAP_MS, 'cubic-bezier(.3,1.4,.4,1)')
          window.setTimeout(onHome, SNAP_MS)
          return
        }
        put(s.x, spot.dy, spot.rot, DROP_MS, 'cubic-bezier(.45,0,.95,.5)')
      }}
    >
      <Face time={time} />
    </div>
  )
}
