import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createLog, getHiddenDomains, getShowClock, getToken, listLogs, setToken, transcribe, undoLast } from './api'
import type { Category, Log, PendingLog } from './types'
import { DOMAINS } from './domains'
import { Row } from './Row'
import { Clock } from './Clock'
import { DailyPlan } from './DailyPlan'
import { Guide } from './Guide'
import { Soma } from './Soma'
import { Cadences } from './Cadences'
import { FocusTimer } from './FocusTimer'
import { FocusPill } from './FocusPill'
import { Learning } from './Learning'
import { Music } from './Music'
import { usePanelState } from './Panel'
import { Places } from './Places'
import { RateModal, rateProps } from './RateModal'
import { Sleep } from './Sleep'
import { SleepReminder } from './SleepReminder'
import { Tasks } from './Tasks'
import { Travel } from './Travel'

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

function dateLabel(date: string): string {
  const today = localDateStr(new Date())
  if (date === today) return 'today'
  if (date === shiftDate(today, -1)) return 'yesterday'
  return new Date(date + 'T12:00:00')
    .toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    .toLowerCase()
}

function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

const FILTERS: { value: Category; label: string }[] = [
  { value: 'all', label: 'all' },
  { value: 'nutrition', label: 'food' },
  { value: 'person', label: 'people' },
  { value: 'music', label: 'music' },
  { value: 'workout', label: 'soma' },
  { value: 'place', label: 'places' },
  { value: 'trip', label: 'travel' },
  { value: 'learning', label: 'learning' },
  { value: 'sleep', label: 'sleep' },
  { value: 'task', label: 'sidequests' },
  { value: 'cadence_completion', label: 'cadence' },
]

// The backend is a free Render service that sleeps after 15 min idle, so the
// first request after a gap often fails while it cold-starts (30-60s+).
// Retry a few times with backoff before surfacing the manual retry button,
// so a cold start resolves itself instead of needing a tap.
const RETRY_DELAYS_MS = [2000, 5000, 10000, 20000]

const PANEL_ROUTE_PREFIXES = [
  '#/music',
  '#/soma',
  '#/places',
  '#/travel',
  '#/sleep',
  '#/cadences',
  '#/learning',
  '#/tasks',
]

function matches(log: Log, category: Category): boolean {
  if (category === 'all') return true
  if (category === 'music') return log.parsed_type === 'album' || log.parsed_type === 'song'
  if (category === 'workout') return log.parsed_type === 'workout' || log.parsed_type === 'weight'
  if (category === 'task') return log.parsed_type === 'task' || log.parsed_type === 'focus_session'
  return log.parsed_type === category
}

export default function App() {
  const route = useHashRoute()
  const [authed, setAuthed] = useState(() => getToken() !== null)
  const [showClock, setShowClockState] = useState(() => getShowClock())
  // A single width-stable slot for whichever domain panel is open, instead
  // of each panel reserving its own flex column - otherwise switching
  // straight from one domain to another (soma -> sidequests) briefly mounts
  // both, and Home visibly jumps left while three columns exist at once.
  // Tracked with the same 220ms grace as an individual panel's own close, so
  // the slot doesn't collapse until the last panel inside has finished
  // animating out.
  const anyPanelOpen = PANEL_ROUTE_PREFIXES.some((p) => route.startsWith(p))
  const { mounted: slotMounted } = usePanelState(anyPanelOpen)

  useEffect(() => {
    const onUnauthorized = () => setAuthed(false)
    window.addEventListener('life-unauthorized', onUnauthorized)
    return () => window.removeEventListener('life-unauthorized', onUnauthorized)
  }, [])

  // The toggle lives in the guide, a separately mounted page, so it can't
  // just set local state here - it broadcasts instead.
  useEffect(() => {
    const onChange = () => setShowClockState(getShowClock())
    window.addEventListener('life-clock-pref-changed', onChange)
    return () => window.removeEventListener('life-clock-pref-changed', onChange)
  }, [])

  if (!authed) return <Gate onUnlock={() => setAuthed(true)} />

  // Guide and focus stay full-page swaps - guide isn't a domain, and focus is
  // a full-screen timer you're meant to leave (the pill covers "away and
  // back"). Every other dashboard opens as a panel beside Home instead, so
  // switching to sidequests/music/etc. never loses today's timeline.
  let content: React.ReactNode
  if (route.startsWith('#/guide')) content = <Guide />
  else if (route.startsWith('#/focus')) content = <FocusTimer />
  else
    content = (
      <div className="shell">
        <Home />
        {slotMounted && (
          <div className="panel-slot">
            <Music open={route.startsWith('#/music')} />
            <Soma open={route.startsWith('#/soma')} />
            <Places open={route.startsWith('#/places')} />
            <Travel open={route.startsWith('#/travel')} />
            <Sleep open={route.startsWith('#/sleep')} />
            <Cadences open={route.startsWith('#/cadences')} />
            <Learning route={route} open={route.startsWith('#/learning')} />
            <Tasks open={route.startsWith('#/tasks')} />
          </div>
        )}
      </div>
    )

  return (
    <>
      {content}
      <SleepReminder />
      <FocusPill route={route} />
      {showClock && <Clock />}
    </>
  )
}

