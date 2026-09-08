// Clicking the title reassembles the whole screen. Everything about how that
// looks lives in styles.css under `.assembling`, hung off one class on <html>;
// this file only decides when the class is on. No React state on purpose - the
// pieces that animate are in three separate trees (Home, the sidequests panel,
// the day plan) and none of them needs to re-render to take part.

// Has to outlast the last thing to finish, which is the stamp's own marks at
// the very end. Cut this shorter and pieces lose their animation mid-flight,
// the same coupling `justParsed` has with the row reveals.
const RUN_MS = 4700



let timer: number | undefined

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
  window.clearTimeout(timer)
  timer = window.setTimeout(() => root.classList.remove('assembling'), RUN_MS)
}

export function isAssembling(): boolean {
  return document.documentElement.classList.contains('assembling')
}

// The stage's copy of the title has to end its flight sitting exactly on the
// real one, and how far that is - and how much smaller - is something CSS has
// no way to ask for. Both are measured here and handed over for the keyframes
// to use. Read *after* the class comes off and layout is flushed: a rect taken
// while the previous run's transform was still applied would be that
// transform's doing, and every following run would drift.
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
