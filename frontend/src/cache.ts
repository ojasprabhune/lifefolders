import type { Log, TaskWithCheckpoints } from './types'

/**
 * A first-frame copy of the two lists you look at most.
 *
 * This is not a data layer and nothing here is ever trusted for longer than
 * one fetch: the real request always follows and replaces whatever was
 * painted. It exists because the backend sleeps after fifteen idle minutes, so
 * opening the app is regularly thirty seconds of empty panel - and the rows
 * that were there when you closed it are almost always still the right ones.
 *
 * Bumping VERSION is how a shape change is retired; a mismatched or unreadable
 * entry is simply ignored, since the fetch covers it.
 */
const VERSION = 1
const TASKS_KEY = 'life_cache_tasks'
const LOGS_KEY = 'life_cache_logs'

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed?.v === VERSION ? (parsed.d as T) : null
  } catch {
    return null
  }
}

function write(key: string, data: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify({ v: VERSION, d: data }))
  } catch {
    // A full or disabled localStorage costs a first-frame paint, nothing else.
  }
}

export function cachedTasks(): TaskWithCheckpoints[] | null {
  const rows = read<TaskWithCheckpoints[]>(TASKS_KEY)
  return Array.isArray(rows) ? rows : null
}

export function cacheTasks(tasks: TaskWithCheckpoints[]) {
  write(TASKS_KEY, tasks)
}

// One day only - the day you were last on, which on any normal visit is today.
// Painting yesterday's rows under today's heading would be worse than blank.
export function cachedLogs(date: string): Log[] | null {
  const entry = read<{ date: string; logs: Log[] }>(LOGS_KEY)
  return entry && entry.date === date && Array.isArray(entry.logs) ? entry.logs : null
}

export function cacheLogs(date: string, logs: Log[]) {
  write(LOGS_KEY, { date, logs })
}

export function clearCaches() {
  try {
    localStorage.removeItem(TASKS_KEY)
    localStorage.removeItem(LOGS_KEY)
  } catch {
    // nothing to do
  }
}
