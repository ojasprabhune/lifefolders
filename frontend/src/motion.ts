import { useLayoutEffect, useRef } from 'react'

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
    { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
  )
  anim.onfinish = remove
  anim.oncancel = remove
}

/**
 * FLIP for a list whose children carry `data-flip-id`. Records where every row
 * sat last render and, when one has moved, starts it from its old position and
 * lets it glide to the new one - so filtering the timeline reflows instead of
 * jumping.
 *
 * The animation runs on transform only, after layout has already settled, so
 * nothing here can shift anything else on the page.
 */
export function useFlipList<T extends HTMLElement>(deps: unknown[]) {
  const ref = useRef<T>(null)
  const positions = useRef(new Map<string, number>())

  // Deps matter here. Measuring on every render would mean a forced layout on
  // every keystroke in the entry box, since typing re-renders the whole page;
  // this only measures when something that can actually move a row changed.
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-flip-id]'))

    // Read every position first, then animate. Interleaving the two would
    // invalidate layout between reads and turn one flush into N.
    const measured = rows.map((row) => ({ row, id: row.dataset.flipId, top: row.offsetTop }))
    const next = new Map<string, number>()
    const animate = !prefersReducedMotion()

    for (const { row, id, top } of measured) {
      if (!id) continue
      next.set(id, top)
      const previous = positions.current.get(id)
      if (animate && previous !== undefined && Math.abs(previous - top) > 1) {
        row.animate(
          [{ transform: `translateY(${previous - top}px)` }, { transform: 'none' }],
          { duration: 280, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        )
      }
    }
    positions.current = next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return ref
}
