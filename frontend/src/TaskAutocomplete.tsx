import { useEffect, useRef } from 'react'
// A wish is offered alongside the open sidequests and marked as one, so a
// name shared by both is never a guess.
export interface Suggestion {
  id: string
  title: string
  wish?: boolean
}

interface TaskAutocompleteProps {
  items: Suggestion[]
  activeIndex: number
  left: number
  top: number
  closing: boolean
  onHover: (index: number) => void
  onAccept: (item: Suggestion) => void
}

export function TaskAutocomplete({
  items,
  activeIndex,
  left,
  top,
  closing,
  onHover,
  onAccept,
}: TaskAutocompleteProps) {
  const activeRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <ul className={`task-autocomplete ${closing ? 'closing' : ''}`} style={{ left, top }}>
      {items.map((item, i) => (
        <li
          key={item.id}
          ref={i === activeIndex ? activeRef : undefined}
          className={i === activeIndex ? 'active' : ''}
          // Keeps focus on the entry input - a click would otherwise blur it
          // before the click handler ever runs.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onAccept(item)}
        >
          {item.title}
          {item.wish && <span className="ac-tag">wish</span>}
        </li>
      ))}
    </ul>
  )
}
