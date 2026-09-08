// Clicking the title reassembles the whole screen. Everything about how that
// looks lives in styles.css under `.assembling`, hung off one class on <html>;
// this file only decides when the class is on. No React state on purpose - the
// pieces that animate are in three separate trees (Home, the sidequests panel,
// the day plan) and none of them needs to re-render to take part.

// Has to outlast the last thing to finish, which is the stamp's own marks at
// the very end. Cut this shorter and pieces lose their animation mid-flight,
// the same coupling `justParsed` has with the row reveals.
const RUN_MS = 4700

// How big the title gets while it is centre stage, and how much of the window
// it is allowed to fill on a narrow one - the shell clips horizontally, so a
// title wider than the window would have its ends cut off.
const TITLE_SCALE_MAX = 4.2
const TITLE_WIDTH_SHARE = 0.72

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

// The title's run starts in the middle of the window at several times its size
// and ends where it actually lives, which is a distance CSS has no way to ask
// for. It is measured here and handed over as three custom properties for the
// keyframes to use. Read *after* the class comes off and layout is flushed:
// a rect taken while the previous run's transform was still applied would be
// that transform's doing, and every following run would drift.
function measureTitle(root: HTMLElement) {
  const brand = document.querySelector('.app > header .brand')
  if (!brand) return
  const box = brand.getBoundingClientRect()
  if (box.width === 0) return
  const scale = Math.min(TITLE_SCALE_MAX, (window.innerWidth * TITLE_WIDTH_SHARE) / box.width)
  root.style.setProperty('--brand-dx', `${window.innerWidth / 2 - (box.left + box.width / 2)}px`)
  root.style.setProperty('--brand-dy', `${window.innerHeight / 2 - (box.top + box.height / 2)}px`)
  root.style.setProperty('--brand-scale', String(scale))
}
