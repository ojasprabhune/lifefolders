import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  addPlanBlock,
  deletePlanBlock,
  generateDayPlan,
  getDayPlan,
  patchDayPlan,
  patchPlanBlock,
  type DayPlan,
  type PlanBlock,
} from './api'
import { prefersReducedMotion } from './motion'
import { formatEffort } from './Tasks'
import type { TaskWithCheckpoints } from './types'

// Blocks carry a length and an order; the clock times come back from the
// server, which walks the list from the start time. That is why every edit
// here replaces the whole plan rather than patching one row - moving one thing
// re-times everything under it.

function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const suffix = h >= 12 ? 'pm' : 'am'
  const hour = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${hour}${suffix}` : `${hour}:${String(m).padStart(2, '0')}${suffix}`
}

function nowHHMM(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function isCurrent(block: PlanBlock, today: boolean): boolean {
  if (!today) return false
  const now = nowHHMM()
  return block.start <= now && now < block.end
}

export function DayPlanner({
  date,
  isToday,
  tasks,
  onChanged,
}: {
  date: string
  isToday: boolean
  tasks: TaskWithCheckpoints[]
  onChanged: () => void
}) {
  const [plan, setPlan] = useState<DayPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(true)
  // Kept mounted while it closes so the cascade can run backwards - last line
  // out first, back up behind the one above it. Unmounting on the click would
  // just make it vanish.
  const [closing, setClosing] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  // A drag is two values moving at different rates. The pointer offset changes
  // every frame and is written straight to the held row's style; the index it
  // would land on changes only when you cross a neighbour, and that one is
  // state because it re-lays-out the rows around it.
  const listRef = useRef<HTMLOListElement>(null)
  const [held, setHeld] = useState<{ id: string; from: number; height: number } | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const dragRef = useRef<{
    id: string
    from: number
    startY: number
    tops: number[]
    heights: number[]
    el: HTMLElement
    moved: boolean
  } | null>(null)
  // Re-renders once a minute so the "now" marker moves without a refresh.
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!isToday) return
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [isToday])

  useEffect(() => {
    getDayPlan(date).then(setPlan).catch(() => {})
  }, [date])

  // Has to match the keyframes: one block's duration plus the capped stagger.
  const spanMs = (n: number) => 240 + Math.min(Math.max(n - 1, 0), 12) * 38
  // Unmounting on the exact frame the last block finishes clips it whenever
  // the timer drifts, so the close waits a little longer than the animation.
  const closeMs = (n: number) => spanMs(n) + 60

  const toggle = () => {
    if (!open) {
      setOpen(true)
      return
    }
    setClosing(true)
    setTimeout(() => {
      setClosing(false)
      setOpen(false)
    }, closeMs(plan?.blocks.length ?? 0))
  }

  // The section's own height is animated alongside the cascade, so whatever
  // sits under it - the day's categories - slides rather than jumping to where
  // the plan will finish. Measured rather than transitioned from `auto`, which
  // isn't animatable.
  const bodyRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el || prefersReducedMotion()) return
    const ms = closing ? closeMs(plan?.blocks.length ?? 0) : spanMs(plan?.blocks.length ?? 0)
    const height = closing ? el.getBoundingClientRect().height : el.scrollHeight
    el.style.overflow = 'hidden'
    // The margin has to travel with the height. Animating height alone leaves
    // the body's 10px top margin standing at zero height, and it only vanishes
    // when the element unmounts - which is the little snap at the very end.
    const shut = { height: '0px', marginTop: '0px' }
    const full = { height: `${height}px`, marginTop: '10px' }
    const frames = closing ? [full, shut] : [shut, full]
    const anim = el.animate(frames, {
      duration: ms,
      easing: 'cubic-bezier(0.33, 1, 0.68, 1)',
      fill: closing ? 'forwards' : 'none',
    })
    const clear = () => {
      if (!closing) el.style.overflow = ''
    }
    anim.onfinish = clear
    anim.oncancel = clear
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closing])

  const run = useCallback(
    async (work: () => Promise<DayPlan>) => {
      setBusy(true)
      try {
        setPlan(await work())
      } catch {
        // leave the plan as it was
      }
      setBusy(false)
      onChanged()
    },
    [onChanged],
  )

  const startDrag = (e: React.PointerEvent<HTMLLIElement>, id: string, index: number) => {
    if (e.button !== 0) return
    // The controls on the row keep working; only the row itself is a handle.
    if ((e.target as HTMLElement).closest('button, input, select, a')) return
    const list = listRef.current
    if (!list) return
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.planner-block'))
    const rects = rows.map((r) => r.getBoundingClientRect())
    if (!rects[index]) return
    setAdding(null)
    dragRef.current = {
      id,
      from: index,
      startY: e.clientY,
      tops: rects.map((r) => r.top),
      heights: rects.map((r) => r.height),
      el: rows[index],
      moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dy = e.clientY - d.startY
    // A few pixels of slop, so a stray press on a row isn't a drag.
    if (!d.moved) {
      if (Math.abs(dy) < 4) return
      d.moved = true
      setHeld({ id: d.id, from: d.from, height: d.heights[d.from] })
      setOverIndex(d.from)
    }
    d.el.style.transform = `translateY(${dy}px)`

    // Where the held row's middle now sits, against where its neighbours
    // started. Measuring against the original layout rather than the live one
    // is what stops the answer oscillating as the others slide out of the way.
    const centre = d.tops[d.from] + d.heights[d.from] / 2 + dy
    let target = d.from
    for (let i = 0; i < d.tops.length; i++) {
      if (i === d.from) continue
      const middle = d.tops[i] + d.heights[i] / 2
      if (i < d.from && centre < middle) target = Math.min(target, i)
      if (i > d.from && centre > middle) target = Math.max(target, i)
    }
    setOverIndex((cur) => (cur === target ? cur : target))
  }

  const endDrag = () => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    const to = overIndex
    const clear = () => {
      d.el.style.transform = ''
      setHeld(null)
      setOverIndex(null)
    }
    if (!d.moved || to === null || to === d.from) {
      clear()
      return
    }
    // The preview stays put until the server answers, so the rows never snap
    // back to the old order for the length of a round trip. Clearing lands in
    // the same commit as the new plan.
    setBusy(true)
    patchPlanBlock(date, d.id, { position: to })
      .then((p) => {
        setPlan(p)
        onChanged()
      })
      .catch(() => {})
      .finally(() => {
        clear()
        setBusy(false)
      })
  }

  // How far a row that isn't the held one has to move to open the gap.
  const shiftOf = (i: number): number => {
    if (!held || overIndex === null || i === held.from) return 0
    if (held.from < overIndex && i > held.from && i <= overIndex) return -held.height
    if (held.from > overIndex && i >= overIndex && i < held.from) return held.height
    return 0
  }

  if (!plan) return null
  const blocks = plan.blocks
  const last = blocks[blocks.length - 1]

  return (
    <section className="planner">
      {/* The title is the control, the same way `resolved` is - no separate
          affordance to aim at. */}
      <button className="planner-head" onClick={toggle}>
        <h2 className="section-title">the script</h2>
        {last && (
          <span className="planner-range">
            {clockLabel(plan.starts_at)} – {clockLabel(last.end)}
          </span>
        )}
      </button>

      {open && (
        <div className={`planner-body ${closing ? 'closing' : ''}`} ref={bodyRef}>
          <div className="planner-bounds">
            <TimeField
              label="from"
              value={plan.starts_at}
              onSave={(v) => void run(() => patchDayPlan(date, { starts_at: v }))}
            />
            <TimeField
              label="by"
              value={plan.ends_at}
              onSave={(v) => void run(() => patchDayPlan(date, { ends_at: v }))}
              onClear={() => void run(() => patchDayPlan(date, { clear_ends_at: true }))}
            />
            <button
              className="planner-generate"
              disabled={busy}
              onClick={() => void run(() => generateDayPlan(date))}
            >
              {busy ? 'thinking…' : blocks.length === 0 ? 'plan it' : 'redo'}
            </button>
          </div>

          {blocks.length === 0 && (
            <div className="empty">nothing planned — hit plan it, or add a block below</div>
          )}

          <ol
            className={`planner-list ${held ? 'plan-dragging' : ''}`}
            ref={listRef}
            style={{ ['--n' as string]: blocks.length }}
          >
            {blocks.flatMap((b, i) => [
              // --i drives the stagger. The body unmounts when collapsed, so
              // the cascade runs on open; editing a block reuses its element
              // by key, so it doesn't replay on every change.
              <li
                key={b.id}
                className={`planner-block ${b.kind} ${isCurrent(b, isToday) ? 'now' : ''} ${
                  held?.id === b.id ? 'plan-held' : ''
                }`}
                style={{
                  ['--i' as string]: i,
                  ['--r' as string]: blocks.length - 1 - i,
                  ...(held && held.id !== b.id ? { transform: `translateY(${shiftOf(i)}px)` } : {}),
                }}
                onPointerDown={(e) => startDrag(e, b.id, i)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <span className="planner-time">{clockLabel(b.start)}</span>
                <span className="planner-label">{b.label}</span>
                <MinutesField
                  value={b.minutes}
                  onSave={(m) => void run(() => patchPlanBlock(date, b.id, { minutes: m }))}
                />
                {b.task_id && (
                  <a
                    className="task-focus"
                    href={`#/focus?task=${b.task_id}&minutes=${b.minutes}&start=1`}
                    aria-label="start a clarity session for this block"
                  >
                    ▷
                  </a>
                )}
                <button
                  className="delete-btn"
                  aria-label="remove this block"
                  onClick={() => void run(() => deletePlanBlock(date, b.id))}
                >
                  ✕
                </button>
                {/* The insert control lives on the seam below each block, so
                    "put something between these two" is one click where you
                    are already looking. */}
                <button
                  className="planner-insert"
                  aria-label="insert after this"
                  onClick={() => setAdding(adding === b.id ? null : b.id)}
                >
                  +
                </button>
              </li>,
              adding === b.id ? (
                <li className="planner-add-row" key={`${b.id}-add`}>
                  <AddRow
                    tasks={tasks}
                    onPick={(body) => {
                      setAdding(null)
                      void run(() => addPlanBlock(date, { ...body, after: b.id }))
                    }}
                    onCancel={() => setAdding(null)}
                  />
                </li>
              ) : null,
            ])}
          </ol>

          {adding !== 'end' ? (
            <button className="planner-add-end" onClick={() => setAdding('end')}>
              + add to the end
            </button>
          ) : (
            <AddRow
              tasks={tasks}
              onPick={(body) => {
                setAdding(null)
                void run(() => addPlanBlock(date, body))
              }}
              onCancel={() => setAdding(null)}
            />
          )}

          {plan.overflow_minutes > 0 && (
            <div className="planner-overflow">
              <span>
                {formatEffort(plan.overflow_minutes)} past {clockLabel(plan.ends_at ?? '00:00')}, when
                you wanted to be asleep.
              </span>
              {plan.push_suggestion && (
                <button
                  className="planner-push"
                  onClick={() => {
                    const s = plan.push_suggestion!
                    // Dropping it from the plan is the reversible half; moving
                    // its deadline is the user's call, so it stays a sentence
                    // they can type rather than something done to them.
                    void run(async () => {
                      const ids = blocks.filter((b) => b.task_id === s.task_id).map((b) => b.id)
                      let next = plan
                      for (const id of ids) next = await deletePlanBlock(date, id)
                      return next
                    })
                  }}
                >
                  drop {plan.push_suggestion.label} ({formatEffort(plan.push_suggestion.minutes)})
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// A native <input type="time"> is segment-based: clicking the minutes and
// typing "20" gets eaten unless you hit the segments in the right order, which
// is what made setting a time feel broken. This is a plain text box that
// accepts what people actually type - "6:20pm", "620", "18:20", "6pm" - and
// prints back one canonical form.
export function parseClock(text: string, current?: string | null): string | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, '')
  if (!s) return null
  const m = s.match(/^(\d{1,2})[:.]?(\d{2})?(am|pm|a|p)?$/)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] === undefined ? 0 : Number(m[2])
  if (min > 59) return null
  let suffix = m[3]?.[0]
  // Nudging 6:35pm to "620" means 6:20pm, not six in the morning: with no am
  // or pm typed and an hour that could be either, the half of the day you were
  // already in wins. Only 13-23 and an explicit suffix override that.
  if (!suffix && h >= 1 && h <= 11 && current) {
    suffix = Number(current.slice(0, 2)) >= 12 ? 'p' : 'a'
  }
  if (suffix === 'p' && h < 12) h += 12
  if (suffix === 'a' && h === 12) h = 0
  if (h > 23) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function TimeField({
  label,
  value,
  onSave,
  onClear,
}: {
  label: string
  value: string | null
  onSave: (v: string) => void
  onClear?: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = value ? clockLabel(value) : '—'

  if (draft === null) {
    return (
      <button className="planner-time-field" onClick={() => setDraft(value ? clockLabel(value) : '')}>
        <span>{label}</span>
        <span className="planner-time-value">{shown}</span>
      </button>
    )
  }

  const commit = () => {
    const raw = draft
    setDraft(null)
    if (raw.trim() === '') {
      onClear?.()
      return
    }
    const parsed = parseClock(raw, value)
    // Something that isn't a time leaves the old one alone rather than wiping it.
    if (parsed && parsed !== value) onSave(parsed)
  }

  return (
    <span className="planner-time-field editing">
      <span>{label}</span>
      <input
        className="planner-time-input"
        autoFocus
        value={draft}
        placeholder="6:20pm"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(null)
        }}
      />
    </span>
  )
}

function MinutesField({ value, onSave }: { value: number; onSave: (m: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft === null) {
    return (
      <button className="planner-minutes" onClick={() => setDraft(String(value))}>
        {formatEffort(value)}
      </button>
    )
  }
  const commit = () => {
    const n = Number(draft)
    setDraft(null)
    if (Number.isFinite(n) && n > 0 && n !== value) onSave(Math.round(n))
  }
  return (
    <input
      className="planner-minutes-input"
      autoFocus
      value={draft}
      inputMode="numeric"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 3))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') setDraft(null)
      }}
    />
  )
}

