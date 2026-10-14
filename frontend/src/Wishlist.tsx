import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { addWishlistItem, archiveWishlistItem, listWishlist, patchWishlistItem } from './api'
import { cacheWishlist } from './cache'
import { Expand } from './Expand'
import { Panel, usePanelState } from './Panel'
import type { WishlistItem, WishlistKind } from './types'
import { Quip } from './Quip'

const KINDS: WishlistKind[] = ['album', 'song', 'place', 'trip', 'learning', 'other']

const KIND_LABEL: Record<WishlistKind, string> = {
  album: 'albums',
  song: 'songs',
  place: 'places',
  trip: 'trips',
  learning: 'learning',
  other: 'other',
}

function daysBetween(from: string, to: number): number {
  return Math.max(0, Math.floor((to - Date.parse(from)) / 86400000))
}

function ageLabel(iso: string): string {
  const days = daysBetween(iso, Date.now())
  if (days === 0) return 'today'
  if (days === 1) return '1 day'
  return `${days} days`
}

// How long it actually sat there, not how old it is now.
function waitLabel(item: WishlistItem): string {
  const days = daysBetween(item.created_at, Date.parse(item.resolved_at ?? item.created_at))
  if (days === 0) return 'same day'
  if (days === 1) return '1 day'
  return `${days} days`
}

