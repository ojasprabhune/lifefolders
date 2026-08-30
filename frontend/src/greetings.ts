// The placeholder in the entry line. Picked in the browser rather than from a
// model: the backend sleeps between visits, and a greeting that shows up three
// seconds after the page does is worse than no greeting at all.

const ANY = [
  "what's on your mind?",
  "what's going on?",
  "what's up?",
  "what's new?",
  "what happened?",
  "what's the word?",
  "what's crackalackin?",
  "how's it rockin?",
  "talk to me",
  "tell me something",
  "go ahead",
  "log it",
  "put it here",
  "anything at all",
  "spill it",
  "how's it going, ojas?",
  "you got this",
  "you got this, bro",
  "one thing at a time",
  "still going, nice",
  "proud of you, keep it up",
  "small stuff counts too",
  "write it before you forget",
  "what did you do?",
  "what's the story?",
  "give me the update",
  "how are we feeling?",
  "what are we doing?",
  "hit me",
  "no wrong answers",
  "even the boring stuff",
  "say less, log more",
  "let's get it down",
  "anything worth keeping?",
  "what'd i miss?",
]

const MORNING = [
  "good morning, ojas",
  "morning, ojas",
  "morning. how'd you sleep?",
  "how'd last night go?",
  "coffee yet?",
  "big day?",
  "what's first today?",
  "let's start something",
  "up early, respect",
  "new day, fresh page",
  "what's the plan?",
  "slow start is fine",
  "make it a good one",
  "breakfast counts",
  "one thing to get done today?",
  "rise and log",
]

const MIDDAY = [
  "how's the day going?",
  "lunch happen?",
  "halfway there",
  "still with me?",
  "what's gotten done?",
  "quick check in",
  "anything so far?",
  "keep it moving",
  "how's it holding up?",
  "afternoon stretch",
  "eat something",
  "what's next?",
]

const AFTER_SCHOOL = [
  "how was school?",
  "how'd class go?",
  "you survived",
  "how'd it go today?",
  "made it out",
  "school's out, what's up?",
  "anything good happen?",
  "how was the day?",
  "worth logging?",
  "snack, then work",
  "take a breath first",
  "what's left for tonight?",
]

const EVENING = [
  "how'd today go?",
  "evening, ojas",
  "what'd you get done?",
  "wrapping up?",
  "dinner counts",
  "long day?",
  "how'd it end up?",
  "anything left?",
  "wind it down",
  "good day or nah?",
  "what's tomorrow look like?",
  "you did enough today",
  "log it before bed",
]

const LATE_NIGHT = [
  "time to sleep",
  "it's late, ojas",
  "still up?",
  "go to bed",
  "one more, then sleep",
  "sleep is the move",
  "burning it late",
  "last thing before bed?",
  "you can finish tomorrow",
  "seriously, sleep",
  "put it down and rest",
  "the bed is right there",
  "nothing good happens after 1am",
]

const HISTORY_KEY = 'lf-greeting-history'
// Long enough that a phrase doesn't come back for weeks of normal use, short
// enough that it can never eat a whole bucket and leave nothing to pick from.
const HISTORY_MAX = 40

function bucket(hour: number): string[] {
  if (hour >= 23 || hour < 5) return LATE_NIGHT
  if (hour < 11) return MORNING
  if (hour < 15) return MIDDAY
  if (hour < 18) return AFTER_SCHOOL
  return EVENING
}

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

export function pickGreeting(now = new Date()): string {
  const pool = [...bucket(now.getHours()), ...ANY]
  const history = readHistory()
  const fresh = pool.filter((p) => !history.includes(p))
  const from = fresh.length > 0 ? fresh : pool
  const pick = from[Math.floor(Math.random() * from.length)]
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([pick, ...history].slice(0, HISTORY_MAX)))
  } catch {
    // Private mode, full quota - a repeat is not worth failing over.
  }
  return pick
}
