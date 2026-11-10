import { LOCAL_ID_PREFIX } from './optimistic'
import type { Log, TaskData, TaskWithCheckpoints } from './types'

/**
 * A sidequest changed by clicking can leave the same timeline row a typed
 * change does - for the milestones only: finishing, reopening, rescheduling,
 * deleting. Starting, dragging between sections, renaming and note edits
 * write nothing, here or on the server; the tasks table carries the result.
 * A milestone's row is on the timeline before the request has left the
 * browser - clicking a status circle and waiting a round trip for its record
 * to appear is the delay the typed path already got rid of.
 *
 * The words are worked out here and again by `tasks::history_of` on the
 * server, which writes the real row. They have to agree exactly: the drawn
 * row is swapped for the server's in place, and any difference in its text
 * reads to the timeline as an edit and flashes.
 *
 * The panel and the timeline are separate trees, so this talks to Home with
 * a window event: `draw` with the local row, then `settle` with the server's
 * copy, or with null when nothing was written or the request failed.
 */
export type HistoryEvent =
  | { kind: 'draw'; log: Log }
  | { kind: 'settle'; localId: string; log: Log | null }

export const HISTORY_EVENT = 'life-history'

type Patch = Partial<Pick<TaskWithCheckpoints, 'title' | 'status' | 'due_date' | 'category' | 'is_exam' | 'note'>>

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// chrono's "%a %b %-d".
function prettyDate(d: string): string {
  const date = new Date(d + 'T00:00')
  return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}`
}

function historyOf(before: TaskWithCheckpoints, change: Patch | 'deleted'): { raw: string; data: TaskData } | null {
  const after = change === 'deleted' ? before : { ...before, ...change }
  const data: TaskData = {
    task_id: before.id,
    title: after.title,
    category: after.category,
    due_date: after.due_date,
    due_time: after.due_time,
    status: after.status,
    is_exam: after.is_exam,
    action: 'status',
    note: null,
  }
  const title = after.title
  if (change === 'deleted') return { raw: `deleted ${title}`, data: { ...data, action: 'deleted' } }
  if (after.status !== before.status) {
    // Starting is state, not an event - the pill flips it freely. Finishing
    // and reopening (which undoes a finished row) are the milestones, the
    // same ones the server keeps (`tasks::history_of`).
    if (after.status !== 'done' && !(after.status === 'not_started' && before.status === 'done')) return null
    const raw = after.status === 'done' ? `finished ${title}` : `reopened ${title}`
    return { raw, data }
  }
  if (after.due_date !== before.due_date) {
    const raw = after.due_date ? `moved ${title} to ${prettyDate(after.due_date)}` : `cleared the due date on ${title}`
    return { raw, data: { ...data, action: 'rescheduled', previous_due_date: before.due_date } }
  }
  // Dragging between sections, renaming and note edits write nothing - the
  // server writes none either, and a drawn row it doesn't answer would be
  // removed the moment the response landed. The tasks table carries the
  // result; reorganizing isn't an event.
  return null
}

function emit(detail: HistoryEvent) {
  window.dispatchEvent(new CustomEvent<HistoryEvent>(HISTORY_EVENT, { detail }))
}

let seq = 0

/**
 * Run a click's request with its timeline row drawn up front. `change` is the
 * patch as the server will apply it (trimmed, with an emptied note as null),
 * so the guess here is the same one the server makes. `send` resolves to the
 * row the server wrote.
 */
export async function withHistory(
  before: TaskWithCheckpoints,
  change: Patch | 'deleted',
  send: () => Promise<Log | null>,
): Promise<void> {
  const guess = historyOf(before, change)
  const localId = guess ? `${LOCAL_ID_PREFIX}hist-${++seq}` : null
  if (guess && localId) {
    emit({
      kind: 'draw',
      log: {
        id: localId,
        localId,
        created_at: new Date().toISOString(),
        raw_input: guess.raw,
        parsed_type: 'task',
        data: guess.data,
      },
    })
  }
  const log = await send().catch(() => null)
  if (localId) emit({ kind: 'settle', localId, log })
  // A row the server wrote that the guess didn't foresee is still history.
  else if (log) emit({ kind: 'draw', log })
}
