import { localDateStr } from './dates'
import type { TaskWithCheckpoints } from './types'

/**
 * A sidequest read out of a typed entry without asking the model.
 *
 * The point of this file is latency, not cleverness. Four of the fields the
 * backend fills in for a task are already parsed deterministically in Rust
 * rather than by the LLM (`#tag`, `@time`, `note:`, and a bare duration - see
 * `tasks.rs`), so for those this is a straight port and the two cannot
 * disagree. What is left is the title, the due date and the exam flag, and a
 * date phrase is ordinary grammar. So an entry that is unmistakably a
 * sidequest can be rendered in full before the request has left the browser,
 * and the server's answer is a confirmation rather than the first thing you
 * see.
 *
 * `parseTaskEntry` returns null unless it is certain, and the caller falls
 * back to the plain pending row. Being wrong here means showing a row of the
 * wrong shape and correcting it a second later, which is worse than waiting.
 */
export interface LocalTask {
  title: string
  category: string
  due_date: string | null
  due_time: string | null
  effort_minutes: number | null
  is_exam: boolean
  note: string | null
}

const DAY_ALIASES: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
}

// What makes a dated entry a sidequest rather than something else that happens
// to mention a day. Deliberately a closed list of schoolwork and deadline
// words rather than a list of things to rule out: "dinner with sarah friday"
// has to fall through to the model, and no deny-list ever finishes.
const TASK_WORDS = new Set([
  'exam', 'exams', 'test', 'tests', 'quiz', 'quizzes', 'midterm', 'midterms',
  'final', 'finals', 'hw', 'homework', 'essay', 'essays', 'worksheet',
  'worksheets', 'pset', 'psets', 'assignment', 'assignments', 'writeup',
  'draft', 'presentation', 'project', 'paper', 'lab', 'labs', 'due',
  'deadline', 'submit', 'submission', 'turnin',
])

// Same words, same word-boundary rule, as `looks_like_exam` in tasks.rs.
const EXAM_WORDS = ['exam', 'test', 'quiz', 'midterm']

const UNIT_WORDS = new Set(['h', 'hr', 'hrs', 'hour', 'hours', 'm', 'min', 'mins', 'minute', 'minutes'])

function isNumber(w: string): boolean {
  return w.length > 0 && /^[0-9.]+$/.test(w) && /[0-9]/.test(w)
}

// A duration written as one word: "40min", "1hr", "2h30". A word that merely
// ends in digits is not one - "ps5" and "1968" have to survive.
function isGluedDuration(w: string): boolean {
  const digits = /^[0-9.]*/.exec(w)?.[0] ?? ''
  if (!digits) return false
  const rest = w.slice(digits.length)
  return UNIT_WORDS.has(rest) || (rest.startsWith('h') && isNumber(rest.slice(1)))
}

/** Port of `tasks::effort_from_text`. */
export function effortFromText(s: string): number | null {
  const lower = s.toLowerCase()
  let total = 0
  let found = false
  let afterHours = false
  let i = 0
  const digit = (c: string) => c >= '0' && c <= '9'
  while (i < lower.length) {
    if (!digit(lower[i])) {
      // Only whitespace may sit between "2h" and its "30".
      if (!/\s/.test(lower[i])) afterHours = false
      i += 1
      continue
    }
    const start = i
    while (i < lower.length && (digit(lower[i]) || lower[i] === '.')) i += 1
    const n = Number(lower.slice(start, i))
    if (!Number.isFinite(n)) {
      afterHours = false
      continue
    }
    let j = i
    while (j < lower.length && lower[j] === ' ') j += 1
    const unitStart = j
    while (j < lower.length && /[a-z]/.test(lower[j])) j += 1
    const unit = lower.slice(unitStart, j)
    if (unit.startsWith('hr') || unit === 'h' || unit.startsWith('hour')) {
      total += n * 60
      found = true
      afterHours = true
      i = j
    } else if (unit === 'm' || unit.startsWith('min')) {
      total += n
      found = true
      afterHours = false
      i = j
    } else if (afterHours && unit === '') {
      total += n
      afterHours = false
    }
  }
  const minutes = Math.round(total)
  // A whole day of work in one sidequest is a typo, not an estimate.
  return found && minutes > 0 && minutes <= 16 * 60 ? minutes : null
}

function noteMarker(s: string): number {
  return s.toLowerCase().indexOf('note:')
}

function explicitCategory(raw: string): string | null {
  for (const w of raw.split(/\s+/)) {
    if (!w.startsWith('#')) continue
    const tag = w.slice(1).replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '').toLowerCase()
    if (tag) return tag
  }
  return null
}

