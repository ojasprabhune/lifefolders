import type {
  AlbumGroups,
  Category,
  CreateResponse,
  Field,
  FieldDetail,
  FieldSummary,
  Log,
  ProposedTopic,
  RankComparison,
  RankResponse,
  Resource,
  Task,
  TaskCheckpoint,
  TaskWithCheckpoints,
  Tier,
  Topic,
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

export async function createLog(rawText: string): Promise<CreateResponse> {
  const res = await fetch(`${API}/api/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      raw_text: rawText,
      tz_offset_min: new Date().getTimezoneOffset(),
    }),
  })
  return (await check(res)).json()
}

export async function listWorkouts(): Promise<Log[]> {
  const res = await fetch(`${API}/api/workouts`, { headers: authHeaders() })
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
  body: Partial<{ status: string; due_date: string; category: string; effort_minutes: number; is_exam: boolean }>,
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

export async function patchCheckpoint(id: string, status: 'todo' | 'done'): Promise<TaskCheckpoint> {
  const res = await fetch(`${API}/api/task-checkpoints/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ status }),
  })
  return (await check(res)).json()
}
