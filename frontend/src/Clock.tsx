import { useEffect, useState } from 'react'

const FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

function pstTime(): string {
  return FORMAT.format(new Date())
}

// Corner clock, styled after the big focus-page countdown. Each character
// is keyed by its position and value, so React only remounts the digits
// that actually changed minute-to-minute (or on the hour/AM-PM flip) -
// that remount is what triggers the per-character fade, the same way the
// iPhone lock screen clock only animates the digit that ticked over.
export function Clock() {
  const [time, setTime] = useState(pstTime)

  useEffect(() => {
    const id = setInterval(() => setTime(pstTime()), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="pst-clock" aria-label={`${time} Pacific time`}>
      {[...time].map((ch, i) => (
        <span key={`${i}-${ch}`} className="pst-clock-char">
          {ch === ' ' ? ' ' : ch}
        </span>
      ))}
    </div>
  )
}
