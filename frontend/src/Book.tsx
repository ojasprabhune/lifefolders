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

// True lines about wherever you are. Several per page, because there is only
// one oldest sidequest and one last night's sleep - asked the same question
// every time, the book kept saying the same sentence. Null on any failure: the
// backend sleeps, and a book that says something else is better than a book
// that says an error.
async function factsFor(route: string): Promise<string[]> {
  try {
    if (route.startsWith('#/tasks')) {
      const tasks = await listTasks()
      const open = tasks.filter((t) => t.status !== 'done')
      if (!open.length) return ['no open sidequests. suspicious.']
      const now = today()
      const lines = [`${open.length} sidequests open. the book is not one of them.`]
      const oldest = open.reduce((a, b) => (a.created_at < b.created_at ? a : b))
      const age = daysSince(oldest.created_at)
      if (age >= 4) lines.push(`"${oldest.title}" has been waiting ${age} days.`)
      const late = open.filter((t) => t.due_date && t.due_date < now).length
      if (late) lines.push(`${late} of them are already late. no comment.`)
      const soon = open.filter((t) => t.due_date === now).length
      if (soon) lines.push(`${soon} due today. this is a book, not a reminder.`)
      const going = open.filter((t) => t.status === 'in_progress').length
      if (going) lines.push(`${going} started, ${open.length - going} still theoretical.`)
      const exams = open.filter((t) => t.is_exam).length
      if (exams) lines.push(exams === 1 ? 'one exam in there. you know the one.' : `${exams} exams in there.`)
      const loose = open.filter((t) => !t.due_date).length
      if (loose) lines.push(`${loose} with no due date. free, in a way.`)
      const swept = tasks.filter((t) => t.completed_at?.startsWith(now)).length
      if (swept) lines.push(`${swept} crossed off today. the page approves.`)
      return lines
    }

    if (route.startsWith('#/sleep')) {
      const nights = await listSleep()
      const slept = nights.filter((l) => (l.data as SleepData).duration_min)
      if (!slept.length) return ['no nights logged. bold.']
      const mins = slept.slice(0, 7).map((l) => (l.data as SleepData).duration_min as number)
      const last = mins[0]
      const lines = [`${Math.floor(last / 60)}h ${last % 60}m, the last night you told me about.`]
      if (mins.length >= 3) {
        const avg = Math.round(mins.reduce((a, b) => a + b, 0) / mins.length)
        lines.push(`${Math.floor(avg / 60)}h ${avg % 60}m a night lately, on average.`)
        const worst = Math.min(...mins)
        if (worst < 360) lines.push(`the short one this week was ${Math.floor(worst / 60)}h ${worst % 60}m.`)
      }
      lines.push(`${slept.length} nights on the record.`)
      return lines
    }

    const spot = ROUTE_CATEGORY.find((r) => route.startsWith(r.prefix))
    const logs = await listLogs(today(), spot ? spot.category : 'all')
    if (!logs.length) {
      return [spot ? `nothing in ${spot.label} today.` : 'nothing logged today. the page matches.']
    }
    const lines = [`the last thing you told me: "${logs[0].raw_input}"`]
    if (logs.length > 1) {
      lines.push(`${logs.length} things logged today${spot ? `, in ${spot.label}` : ''}.`)
      lines.push(`you opened today with: "${logs[logs.length - 1].raw_input}"`)
    }
    return lines
  } catch {
    return []
  }
}

let lastPage: string | null = null
let lastFact: string | null = null

// Never the line the book said last time, whichever page it came from.
function freshFact(lines: string[]): string | null {
  const fresh = lines.filter((l) => l !== lastFact)
  if (!fresh.length) return null
  const line = fresh[Math.floor(Math.random() * fresh.length)]
  lastFact = line
  return line
}

// A live line is the rarer half of the pool on purpose: there are fifty pages
// and only a handful of true things to say, so an even split reads as the book
// only ever talking about your sidequests.
const FACT_CHANCE = 0.28

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
  if (Math.random() < FACT_CHANCE) {
    const fact = freshFact(await factsFor(route))
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
