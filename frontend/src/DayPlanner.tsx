import { useCallback, useEffect, useRef, useState } from 'react'
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
  const [adding, setAdding] = useState<string | null>(null)
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

  if (!plan) return null
  const blocks = plan.blocks
  const last = blocks[blocks.length - 1]

  return (
    <section className="planner">
      {/* The title is the control, the same way `resolved` is - no separate
          affordance to aim at. */}
      <button className="planner-head" onClick={() => setOpen((v) => !v)}>
        <h2 className="section-title">the script</h2>
        {last && (
          <span className="planner-range">
            {clockLabel(plan.starts_at)} – {clockLabel(last.end)}
          </span>
        )}
      </button>

      {open && (
        <div className="planner-body">
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

          <ol className="planner-list">
            {blocks.map((b, i) => (
              // --i drives the stagger. The body unmounts when collapsed, so
              // the cascade runs on open; editing a block reuses its element
              // by key, so it doesn't replay on every change.
              <li
                key={b.id}
                className={`planner-block ${b.kind} ${isCurrent(b, isToday) ? 'now' : ''}`}
                style={{ ['--i' as string]: i }}
              >
                <span className="planner-time">{clockLabel(b.start)}</span>
                <span className="planner-label">{b.label}</span>
                <MinutesField
                  value={b.minutes}
                  onSave={(m) => void run(() => patchPlanBlock(date, b.id, { minutes: m }))}
                />
                {b.task_id && (
                  <a className="task-focus" href={`#/focus?task=${b.task_id}`} aria-label="clarity session">
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
                {adding === b.id && (
                  <AddRow
                    tasks={tasks}
                    onPick={(body) => {
                      setAdding(null)
                      void run(() => addPlanBlock(date, { ...body, after: b.id }))
                    }}
                    onCancel={() => setAdding(null)}
                  />
                )}
              </li>
            ))}
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
  return (
    <label className="planner-time-field">
      <span>{label}</span>
      <input
        type="time"
        value={value ?? ''}
        onChange={(e) => {
          if (e.target.value) onSave(e.target.value)
          else onClear?.()
        }}
      />
    </label>
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

function AddRow({
  tasks,
  onPick,
  onCancel,
}: {
  tasks: TaskWithCheckpoints[]
  onPick: (body: { kind: string; task_id?: string; label?: string; minutes?: number }) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="planner-add" ref={ref}>
      <button onClick={() => onPick({ kind: 'break', label: 'break', minutes: 15 })}>break</button>
      <select
        defaultValue=""
        onChange={(e) => e.target.value && onPick({ kind: 'task', task_id: e.target.value })}
      >
        <option value="" disabled>
          a sidequest…
        </option>
        {tasks
          .filter((t) => t.status !== 'done')
          .map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
      </select>
      <button onClick={onCancel} aria-label="cancel">
        ✕
      </button>
    </div>
  )
}
