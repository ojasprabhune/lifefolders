import { useCallback, useEffect, useState } from 'react'
import { rankList } from './api'
import { Expand } from './Expand'
import { Panel, usePanelState } from './Panel'
import { RateModal, rateProps } from './RateModal'
import type { AlbumGroups, Log, Tier, TripData } from './types'
import { Quip } from './Quip'

const TIER_ORDER: Tier[] = ['loved', 'fine', 'disliked']

export function Travel({ open }: { open: boolean }) {
  const [groups, setGroups] = useState<AlbumGroups | null>(null)
  const [rateLog, setRateLog] = useState<Log | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const { mounted, closing } = usePanelState(open)

  const refresh = useCallback(async () => {
    try {
      setGroups(await rankList('trip'))
    } catch {
      // keep current list
    }
  }, [])

  useEffect(() => {
    if (!mounted) return
    void refresh()
  }, [mounted, refresh])

  const trips = groups ? [...TIER_ORDER.flatMap((t) => groups[t]), ...groups.unrated] : []

  if (!mounted) return null

  return (
    <Panel closing={closing}>
      <header>
        <h1 className="brand">
          travel
          <Quip domain="travel" />
        </h1>
        <a className="guide-link" href="#/">
          back
        </a>
      </header>

      <main className="list">
        {trips.map((trip) => {
          const data = trip.data as TripData
          const open = expandedId === trip.id
          return (
            <div key={trip.id} className={`row-wrap ${open ? 'open' : ''}`}>
              <div className="row" onClick={() => setExpandedId(open ? null : trip.id)}>
                <span className="row-main">
                  {data.destination}
                  {data.start_date && <span className="row-sub"> {data.start_date}</span>}
                </span>
                <span className="row-right">
                  {data.rating !== null ? (
                    data.rating.toFixed(1)
                  ) : (
                    <button
                      className="rate-link"
                      onClick={(e) => {
                        e.stopPropagation()
                        setRateLog(trip)
                      }}
                    >
                      rate
                    </button>
                  )}
                </span>
              </div>
              <Expand open={open}>
                    <div className="editor">
                      {data.itinerary.length > 0 ? (
                        <div className="itinerary">
                          {data.itinerary.map((item, i) => (
                            <div key={i} className="itinerary-item">
                              <span>{item.name}</span>
                              {item.note && <span className="row-sub"> {item.note}</span>}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="workout-meta">no itinerary yet</span>
                      )}
                      {data.thoughts && <p className="workout-notes">{data.thoughts}</p>}
                      {data.rating !== null && (
                        <div className="editor-footer">
                          <span className="editor-meta">{data.rating_tier}</span>
                          <button className="action" onClick={() => setRateLog(trip)}>
                            re-rank
                          </button>
                        </div>
                      )}
                    </div>
              </Expand>
            </div>
          )
        })}
        {trips.length === 0 && <div className="empty">no trips logged</div>}
      </main>

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
