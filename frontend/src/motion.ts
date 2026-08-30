import { useCallback, useLayoutEffect, useRef } from 'react'

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Shrink an element to nothing before it leaves the DOM, so the rows below it
 * slide up instead of snapping. The height has to be measured and animated
 * explicitly - `auto` is not an animatable value, and the row's height depends
 * on its content.
 */
export function collapseAndRemove(el: HTMLElement | null, remove: () => void) {
  if (!el || prefersReducedMotion()) {
    remove()
    return
  }
  const height = el.getBoundingClientRect().height
  el.style.overflow = 'hidden'
  const anim = el.animate(
    [
      { height: `${height}px`, opacity: 1 },
      { height: '0px', opacity: 0 },
    ],
    // `fill: forwards` matters: without it the row springs back to full height
    // for the frame between the animation finishing and React unmounting it.
    { duration: 160, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
  )
  anim.onfinish = remove
  anim.oncancel = remove
}

/**
 * FLIP for a list whose children carry `data-flip-id`.
 *
 * Positions are captured by the caller, in the handler that is about to
 * reorder the list, rather than remembered from the previous render. An
 * earlier version kept a map across renders and it was wrong: expanding a row
 * changes layout through a CSS transition, which re-runs no effect, so the map
 * silently went stale and the next change yanked every row back to where they
 * sat before the expand. Capturing on demand also means expanding, deleting
 * and changing day - none of which want a FLIP - simply never trigger one.
 */
export function useFlipList<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const pending = useRef<Map<string, number> | null>(null)

  const capture = useCallback(() => {
    const root = ref.current
    if (!root || prefersReducedMotion()) return
    const map = new Map<string, number>()
    root.querySelectorAll<HTMLElement>('[data-flip-id]').forEach((row) => {
      if (row.dataset.flipId) map.set(row.dataset.flipId, row.offsetTop)
    })
    pending.current = map
  }, [])

  // Cheap when nothing was captured: it reads no layout at all, which matters
  // because typing in the entry box re-renders this whole page.
  useLayoutEffect(() => {
    const root = ref.current
    const before = pending.current
    if (!root || !before) return
    pending.current = null

    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-flip-id]'))
    // Read every position before starting any animation - interleaving the two
    // turns one layout flush into N.
    const measured = rows.map((row) => ({ row, id: row.dataset.flipId, top: row.offsetTop }))
    for (const { row, id, top } of measured) {
      if (!id) continue
      const previous = before.get(id)
      if (previous !== undefined && Math.abs(previous - top) > 1) {
        row.animate(
          [{ transform: `translateY(${previous - top}px)` }, { transform: 'none' }],
          { duration: 190, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        )
      }
    }
  })

  return { ref, capture }
}

/**
 * The "done" sweep: the row holds still while a line draws through its title
 * (pure CSS, keyed off a class on the wrapper), then collapses away so the
 * rows below slide up. Same measured-height reasoning as collapseAndRemove -
 * `auto` isn't animatable and the height depends on the content.
 */
export function strikeOut(el: HTMLElement | null, done: () => void) {
  if (!el || prefersReducedMotion()) {
    done()
    return
  }
  const height = el.getBoundingClientRect().height
  el.style.overflow = 'hidden'
  const anim = el.animate(
    [
      { height: `${height}px`, opacity: 1, offset: 0 },
      { height: `${height}px`, opacity: 0.45, offset: 0.62 },
      { height: '0px', opacity: 0, offset: 1 },
    ],
    { duration: 440, easing: 'ease-in-out', fill: 'forwards' },
  )
  anim.onfinish = done
  anim.oncancel = done
}

/**
 * Flash an element when the text inside it actually changes, and only then -
 * an edit that didn't touch this field shouldn't light it up. Compares
 * rendered text rather than props because the caller renders a summary, not
 * the underlying fields. Silent on first mount: arriving isn't a change.
 */
export function useTextFlash<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T>(null)
  const previous = useRef<string | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const text = el.textContent ?? ''
    const before = previous.current
    previous.current = text
    if (before === null || before === text || !enabled || prefersReducedMotion()) return
    el.classList.remove('field-flash')
    // Forcing a reflow is the documented way to restart a CSS animation that
    // is already on the element - without it a second edit doesn't replay.
    void el.offsetWidth
    el.classList.add('field-flash')
  })

  return ref
}
