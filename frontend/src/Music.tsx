import { useCallback, useEffect, useState } from 'react'
import { listAlbums, listSongs, updateLog } from './api'
import { Panel, usePanelState } from './Panel'
import { RateModal, rateProps } from './RateModal'
import type { AlbumData, AlbumGroups, Log, SongData, Tier } from './types'
import { Quip } from './Quip'

const TIER_ORDER: Tier[] = ['loved', 'fine', 'disliked']

export function Music({ open }: { open: boolean }) {
  const [groups, setGroups] = useState<AlbumGroups | null>(null)
  const [queue, setQueue] = useState<Log[]>([])
  const [rateAlbum, setRateAlbum] = useState<Log | null>(null)
  const { mounted, closing } = usePanelState(open)

  const refresh = useCallback(async () => {
    try {
      const [albums, songs] = await Promise.all([listAlbums(), listSongs('to_revisit')])
      setGroups(albums)
      setQueue(songs)
    } catch {
      // leave whatever is rendered
    }
  }, [])

  useEffect(() => {
    if (!mounted) return
    void refresh()
  }, [mounted, refresh])

  const markRevisited = async (song: Log) => {
    setQueue((q) => q.filter((s) => s.id !== song.id))
    try {
      await updateLog(song.id, { data: { status: 'revisited' } })
    } catch {
      setQueue((q) => [song, ...q])
    }
  }

  if (!mounted) return null

  return (
    <Panel closing={closing}>
      <header>
        <h1 className="brand">
          music
          <Quip domain="music" />
        </h1>
        <a className="guide-link" href="#/">
          back
        </a>
      </header>

      <section className="music-section">
        <h2 className="section-title">albums</h2>
        {groups &&
          TIER_ORDER.map((tier) => {
            const albums = groups[tier]
            if (albums.length === 0) return null
            return (
              <div key={tier} className="tier-group">
                <span className="tier-label">{tier}</span>
                {albums.map((album) => (
                  <AlbumRow key={album.id} album={album} onRate={() => setRateAlbum(album)} />
                ))}
              </div>
            )
          })}
        {groups && groups.unrated.length > 0 && (
          <div className="tier-group">
            <span className="tier-label">unrated</span>
            {groups.unrated.map((album) => (
              <AlbumRow key={album.id} album={album} onRate={() => setRateAlbum(album)} />
            ))}
          </div>
        )}
        {groups &&
          groups.unrated.length === 0 &&
          TIER_ORDER.every((t) => groups[t].length === 0) && (
            <div className="empty">no albums logged</div>
          )}
      </section>

      <section className="music-section">
        <h2 className="section-title">revisit</h2>
        {queue.map((song) => {
          const data = song.data as SongData
          return (
            <div key={song.id} className="row music-row">
              <span className="row-main">
                {data.title ? `${data.title}${data.artist ? `, ${data.artist}` : ''}` : data.context}
                {data.title && data.context && <span className="row-sub"> {data.context}</span>}
              </span>
              <button className="action save" onClick={() => void markRevisited(song)}>
                revisited
              </button>
            </div>
          )
        })}
        {queue.length === 0 && <div className="empty">nothing to revisit</div>}
      </section>

      {rateAlbum && (
        <RateModal
          {...rateProps(rateAlbum)}
          itemId={rateAlbum.id}
          onClose={(rated) => {
            setRateAlbum(null)
            if (rated) void refresh()
          }}
        />
      )}
    </Panel>
  )
}

function AlbumRow({ album, onRate }: { album: Log; onRate: () => void }) {
  const data = album.data as AlbumData
  return (
    <div className="row music-row" onClick={onRate}>
      <span className="row-main">
        {data.title}
        <span className="row-sub"> {data.artist}</span>
      </span>
      <span className="row-right">
        {data.rating !== null ? data.rating.toFixed(1) : <span className="rate-link">rate</span>}
      </span>
    </div>
  )
}
