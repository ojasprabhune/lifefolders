import { useState } from 'react'
import { rankItem } from './api'
import type { Opponent, RankComparison, Tier } from './types'

interface RateModalProps {
  domain: string
  category: string | null
  itemId: string
  label: string
  onClose: (rated: boolean) => void
}

const TIERS: { value: Tier; label: string }[] = [
  { value: 'loved', label: 'loved it' },
  { value: 'fine', label: 'it was fine' },
  { value: 'disliked', label: 'disliked it' },
]

export function RateModal({ domain, category, itemId, label, onClose }: RateModalProps) {
  const [tier, setTier] = useState<Tier | null>(null)
  const [comparisons, setComparisons] = useState<RankComparison[]>([])
  const [opponent, setOpponent] = useState<Opponent | null>(null)
  const [rating, setRating] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // The parent unmounts this the moment onClose comes back, so the exit has
  // to be played here, before handing over.
  const [closing, setClosing] = useState(false)

  const dismiss = (rated: boolean) => {
    if (closing) return
    setClosing(true)
    setTimeout(() => onClose(rated), 180)
  }

  const step = async (t: Tier, comps: RankComparison[]) => {
    setBusy(true)
    setError('')
    try {
      const res = await rankItem(domain, category, itemId, t, comps)
      if (res.done) {
        setRating(res.rating)
        setTimeout(() => dismiss(true), 1100)
      } else {
        setOpponent(res.next_opponent)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ranking failed')
      setTier(null)
      setComparisons([])
      setOpponent(null)
    } finally {
      setBusy(false)
    }
  }

  const pickTier = (t: Tier) => {
    setTier(t)
    void step(t, [])
  }

  const choose = (preferred: 'this' | 'that') => {
    if (!tier || !opponent || busy) return
    const next = [...comparisons, { opponent_id: opponent.id, preferred }]
    setComparisons(next)
    void step(tier, next)
  }

  return (
    <div
      className={`modal-overlay ${closing ? 'closing' : ''}`}
      onClick={() => rating === null && dismiss(false)}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {rating !== null ? (
          <div className="modal-card result" key="result">
            <span className="modal-album">{label}</span>
            <span className="modal-rating">{rating.toFixed(1)}</span>
          </div>
        ) : tier === null ? (
          <div className="modal-card" key="tier">
            <span className="modal-album">{label}</span>
            <div className="tier-buttons">
              {TIERS.map((t) => (
                <button key={t.value} className="tier-btn" onClick={() => pickTier(t.value)}>
                  {t.label}
                </button>
              ))}
            </div>
            {error && <span className="modal-error">{error}</span>}
          </div>
        ) : (
          <div className="modal-card" key={comparisons.length}>
            <span className="modal-question">which did you prefer?</span>
            <div className="versus">
              <button className="versus-btn" disabled={busy} onClick={() => choose('this')}>
                <span className="versus-title">{label}</span>
              </button>
              {opponent && (
                <button className="versus-btn" disabled={busy} onClick={() => choose('that')}>
                  <span className="versus-title">{opponent.label}</span>
                </button>
              )}
            </div>
            {error && <span className="modal-error">{error}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

export function rateProps(log: { parsed_type: string; data: unknown }): {
  domain: string
  category: string | null
  label: string
} {
  const data = log.data as Record<string, unknown>
  switch (log.parsed_type) {
    case 'album':
      return { domain: 'album', category: null, label: `${data.title}, ${data.artist}` }
    case 'place':
      return { domain: 'place', category: String(data.category), label: String(data.name) }
    case 'trip':
      return { domain: 'trip', category: null, label: String(data.destination) }
    default:
      return { domain: '', category: null, label: '' }
  }
}
