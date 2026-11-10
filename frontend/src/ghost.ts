import type { Task, WishlistItem } from './types'
import { bestMatch, findDate } from './localParse'
import { localDateStr } from './dates'

/**
 * Ghost text for the entry bar: the few words the entry is statistically
 * about to gain, offered grey inside the box and spliced in on Tab.
 *
 * This is a predictor, not a parser - it only has to be right often enough to
 * be faster than typing, and its coverage is deliberately the handful of
 * command shapes the app hears daily: pushing a late sidequest forward, the
 * "push everything due X to Y" bulk move, dating a `task:` entry, and moving a
 * wish across kinds. Each rule keys on the *last word typed* plus what live
 * state the body names, which is what makes "chem lab due" read as "tomorrow"
 * only when "chem lab" is really overdue. A wrong prediction costs nothing -
 * it disappears the next keystroke - so the measure of failure is noise, not
 * data, and the list stays short.
 */

const SLOTS = new Set(['due', 'by', 'to', 'on', 'before'])

const COMMAND_WORDS = new Set(['reschedule', 'push', 'move', 'delay', 'postpone', 'defer'])

// "albums" is the default kind for a moved wish - it can be typed over.
const FIRST_WISH_KIND = 'albums'

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function token(w: string): string {
  return w.replace(/^[^a-z0-9:-]+|[^a-z0-9:-]+$/gi, '').toLowerCase()
}

function dayAfter(date: string): string {
  const d = new Date(date + 'T12:00:00')
  d.setDate(d.getDate() + 1)
  return localDateStr(d)
}

function weekdayOf(date: string): number {
  return new Date(date + 'T12:00:00').getDay()
}

/** The word that means "this has started going late": the day after today. */
function forward(): string {
  return 'tomorrow'
}

/** The task the entry is addressing. The query is the k words ending just
 *  before the trigger word, longest window first: an entry that names
 *  something already tracked - exactly or by prefix, loose like `bestMatch`
 *  on purpose, because this is guessing intent, not deciding whether the
 *  entry updates anything. */
function tailTask(tokens: string[], end: number, tasks: Task[]): Task | null {
  let partial: Task | null = null
  const maxK = Math.min(4, end)
  for (let k = maxK; k >= 1; k--) {
    const q = tokens
      .slice(end - k, end)
      .map(token)
      .join(' ')
    if (!q) continue
    const hit = bestMatch(tasks, q)
    if (!hit) continue
    if (hit.title.trim().toLowerCase() === q) return hit
    if (!partial) partial = hit
  }
  return partial
}

function bodyWish(hay: string, wishes: WishlistItem[]): WishlistItem | null {
  const lower = hay.toLowerCase()
  let best: WishlistItem | null = null
  let bestLen = 0
  for (const w of wishes) {
    const t = w.title.trim().toLowerCase()
    if (t && t.length > bestLen && lower.includes(t)) {
      best = w
      bestLen = t.length
    }
  }
  return best
}

/** The words after the last command word - the name being acted on, when a
 *  command is present at all. */
function commandName(raw: string[], lows: string[]): string | null {
  for (let i = lows.length - 1; i >= 0; i--) {
    if (COMMAND_WORDS.has(lows[i])) {
      const rest = raw
        .slice(i + 1)
        .map(token)
        .join(' ')
        .trim()
      return rest || null
    }
  }
  return null
}

export function ghostFor(
  raw: string,
  today: string,
  tasks: Task[],
  wishes: WishlistItem[],
): string | null {
  const open = tasks.filter((t) => t.status !== 'done')
  const openWishes = wishes.filter((w) => !w.resolved_at)

  let body = raw.trim()
  const lower = body.toLowerCase()
  if (lower.startsWith('wish:')) return null
  const forced = lower.startsWith('task:')
  if (forced) body = body.slice(5)
  else if (lower.startsWith('/')) body = body.slice(1)
  body = body.trim()

  const tokens = body.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const lows = tokens.map(token)
  const last = lows[lows.length - 1]

  const commandish = lows.some((w) => COMMAND_WORDS.has(w))
  const everything = lows.includes('everything')
  const slot = SLOTS.has(last)
  // The trigger word itself is excluded from the tail search - it belongs to
  // the date slot, the same way `localParse` strips a lead-in from a title.
  const ctx = slot ? tailTask(tokens, tokens.length - 1, open) : null
  const wish = bodyWish(body, openWishes)
  // The "push everything due ... to ..." chain, chunk by chunk. The bare
  // "push" only offers the guide's bulk shape when it is the whole entry -
  // "vertical push" is a workout, not a command.
  if (last === 'push' && lows.length === 1) return 'everything '
  if (commandish && everything) {
    if (last === 'everything') return 'due '
    if (last === 'due') return 'today '
    if (last === 'to') {
      // Follow the guide's example - due tomorrow to the next weekday over.
      const source = findDate(tokens.slice(Math.max(0, tokens.length - 7), tokens.length - 1), today)
      return source ? WEEKDAYS[weekdayOf(dayAfter(source.date))] : forward()
    }
    // A source day just landed (today/tomorrow/a weekday); ask where to.
    if (!slot && findDate([last], today)) return 'to '
  }

  // A date slot. "due" is sidequest grammar; "to" and friends are only safe
  // to predict in a command sentence or against something already tracked.
  if (slot) {
    if (ctx) {
      const due = ctx.due_date
      // Overdue, or due today, means push it forward - the commonest thing
      // to want. A future date is a person's choice; no guessing there.
      if (due && due <= today) return forward()
      return null
    }
    if (last === 'to' && wish && commandish) return FIRST_WISH_KIND
    if (forced || commandish) return forward()
    return null
  }

  // Right after a title: a command wants its date, a late sidequest wants
  // its "due". Either way the next word is known before it is typed.
  const name = commandName(tokens, lows)
  if (name) {
    const hit = bestMatch(open, name)
    if (hit && hit.title.trim().toLowerCase() === name) return ` to ${forward()}`
    const w = openWishes.find((x) => x.title.trim().toLowerCase() === name)
    if (w) return ` to ${FIRST_WISH_KIND}`
  }

  if (!commandish) {
    const q = lows.join(' ')
    const hit = bestMatch(open, q)
    if (hit && hit.title.trim().toLowerCase() === q) {
      const due = hit.due_date
      if (due && due <= today) return ' due'
    }
  }

  return null
}
