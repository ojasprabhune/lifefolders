// Clicking the title reassembles the whole screen. Everything about how that
// looks lives in styles.css under `.assembling`, hung off one class on <html>;
// this file only decides when the class is on. No React state on purpose - the
// pieces that animate are in three separate trees (Home, the sidequests panel,
// the day plan) and none of them needs to re-render to take part.

// Has to outlast the last thing to finish, which is the stamp's own marks at
// the very end. Cut this shorter and pieces lose their animation mid-flight,
// the same coupling `justParsed` has with the row reveals.
const RUN_MS = 10300

// The one part of the sequence that is not a CSS animation: the day strip is
// scrolled by hand, so DueStrip needs to know when its turn is. Keep these in
// step with the strip's own delays in styles.css.
export const STRIP_START_MS = 4300
export const STRIP_RUN_MS = 1400

// When the title leaves the stage for the header - 82% of its 3300ms run, and
// the last moment its landing place can still be measured.
const FLY_AT = 2706

let timer: number | undefined
let startedAt = 0

export function runAssemble() {
  const root = document.documentElement
  // Removing the class and reading layout before adding it back is what lets a
  // second click restart the sequence: a finished animation only re-runs when
  // something about it changes, and the browser has to see the "off" state
  // before it can see the "on" one again.
  root.classList.remove('assembling')
  void root.offsetWidth
  measureTitle(root)
  root.classList.add('assembling')
  startedAt = performance.now()
  window.clearTimeout(timer)
  timer = window.setTimeout(() => root.classList.remove('assembling'), RUN_MS)
  // The click usually changes the route as well, and opening the panel moves
  // Home's whole column - so the reading taken a moment ago is against a layout
  // that is about to stop being true, and the title flies to where the title
  // used to be. Re-read as React commits, and then keep re-reading right up to
  // the last moment before the flight: whatever has settled by FLY_AT is what
  // the word has to land on, and a custom property changed under a running
  // animation does re-resolve its keyframes (checked, not assumed). Nothing is
  // read after that, because from there the flight's own transform is in the
  // rect and each reading would send the next one further out.
  requestAnimationFrame(() => {
    measureTitle(root)
    requestAnimationFrame(() => measureTitle(root))
  })
  for (const at of [400, 1200, FLY_AT - 200]) {
    window.setTimeout(() => measureTitle(root), at)
  }
  window.dispatchEvent(new CustomEvent('life-assemble'))
}

export function isAssembling(): boolean {
  return document.documentElement.classList.contains('assembling')
}

// How far into the current run we are, or null if none is going. A panel that
// mounts *because* of the click misses the event that announced it, so it asks
// this instead of listening.
export function assembleElapsed(): number | null {
  return isAssembling() ? performance.now() - startedAt : null
}

// The stage's copy of the title has to end its flight sitting exactly on the
// real one, and how far that is - and how much smaller - is something CSS has
// no way to ask for. Both are measured here and handed over for the keyframes
// to use. Only ever read while the stage is still holding still: once the
// flight is under way its own transform is in the rect, and feeding that back
// in would send each reading further off than the last.
function measureTitle(root: HTMLElement) {
  const real = document.querySelector('.app > header .brand')
  const stage = document.querySelector('.brand-stage-word')
  if (!real || !stage) return
  const to = real.getBoundingClientRect()
  const from = stage.getBoundingClientRect()
  if (to.width === 0 || from.width === 0) return
  root.style.setProperty('--stage-dx', `${to.left + to.width / 2 - (from.left + from.width / 2)}px`)
  root.style.setProperty('--stage-dy', `${to.top + to.height / 2 - (from.top + from.height / 2)}px`)
  root.style.setProperty('--stage-scale', String(to.width / from.width))
}