function parseFlexibleTime(s: string): string | null {
  const cleaned = s.replace(/^[^a-z0-9:]+|[^a-z0-9:]+$/gi, '').toLowerCase()
  const m = /^([0-9]{1,2})(?::([0-9]{2}))?(?::[0-9]{2})?(am|pm)?$/.exec(cleaned)
  if (!m) return null
  let hour = Number(m[1])
  const minute = Number(m[2] ?? '0')
  const suffix = m[3]
  if (suffix) {
    if (hour < 1 || hour > 12) return null
    if (suffix === 'pm' && hour !== 12) hour += 12
    if (suffix === 'am' && hour === 12) hour = 0
  } else if (hour > 23 || m[2] === undefined) {
    // Bare "3" with no colon and no am/pm is a number, not a time - chrono's
    // formats all require one or the other.
    return null
  }
  if (minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function explicitTime(raw: string): string | null {
  for (const w of raw.split(/\s+/)) {
    if (!w.startsWith('@')) continue
    const t = parseFlexibleTime(w.slice(1))
    if (t) return t
  }
  return null
}

function shift(today: string, days: number): string {
  const d = new Date(today + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return localDateStr(d)
}

function weekdayOf(dateStr: string): number {
  return new Date(dateStr + 'T12:00:00').getDay()
}

// The nearest occurrence on or after today: "due friday" said on a friday
// morning means today, which is how people say it. "next friday" is the same
// search made strict, so on a friday it moves you a week rather than nowhere.
function nextWeekday(today: string, target: number, strict: boolean): string {
  const from = weekdayOf(today)
  let delta = (target - from + 7) % 7
  if (delta === 0 && strict) delta = 7
  return shift(today, delta)
}

function monthDay(today: string, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const year = Number(today.slice(0, 4))
  const make = (y: number) => {
    const d = new Date(y, month - 1, day)
    // Rejects "feb 30", which JS would roll forward into march.
    return d.getMonth() === month - 1 ? localDateStr(d) : null
  }
  const thisYear = make(year)
  if (!thisYear) return null
  // A month already behind us is next year's - "jan 12" typed in september.
  return thisYear >= today ? thisYear : make(year + 1)
}

type DateHit = { date: string; from: number; to: number }

/**
 * Find a due date in a list of words, and say which words it used so they can
 * be taken back out of the title. A phrase led into by "due"/"by"/"on" wins
 * over a bare one anywhere else in the entry; failing that the last hit does,
 * since a deadline is normally the tail of the sentence.
 */
function findDate(words: string[], today: string): DateHit | null {
  const lead = new Set(['due', 'by', 'on', 'before'])
  const hits: DateHit[] = []
  let consumed = -1
  const push = (date: string | null, from: number, to: number) => {
    if (!date) return
    hits.push({ date, from, to })
    // A phrase swallows the words it used. Without this the bare "friday"
    // inside "next friday" matches on its own, wins as the later hit, and
    // leaves "next" sitting in the title.
    consumed = to
  }

  for (let i = 0; i < words.length; i++) {
    if (i <= consumed) continue
    const w = words[i].replace(/^[^a-z0-9/-]+|[^a-z0-9/-]+$/gi, '').toLowerCase()
    const next = (words[i + 1] ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()
    const after = (words[i + 2] ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()

    if (w === 'today' || w === 'tonight' || w === 'tonite') push(today, i, i)
    else if (w === 'tomorrow' || w === 'tmrw' || w === 'tmr' || w === 'tmw' || w === 'tomo') {
      push(shift(today, 1), i, i)
    } else if (w === 'yesterday') push(shift(today, -1), i, i)
    else if (w === 'next' && next === 'week') push(shift(today, 7), i, i + 1)
    else if (w === 'next' && DAY_ALIASES[next] !== undefined) {
      push(nextWeekday(today, DAY_ALIASES[next], true), i, i + 1)
    } else if ((w === 'this' || w === 'coming') && DAY_ALIASES[next] !== undefined) {
      push(nextWeekday(today, DAY_ALIASES[next], false), i, i + 1)
    } else if (w === 'in' && isNumber(next) && /^(day|days|week|weeks)$/.test(after)) {
      const n = Number(next)
      push(shift(today, after.startsWith('week') ? n * 7 : n), i, i + 2)
    } else if (w === 'in' && (next === 'a' || next === 'one') && after === 'week') {
      push(shift(today, 7), i, i + 2)
    } else if (DAY_ALIASES[w] !== undefined) {
      push(nextWeekday(today, DAY_ALIASES[w], false), i, i)
    } else if (MONTHS[w] !== undefined && isNumber(next)) {
      push(monthDay(today, MONTHS[w], Number(next)), i, i + 1)
    } else if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(w)) {
      push(w, i, i)
    } else {
      const slash = /^([0-9]{1,2})\/([0-9]{1,2})(?:\/[0-9]{2,4})?$/.exec(w)
      if (slash) push(monthDay(today, Number(slash[1]), Number(slash[2])), i, i)
    }
  }

  if (hits.length === 0) return null
  const led = hits.find((h) => h.from > 0 && lead.has(words[h.from - 1].toLowerCase()))
  return led ?? hits[hits.length - 1]
}

/** Port of `tasks::strip_markers`, plus the date phrase, which the model
 *  normally leaves out of the title on its own. */
function stripMarkers(words: string[], skip: (i: number) => boolean): string {
  const out: string[] = []
  let i = 0
  while (i < words.length) {
    if (skip(i)) {
      i += 1
      continue
    }
    const w = words[i]
    const lower = w.toLowerCase()
    if (w.startsWith('#') || w.startsWith('@') || isGluedDuration(lower)) {
      i += 1
      continue
    }
    // A bare number is only a duration when the word after it is a unit,
    // which is what keeps "read 30 pages" intact.
    if (isNumber(lower) && UNIT_WORDS.has((words[i + 1] ?? '').toLowerCase())) {
      i += 2
      continue
    }
    out.push(w)
    i += 1
  }
  return out.join(' ')
}

function looksLikeExam(title: string): boolean {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => EXAM_WORDS.includes(w))
}

function categoryFor(words: string[]): string {
  const set = new Set(words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, '')))
  if (set.has('project') || set.has('presentation')) return 'project'
  for (const w of TASK_WORDS) if (set.has(w)) return 'homework'
  return 'other'
}

/** Port of `tasks::best_match`, so the decision to skip an entry here is the
 *  same decision the server would make about updating rather than creating. */
export function bestMatch(
  items: TaskWithCheckpoints[],
  query: string,
): TaskWithCheckpoints | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  let best: { item: TaskWithCheckpoints; score: number } | null = null
  for (const item of items) {
    const n = item.title.trim().toLowerCase()
    const score = n === q ? 2 : n.includes(q) || q.includes(n) ? 1 : 0
    if (score === 0) continue
    if (!best || score > best.score) best = { item, score }
  }
  return best?.item ?? null
}