// Its own row rather than something crammed into the block's flex line, which
// squeezed the label to one letter per line and pushed the controls off the
// right edge. Anything can go in: a walk, a snack, a shower - it doesn't have
// to be a sidequest or one of the two words the old version offered.
function AddRow({
  tasks,
  onPick,
  onCancel,
}: {
  tasks: TaskWithCheckpoints[]
  onPick: (body: { kind: string; task_id?: string; label?: string; minutes?: number }) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  const [minutes, setMinutes] = useState('15')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = () => {
    const text = label.trim()
    if (!text) return
    const n = Number(minutes)
    onPick({ kind: 'break', label: text, minutes: Number.isFinite(n) && n > 0 ? Math.round(n) : 15 })
  }

  return (
    <div className="planner-add">
      <input
        className="planner-add-label"
        autoFocus
        value={label}
        placeholder="walk, snack, shower…"
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <input
        className="planner-add-mins"
        value={minutes}
        inputMode="numeric"
        aria-label="minutes"
        onChange={(e) => setMinutes(e.target.value.replace(/\D/g, '').slice(0, 3))}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <button className="planner-add-go" onClick={submit} disabled={!label.trim()}>
        add
      </button>
      <select
        className="planner-add-pick"
        value=""
        onChange={(e) => e.target.value && onPick({ kind: 'task', task_id: e.target.value })}
      >
        <option value="">or a sidequest…</option>
        {tasks
          .filter((t) => t.status !== 'done')
          .map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
      </select>
      <button className="planner-add-cancel" onClick={onCancel} aria-label="cancel">
        ✕
      </button>
    </div>
  )
}
