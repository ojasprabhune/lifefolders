// Clicking the title reassembles the whole screen. Everything about how that
// looks lives in styles.css under `.assembling`, hung off one class on <html>;
// this file only decides when the class is on. No React state on purpose - the
// pieces that animate are in three separate trees (Home, the sidequests panel,
// the day plan) and none of them needs to re-render to take part.

// Has to outlast the last thing to finish, which is a sidequest's impact burst
// at the end of its cascade. Cut this shorter and pieces lose their animation
// mid-flight, the same coupling `justParsed` has with the row reveals.
const RUN_MS = 2600

let timer: number | undefined

export function runAssemble() {
  const root = document.documentElement
  // Removing the class and reading layout before adding it back is what lets a
  // second click restart the sequence: a finished animation only re-runs when
  // something about it changes, and the browser has to see the "off" state
  // before it can see the "on" one again.
  root.classList.remove('assembling')
  void root.offsetWidth
  root.classList.add('assembling')
  window.clearTimeout(timer)
  timer = window.setTimeout(() => root.classList.remove('assembling'), RUN_MS)
}

export function isAssembling(): boolean {
  return document.documentElement.classList.contains('assembling')
}
