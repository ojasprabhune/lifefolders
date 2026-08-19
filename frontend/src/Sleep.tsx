import { useEffect, useState } from 'react'
import { listSleep } from './api'
import { Panel, usePanelState } from './Panel'
import { formatDuration } from './Row'
import type { Log, SleepData } from './types'

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function dayName(dateStr: string): string {
  return DAY_NAMES[new Date(dateStr + 'T00:00').getDay()]
}

export function Sleep({ open }: { open: boolean }) {
  const [nights, setNights] = useState<Log[]>([])
  const { mounted, closing } = usePanelState(open)

  useEffect(() => {
    if (!mounted) return
    listSleep()
      .then(setNights)
      .catch(() => {})
  }, [mounted])

  if (!mounted) return null

  return (
    <Panel closing={closing}>
      <header>
        <h1 className="brand">sleep</h1>
        <a className="guide-link" href="#/">
          back
        </a>
      </header>

      <main className="list">
        {nights.map((night) => {
          const data = night.data as SleepData
          return (
            <div key={night.id} className="row music-row">
              <span className="row-time sleep-day">{dayName(data.night_date)}</span>
              <span className="row-main">{data.night_date}</span>
              <span className="row-right">
                {data.sleep_end === null
                  ? 'sleeping'
                  : data.duration_min !== null
                    ? formatDuration(data.duration_min)
                    : 'no start recorded'}
              </span>
            </div>
          )
        })}
        {nights.length === 0 && <div className="empty">no nights logged</div>}
      </main>
    </Panel>
  )
}
