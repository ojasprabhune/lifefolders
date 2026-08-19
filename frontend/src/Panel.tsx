import { useEffect, useState } from 'react'

// Keeps a panel mounted for one closing animation after `open` goes false,
// instead of vanishing instantly - same lifecycle Tasks used before this was
// shared out to every dashboard page.
export function usePanelState(open: boolean, closeMs = 220) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
    } else if (mounted) {
      setClosing(true)
      const t = setTimeout(() => setMounted(false), closeMs)
      return () => clearTimeout(t)
    }
  }, [open, mounted, closeMs])

  return { mounted, closing }
}

// Shared "half on the right" chrome: sits beside Home on wide screens, slides
// in as a full-width overlay with a dimming backdrop below ~900px. Each page
// owns its own header/back-link as children; this only owns the open/close
// animation. Not used by focus (full-screen timer) or guide (not a domain).
export function Panel({ closing, children }: { closing: boolean; children: React.ReactNode }) {
  return (
    <>
      <div
        className={`panel-backdrop ${closing ? 'closing' : ''}`}
        onClick={() => {
          window.location.hash = '#/'
        }}
      />
      <div className={`side-panel ${closing ? 'closing' : ''}`}>{children}</div>
    </>
  )
}