export function parseTaskEntry(
  raw: string,
  today: string,
  openTasks: TaskWithCheckpoints[],
): LocalTask | null {
  const trimmed = raw.trim()
  // A command acts on things that already exist and a wish is its own domain;
  // both are the server's to work out.
  if (trimmed.startsWith('/') || trimmed.toLowerCase().startsWith('wish:')) return null

  const forced = trimmed.toLowerCase().startsWith('task:')
  const body = forced ? trimmed.slice(5).trim() : trimmed
  if (!body) return null

  const idx = noteMarker(body)
  const head = idx === -1 ? body : body.slice(0, idx)
  const note = idx === -1 ? null : body.slice(idx + 5).trim() || null

  // Category and time are read from the whole entry, effort from the head
  // only - a duration after "note:" is time already spent. Same split as
  // `explicit_category` / `explicit_effort`.
  const tag = explicitCategory(body)
  const dueTime = explicitTime(body)
  const effort = effortFromText(head)

  const words = head.split(/\s+/).filter(Boolean)
  const hit = findDate(words, today)
  const taskish = words.some((w) => TASK_WORDS.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')))
  if (!forced && !tag && !(hit && taskish)) return null

  const skipFrom = hit ? hit.from : -1
  const skipTo = hit ? hit.to : -1
  // The lead-in belongs to the date, not the title: "essay due friday" is an
  // essay, and "essay due" reads like an unfinished sentence.
  const leadIn =
    hit && hit.from > 0 && ['due', 'by', 'on', 'before'].includes(words[hit.from - 1].toLowerCase())
      ? hit.from - 1
      : -1
  const title = stripMarkers(words, (i) => i === leadIn || (i >= skipFrom && i <= skipTo)).trim()
  if (!title) return null

  // An entry that names something already open is an update, and which fields
  // an update touches - and whether a note appends or replaces - is the
  // server's decision. Only creates are shown ahead of it.
  if (bestMatch(openTasks, title)) return null

  return {
    title,
    category: tag ?? categoryFor(words),
    due_date: hit?.date ?? null,
    due_time: dueTime,
    effort_minutes: effort,
    is_exam: looksLikeExam(title),
    note,
  }
}
