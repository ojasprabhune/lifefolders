import { useCallback, useEffect, useState } from 'react'
import { rankList } from './api'
import { Panel, usePanelState } from './Panel'
import { RateModal, rateProps } from './RateModal'
import type { AlbumGroups, Log, PlaceCategory, PlaceData, Tier } from './types'

const CATEGORIES: PlaceCategory[] = ['coffee', 'restaurant', 'bar', 'dessert', 'other']
const TIER_ORDER: Tier[] = ['loved', 'fine', 'disliked']

export function Places({ open }: { open: boolean }) {
  const [groups, setGroups] = useState<Record<string, AlbumGroups>>({})
  const [rateLog, setRateLog] = useState<Log | null>(null)
  const { mounted, closing } = usePanelState(open)

  const refresh = useCallback(async () => {
    const out: Record<string, AlbumGroups> = {}
    await Promise.all(
      CATEGORIES.map(async (cat) => {
        try {
          out[cat] = await rankList('place', cat)
        } catch {
          // skip categories that fail to load
        }
      }),
    )
    setGroups(out)
  }, [])

  useEffect(() => {
    if (!mounted) return
    void refresh()
  }, [mounted, refresh])

  const hasAny = Object.values(groups).some((g) =>
    [...TIER_ORDER.map((t) => g[t]), g.unrated].some((list) => list.length > 0),
  )

  if (!mounted) return null

  return (
    <Panel closing={closing}>
      <header>
        <h1 className="brand">places</h1>
        <a className="guide-link" href="#/">
          back
        </a>
      </header>

      {CATEGORIES.map((cat) => {
        const g = groups[cat]
        if (!g) return null
        const ranked = TIER_ORDER.flatMap((t) => g[t])
        if (ranked.length === 0 && g.unrated.length === 0) return null
        return (
          <section key={cat} className="music-section">
            <h2 className="section-title">{cat}</h2>
            {[...ranked, ...g.unrated].map((place) => {
              const data = place.data as PlaceData
              return (
                <div key={place.id} className="row music-row" onClick={() => setRateLog(place)}>
                  <span className="row-main">
                    {data.name}
                    {data.city && <span className="row-sub"> {data.city}</span>}
                  </span>
                  <span className="row-right">
                    {data.rating !== null ? data.rating.toFixed(1) : <span className="rate-link">rate</span>}
                  </span>
                </div>
              )
            })}
          </section>
        )
      })}
      {!hasAny && <div className="empty">no places logged</div>}

      {rateLog && (
        <RateModal
          {...rateProps(rateLog)}
          itemId={rateLog.id}
          onClose={(rated) => {
            setRateLog(null)
            if (rated) void refresh()
          }}
        />
      )}
    </Panel>
  )
}
