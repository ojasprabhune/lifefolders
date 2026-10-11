import { useEffect, useRef } from 'react'
import type { TaskWithCheckpoints } from './types'

interface TaskAutocompleteProps {
  items: TaskWithCheckpoints[]
  activeIndex: number
  left: number
  top: number
  closing: boolean
  onHover: (index: number) => void
  onAccept: (item: TaskWithCheckpoints) => void
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
        </li>
      ))}
    </ul>
  )
}
