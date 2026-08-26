import { useCallback, useEffect, useRef, useState } from 'react'
import { listDailyNotes, patchDailyNote } from './api'

type SaveState = 'idle' | 'saving' | 'saved'

function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return localDateStr(d)
}

function dayLabel(date: string, offset: number): string {
  if (offset === 0) return 'today'
  if (offset === -1) return 'yesterday'
  return new Date(date + 'T12:00:00')
    .toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    .toLowerCase()
}

// One row per day, most-recent-first; a note the server hasn't got a row for
// yet is just empty text that a first edit will create.
type NoteMap = Record<string, { today_text: string; tomorrow_text: string }>

const DAYS = 7

export function DailyPlan() {
  const today = localDateStr(new Date())
  const [offset, setOffset] = useState(0) // 0 = today, -1 = yesterday, ...
  const [today_text, setTodayText] = useState('')
  const [tomorrow_text, setTomorrowText] = useState('')
  const [status, setStatus] = useState<SaveState>('idle')

  const notesRef = useRef<NoteMap>({})
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const date = shiftDate(today, offset)

  const load = useCallback(
    (showing: string) =>
      listDailyNotes(DAYS)
        .then((rows) => {
          const map: NoteMap = {}
          rows.forEach((r) => {
            map[r.date] = { today_text: r.today_text, tomorrow_text: r.tomorrow_text }
          })
          notesRef.current = map
          const n = map[showing]
          setTodayText(n?.today_text ?? '')
          setTomorrowText(n?.tomorrow_text ?? '')
        })
        .catch(() => {}),
    [],
  )

  useEffect(() => {
    void load(today)
  }, [today, load])

  // "what should i do first" writes straight into today's box on the server,
  // so the box has to re-read itself. Only when today is the day on screen and
  // nothing is mid-save, so it can't overwrite what's being typed.
  useEffect(() => {
    const onCreated = () => {
      if (date !== today || saveTimer.current !== undefined) return
      void load(today)
    }
    window.addEventListener('life-log-created', onCreated)
    return () => window.removeEventListener('life-log-created', onCreated)
  }, [date, today, load])

  // On paging to a different day, load that day's text from what we already
  // fetched. Reads through a ref so a background save (which updates the map)
  // never clobbers what the user is currently typing.
  useEffect(() => {
    const n = notesRef.current[date]
    setTodayText(n?.today_text ?? '')
    setTomorrowText(n?.tomorrow_text ?? '')
  }, [date])

  const scheduleSave = (next: { today_text: string; tomorrow_text: string }) => {
    const target = date
    setStatus('saving')
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      // Cleared once it fires so "is a save pending" stays an honest question -
      // the refresh listener reads it to decide whether it may replace the text.
      saveTimer.current = undefined
      try {
        await patchDailyNote(target, next)
        notesRef.current[target] = next
        setStatus('saved')
        setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 1600)
      } catch {
        setStatus('idle')
      }
    }, 800)
  }

  const onToday = (v: string) => {
    setTodayText(v)
    scheduleSave({ today_text: v, tomorrow_text })
  }
  const onTomorrow = (v: string) => {
    setTomorrowText(v)
    scheduleSave({ today_text, tomorrow_text: v })
  }

  const canForward = offset < 0

  return (
    <div className="daily">
      <div className="daily-head">
        <div className="daily-nav">
          <button
            className="chev"
            onClick={() => setOffset((o) => Math.max(o - 1, -(DAYS - 1)))}
            disabled={offset <= -(DAYS - 1)}
            aria-label="previous day"
          >
            &lsaquo;
          </button>
          <span className="daily-daylabel">{dayLabel(date, offset)}</span>
          <button
            className="chev"
            onClick={() => setOffset((o) => Math.min(o + 1, 0))}
            disabled={!canForward}
            aria-label="next day"
          >
            &rsaquo;
          </button>
        </div>
        <span className={`daily-saved ${status}`}>
          {status === 'saving' ? 'saving…' : status === 'saved' ? 'saved' : ''}
        </span>
      </div>
      <div className="daily-grid">
        <AutoField label="today" value={today_text} onChange={onToday} placeholder="what's the plan…" />
        <AutoField
          label="tomorrow"
          value={tomorrow_text}
          onChange={onTomorrow}
          placeholder="carries into tomorrow's today…"
        />
      </div>
    </div>
  )
}

function AutoField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  return (
    <label className="daily-field">
      <span className="daily-label">{label}</span>
      <textarea
        ref={ref}
        className="daily-text"
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}
