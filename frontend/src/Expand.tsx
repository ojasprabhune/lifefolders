import { useEffect, useRef, useState, type ReactNode } from 'react'

const CLOSE_MS = 220

// The old technique (grid-template-rows: 0fr/1fr toggled by a class) opens
// fine but Safari doesn't reliably animate the collapse direction - it just
// snaps shut. Measuring the actual content height and transitioning an
// explicit max-height animates both directions consistently everywhere.
export function Expand({ open, children }: { open: boolean; children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  const [render, setRender] = useState(open)

  // Keep the content mounted for the duration of the close transition so
  // there's still something to measure/shrink away from; only unmount once
  // it's fully collapsed.
  useEffect(() => {
    if (open) {
      setRender(true)
      return
    }
    if (!render) return
    const t = setTimeout(() => setRender(false), CLOSE_MS)
    return () => clearTimeout(t)
  }, [open, render])

  useEffect(() => {
    if (!render) return
    setHeight(open ? (innerRef.current?.scrollHeight ?? 0) : 0)
  }, [open, render, children])

  return (
    <div className="expand" style={{ maxHeight: height }}>
      <div className="expand-inner" ref={innerRef}>
        {render && children}
      </div>
    </div>
  )
}
