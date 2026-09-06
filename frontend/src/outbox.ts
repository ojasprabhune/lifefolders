/**
 * Entries that were typed but whose write has not been confirmed. Kept on disk
 * so that closing the tab, or a reload, mid-request doesn't take the sentence
 * with it.
 *
 * Nothing here is ever replayed automatically. The backend has no idempotency
 * key, so a request that actually succeeded and only lost its response would
 * come back a second time as a duplicate entry. Leftovers are handed back as
 * the same failed rows a dead network produces, and retrying is a tap.
 */
const KEY = 'life_outbox'

export interface OutboxEntry {
  tempId: string
  raw: string
}

function read(): OutboxEntry[] {
  try {
    const rows = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function write(rows: OutboxEntry[]) {
  try {
    if (rows.length === 0) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(rows))
  } catch {
    // nothing to do
  }
}

export function rememberOutbox(tempId: string, raw: string) {
  write([...read().filter((e) => e.tempId !== tempId), { tempId, raw }])
}

export function forgetOutbox(tempId: string) {
  write(read().filter((e) => e.tempId !== tempId))
}

// Drained once per page load, not once per mount. Home unmounts on the way out
// to a full-page route, and a second read would pick up whatever is in flight
// right now and offer it back as though it had failed.
let drained = false

export function takeOutbox(): OutboxEntry[] {
  if (drained) return []
  drained = true
  const rows = read()
  if (rows.length > 0) write([])
  return rows
}
