import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createLog, getHiddenDomains, getShowClock, getToken, listLogs, setToken, transcribe, undoLast } from './api'
import { getBackendState, markBackendOffline, markBackendOnline, type BackendState } from './backendStatus'
import type { Category, Log, PendingLog } from './types'
import { DOMAINS } from './domains'
import { Row } from './Row'
import { adoptFocusSession, restoreFocusSession } from './focusEngine'
import { Clock } from './Clock'
import { DailyPlan } from './DailyPlan'
import { useFlipList } from './motion'
import { Guide } from './Guide'
import { Soma } from './Soma'
import { CadenceWall, Cadences } from './Cadences'
import { SleepWall } from './SleepWall'
import { FocusTimer } from './FocusTimer'
import { FocusPill } from './FocusPill'
import { Learning } from './Learning'
import { Music } from './Music'
import { usePanelState } from './Panel'
import { Places } from './Places'
import { RateModal, rateProps } from './RateModal'
import { Search } from './Search'
import { Sleep } from './Sleep'
import { SleepReminder } from './SleepReminder'
import { Tasks } from './Tasks'
import { Travel } from './Travel'
import { Wishlist } from './Wishlist'

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
  { value: 'sleep', label: 'solace' },
  { value: 'task', label: 'sidequests' },
  { value: 'cadence_completion', label: 'cadence' },
  { value: 'wishlist', label: 'wishlist' },
]

// The backend is a free Render service that sleeps after 15 min idle, so the
// first request after a gap often fails while it cold-starts (30-60s+).
// Retry a few times with backoff before surfacing the manual retry button,
// so a cold start resolves itself instead of needing a tap.
const MIC_BARS = 5

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
  '#/search',
  '#/wishlist',
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

  // Pick a running timer back up after a reload. Needs a token, so it waits
  // for auth rather than firing at module load.
  useEffect(() => {
    if (!authed) return
    void restoreFocusSession()
  }, [authed])

  // The toggle lives in the guide, a separately mounted page, so it can't
  // just set local state here - it broadcasts instead.
  useEffect(() => {
    const onChange = () => setShowClockState(getShowClock())
    window.addEventListener('life-clock-pref-changed', onChange)
    return () => window.removeEventListener('life-clock-pref-changed', onChange)
  }, [])

  // "/" jumps to search from anywhere, except while typing - it lives here
  // rather than in Home so it still works from the guide and focus pages.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      if (getHiddenDomains().includes('search')) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      e.preventDefault()
      window.location.hash = '#/search'
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!authed) return <Gate onUnlock={() => setAuthed(true)} />

  // Guide, focus and the two walls stay full-page swaps - guide isn't a
  // domain, focus is a full-screen timer you're meant to leave (the pill
  // covers "away and back"), and a wall is a panel deliberately given the
  // whole width. Every other dashboard opens as a panel beside Home instead,
  // so switching to sidequests/music/etc. never loses today's timeline.
  let content: React.ReactNode
  if (route.startsWith('#/cadences/all')) content = <CadenceWall />
  else if (route.startsWith('#/sleep/all')) content = <SleepWall />
  else if (route.startsWith('#/guide')) content = <Guide />
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
            <Search open={route.startsWith('#/search')} />
            <Wishlist open={route.startsWith('#/wishlist')} />
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

