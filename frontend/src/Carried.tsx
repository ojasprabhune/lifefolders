import { useEffect, useRef, type ReactNode } from 'react'

// Something knocked off the shelf and left on the floor, and the drag that
// puts it back. Its slot stays exactly where it was and only goes invisible,
// which is what makes the snap trivial: home is where its own transform is
// zero, so how far it is from home is only how far it has been carried.
export type Spot = {
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

// Everything about where it is lives in one inline transform written by hand
// rather than in state: this is a drag, and the clock that uses it would
// otherwise re-render its own ticking face sixty times a second.
export function Carried({
  spot,
  className,
  label,
  onHome,
  children,
}: {
  spot: Spot
  className: string
  label: string
  onHome: () => void
  children?: ReactNode
}) {
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
      put(spot.dx, spot.dy + 3, spot.rot * 1.15, DROP_MS, 'cubic-bezier(.45,0,.95,.5)'),
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
      className={className}
      style={{ left: spot.left, top: spot.top, width: spot.w, height: spot.h }}
      aria-label={label}
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
        if (Math.hypot(s.x, s.y) < SNAP_NEAR) {
          put(0, 0, 0, SNAP_MS, 'cubic-bezier(.3,1.4,.4,1)')
          window.setTimeout(onHome, SNAP_MS)
          return
        }
        put(s.x, spot.dy, spot.rot, DROP_MS, 'cubic-bezier(.45,0,.95,.5)')
      }}
    >
      {children}
    </div>
  )
}
