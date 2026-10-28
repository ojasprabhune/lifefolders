import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { getHiddenDomains } from './api'
import { localDateStr } from './dates'
import { getFocusSession, toggleFocusAfk, toggleFocusPause } from './focusEngine'
import { rememberTaskDay } from './lastPanel'

/**
 * Vim-style keys, all of them, in one place. Pages opt in with markup rather
 * than code, so nothing about how a page renders changes for the mouse:
 *
 *   data-kb-scope    a list you can be "in" - the timeline, or the open panel
 *   data-kb-section  a run of items inside one; h/l hop between these
 *   data-kb-item     one thing j/k land on
 *   data-kb-open     inside an item: what Enter clicks (="dblclick" to double-click it)
 *   data-kb-focus    inside an item: what f clicks
 *   data-kb-expanded on an item that is open, so Esc knows to close it
 *
 * An action that isn't a click - x on a sidequest - is a `kb:<action>` event
 * dispatched on the item, picked up with `useKbAction`. A listener that takes
 * it stops the click fallback.
 *
 * The selection is a `data-kb-selected` attribute written straight onto the
 * element, never React state: nothing re-renders as you move, and it can't
 * drift from the DOM it is describing.
 */

type KbAction = 'open' | 'focus' | 'done'

const SCOPE = '[data-kb-scope]'
const SECTION = '[data-kb-section]'
const ITEM = '[data-kb-item]'
const SEQUENCE_MS = 1000
const HINT_EXIT_MS = 140
const HELP_EXIT_MS = 180

export const SHORTCUTS: { group: string; keys: [string, string][] }[] = [
  {
    group: 'anywhere',
    keys: [
      ['j  k', 'down and up a list (or ↓ ↑)'],
      ['h  l', 'previous and next section (or ← →)'],
      ['g g  G', 'top and bottom of the list'],
      ['enter', 'open what is selected'],
      ['esc', 'close it and let go, or leave a text box'],
      ['/', 'type an entry'],
      ['?', 'this list'],
    ],
  },
  {
    group: 'go to',
    keys: [
      ['g h', 'the timeline'],
      ['g t', 'sidequests, everything'],
      ['g d', "today's script"],
      ['g f', 'clarity'],
      ['g s', 'search'],
    ],
  },
  {
    group: 'on a sidequest or script block',
    keys: [
      ['x', 'mark it done, or not done'],
      ['f', 'start a clarity session on it'],
    ],
  },
  {
    group: 'during clarity',
    keys: [
      ['space', 'pause and resume'],
      ['a', 'afk and back'],
    ],
  },
]

// A button or checkbox is focused after every click; only somewhere you type
// turns the keys off.
const NOT_TYPING = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'])

function isTyping(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el.tagName === 'INPUT' && !NOT_TYPING.has((el as HTMLInputElement).type)
}

// On screen and staying there. A panel or block on its way out still has a
// box for the length of its exit, and a folded Expand keeps its children's
// boxes at full height behind a zero-height clip.
function shown(el: Element): boolean {
  if (el.getClientRects().length === 0 || el.closest('.closing')) return false
  const fold = el.parentElement?.closest('.expand')
  return !fold || fold.getBoundingClientRect().height > 1
}

function scopes(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(SCOPE)].filter(shown)
}

function itemsIn(scope: Element): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(ITEM)].filter((i) => i.closest(SCOPE) === scope && shown(i))
}

// The open panel when there is one with anything in it, since that's what
// you just went to; otherwise the timeline.
function startScope(): HTMLElement | null {
  return scopes().reverse().find((s) => itemsIn(s).length > 0) ?? null
}

// Sections across every scope in page order, so h from a panel's first
// section lands on the timeline beside it.
function groups(): { el: Element; items: HTMLElement[] }[] {
  const out: { el: Element; items: HTMLElement[] }[] = []
  for (const scope of scopes()) {
    for (const item of itemsIn(scope)) {
      const el = item.closest(SECTION) ?? scope
      const last = out[out.length - 1]
      if (last?.el === el) last.items.push(item)
      else out.push({ el, items: [item] })
    }
  }
  return out
}

let selected: HTMLElement | null = null
// Where the selection was, for when its element goes away under it - a
// sidequest marked done leaves the list, and j should carry on from its gap.
let lastScope: Element | null = null
let lastIndex = 0

function live(): HTMLElement | null {
  return selected && selected.isConnected && shown(selected) ? selected : null
}

function select(el: HTMLElement) {
  selected?.removeAttribute('data-kb-selected')
  selected = el
  el.setAttribute('data-kb-selected', '')
  el.scrollIntoView({ block: 'nearest' })
  lastScope = el.closest(SCOPE)
  lastIndex = lastScope ? itemsIn(lastScope).indexOf(el) : 0
}

function clearSelection() {
  selected?.removeAttribute('data-kb-selected')
  selected = null
  lastScope = null
}

