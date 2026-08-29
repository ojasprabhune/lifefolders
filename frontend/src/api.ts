import type {
  AlbumGroups,
  Category,
  CreateResponse,
  DailyNote,
  Field,
  FieldDetail,
  FieldSummary,
  Cadence,
  CadenceCompletions,
  CadenceSchedule,
  FocusSession,
  Log,
  StartedSession,
  ProposedTopic,
  RankComparison,
  RankResponse,
  Resource,
  Task,
  TaskCheckpoint,
  TaskWithCheckpoints,
  Tier,
  Topic,
  WishlistItem,
} from './types'

const API = import.meta.env.VITE_API_URL ?? 'https://lifefolders-api.onrender.com'
const TOKEN_KEY = 'life_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

const HIDDEN_DOMAINS_KEY = 'life_hidden_domains'

export function getHiddenDomains(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_DOMAINS_KEY) ?? '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

export function saveHiddenDomains(ids: string[]) {
  localStorage.setItem(HIDDEN_DOMAINS_KEY, JSON.stringify(ids))
}

export type Theme = 'light' | 'dark'
const THEME_KEY = 'life_theme'

// null means "no explicit choice yet" - CSS falls back to the OS preference
// via prefers-color-scheme until the switch in the guide is used once.
export function getTheme(): Theme | null {
  const t = localStorage.getItem(THEME_KEY)
  return t === 'light' || t === 'dark' ? t : null
}

export function setTheme(theme: Theme) {
  localStorage.setItem(THEME_KEY, theme)
  document.documentElement.setAttribute('data-theme', theme)
  document
    .getElementById('theme-color-meta')
    ?.setAttribute('content', theme === 'dark' ? '#1c1713' : '#fbf3ea')
}

const SHOW_CLOCK_KEY = 'life_show_clock'

export function getShowClock(): boolean {
  return localStorage.getItem(SHOW_CLOCK_KEY) === '1'
}

// Read from the guide's toggle and the always-mounted App shell separately,
// so the corner clock can appear/disappear immediately without a reload.
export function setShowClock(show: boolean) {
  localStorage.setItem(SHOW_CLOCK_KEY, show ? '1' : '0')
  window.dispatchEvent(new Event('life-clock-pref-changed'))
}

const SLEEP_GOAL_KEY = 'life_sleep_goal_min'

export function getSleepGoalMin(): number {
  const n = Number(localStorage.getItem(SLEEP_GOAL_KEY))
  return Number.isFinite(n) && n > 0 ? n : 480
}

export function setSleepGoalMin(min: number) {
  localStorage.setItem(SLEEP_GOAL_KEY, String(min))
}

// Unauthenticated and DB-free on the backend, so this succeeds the instant
// the process is up even if the Postgres connection or a real query would
// still be slow - the cheapest possible "is it alive" probe.
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/health`, { cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function check(res: Response): Promise<Response> {
  if (res.status === 401) {
    clearToken()
    window.dispatchEvent(new Event('life-unauthorized'))
    throw new Error('unauthorized')
  }
  if (!res.ok) {
    let message = `request failed (${res.status})`
    try {
      const body = await res.json()
      if (body.error) message = body.error
    } catch {
      // keep the status message
    }
    throw new Error(message)
  }
  return res
}

export async function createLog(rawText: string, forDate?: string): Promise<CreateResponse> {
  const res = await fetch(`${API}/api/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      raw_text: rawText,
      tz_offset_min: new Date().getTimezoneOffset(),
      for_date: forDate,
    }),
  })
  return (await check(res)).json()
}