export function Wishlist({ open }: { open: boolean }) {
  const [items, setItems] = useState<WishlistItem[]>([])
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<WishlistKind>('album')
  const [showResolved, setShowResolved] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [dragOver, setDragOver] = useState<WishlistKind | null>(null)
  const { mounted, closing } = usePanelState(open)

  // Also feeds the entry box's autocomplete, which reads the cache.
  const refresh = useCallback(() => {
    listWishlist()
      .then((all) => {
        setItems(all)
        cacheWishlist(all)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!mounted) return
    refresh()
    window.addEventListener('life-log-created', refresh)
    return () => window.removeEventListener('life-log-created', refresh)
  }, [mounted, refresh])

  const add = async () => {
    const value = title.trim()
    if (!value) return
    setTitle('')
    await addWishlistItem({ kind, title: value }).catch(() => {})
    refresh()
  }

  const resolve = async (item: WishlistItem) => {
    setItems((all) =>
      all.map((i) => (i.id === item.id ? { ...i, resolved_at: new Date().toISOString() } : i)),
    )
    await patchWishlistItem(item.id, { resolved: true }).catch(() => {})
    refresh()
  }

  const move = async (id: string, to: WishlistKind) => {
    const item = items.find((i) => i.id === id)
    if (!item || item.kind === to) return
    setItems((all) => all.map((i) => (i.id === id ? { ...i, kind: to } : i)))
    await patchWishlistItem(id, { kind: to }).catch(() => {})
    refresh()
  }

  const remove = async (id: string) => {
    setItems((all) => all.filter((i) => i.id !== id))
    await archiveWishlistItem(id).catch(() => {})
    refresh()
  }

  const openItems = useMemo(() => items.filter((i) => !i.resolved_at), [items])
  const resolved = useMemo(
    () =>
      items
        .filter((i) => i.resolved_at)
        .sort((a, b) => (b.resolved_at ?? '').localeCompare(a.resolved_at ?? '')),
    [items],
  )

  if (!mounted) return null

  return (
    <Panel closing={closing}>
      <header>
        <h1 className="brand">
          wishlist
          <Quip domain="wishlist" />
        </h1>
        <a className="guide-link" href="#/">
          back
        </a>
      </header>

      <div className="wish-add">
        <input
          className="wish-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          placeholder="something to do later..."
        />
        <select
          className="wish-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as WishlistKind)}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>

      <main
        className="list"
        // A drag cancelled with Esc leaves no dragleave behind.
        onDragEnd={() => {
          setDragging(false)
          setDragOver(null)
        }}
      >
        {KINDS.map((k) => {
          const group = openItems.filter((i) => i.kind === k)
          // Empty kinds only exist as somewhere to drop while a drag is on.
          if (group.length === 0 && !dragging) return null
          return (
            <section
              key={k}
              className={`music-section task-section ${dragOver === k ? 'drag-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                if (dragOver !== k) setDragOver(k)
              }}
              // Same rule as the sidequests panel: a leave into a child is not
              // a leave.
              onDragLeave={(e) => {
                const to = e.relatedTarget as Node | null
                if (!to || e.currentTarget.contains(to)) return
                setDragOver((c) => (c === k ? null : c))
              }}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                setDragOver(null)
                const id = e.dataTransfer.getData('text/plain')
                if (id) void move(id, k)
              }}
            >
              <h2 className="section-title">{KIND_LABEL[k]}</h2>
              {group.map((item) => (
                <WishRow
                  key={item.id}
                  item={item}
                  onDragStart={() => setDragging(true)}
                  onResolve={() => void resolve(item)}
                  onRemove={() => void remove(item.id)}
                  onSaved={refresh}
                />
              ))}
              {group.length === 0 && <div className="wish-drop">drop here</div>}
            </section>
          )
        })}

        {openItems.length === 0 && <div className="empty">nothing on the list yet</div>}

        {resolved.length > 0 && (
          <div className="resolved-section">
            {/* A <details> opens and closes instantly, and this is a list. */}
            <button
              className="section-title resolved-summary"
              onClick={() => setShowResolved((v) => !v)}
            >
              done ({resolved.length})
            </button>
            <Expand open={showResolved}>
              <div className="resolved-list">
                {resolved.map((item) => (
                  <div key={item.id} className="row music-row">
                    <span className="row-main">{item.title}</span>
                    <span className="row-right">waited {waitLabel(item)}</span>
                  </div>
                ))}
              </div>
            </Expand>
          </div>
        )}
      </main>
    </Panel>
  )
}

function WishRow({
  item,
  onDragStart,
  onResolve,
  onRemove,
  onSaved,
}: {
  item: WishlistItem
  onDragStart: () => void
  onResolve: () => void
  onRemove: () => void
  onSaved: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [titleDraft, setTitleDraft] = useState(item.title)
  const [noteDraft, setNoteDraft] = useState(item.detail ?? '')
  const ghostRef = useRef<HTMLElement | null>(null)
  const noteFieldRef = useRef<HTMLTextAreaElement>(null)
  const noteLines = (item.detail ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  // Layout effect for the same reason as the sidequest card's: <Expand>
  // measures in a plain effect and would otherwise cap the pre-grow height.
  useLayoutEffect(() => {
    const el = noteFieldRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [noteDraft, expanded])

  // A typed entry can append a line or rename it underneath; never while the
  // field is being typed in.
  useEffect(() => {
    setNoteDraft((d) => (document.activeElement?.tagName !== 'TEXTAREA' ? item.detail ?? '' : d))
  }, [item.detail])

  useEffect(() => {
    setTitleDraft((d) => (document.activeElement?.tagName !== 'INPUT' ? item.title : d))
  }, [item.title])

  const saveTitle = async () => {
    const next = titleDraft.trim()
    if (!next) {
      setTitleDraft(item.title)
      return
    }
    if (next === item.title) return
    await patchWishlistItem(item.id, { title: next }).catch(() => {})
    onSaved()
  }

  const saveNote = async () => {
    const next = noteDraft.trim()
    if (next === (item.detail ?? '')) return
    await patchWishlistItem(item.id, { detail: next }).catch(() => {})
    onSaved()
  }

  return (
    <div className={`wish-row-wrap ${expanded ? 'open' : ''}`}>
      <div
        className={`row wish-row ${dragging ? 'dragging' : ''}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', item.id)
          e.dataTransfer.effectAllowed = 'move'
          setDragging(true)
          // Deferred: adding the empty kinds' drop zones inside dragstart
          // itself can make the browser abort the drag.
          window.setTimeout(onDragStart, 0)
          // The browser's own drag image comes back blank inside .side-panel -
          // same workaround as the sidequest rows.
          const row = e.currentTarget
          const rect = row.getBoundingClientRect()
          const ghost = row.cloneNode(true) as HTMLElement
          ghost.style.position = 'fixed'
          ghost.style.top = '-1000px'
          ghost.style.left = '0'
          ghost.style.width = `${rect.width}px`
          ghost.style.background = 'var(--bg)'
          ghost.style.pointerEvents = 'none'
          document.body.appendChild(ghost)
          ghostRef.current = ghost
          e.dataTransfer.setDragImage(ghost, e.clientX - rect.left, e.clientY - rect.top)
        }}
        onDragEnd={() => {
          setDragging(false)
          ghostRef.current?.remove()
          ghostRef.current = null
        }}
      >
        <span className="row-main" onClick={() => setExpanded((v) => !v)}>
          {item.title}
          {noteLines.length > 0 && (
            <span className="wish-note">
              {noteLines.map((line, i) => (
                <span key={i}>{line}</span>
              ))}
            </span>
          )}
        </span>
        <span className="row-right">
          <span className="wish-age">{ageLabel(item.created_at)}</span>
          <button className="action save" onClick={onResolve}>
            done
          </button>
          <button className="dismiss" onClick={onRemove} aria-label="remove">
            &times;
          </button>
        </span>
      </div>
      <Expand open={expanded}>
        <div className="task-note-edit wish-edit">
          <input
            className="task-title-input"
            value={titleDraft}
            placeholder="title"
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setTitleDraft(item.title)
                e.currentTarget.blur()
              }
            }}
          />
          <textarea
            ref={noteFieldRef}
            rows={2}
            value={noteDraft}
            placeholder="note"
            onChange={(e) => setNoteDraft(e.target.value)}
            onBlur={() => void saveNote()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.blur()
            }}
          />
          {noteDraft !== (item.detail ?? '') && <span className="task-note-hint">unsaved</span>}
        </div>
      </Expand>
    </div>
  )
}