function move(dir: 1 | -1): boolean {
  const cur = live()
  if (cur) {
    const items = itemsIn(cur.closest(SCOPE)!)
    const next = items[Math.min(Math.max(items.indexOf(cur) + dir, 0), items.length - 1)]
    if (next) select(next)
    return true
  }
  if (lastScope?.isConnected) {
    const items = itemsIn(lastScope)
    const at = dir > 0 ? lastIndex : lastIndex - 1
    const next = items[Math.min(Math.max(at, 0), items.length - 1)]
    if (next) {
      select(next)
      return true
    }
  }
  const start = startScope()
  if (!start) return false
  select(itemsIn(start)[0])
  return true
}

function edge(end: 'first' | 'last'): boolean {
  const scope = live()?.closest(SCOPE) ?? startScope()
  const items = scope ? itemsIn(scope) : []
  if (items.length === 0) return false
  select(end === 'first' ? items[0] : items[items.length - 1])
  return true
}

function hop(dir: 1 | -1): boolean {
  const all = groups()
  if (all.length === 0) return false
  const cur = live()
  if (!cur) return move(1)
  const here = cur.closest(SECTION) ?? cur.closest(SCOPE)
  const next = all[all.findIndex((g) => g.el === here) + dir]
  if (next) select(next.items[0])
  return true
}

function act(item: HTMLElement, action: KbAction): boolean {
  const ev = new CustomEvent(`kb:${action}`, { cancelable: true, bubbles: true })
  item.dispatchEvent(ev)
  if (ev.defaultPrevented) return true
  const target = item.querySelector<HTMLElement>(`[data-kb-${action}]`) ?? (action === 'open' ? item : null)
  if (!target) return false
  if (target.dataset.kbOpen === 'dblclick') target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  else target.click()
  return true
}

/**
 * For an action that isn't a click. The event bubbles from the selected item,
 * so `ref` can be the item itself or anything around a set of them; the
 * handler is given the item.
 */
export function useKbAction(
  ref: RefObject<HTMLElement | null>,
  action: KbAction,
  handler: (item: HTMLElement) => void,
) {
  const fn = useRef(handler)
  useLayoutEffect(() => {
    fn.current = handler
  })
  useEffect(() => {
    // On the window rather than the element, so a list that mounts after
    // this runs - the script's, once the plan arrives - is still covered.
    const on = (e: Event) => {
      const item = e.target as HTMLElement
      if (!ref.current?.contains(item)) return
      e.preventDefault()
      fn.current(item)
    }
    window.addEventListener(`kb:${action}`, on)
    return () => window.removeEventListener(`kb:${action}`, on)
  }, [ref, action])
}

// Something that is about to exist - the entry box after navigating home,
// the script's first block once its plan has loaded. Each new key cancels the
// last wait, so a slow load can't grab the selection back afterwards.
let waitSeq = 0
function when<T>(find: () => T | null, then: (found: T) => void, ms = 3000) {
  const mine = ++waitSeq
  const started = Date.now()
  const tick = () => {
    if (mine !== waitSeq) return
    const found = find()
    if (found) then(found)
    else if (Date.now() - started < ms) window.setTimeout(tick, 50)
  }
  tick()
}

function go(hash: string) {
  if (window.location.hash !== hash) window.location.hash = hash
}

// The sidequests panel keeps its day in its own state, read from session
// storage when it mounts - so both are told.
function showTaskDay(day: string | null) {
  rememberTaskDay(day, localDateStr(new Date()))
  window.dispatchEvent(new CustomEvent('life-task-day', { detail: day }))
}

function jump(key: string): void {
  const hidden = getHiddenDomains()
  switch (key) {
    case 'g':
      edge('first')
      return
    case 'h':
      go('#/')
      return
    case 't':
      if (hidden.includes('sidequests')) return
      showTaskDay(null)
      go('#/tasks')
      return
    case 'd':
      if (hidden.includes('sidequests')) return
      showTaskDay(localDateStr(new Date()))
      go('#/tasks')
      when(
        () => document.querySelector<HTMLElement>('[data-kb-section="script"]'),
        (script) => {
          script.scrollIntoView({ block: 'nearest' })
          const first = itemsIn(script.closest(SCOPE)!).find((i) => script.contains(i))
          if (first) select(first)
        },
      )
      return
    case 'f':
      if (!hidden.includes('clarity')) go('#/focus')
      return
    case 's':
      if (!hidden.includes('search')) go('#/search')
      return
  }
}

