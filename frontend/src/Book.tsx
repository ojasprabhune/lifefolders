import { listLogs, listSleep, listTasks } from './api'
import { COUNTED, PAGES, pickNot } from './remarks'
import type { Category, SleepData } from './types'

const ROUTE_CATEGORY: { prefix: string; category: Category; label: string }[] = [
  { prefix: '#/music', category: 'music', label: 'music' },
  { prefix: '#/soma', category: 'workout', label: 'soma' },
  { prefix: '#/places', category: 'place', label: 'places' },
  { prefix: '#/travel', category: 'trip', label: 'travel' },
  { prefix: '#/learning', category: 'learning', label: 'learning' },
  { prefix: '#/cadences', category: 'cadence_completion', label: 'cadences' },
  { prefix: '#/wishlist', category: 'wishlist', label: 'the wishlist' },
]

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
}

// One true line about wherever you are. Null on any failure - the backend
// sleeps, and a book that says something else is better than a book that
// says an error.
async function factFor(route: string): Promise<string | null> {
  try {
    if (route.startsWith('#/tasks')) {
      const tasks = await listTasks()
      const open = tasks.filter((t) => t.status !== 'done')
      if (!open.length) return 'no open sidequests. suspicious.'
      const oldest = open.reduce((a, b) => (a.created_at < b.created_at ? a : b))
      const age = daysSince(oldest.created_at)
      if (age < 2) return `${open.length} sidequests open, all of them fresh.`
      return `${open.length} open. "${oldest.title}" has been waiting ${age} days.`
    }

    if (route.startsWith('#/sleep')) {
      const nights = await listSleep()
      const last = nights.find((l) => (l.data as SleepData).duration_min)
      if (!last) return 'no nights logged. bold.'
      const min = (last.data as SleepData).duration_min as number
      return `${Math.floor(min / 60)}h ${min % 60}m, the last night you told me about.`
    }

    const spot = ROUTE_CATEGORY.find((r) => route.startsWith(r.prefix))
    const logs = await listLogs(today(), spot ? spot.category : 'all')
    if (!logs.length) {
      return spot ? `nothing in ${spot.label} today.` : 'nothing logged today. the page matches.'
    }
    return `the last thing you told me: "${logs[0].raw_input}"`
  } catch {
    return null
  }
}

let lastPage: string | null = null

// What is on the page, worked out before the book falls rather than when you
// open it: the backend sleeps, and a book that is open for three seconds
// cannot spend two of them fetching.
export async function pageFor(route: string, reads: number): Promise<string> {
  const nonsense = () => {
    const line = pickNot(PAGES, lastPage)
    lastPage = line
    return line
  }
  // The count stays out of it until pulling books off the shelf is clearly a
  // habit rather than a thing that happened to you.
  if (reads >= 25 && Math.random() < 0.3) {
    return COUNTED[Math.floor(Math.random() * COUNTED.length)](reads)
  }
  if (Math.random() < 0.45) {
    const fact = await factFor(route)
    // Whatever you typed can be any length; a page cannot.
    if (fact) return fact.length > 250 ? `${fact.slice(0, 249).trimEnd()}…` : fact
  }
  return nonsense()
}

// A page holds about a hundred characters at reading size. Past that the text
// runs across the spread the way it would in a real book, and past that again
// the type gets smaller rather than the words getting cut.
function pages(text: string): [string, string] {
  if (text.length <= 96) return ['', text]
  const mid = Math.floor(text.length / 2)
  const at = text.lastIndexOf(' ', mid)
  const cut = at > 20 ? at : mid
  return [text.slice(0, cut), text.slice(cut).trimStart()]
}

export type Fallen = {
  i: number
  color: string
  left: number
  top: number
  w: number
  h: number
  dx: number
  dy: number
  text: string
}

// On the floor, or on its way back up. The open spread is a different thing
// entirely - a book this size cannot become a page spread, so the one hands
// over to the other rather than morphing into it.
export type Phase = 'floor' | 'open' | 'closing' | 'back'

export function FallenBook({
  fallen,
  phase,
  onOpen,
}: {
  fallen: Fallen
  phase: Phase
  onOpen: () => void
}) {
  const [left, right] = pages(fallen.text)
  const style = {
    left: `${fallen.left}px`,
    top: `${fallen.top}px`,
    width: `${fallen.w}px`,
    height: `${fallen.h}px`,
    background: fallen.color,
    ['--dx' as string]: `${fallen.dx}px`,
    ['--dy' as string]: `${fallen.dy}px`,
  }

  return (
    <>
      {(phase === 'floor' || phase === 'back') && (
        <button
          className={`book-fallen${phase === 'back' ? ' going-back' : ''}`}
          style={style}
          onClick={phase === 'floor' ? onOpen : undefined}
          aria-label="a book fell off the shelf"
        />
      )}
      {(phase === 'open' || phase === 'closing') && (
        <div
          className={`book-spread${phase === 'closing' ? ' closing' : ''}${
            fallen.text.length > 200 ? ' small' : ''
          }`}
        >
          <div
            className={`book-leaf left${left ? '' : ' ruled'}`}
            style={{ ['--c' as string]: fallen.color }}
          >
            {left && <p>{left}</p>}
          </div>
          <div className="book-leaf right" style={{ ['--c' as string]: fallen.color }}>
            <p>{right}</p>
          </div>
        </div>
      )}
    </>
  )
}
