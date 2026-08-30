import { useCallback, useEffect, useMemo, useState } from 'react'
import { addWishlistItem, archiveWishlistItem, listWishlist, patchWishlistItem } from './api'
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
  const { mounted, closing } = usePanelState(open)

  const refresh = useCallback(() => {
    listWishlist().then(setItems).catch(() => {})
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

      <main className="list">
        {KINDS.map((k) => {
          const group = openItems.filter((i) => i.kind === k)
          if (group.length === 0) return null
          return (
            <section key={k} className="music-section">
              <h2 className="section-title">{KIND_LABEL[k]}</h2>
              {group.map((item) => (
                <div key={item.id} className="row music-row">
                  <span className="row-main">
                    {item.title}
                    {item.detail && <span className="row-sub"> {item.detail}</span>}
                  </span>
                  <span className="row-right">
                    <span className="wish-age">{ageLabel(item.created_at)}</span>
                    <button className="action save" onClick={() => void resolve(item)}>
                      done
                    </button>
                    <button className="dismiss" onClick={() => void remove(item.id)} aria-label="remove">
                      &times;
                    </button>
                  </span>
                </div>
              ))}
            </section>
          )
        })}

        {openItems.length === 0 && <div className="empty">nothing on the list yet</div>}

        {resolved.length > 0 && (
          <details className="resolved-section">
            <summary className="section-title">done ({resolved.length})</summary>
            <div className="resolved-list">
              {resolved.map((item) => (
                <div key={item.id} className="row music-row">
                  <span className="row-main">{item.title}</span>
                  <span className="row-right">waited {waitLabel(item)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </main>
    </Panel>
  )
}