/** Mounted once, beside the routes. Renders the ? sheet and the "g" hint. */
export function KeyboardNav({ route }: { route: string }) {
  const [help, setHelp] = useState<'open' | 'closing' | null>(null)
  const [hint, setHint] = useState<'open' | 'closing' | null>(null)
  const pendingG = useRef(false)
  const gTimer = useRef<number | undefined>(undefined)
  const helpRef = useRef(help)
  helpRef.current = help
  const routeRef = useRef(route)
  routeRef.current = route

  const closeHelp = () => {
    setHelp((h) => (h === 'open' ? 'closing' : h))
    window.setTimeout(() => setHelp((h) => (h === 'closing' ? null : h)), HELP_EXIT_MS)
  }

  useEffect(() => {
    const endSequence = () => {
      pendingG.current = false
      window.clearTimeout(gTimer.current)
      setHint((h) => (h === 'open' ? 'closing' : h))
      window.setTimeout(() => setHint((h) => (h === 'closing' ? null : h)), HINT_EXIT_MS)
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return
      const active = document.activeElement

      // The target, not whatever has focus by now: a field that blurs itself
      // on Escape has already let go by the time this runs, and the same
      // press would otherwise go on to close the row it sits in.
      const typedIn = e.target as Element | null
      if (isTyping(typedIn)) {
        // Something with an Escape of its own - the entry box closing its
        // suggestions - has already said so.
        if (e.key === 'Escape' && !e.defaultPrevented && typedIn === active) typedIn.blur()
        return
      }

      if (helpRef.current) {
        if (e.key === 'Escape' || e.key === '?') {
          e.preventDefault()
          closeHelp()
        }
        return
      }

      if (pendingG.current) {
        endSequence()
        if (e.key === 'Shift') return
        e.preventDefault()
        waitSeq++
        jump(e.key)
        return
      }

      const repeatable = ['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key)
      if (e.repeat && !repeatable) return

      // Enter and space on a focused button already click it.
      const onControl = active instanceof HTMLElement && active.matches('button, a, summary')
      const done = (handled: boolean) => {
        if (handled) e.preventDefault()
      }

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          waitSeq++
          return done(move(1))
        case 'k':
        case 'ArrowUp':
          waitSeq++
          return done(move(-1))
        case 'h':
        case 'ArrowLeft':
          waitSeq++
          return done(hop(-1))
        case 'l':
        case 'ArrowRight':
          waitSeq++
          return done(hop(1))
        case 'G':
          return done(edge('last'))
        case 'g':
          e.preventDefault()
          pendingG.current = true
          setHint('open')
          gTimer.current = window.setTimeout(endSequence, SEQUENCE_MS)
          return
        case 'Enter': {
          const cur = live()
          if (!cur || onControl) return
          return done(act(cur, 'open'))
        }
        case 'x': {
          const cur = live()
          return done(!!cur && act(cur, 'done'))
        }
        case 'f': {
          const cur = live()
          return done(!!cur && act(cur, 'focus'))
        }
        case 'Escape': {
          const cur = live()
          if (cur?.hasAttribute('data-kb-expanded')) act(cur, 'open')
          if (selected) {
            e.preventDefault()
            clearSelection()
          }
          return
        }
        case '/':
          e.preventDefault()
          waitSeq++
          if (!document.querySelector('.entry-input')) go('#/')
          when(
            () => document.querySelector<HTMLInputElement>('.entry-input'),
            (input) => input.focus(),
          )
          return
        case '?':
          e.preventDefault()
          setHelp('open')
          return
      }

      if (routeRef.current.startsWith('#/focus')) {
        const session = getFocusSession()
        if (e.key === ' ') {
          // Taken whether or not there is a session, so space never scrolls
          // the page or presses whichever button was clicked last.
          e.preventDefault()
          if (onControl) (active as HTMLElement).blur()
          if (session && session.afkAtMs === null) void toggleFocusPause()
        } else if (e.key === 'a' && session && session.pausedAtMs === null) {
          e.preventDefault()
          void toggleFocusAfk()
        }
      }
    }

    // Clicking somewhere is a different way of pointing; leaving a keyboard
    // highlight behind on whatever you'd last arrowed to would be two
    // selections at once.
    const onPointer = () => clearSelection()
    const onRoute = () => clearSelection()

    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('hashchange', onRoute)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('hashchange', onRoute)
      window.clearTimeout(gTimer.current)
    }
  }, [])

  return (
    <>
      {hint && <div className={`kb-hint ${hint === 'closing' ? 'closing' : ''}`}>g…</div>}
      {help && (
        <div className={`modal-overlay ${help === 'closing' ? 'closing' : ''}`} onClick={closeHelp}>
          <div className="modal kb-help" onClick={(e) => e.stopPropagation()}>
            <div className="modal-card">
              <ShortcutList />
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** The whole list, as the ? sheet and the guide both show it. */
export function ShortcutList() {
  return (
    <div className="kb-list">
      {SHORTCUTS.map((g) => (
        <div key={g.group} className="kb-group">
          <h3>{g.group}</h3>
          <dl>
            {g.keys.map(([keys, does]) => (
              <div key={keys + does} className="kb-row">
                <dt>
                  {keys.split('  ').map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </dt>
                <dd>{does}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  )
}
