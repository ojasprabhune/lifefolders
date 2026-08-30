import { useEffect, useMemo, useRef, useState } from 'react'
import { getHiddenDomains, searchLogs } from './api'
import { DOMAINS } from './domains'
import { Panel, usePanelState } from './Panel'
import { RateModal, rateProps } from './RateModal'
import { Row } from './Row'
import type { Log } from './types'

function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function dateLabel(date: string): string {
  const today = new Date()
  if (date === localDateStr(today)) return 'today'
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date === localDateStr(yesterday)) return 'yesterday'
  return new Date(date + 'T12:00:00')
    .toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    .toLowerCase()
}

export function Search({ open }: { open: boolean }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Log[]>([])
  const [searched, setSearched] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [rateLog, setRateLog] = useState<Log | null>(null)
  const [hiddenDomains] = useState<string[]>(() => getHiddenDomains())
  const inputRef = useRef<HTMLInputElement>(null)
  const { mounted, closing } = usePanelState(open)

  const hiddenParsedTypes = useMemo(
    () =>
      new Set(DOMAINS.filter((d) => hiddenDomains.includes(d.id)).flatMap((d) => d.parsedTypes)),
    [hiddenDomains],
  )

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setResults([])
      setSearched(false)
      return
    }
    let stale = false
    const t = setTimeout(() => {
      searchLogs(term)
        .then((found) => {
          if (stale) return
          setResults(found)
          setSearched(true)
        })
        .catch(() => {})
    }, 250)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [q])

  const days = useMemo(() => {
    const byDate = new Map<string, Log[]>()
    for (const log of results) {
      if (hiddenParsedTypes.has(log.parsed_type)) continue
      const key = localDateStr(new Date(log.created_at))
      const existing = byDate.get(key)
      if (existing) existing.push(log)
      else byDate.set(key, [log])
    }
    return [...byDate]
  }, [results, hiddenParsedTypes])

  if (!mounted) return null

  return (
    <Panel closing={closing}>
      <header>
        <h1 className="brand">search</h1>
        <a className="guide-link" href="#/">
          back
        </a>
      </header>

      <input
        ref={inputRef}
        className="entry-input search-input"
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="find anything logged..."
      />

      <main className="list">
        {days.map(([date, logs]) => (
          <section key={date} className="music-section">
            <h2 className="section-title">{dateLabel(date)}</h2>
            {logs.map((log) => (
              <Row
                restored={false}
                key={log.id}
                log={log}
                justParsed={false}
                expanded={expandedId === log.id}
                onToggle={() => setExpandedId(expandedId === log.id ? null : log.id)}
                onChange={(updated) =>
                  setResults((r) => r.map((x) => (x.id === updated.id ? updated : x)))
                }
                onDelete={(id) => setResults((r) => r.filter((x) => x.id !== id))}
                onRate={(l) => setRateLog(l)}
              />
            ))}
          </section>
        ))}
        {searched && days.length === 0 && <div className="empty">nothing found</div>}
      </main>

      {rateLog && (
        <RateModal
          {...rateProps(rateLog)}
          itemId={rateLog.id}
          onClose={() => setRateLog(null)}
        />
      )}
    </Panel>
  )
}
