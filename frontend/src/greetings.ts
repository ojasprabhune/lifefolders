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
  "the internet will still be here tomorrow",
  "you're not thinking clearly right now",
  "whatever it is, it can wait",
  "close the laptop",
  "tomorrow-you is begging",
  "this is the third 'one more'",
  "your bed, unused, is right there",
  "sleep debt has interest",
  "midnight ideas are usually bad",
  "log it and go",
  "you always regret this at 7am",
  "quit scrolling, ojas",
  "the day is over. let it be.",
  "goodnight means goodnight",
  "this is when the bad decisions live",
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

// Per-domain lines under each panel title. Same idea as the entry greeting,
// same reason for living in the browser rather than coming from a model.
const QUIPS: Record<string, string[]> = {
  tasks: [
    'locked in right?',
    "what's actually due?",
    "you said you'd do these",
    'future you is watching',
    'pick one. just one.',
    "the list doesn't shrink itself",
    'start with the ugly one',
    "you're closer than it looks",
    "quests don't clear themselves",
    'deadlines are suggestions, right?',
    'one down beats none started',
    'stop reading, start doing',
    'half of these are five minutes',
    'the hard one first, coward',
  ],
  soma: [
    "where's the lean bulk?",
    'the gym is still there',
    'protein? be honest.',
    'you skipped legs again',
    "gains don't log themselves",
    'one set beats zero',
    'go outside and move',
    "your body called, it's bored",
    "the bar isn't heavy today",
    'rest days are not rest weeks',
  ],
  cadence: [
    'drink some water. now.',
    'did you make the bed?',
    'streaks break quietly',
    'consistency beats intensity, allegedly',
    'you were doing so well',
    'small things, every day',
    "don't break it today",
    'the chain is watching',
    'yesterday you: disappointed',
    'brush your teeth, champ',
    'showing up is the whole trick',
    'a bad day still counts',
    'prove me wrong today',
    'two days off is a pattern',
  ],
  music: [
    "what's on repeat?",
    'still that one album?',
    'found anything good?',
    'rate something, coward',
    'your taste is a work in progress',
    'silence is also a choice',
    'put something on',
  ],
  places: [
    'been anywhere new?',
    'the world is bigger than your room',
    'go somewhere with a door',
    'the same three spots, huh',
    'new coffee shop? no?',
  ],
  travel: [
    'where to next?',
    'the map is mostly empty',
    'book something, eventually',
    'wanderlust is not a plan',
  ],
  learning: [
    'learned anything today?',
    "the pdf won't read itself",
    'curiosity, but scheduled',
    'one chapter. that is it.',
    'you bookmarked it. now read it.',
  ],
  sleep: [
    "how'd last night treat you?",
    'sleep is not optional',
    'the bed misses you',
    "you can't out-caffeine this",
    'eight hours is a rumor, apparently',
    'the ring does not lie',
  ],
  wishlist: [
    'still want it?',
    'wanting is free',
    'cross one off already',
    'the list is patient, you are not',
  ],
}

export function pickQuip(domain: string): string {
  const pool = QUIPS[domain] ?? []
  if (pool.length === 0) return ''
  const key = `lf-quip-${domain}`
  const last = (() => {
    try {
      return localStorage.getItem(key) ?? ''
    } catch {
      return ''
    }
  })()
  const fresh = pool.filter((q) => q !== last)
  const pick = fresh[Math.floor(Math.random() * fresh.length)]
  try {
    localStorage.setItem(key, pick)
  } catch {
    // see pickGreeting
  }
  return pick
}
