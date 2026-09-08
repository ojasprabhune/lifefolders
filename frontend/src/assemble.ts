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
  root.classList.add('assembling')
  startedAt = performance.now()
  window.clearTimeout(timer)
  timer = window.setTimeout(() => root.classList.remove('assembling'), RUN_MS)
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
