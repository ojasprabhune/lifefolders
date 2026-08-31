// Everything the toys can say. Kept in one place because the drawer, the
// corner and the stamp all draw from it and the voice has to match.

export const NONSENSE = [
  'the drawer is empty. it was empty before you looked.',
  'nothing. try again the same way and expect something else.',
  'a key. no idea what it opens.',
  "someone else's list: eggs, twine, a small hammer.",
  'one (1) spare hour. non-transferable.',
  'a button that came off something.',
  'half a thought. the other half is in the other drawer.',
  'there is no other drawer.',
  'a paperclip, straightened. someone was thinking hard.',
  'two AA batteries, probably dead.',
  'an olive pit. rude.',
  'a receipt for something you did not buy.',
  'your own handwriting, unreadable.',
  'the sound of a drawer opening, written down.',
  'IOU: one good night of sleep.',
  'a stamp for a country that no longer exists.',
  'lint, mostly.',
  'a screw. it goes to something important.',
  'a mint from a restaurant you did not like.',
  'the drawer would like to be closed now.',
  'nothing here. the good drawer is elsewhere.',
  'a coupon, expired 2019.',
  'one sock. no comment.',
  'a fortune with the fortune torn off.',
  'a dead pen. you will put it back.',
  'the manual for an appliance you no longer own.',
  'a rubber band that snaps if you look at it.',
  'someone wrote "important" on this and nothing else.',
  'a key that is definitely to the old apartment.',
  'this drawer sticks. you know this. you keep opening it.',
  'wrong drawer.',
  'a chopstick. singular.',
  'an allen key for furniture you assembled wrong.',
  'the little plastic thing that keeps bread closed.',
  'a charger for a phone that is gone.',
  'three pennies and a coin from somewhere else.',
  'you again.',
  'nothing new since last time. that was ninety seconds ago.',
  'this is not work.',
  'still not work.',
  'i will keep letting you do this.',
  'a nail. one nail.',
  'a takeout menu for a place that closed.',
  'a warranty card, unsent, for a thing long broken.',
  'a spare key to this drawer, which does not lock.',
  'four thumbtacks and a strong opinion.',
  'the drawer has been asked to be more interesting and has declined.',
]

export const COUNTED = [
  (n: number) => `that is ${n} pulls.`,
  (n: number) => `${n} times now. i do keep count.`,
  (n: number) => `${n}. you have other things to do.`,
  (n: number) => `pull ${n}. the drawer is holding up well.`,
  (n: number) => `${n} and nothing has changed in here.`,
  (n: number) => `${n}. i have started rounding.`,
  (n: number) => `at ${n} pulls i think this is a hobby.`,
  (n: number) => `${n}. the drawer is fine. are you?`,
  (n: number) => `${n} pulls, zero findings.`,
]

export const PEELS = [
  'nothing under here either.',
  'stop that.',
  'you found the corner.',
  'the page underneath is the same page.',
  'careful, it tears.',
  'made you look.',
  'this is load-bearing. probably.',
  'no notes on the back.',
  'the corner would prefer to lie flat.',
  'you are going to wear this out.',
]

export const STAMP_WORDS = [
  'SEEN',
  'NOTED',
  'AGAIN?',
  'FINE',
  'LATE',
  'SURE',
  'HMM',
  'DENIED',
  'PENDING',
  'LOGGED',
  'WHY',
  'NO',
  'ENOUGH',
  'VOID',
]

// Never the same line twice running - the pools are big enough that a repeat
// reads as the thing being broken rather than random.
export function pickNot<T>(list: T[], last: T | null): T {
  if (list.length < 2) return list[0]
  let next = last as T
  while (next === last) next = list[Math.floor(Math.random() * list.length)]
  return next
}
