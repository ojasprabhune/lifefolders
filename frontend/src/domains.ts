import type { Category } from './types'

// Single source of truth for "domain" as a hideable unit - the Guide page's
// hidden-domains checkboxes read/write this list by id, and it's also what
// drives which nav links, filter chips, and timeline entries disappear when
// a domain is hidden. "guide" itself is deliberately not in this list -
// hiding your way to the settings page would be a dead end.
export const DOMAINS: {
  id: string
  label: string
  navHref?: string
  filterValue?: Category
  parsedTypes: string[]
}[] = [
  { id: 'food', label: 'food', filterValue: 'nutrition', parsedTypes: ['nutrition'] },
  { id: 'people', label: 'people', filterValue: 'person', parsedTypes: ['person'] },
  { id: 'learning', label: 'learning', navHref: '#/learning', filterValue: 'learning', parsedTypes: ['learning'] },
  { id: 'soma', label: 'soma', navHref: '#/soma', filterValue: 'workout', parsedTypes: ['workout', 'weight'] },
  { id: 'music', label: 'music', navHref: '#/music', filterValue: 'music', parsedTypes: ['album', 'song'] },
  { id: 'places', label: 'places', navHref: '#/places', filterValue: 'place', parsedTypes: ['place'] },
  { id: 'travel', label: 'travel', navHref: '#/travel', filterValue: 'trip', parsedTypes: ['trip'] },
  { id: 'solace', label: 'solace', navHref: '#/sleep', filterValue: 'sleep', parsedTypes: ['sleep'] },
  {
    id: 'cadence',
    label: 'cadence',
    navHref: '#/cadences',
    filterValue: 'cadence_completion',
    parsedTypes: ['cadence_completion'],
  },
  { id: 'sidequests', label: 'sidequests', navHref: '#/tasks', filterValue: 'task', parsedTypes: ['task'] },
  { id: 'clarity', label: 'clarity', navHref: '#/focus', parsedTypes: ['focus_session'] },
  { id: 'dailyplan', label: 'daily plan', parsedTypes: [] },
  // No filterValue or parsedTypes: search isn't a kind of entry, it's a way
  // to find them. It's here so it can be hidden like anything else.
  { id: 'search', label: 'search', navHref: '#/search', parsedTypes: [] },
]