// The Render backend sleeps after 15 min idle, so a cold start can take
// well past a normal request timeout - this surfaces that state instead of
// letting an entry just silently fail to parse.
function BackendNotice() {
  const [state, setState] = useState<BackendState>(() => getBackendState())

  useEffect(() => {
    const onChange = (e: Event) => setState((e as CustomEvent<BackendState>).detail)
    window.addEventListener('life-backend-status-changed', onChange)
    return () => window.removeEventListener('life-backend-status-changed', onChange)
  }, [])

  if (state.status === 'online') return null

  return (
    <div className="backend-notice">
      <span className="backend-notice-dot" />
      waking up the server… {state.secondsLeft}s
    </div>
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
        <h1 className="brand">
          l<span className="brand-i">i</span>fe
          <span className="brand-sub">folders</span>
        </h1>
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
  // What the list is actually showing, and which way it got there. Both have
  // to change in the same commit as the rows themselves - see `refresh`.
  const [view, setView] = useState<{ date: string; slide: 'back' | 'forward' | null }>(() => ({
    date: localDateStr(new Date()),
    slide: null,
  }))
  const pendingSlide = useRef<'back' | 'forward' | null>(null)
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
  const [restored, setRestored] = useState<Set<string>>(new Set())
  // Read by the undo handler, which is bound once and would otherwise close
  // over whatever the list held when it was installed. `refresh` writes it
  // directly as well, because undo reads it the moment its refresh resolves -
  // before this effect has had a chance to run.
  const logsRef = useRef<Log[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [rateAlbum, setRateAlbum] = useState<Log | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const today = localDateStr(new Date())
  const isToday = date === today
  const { ref: listRef, capture: captureRows } = useFlipList<HTMLElement>()

  const goDay = (delta: number) => {
    pendingSlide.current = delta < 0 ? 'back' : 'forward'
    setDate((d) => shiftDate(d, delta))
  }

  // The direction class and the remount key both have to land in the same
  // commit as the new rows. Two earlier versions got this wrong: keying the
  // slide to `date` ran the animation on the day you were leaving, and holding
  // the direction in its own state restarted the animation in place the moment
  // you reversed direction, because the class changed on an already-mounted
  // list without a remount to go with it.
  const refresh = useCallback(async (d: string) => {
    try {
      const rows = await listLogs(d, 'all')
      const slide = pendingSlide.current
      pendingSlide.current = null
      logsRef.current = rows
      setLogs(rows)
      // A same-day refresh (undo, a command) keeps the object identical, so
      // nothing about the list's animation state changes underneath it.
      setView((v) => (v.date === d && slide === null ? v : { date: d, slide }))
    } catch {
      // a failed fetch leaves the previous list; logging still works
    }
  }, [])

  useEffect(() => {
    void refresh(date)
  }, [date, refresh])

  useEffect(() => {
    logsRef.current = logs
  }, [logs])

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
      const before = new Set(logsRef.current.map((l) => l.id))
      undoLast()
        .then(async () => {
          flash('undone')
          await refresh(date)
          // An undone edit already announces itself - the row's summary
          // changes and Row flashes the field that moved. This is for the
          // other case, where undo put a whole row back that wasn't there.
          const back = logsRef.current.filter((l) => !before.has(l.id)).map((l) => l.id)
          if (back.length > 0) {
            setRestored(new Set(back))
            setTimeout(() => setRestored(new Set()), 560)
          }
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
    // Typing while looking at an earlier day logs to that day - the entry
    // lands there and the view stays put, rather than snapping back to today.
    const forDate = isToday ? undefined : date

    for (let attempt = 0; ; attempt++) {
      try {
        const {
          logs: created,
          notice: message,
          focus_session,
        } = await createLog(rawText, forDate)
        markBackendOnline()
        const createdIds = new Set(created.map((x) => x.id))
        const sleeps = created.filter((x) => x.parsed_type === 'sleep')
        const rest = created.filter((x) => x.parsed_type !== 'sleep')
        setPendings((p) => p.filter((x) => x.tempId !== id))
        setLogs((l) => [...rest, ...l.filter((x) => !createdIds.has(x.id)), ...sleeps])
        // Fires even when a command produced no logs at all - the sidequests
        // panel and any open dashboard still need to pick up the change.
        window.dispatchEvent(new Event('life-log-created'))
        if (message) {
          setNotice(message)
          setTimeout(() => setNotice(null), 6000)
        }
        if (focus_session) {
          adoptFocusSession(focus_session)
          window.location.hash = '#/focus'
        }
        setJustParsed((s) => {
          const next = new Set(s)
          created.forEach((x) => next.add(x.id))
          return next
        })
        // Outlasts the longest reveal in styles.css (the completion strike at
        // 620ms) - if this fires first the row loses its markup mid-animation.
        setTimeout(() => {
          setJustParsed((s) => {
            const next = new Set(s)
            createdIds.forEach((x) => next.delete(x))
            return next
          })
        }, 700)
        // A command writes no logs row but does change ones already on
        // screen (a deleted entry, a rescheduled sidequest), so re-read the
        // day rather than leaving a stale list.
        if (created.length === 0) void refresh(date)
        return
      } catch {
        if (attempt === 0) markBackendOffline()
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
  const barsRef = useRef<HTMLSpanElement>(null)
  const audioRef = useRef<{ ctx: AudioContext; raf: number } | null>(null)

  // The five bars are driven from the real microphone level, written to CSS
  // custom properties on the button rather than to React state - this ticks at
  // 60fps and re-rendering Home (and the whole timeline under it) that often
  // would be absurd.
  const startMeter = (stream: MediaStream) => {
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 64
    analyser.smoothingTimeConstant = 0.75
    ctx.createMediaStreamSource(stream).connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    const bucket = Math.floor(data.length / MIC_BARS)

    const tick = () => {
      analyser.getByteFrequencyData(data)
      const el = barsRef.current
      if (el) {
        for (let i = 0; i < MIC_BARS; i++) {
          let sum = 0
          for (let j = i * bucket; j < (i + 1) * bucket; j++) sum += data[j]
          const level = Math.min(1, sum / bucket / 140)
          el.style.setProperty(`--l${i}`, (0.12 + level * 0.88).toFixed(3))
        }
      }
      state.raf = requestAnimationFrame(tick)
    }
    const state = { ctx, raf: requestAnimationFrame(tick) }
    audioRef.current = state
  }

  const stopMeter = () => {
    const a = audioRef.current
    if (!a) return
    cancelAnimationFrame(a.raf)
    void a.ctx.close()
    audioRef.current = null
  }

  const startRecording = async () => {
    if (recState !== 'idle') return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      const recorder = new MediaRecorder(stream, { mimeType: mime })
      chunksRef.current = []
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data)
      recorder.onstop = async () => {
        stopMeter()
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
      startMeter(stream)
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
        <h1 className="brand">
          l<span className="brand-i">i</span>fe
          <span className="brand-sub">folders</span>
        </h1>
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

      <BackendNotice />

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
            {recState === 'recording' ? (
              <span className="mic-bars" ref={barsRef}>
                {Array.from({ length: MIC_BARS }, (_, i) => (
                  <span key={i} className="mic-bar" />
                ))}
              </span>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0" />
                <line x1="12" y1="18" x2="12" y2="21" />
              </svg>
            )}
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
          <button className="chev" onClick={() => goDay(-1)} aria-label="previous day">
            &lsaquo;
          </button>
          <span className="datelabel">{dateLabel(date)}</span>
          <button className="chev" onClick={() => goDay(1)} disabled={isToday} aria-label="next day">
            &rsaquo;
          </button>
        </div>
        <div className="filters">
          {visibleFilters.map((f) => (
            <button
              key={f.value}
              className={`filter ${category === f.value ? 'active' : ''}`}
              onClick={() => {
                captureRows()
                setCategory(f.value)
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="total">
          cals <span className="total-num">{Math.round(totalCals)}</span>
        </span>
      </div>

      <main
        className={`list day-list ${view.slide ? `slide-${view.slide}` : ''}`}
        key={view.date}
        ref={listRef}
      >
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
            restored={restored.has(log.id)}
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