function Gate({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState('')

  const submit = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || !value.trim()) return
    setToken(value.trim())
    onUnlock()
  }

  return (
    <div className="app">
      <header>
        <h1 className="brand">life</h1>
      </header>
      <input
        className="entry-input"
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={submit}
        placeholder="password"
        autoFocus
      />
    </div>
  )
}

function Home() {
  const [date, setDate] = useState(() => localDateStr(new Date()))
  const [category, setCategory] = useState<Category>('all')
  const [logs, setLogs] = useState<Log[]>([])
  const [hiddenDomains] = useState<string[]>(() => getHiddenDomains())
  const hiddenParsedTypes = useMemo(
    () =>
      new Set(
        DOMAINS.filter((d) => hiddenDomains.includes(d.id)).flatMap((d) => d.parsedTypes),
      ),
    [hiddenDomains],
  )
  const hiddenFilterValues = useMemo(
    () =>
      new Set(
        DOMAINS.filter((d) => hiddenDomains.includes(d.id) && d.filterValue).map(
          (d) => d.filterValue as Category,
        ),
      ),
    [hiddenDomains],
  )
  const [pendings, setPendings] = useState<PendingLog[]>([])
  const [justParsed, setJustParsed] = useState<Set<string>>(new Set())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [rateAlbum, setRateAlbum] = useState<Log | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const today = localDateStr(new Date())
  const isToday = date === today

  const refresh = useCallback(async (d: string) => {
    try {
      setLogs(await listLogs(d, 'all'))
    } catch {
      // a failed fetch leaves the previous list; logging still works
    }
  }, [])

  useEffect(() => {
    void refresh(date)
  }, [date, refresh])

  const flash = (message: string) => {
    setNotice(message)
    setTimeout(() => setNotice(null), 2500)
  }

  // Cmd/Ctrl+Z undoes the last logged entry's add/edit/delete, but only
  // when focus isn't in a text field - typing in the entry input should
  // still get plain browser undo for the text itself.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      e.preventDefault()
      undoLast()
        .then(() => {
          flash('undone')
          void refresh(date)
          window.dispatchEvent(new Event('life-log-created'))
        })
        .catch(() => flash('nothing to undo'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [date, refresh])

  const submit = async (rawText: string, tempId?: string) => {
    const id = tempId ?? `tmp-${Math.random().toString(36).slice(2)}`
    setPendings((p) => [
      { tempId: id, raw_input: rawText, failed: false, retrying: false },
      ...p.filter((x) => x.tempId !== id),
    ])
    if (!isToday) setDate(today)

    for (let attempt = 0; ; attempt++) {
      try {
        const { logs: created, notice: message } = await createLog(rawText)
        const createdIds = new Set(created.map((x) => x.id))
        const sleeps = created.filter((x) => x.parsed_type === 'sleep')
        const rest = created.filter((x) => x.parsed_type !== 'sleep')
        setPendings((p) => p.filter((x) => x.tempId !== id))
        setLogs((l) => [...rest, ...l.filter((x) => !createdIds.has(x.id)), ...sleeps])
        window.dispatchEvent(new Event('life-log-created'))
        if (message) {
          setNotice(message)
          setTimeout(() => setNotice(null), 6000)
        }
        setJustParsed((s) => {
          const next = new Set(s)
          created.forEach((x) => next.add(x.id))
          return next
        })
        setTimeout(() => {
          setJustParsed((s) => {
            const next = new Set(s)
            createdIds.forEach((x) => next.delete(x))
            return next
          })
        }, 500)
        return
      } catch {
        const delay = RETRY_DELAYS_MS[attempt]
        if (delay === undefined) {
          setPendings((p) =>
            p.map((x) => (x.tempId === id ? { ...x, failed: true, retrying: false } : x)),
          )
          return
        }
        setPendings((p) => p.map((x) => (x.tempId === id ? { ...x, retrying: true } : x)))
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  const send = () => {
    const value = text.trim()
    if (!value) return
    setText('')
    void submit(value)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') send()
  }

  const [recState, setRecState] = useState<'idle' | 'recording' | 'transcribing' | 'denied'>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const startRecording = async () => {
    if (recState !== 'idle') return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      const recorder = new MediaRecorder(stream, { mimeType: mime })
      chunksRef.current = []
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data)
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: mime })
        if (blob.size < 1000) {
          setRecState('idle')
          return
        }
        setRecState('transcribing')
        try {
          const transcript = await transcribe(blob)
          if (transcript) {
            setText((t) => (t ? `${t} ${transcript}` : transcript))
          }
        } catch {
          // leave the textbox as it was
        }
        setRecState('idle')
        inputRef.current?.focus()
      }
      recorder.start()
      recorderRef.current = recorder
      setRecState('recording')
    } catch {
      setRecState('denied')
      setTimeout(() => setRecState('idle'), 2500)
    }
  }

  const stopRecording = () => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
    }
  }

  const visible = logs.filter((l) => matches(l, category) && !hiddenParsedTypes.has(l.parsed_type))
  const visibleFilters = FILTERS.filter((f) => f.value === 'all' || !hiddenFilterValues.has(f.value))
  const totalCals = logs
    .filter((l) => l.parsed_type === 'nutrition')
    .reduce((sum, l) => sum + (Number((l.data as { calories?: number }).calories) || 0), 0)

  return (
    <div className="app">
      <header>
        <h1 className="brand">life</h1>
        <nav className="header-nav">
          {DOMAINS.filter((d) => d.navHref && !hiddenDomains.includes(d.id)).map((d) => (
            <a key={d.id} className="guide-link" href={d.navHref}>
              {d.label}
            </a>
          ))}
          <a className="guide-link" href="#/guide">
            guide
          </a>
        </nav>
      </header>

      <div className="input-wrap">
        <input
          ref={inputRef}
          className="entry-input"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            recState === 'recording'
              ? 'listening...'
              : recState === 'transcribing'
                ? 'transcribing...'
                : recState === 'denied'
                  ? 'microphone access denied'
                  : 'write anything...'
          }
          autoFocus
          enterKeyHint="send"
        />
        <div className="input-actions">
          <button
            className={`mic-btn ${recState}`}
            onPointerDown={(e) => {
              e.preventDefault()
              void startRecording()
            }}
            onPointerUp={stopRecording}
            onPointerLeave={stopRecording}
            aria-label="hold to record"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <line x1="12" y1="18" x2="12" y2="21" />
            </svg>
          </button>
          <button
            className="send-btn"
            onClick={send}
            disabled={!text.trim()}
            aria-label="log entry"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <line x1="3" y1="12" x2="20" y2="12" />
              <polyline points="13 5 20 12 13 19" />
            </svg>
          </button>
        </div>
      </div>

      {!hiddenDomains.includes('dailyplan') && <DailyPlan />}

      <div className="dateline">
        <div className="datenav">
          <button className="chev" onClick={() => setDate(shiftDate(date, -1))} aria-label="previous day">
            &lsaquo;
          </button>
          <span className="datelabel">{dateLabel(date)}</span>
          <button
            className="chev"
            onClick={() => setDate(shiftDate(date, 1))}
            disabled={isToday}
            aria-label="next day"
          >
            &rsaquo;
          </button>
        </div>
        <div className="filters">
          {visibleFilters.map((f) => (
            <button
              key={f.value}
              className={`filter ${category === f.value ? 'active' : ''}`}
              onClick={() => setCategory(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="total">
          cals <span className="total-num">{Math.round(totalCals)}</span>
        </span>
      </div>

      <main className="list">
        {notice && <div className="notice">{notice}</div>}
        {isToday &&
          pendings.map((p) => (
            <div
              key={p.tempId}
              className={`row pending ${p.failed ? 'failed' : ''}`}
              onClick={() => p.failed && void submit(p.raw_input, p.tempId)}
            >
              <span className="row-main">{p.raw_input}</span>
              <span className="row-right">
                {p.failed ? (
                  <>
                    retry
                    <button
                      className="dismiss"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPendings((x) => x.filter((y) => y.tempId !== p.tempId))
                      }}
                      aria-label="dismiss"
                    >
                      &times;
                    </button>
                  </>
                ) : p.retrying ? (
                  'retrying…'
                ) : (
                  '...'
                )}
              </span>
            </div>
          ))}
        {visible.map((log) => (
          <Row
            key={log.id}
            log={log}
            justParsed={justParsed.has(log.id)}
            expanded={expandedId === log.id}
            onToggle={() => setExpandedId(expandedId === log.id ? null : log.id)}
            onChange={(updated) =>
              setLogs((l) => l.map((x) => (x.id === updated.id ? updated : x)))
            }
            onDelete={(id) => setLogs((l) => l.filter((x) => x.id !== id))}
            onRate={(album) => setRateAlbum(album)}
          />
        ))}
        {visible.length === 0 && pendings.length === 0 && (
          <div className="empty">nothing logged</div>
        )}
      </main>

      {rateAlbum && (
        <RateModal
          {...rateProps(rateAlbum)}
          itemId={rateAlbum.id}
          onClose={(rated) => {
            setRateAlbum(null)
            if (rated) void refresh(date)
          }}
        />
      )}
    </div>
  )
}