export async function listWorkouts(): Promise<Log[]> {
  const res = await fetch(`${API}/api/workouts`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function listWeights(): Promise<Log[]> {
  const res = await fetch(`${API}/api/weights`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function listLogs(date: string, category: Category): Promise<Log[]> {
  const params = new URLSearchParams({
    date,
    category,
    tz_offset_min: String(new Date().getTimezoneOffset()),
  })
  const res = await fetch(`${API}/api/logs?${params}`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function searchLogs(q: string): Promise<Log[]> {
  const res = await fetch(`${API}/api/search?q=${encodeURIComponent(q)}`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function listWishlist(): Promise<WishlistItem[]> {
  const res = await fetch(`${API}/api/wishlist`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function addWishlistItem(body: {
  kind: string
  title: string
  detail?: string
}): Promise<WishlistItem> {
  const res = await fetch(`${API}/api/wishlist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  return (await check(res)).json()
}

export async function patchWishlistItem(
  id: string,
  body: { title?: string; detail?: string; resolved?: boolean },
): Promise<WishlistItem> {
  const res = await fetch(`${API}/api/wishlist/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  return (await check(res)).json()
}

export async function archiveWishlistItem(id: string): Promise<void> {
  const res = await fetch(`${API}/api/wishlist/${id}`, { method: 'DELETE', headers: authHeaders() })
  await check(res)
}

export async function listAlbums(): Promise<AlbumGroups> {
  const res = await fetch(`${API}/api/albums`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function listSongs(status: string): Promise<Log[]> {
  const res = await fetch(`${API}/api/songs?status=${status}`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function rankItem(
  domain: string,
  category: string | null,
  itemId: string,
  tier: Tier,
  comparisons: RankComparison[],
): Promise<RankResponse> {
  const res = await fetch(`${API}/api/rank`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ domain, category, item_id: itemId, tier, comparisons }),
  })
  return (await check(res)).json()
}

export async function rankList(domain: string, category?: string): Promise<AlbumGroups> {
  const params = new URLSearchParams({ domain })
  if (category) params.set('category', category)
  const res = await fetch(`${API}/api/rank/list?${params}`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function listSleep(): Promise<Log[]> {
  const res = await fetch(`${API}/api/sleep`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function getSleepInsight(
  goalMin: number,
): Promise<{ blurb: string; generated_for: string }> {
  const params = new URLSearchParams({
    tz_offset_min: String(new Date().getTimezoneOffset()),
    goal_min: String(goalMin),
  })
  const res = await fetch(`${API}/api/sleep/insight?${params}`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function transcribe(blob: Blob): Promise<string> {
  const form = new FormData()
  const ext = blob.type.includes('mp4') ? 'm4a' : 'webm'
  form.append('file', blob, `audio.${ext}`)
  const res = await fetch(`${API}/api/transcribe`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  return (((await (await check(res)).json()) as { text: string }).text ?? '').trim()
}

export async function updateLog(
  id: string,
  patch: { raw_input?: string; data?: Record<string, unknown> },
): Promise<Log> {
  const res = await fetch(`${API}/api/logs/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  })
  return (await check(res)).json()
}

export async function deleteLog(id: string): Promise<void> {
  const res = await fetch(`${API}/api/logs/${id}`, { method: 'DELETE', headers: authHeaders() })
  await check(res)
}

export async function undoLast(): Promise<void> {
  const res = await fetch(`${API}/api/undo`, { method: 'POST', headers: authHeaders() })
  await check(res)
}

const tz = () => String(new Date().getTimezoneOffset())

export async function listFields(): Promise<FieldSummary[]> {
  const res = await fetch(`${API}/api/fields?tz_offset_min=${tz()}`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function getField(id: string): Promise<FieldDetail> {
  const res = await fetch(`${API}/api/fields/${id}?tz_offset_min=${tz()}`, {
    headers: authHeaders(),
  })
  return (await check(res)).json()
}

export async function createField(body: {
  name: string
  goal_text?: string
  timeline_text?: string
}): Promise<Field> {
  const res = await fetch(`${API}/api/fields`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  return (await check(res)).json()
}

export async function addResource(
  fieldId: string,
  form: FormData,
): Promise<Resource & { notice: string | null }> {
  const res = await fetch(`${API}/api/fields/${fieldId}/resources`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  return (await check(res)).json()
}

export async function generatePlan(fieldId: string): Promise<ProposedTopic[]> {
  const res = await fetch(`${API}/api/fields/${fieldId}/plan/generate`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return (await check(res)).json()
}

export async function savePlan(fieldId: string, topics: ProposedTopic[]): Promise<Topic[]> {
  const res = await fetch(`${API}/api/fields/${fieldId}/plan`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(topics),
  })
  return (await check(res)).json()
}

export async function patchTopic(
  id: string,
  body: { status?: string; confidence?: number; name?: string },
): Promise<Topic> {
  const res = await fetch(`${API}/api/topics/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  return (await check(res)).json()
}

export async function patchResource(
  id: string,
  body: { current_unit?: number; total_units?: number; title?: string },
): Promise<Resource> {
  const res = await fetch(`${API}/api/resources/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  return (await check(res)).json()
}

export async function listTasks(): Promise<TaskWithCheckpoints[]> {
  const res = await fetch(`${API}/api/tasks`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function patchTask(
  id: string,
  body: Partial<{
    title: string
    status: string
    due_date: string
    due_time: string
    category: string
    effort_minutes: number
    is_exam: boolean
    note: string
  }>,
): Promise<Task> {
  const res = await fetch(`${API}/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  return (await check(res)).json()
}

export async function deleteTask(id: string): Promise<void> {
  const res = await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE', headers: authHeaders() })
  await check(res)
}

export async function patchCheckpoint(
  id: string,
  patch: { status?: 'todo' | 'done'; offset_days?: number },
): Promise<TaskCheckpoint> {
  const res = await fetch(`${API}/api/task-checkpoints/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  })
  return (await check(res)).json()
}

export async function listCadences(): Promise<Cadence[]> {
  const res = await fetch(`${API}/api/cadences`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function createCadence(
  body: { name: string } & Partial<CadenceSchedule>,
): Promise<Cadence> {
  const res = await fetch(`${API}/api/cadences`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  return (await check(res)).json()
}

export async function patchCadence(
  id: string,
  body: Partial<{ name: string } & CadenceSchedule>,
): Promise<Cadence> {
  const res = await fetch(`${API}/api/cadences/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  return (await check(res)).json()
}

export async function archiveCadence(id: string): Promise<void> {
  const res = await fetch(`${API}/api/cadences/${id}`, { method: 'DELETE', headers: authHeaders() })
  await check(res)
}

export async function getCadenceCompletions(id: string, days = 90): Promise<CadenceCompletions> {
  const params = new URLSearchParams({ days: String(days), tz_offset_min: tz() })
  const res = await fetch(`${API}/api/cadences/${id}/completions?${params}`, {
    headers: authHeaders(),
  })
  return (await check(res)).json()
}

export async function listAllCadenceCompletions(
  days = 90,
): Promise<Record<string, CadenceCompletions>> {
  const params = new URLSearchParams({ days: String(days), tz_offset_min: tz() })
  const res = await fetch(`${API}/api/cadence-completions?${params}`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function listDailyNotes(days = 7): Promise<DailyNote[]> {
  const params = new URLSearchParams({ days: String(days), tz_offset_min: tz() })
  const res = await fetch(`${API}/api/daily-notes?${params}`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function patchDailyNote(
  date: string,
  body: { today_text?: string; tomorrow_text?: string },
): Promise<DailyNote> {
  const res = await fetch(`${API}/api/daily-notes/${date}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  return (await check(res)).json()
}

export async function startFocusSession(body: {
  task_id?: string
  new_task?: { title: string; category?: string }
  cadence_id?: string
  planned_minutes: number
}): Promise<StartedSession> {
  const res = await fetch(`${API}/api/focus-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  return (await check(res)).json()
}

export async function getActiveFocusSession(): Promise<StartedSession | null> {
  const res = await fetch(`${API}/api/focus-sessions/active`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function pauseFocusSession(id: string): Promise<FocusSession> {
  const res = await fetch(`${API}/api/focus-sessions/${id}/pause`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return (await check(res)).json()
}

export async function resumeFocusSession(id: string): Promise<FocusSession> {
  const res = await fetch(`${API}/api/focus-sessions/${id}/resume`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return (await check(res)).json()
}

export async function extendFocusSession(id: string, minutes: number): Promise<FocusSession> {
  const res = await fetch(`${API}/api/focus-sessions/${id}/extend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ minutes }),
  })
  return (await check(res)).json()
}

export async function endFocusSession(id: string, completed: boolean): Promise<void> {
  const res = await fetch(`${API}/api/focus-sessions/${id}/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ completed, tz_offset_min: new Date().getTimezoneOffset() }),
  })
  await check(res)
}

// Fire-and-forget end for tab close. sendBeacon can't set an auth header, so
// the token rides in the body; text/plain keeps it a "simple" request (no CORS
// preflight) so it actually goes out during unload.
export async function listTaskFocusSessions(taskId: string): Promise<FocusSession[]> {
  const res = await fetch(`${API}/api/tasks/${taskId}/focus-sessions`, { headers: authHeaders() })
  return (await check(res)).json()
}

export async function deleteFocusSession(id: string): Promise<void> {
  const res = await fetch(`${API}/api/focus-sessions/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  await check(res)
}
