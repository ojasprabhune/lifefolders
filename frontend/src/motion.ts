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
export function collapseAndRemove(
  el: HTMLElement | null,
  remove: () => void,
  // A deleted row wants to be gone; a notice that has simply timed out wants
  // to be let go of, so it gets longer and an ease-out - the whole complaint
  // about the old behaviour was the snap at the end.
  { ms = 160, easing = 'cubic-bezier(0.4, 0, 1, 1)' } = {},
) {
  if (!el || prefersReducedMotion()) {
    remove()
    return
  }
  const height = el.getBoundingClientRect().height
  // The padding has to come down with the height. `box-sizing: border-box` is
  // set globally, so `height` counts the padding, and the used height can't go
  // below it - the element stalls at padding-top + padding-bottom and then
  // vanishes, which is a snap of exactly that many pixels at the very end.
  const style = getComputedStyle(el)
  const { paddingTop, paddingBottom, marginTop, marginBottom } = style
  el.style.overflow = 'hidden'
  const anim = el.animate(
    [
      { height: `${height}px`, paddingTop, paddingBottom, marginTop, marginBottom, opacity: 1 },
      {
        height: '0px',
        paddingTop: '0px',
        paddingBottom: '0px',
        // And the margins, for the same reason one step out: an element at
        // zero height still holds its neighbours apart by its margin, so the
        // gap it leaves behind closes all at once when it finally unmounts.
        marginTop: '0px',
        marginBottom: '0px',
        opacity: 0,
      },
    ],
    // `fill: forwards` matters: without it the row springs back to full height
    // for the frame between the animation finishing and React unmounting it.
    { duration: ms, easing, fill: 'forwards' },
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
      // The line finishes drawing at 620ms, then the struck-out row is held
      // for a beat before it goes - collapsing it the moment the line lands
      // means you never actually see the thing you just crossed off.
      { height: `${height}px`, opacity: 1, offset: 0 },
      { height: `${height}px`, opacity: 0.5, offset: 0.56 },
      { height: `${height}px`, opacity: 0.5, offset: 0.68 },
      { height: '0px', opacity: 0, offset: 1 },
    ],
    { duration: 1100, easing: 'ease-in-out', fill: 'forwards' },
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

/**
 * The reverse of strikeOut: a row that has come back opens from nothing and
 * overshoots slightly on the way, so it reads as landing rather than simply
 * being there. The rows below it are pushed down by the height change, and the
 * caller's FLIP carries them - which is the ripple.
 */
export function unfold(el: HTMLElement | null) {
  if (!el || prefersReducedMotion()) return
  // Measure the row at rest. A previous run of this animation still on the
  // element is holding it near zero, so measuring over the top of one gives a
  // height of about 1px and the row appears to jump instead of opening.
  el.getAnimations().forEach((a) => a.cancel())
  const height = el.getBoundingClientRect().height
  el.style.overflow = 'hidden'
  const anim = el.animate(
    [
      { height: '0px', opacity: 0, transform: 'translateY(-6px)' },
      { height: `${height}px`, opacity: 1, transform: 'translateY(0)' },
    ],
    { duration: 380, easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)' },
  )
  const clear = () => {
    el.style.overflow = ''
  }
  anim.onfinish = clear
  anim.oncancel = clear
}

/**
 * A sidequest that has just been moved off the day you are looking at. It has
 * nowhere to go in this list, so rather than vanishing it leaves sideways at
 * full opacity and the gap it was holding open closes behind it, which is what
 * carries the rows below up.
 *
 * Two animations rather than one keyframe list, because they overlap: the
 * collapse starts while the row is still travelling, and a single list of
 * keyframes can't say that. The measured height is the same reasoning as
 * everywhere else here - `auto` is not animatable.
 */
export function flingOut(el: HTMLElement | null, done: () => void) {
  if (!el || prefersReducedMotion()) {
    done()
    return
  }
  const rect = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const { paddingTop, paddingBottom, marginTop, marginBottom, borderBottomWidth } = style
  // Measured to the window edge rather than a fixed number: the panel sits in
  // a centred shell on a wide screen and hard against the right edge on a
  // narrow one, so anything fixed either falls short or overshoots.
  const distance = window.innerWidth - rect.left + 24
  // The section clips while the row is in the air. A transformed row still
  // counts towards the page's scrollable area, so without this a horizontal
  // scrollbar flashes in and out underneath the panel. `clip` rather than
  // `hidden` so the section doesn't become a scroll container mid-animation.
  const clip = el.parentElement
  clip?.classList.add('fling-clip')
  el.style.overflow = 'hidden'
  // Quick, but not so front-loaded that the row is off the edge inside three
  // frames - most of the travel that can be seen happens in the panel's own
  // width, and an ease-out steep enough to feel like a launch skipped it.
  el.animate([{ transform: 'none' }, { transform: `translateX(${distance}px)` }], {
    duration: 340,
    easing: 'cubic-bezier(0.34, 0.6, 0.45, 1)',
    fill: 'forwards',
  })
  const collapse = el.animate(
    [
      { height: `${rect.height}px`, paddingTop, paddingBottom, marginTop, marginBottom, borderBottomWidth },
      {
        height: '0px',
        paddingTop: '0px',
        paddingBottom: '0px',
        marginTop: '0px',
        marginBottom: '0px',
        // The row's own bottom rule is a pixel of height in its own right, and
        // a pixel left standing until unmount is a pixel that snaps.
        borderBottomWidth: '0px',
      },
    ],
    { duration: 280, delay: 140, easing: 'cubic-bezier(0.33, 1, 0.68, 1)', fill: 'forwards' },
  )
  const finish = () => {
    clip?.classList.remove('fling-clip')
    done()
  }
  collapse.onfinish = finish
  collapse.oncancel = finish
}
