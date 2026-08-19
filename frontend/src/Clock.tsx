import { useEffect, useState } from 'react'

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

// Corner clock, styled after the big focus-page countdown. Each character
// is keyed by its position and value, so React only remounts the digits
// that actually changed minute-to-minute (or on the hour flip) - that
// remount is what triggers the per-character fade, the same way the
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
