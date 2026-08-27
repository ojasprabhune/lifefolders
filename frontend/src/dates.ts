// Deadlines read as days, not dates. "2026-08-31" makes you find today on the
// clock and subtract; "monday" doesn't. Everything here is local-midnight
// anchored, so the today/tomorrow boundaries land where the calendar says.

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function daysUntil(dateStr: string): number {
  const d = new Date(dateStr + 'T00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.ceil((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

// A bare weekday repeats every 7 days, so anything a week or more out has to
// carry the date too or "friday" is a guess.
function dayAndDate(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00')
    .toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    .toLowerCase()
    .replace(',', '')
}

function weekday(dateStr: string): string {
  return DAY_NAMES[new Date(dateStr + 'T00:00').getDay()]
}

function upcoming(days: number, dateStr: string): string {
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days < 7) return weekday(dateStr)
  return dayAndDate(dateStr)
}

// How a deadline reads right now, overdue included. For anything still open.
export function dueLabel(dateStr: string): string {
  const days = daysUntil(dateStr)
  if (days === -1) return 'yesterday'
  if (days < -1) return `${-days} days late`
  return upcoming(days, dateStr)
}

// Which day something falls on, without ever calling it late - a finished
// sidequest or a ticked-off checkpoint isn't overdue, it's just in the past.
export function dayLabel(dateStr: string): string {
  const days = daysUntil(dateStr)
  if (days === -1) return 'yesterday'
  if (days < -1) return days > -7 ? weekday(dateStr) : dayAndDate(dateStr)
  return upcoming(days, dateStr)
}
