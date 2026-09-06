import type { LocalTask } from './localParse'
import type { Log, TaskData, TaskWithCheckpoints } from './types'

/**
 * Sidequests that have been read out of a typed entry locally and are already
 * on screen, but whose write has not come back yet. Home creates them and the
 * sidequests panel renders them, and the two are not in the same tree, so this
 * is a module-level store with a subscription rather than shared state.
 *
 * The handover is deliberately gapless. When the server answers, the entry is
 * not dropped - it is given the id the server assigned, and the panel discards
 * it only once its own next fetch actually contains that id. Dropping it on
 * the response instead leaves the row missing for the length of the refetch,
 * which is a hole opening in the middle of the list.
 */
export const LOCAL_ID_PREFIX = 'local-'

type Entry = { id: string; task: TaskWithCheckpoints }

let entries: Entry[] = []
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((fn) => fn())
}

export function optimisticTasks(): TaskWithCheckpoints[] {
  return entries.map((e) => e.task)
}

export function subscribeOptimistic(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function addOptimistic(localId: string, task: TaskWithCheckpoints) {
  entries = [...entries, { id: localId, task: { ...task, id: localId } }]
  emit()
}

/** The write landed: keep showing the row, but under the id the server gave
 *  it, so the next fetch can take it over without a gap. */
export function settleOptimistic(localId: string, taskId: string) {
  entries = entries.map((e) => (e.id === localId ? { ...e, task: { ...e.task, id: taskId } } : e))
  emit()
  // clearSettled only runs when the panel is open and fetching. A settled
  // entry is invisible either way - the merge drops any id the real list
  // already has - so this is only here to stop them accumulating across a
  // session spent entirely on the timeline.
  setTimeout(() => dropOptimistic(localId), 30000)
}

export function dropOptimistic(localId: string) {
  const next = entries.filter((e) => e.id !== localId)
  if (next.length === entries.length) return
  entries = next
  emit()
}

/** Called with every fetched list: anything the server is now reporting for
 *  itself has been handed over and this copy is no longer needed. */
export function clearSettled(serverIds: Set<string>) {
  const next = entries.filter((e) => !serverIds.has(e.task.id))
  if (next.length === entries.length) return
  entries = next
  emit()
}

export function isOptimistic(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX)
}

/** The timeline row and the panel row for a locally-parsed sidequest, in the
 *  exact shape the server would have sent back for a freshly created one. */
export function optimisticLog(
  localId: string,
  raw: string,
  parsed: LocalTask,
  createdAt: string,
): Log {
  const data: TaskData = {
    task_id: localId,
    title: parsed.title,
    category: parsed.category,
    due_date: parsed.due_date,
    due_time: parsed.due_time,
    status: 'not_started',
    is_exam: parsed.is_exam,
    action: 'created',
    note: parsed.note,
  }
  return { id: localId, localId, created_at: createdAt, raw_input: raw, parsed_type: 'task', data }
}

export function optimisticTask(
  localId: string,
  parsed: LocalTask,
  createdAt: string,
): TaskWithCheckpoints {
  return {
    id: localId,
    title: parsed.title,
    category: parsed.category,
    due_date: parsed.due_date,
    due_time: parsed.due_time,
    effort_minutes: parsed.effort_minutes,
    status: 'not_started',
    is_exam: parsed.is_exam,
    note: parsed.note,
    created_at: createdAt,
    completed_at: null,
    // An exam's spaced-review checkpoints are generated server-side; they turn
    // up with the refresh a moment later rather than being guessed at here.
    checkpoints: [],
  }
}
