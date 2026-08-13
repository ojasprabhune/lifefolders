import { useEffect, useState } from 'react'
import { deleteLog, updateLog } from './api'
import type {
  AlbumData,
  LearningData,
  Log,
  NutritionData,
  PersonData,
  PlaceData,
  SleepData,
  SongData,
  SongStatus,
  TaskData,
  TripData,
  WorkoutData,
} from './types'

interface RowProps {
  log: Log
  justParsed: boolean
  expanded: boolean
  onToggle: () => void
  onChange: (log: Log) => void
  onDelete: (id: string) => void
  onRate: (log: Log) => void
}

function timeOf(iso: string): string {
  return new Date(iso)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()
    .replace(' ', '')
}

function rowTime(log: Log): string {
  if (log.parsed_type === 'sleep') {
    const end = (log.data as SleepData).sleep_end
    if (end) return timeOf(end)
  }
  return timeOf(log.created_at)
}

const SONG_STATUS_LABEL: Record<SongStatus, string> = {
  loved: 'loved',
  to_revisit: 'revisit',
  revisited: 'revisited',
}

export function workoutSummary(data: WorkoutData): string {
  if (data.exercises.length === 0) return 'workout, no sets logged'
  const parts = [
    `${data.exercises.length} exercise${data.exercises.length === 1 ? '' : 's'}`,
    `${data.total_sets} sets`,
  ]
  return `workout, ${parts.join(', ')}`
}

export function workoutVolume(data: WorkoutData): string {
  if (data.total_volume === null) return ''
  const unit = data.exercises.flatMap((e) => e.sets).find((s) => s.unit)?.unit ?? 'kg'
  return `${data.total_volume.toLocaleString()} ${unit}`
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  return `${h}h ${String(m).padStart(2, '0')}m`
}

export function learningSummary(data: LearningData): string {
  const parts: string[] = []
  if (data.resource_title && data.resource_progress !== null) {
    parts.push(`${data.resource_title} ${data.resource_progress}`)
  } else if (data.resource_title) {
    parts.push(data.resource_title)
  }
  if (data.problems_count !== null) {
    const kind = data.problems_type === 'implementation' ? 'impl' : data.problems_type ?? ''
    parts.push(`+${data.problems_count} ${kind} problems`.replace('  ', ' '))
  }
  if (data.topic_name && !parts.length) parts.push(data.topic_name)
  if (!parts.length && data.note) parts.push(data.note)
  if (!parts.length) parts.push('studied')
  const prefix = data.field_name ? `${data.field_name}: ` : ''
  return prefix + parts.join(', ')
}

function summary(log: Log): string {
  switch (log.parsed_type) {
    case 'nutrition':
      return (log.data as NutritionData).food_name
    case 'person':
      return `met ${(log.data as PersonData).name}`
    case 'album': {
      const a = log.data as AlbumData
      return `${a.title}, ${a.artist}`
    }
    case 'song': {
      const s = log.data as SongData
      if (s.title) return s.artist ? `${s.title}, ${s.artist}` : s.title
      return s.context ?? 'a song'
    }
    case 'workout':
      return workoutSummary(log.data as WorkoutData)
    case 'place': {
      const p = log.data as PlaceData
      return p.order_text ? `${p.name}, ${p.order_text}` : p.name
    }
    case 'trip': {
      const t = log.data as TripData
      const stops = t.itinerary.length
      return stops > 0 ? `${t.destination}, ${stops} stop${stops === 1 ? '' : 's'}` : t.destination
    }
    case 'sleep': {
      const s = log.data as SleepData
      if (s.sleep_end === null) return 'sleeping'
      if (s.duration_min !== null) return `slept ${formatDuration(s.duration_min)}`
      return 'woke up'
    }
    case 'learning':
      return learningSummary(log.data as LearningData)
    case 'task': {
      const t = log.data as TaskData
      const due = t.due_date ? `, due ${t.due_date}` : ''
      if (t.action === 'status') return `${t.status === 'done' ? 'completed' : t.status === 'in_progress' ? 'started' : 'updated'}: ${t.title}`
      if (t.action === 'rescheduled') return `rescheduled: ${t.title}${due}`
      if (t.action === 'moved') return `moved: ${t.title} → ${t.is_exam ? 'exam' : t.category}`
      if (t.action === 'note') return t.note ? `${t.title}: ${t.note}` : `updated: ${t.title}`
      return `added task: ${t.title}${due}`
    }
  }
}

function badge(log: Log): { label: string; kind: string } {
  switch (log.parsed_type) {
    case 'nutrition':
      return { label: 'food', kind: 'food' }
    case 'person':
      return { label: 'people', kind: 'people' }
    case 'album':
    case 'song':
      return { label: 'music', kind: 'music' }
    case 'workout':
      return { label: 'gym', kind: 'gym' }
    case 'place':
      return { label: 'places', kind: 'place' }
    case 'trip':
      return { label: 'travel', kind: 'trip' }
    case 'sleep':
      return { label: 'sleep', kind: 'sleep' }
    case 'learning':
      return { label: 'learning', kind: 'learning' }
    case 'task':
      return (log.data as TaskData).is_exam
        ? { label: 'exam', kind: 'exam' }
        : { label: 'task', kind: 'task' }
  }
}

function rightSide(log: Log, onRate: (log: Log) => void): React.ReactNode {
  switch (log.parsed_type) {
    case 'nutrition':
      return Math.round((log.data as NutritionData).calories)
    case 'album': {
      const a = log.data as AlbumData
      if (a.rating !== null) return a.rating.toFixed(1)
      return (
        <button
          className="rate-link"
          onClick={(e) => {
            e.stopPropagation()
            onRate(log)
          }}
        >
          rate
        </button>
      )
    }
    case 'song':
      return <span className="status-label">{SONG_STATUS_LABEL[(log.data as SongData).status]}</span>
    case 'workout':
      return workoutVolume(log.data as WorkoutData)
    case 'place':
    case 'trip': {
      const rated = (log.data as PlaceData | TripData).rating
      if (rated !== null) return rated.toFixed(1)
      return (
        <button
          className="rate-link"
          onClick={(e) => {
            e.stopPropagation()
            onRate(log)
          }}
        >
          rate
        </button>
      )
    }
    case 'sleep': {
      const s = log.data as SleepData
      return s.sleep_end === null ? <span className="status-label">zzz</span> : ''
    }
    default:
      return ''
  }
}

export function Row({ log, justParsed, expanded, onToggle, onChange, onDelete, onRate }: RowProps) {
  const [renderEditor, setRenderEditor] = useState(expanded)

  useEffect(() => {
    if (expanded) {
      setRenderEditor(true)
      return
    }
    if (!renderEditor) return
    const t = setTimeout(() => setRenderEditor(false), 220)
    return () => clearTimeout(t)
  }, [expanded, renderEditor])

  const quickDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await deleteLog(log.id)
      onDelete(log.id)
      // a task-type entry cascades to deleting the real task server-side;
      // nudge the tasks panel to pick that up right away if it's open
      window.dispatchEvent(new Event('life-log-created'))
    } catch {
      // leave the row in place if the delete failed
    }
  }

  return (
    <div className={`row-wrap ${expanded ? 'open' : ''}`}>
      <div className={`row ${justParsed ? 'morph' : ''}`} onClick={onToggle}>
        <span className="row-time">{rowTime(log)}</span>
        <span className={`badge ${badge(log).kind}`}>{badge(log).label}</span>
        <span className="row-main">{summary(log)}</span>
        <span className="row-right">{rightSide(log, onRate)}</span>
        <button className="delete-btn" onClick={quickDelete} aria-label="delete entry">
          ✕
        </button>
      </div>
      <div className="expand">
        <div className="expand-inner">
          {renderEditor && <Editor log={log} onChange={onChange} onDelete={onDelete} onRate={onRate} />}
        </div>
      </div>
    </div>
  )
}

function Editor({
  log,
  onChange,
  onDelete,
  onRate,
}: EditorProps & { onRate: (log: Log) => void }) {
  switch (log.parsed_type) {
    case 'nutrition':
      return <FoodEditor log={log} onChange={onChange} onDelete={onDelete} />
    case 'person':
      return <PersonEditor log={log} onChange={onChange} onDelete={onDelete} />
    case 'album':
      return <AlbumEditor log={log} onChange={onChange} onDelete={onDelete} onRate={onRate} />
    case 'song':
      return <SongEditor log={log} onChange={onChange} onDelete={onDelete} />
    case 'workout':
      return <WorkoutEditor log={log} onChange={onChange} onDelete={onDelete} />
    case 'place':
      return <PlaceEditor log={log} onChange={onChange} onDelete={onDelete} onRate={onRate} />
    case 'trip':
      return <TripEditor log={log} onChange={onChange} onDelete={onDelete} onRate={onRate} />
    case 'sleep':
      return <SleepEditor log={log} onChange={onChange} onDelete={onDelete} />
    case 'learning':
      return <LearningEditor log={log} onChange={onChange} onDelete={onDelete} />
    case 'task':
      return <TaskLogEditor log={log} onChange={onChange} onDelete={onDelete} />
  }
}

const PLACE_CATEGORIES = ['coffee', 'restaurant', 'bar', 'dessert', 'other'] as const

function PlaceEditor({
  log,
  onChange,
  onDelete,
  onRate,
}: EditorProps & { onRate: (log: Log) => void }) {
  const data = log.data as PlaceData
  const [fields, setFields] = useState({
    name: data.name,
    order_text: data.order_text ?? '',
    city: data.city ?? '',
    thoughts: data.thoughts ?? '',
  })
  const [category, setCategory] = useState(data.category)
  const { saving, error, save, remove } = useEditor(log, onChange, onDelete)

  const submit = () =>
    save({
      name: fields.name,
      category,
      order_text: fields.order_text.trim() || null,
      city: fields.city.trim() || null,
      thoughts: fields.thoughts.trim() || null,
    })

  const meta =
    data.rating !== null && data.rating_tier
      ? `${data.rating_tier} ${data.rating.toFixed(1)}`
      : 'unrated'

  return (
    <div className="editor">
      <div className="editor-grid two">
        <label>
          <span>name</span>
          <input value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} />
        </label>
        <label>
          <span>order</span>
          <input
            value={fields.order_text}
            onChange={(e) => setFields({ ...fields, order_text: e.target.value })}
          />
        </label>
      </div>
      <label>
        <span>category</span>
        <div className="status-buttons">
          {PLACE_CATEGORIES.map((c) => (
            <button
              key={c}
              className={`filter ${category === c ? 'active' : ''}`}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </label>
      <div className="editor-grid two">
        <label>
          <span>city</span>
          <input value={fields.city} onChange={(e) => setFields({ ...fields, city: e.target.value })} />
        </label>
      </div>
      <label>
        <span>thoughts</span>
        <textarea
          rows={2}
          value={fields.thoughts}
          onChange={(e) => setFields({ ...fields, thoughts: e.target.value })}
        />
      </label>
      <div className="editor-footer">
        <span className="editor-meta">{error || meta}</span>
        <div className="editor-actions">
          <button className="action" onClick={() => onRate(log)}>
            {data.rating !== null ? 're-rank' : 'rate'}
          </button>
          <button className="action delete" onClick={remove}>
            delete
          </button>
          <button className="action save" onClick={submit} disabled={saving}>
            {saving ? 'saving' : 'save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function TripEditor({
  log,
  onChange,
  onDelete,
  onRate,
}: EditorProps & { onRate: (log: Log) => void }) {
  const data = log.data as TripData
  const [fields, setFields] = useState({
    destination: data.destination,
    start_date: data.start_date ?? '',
    end_date: data.end_date ?? '',
    thoughts: data.thoughts ?? '',
  })
  const { saving, error, save, remove } = useEditor(log, onChange, onDelete)

  const submit = () =>
    save({
      destination: fields.destination,
      start_date: fields.start_date.trim() || null,
      end_date: fields.end_date.trim() || null,
      thoughts: fields.thoughts.trim() || null,
    })

  const meta =
    data.rating !== null && data.rating_tier
      ? `${data.rating_tier} ${data.rating.toFixed(1)}`
      : 'unrated'

  return (
    <div className="editor">
      <label>
        <span>destination</span>
        <input
          value={fields.destination}
          onChange={(e) => setFields({ ...fields, destination: e.target.value })}
        />
      </label>
      <div className="editor-grid two">
        <label>
          <span>start</span>
          <input
            placeholder="YYYY-MM-DD"
            value={fields.start_date}
            onChange={(e) => setFields({ ...fields, start_date: e.target.value })}
          />
        </label>
        <label>
          <span>end</span>
          <input
            placeholder="YYYY-MM-DD"
            value={fields.end_date}
            onChange={(e) => setFields({ ...fields, end_date: e.target.value })}
          />
        </label>
      </div>
      {data.itinerary.length > 0 && (
        <div className="itinerary">
          {data.itinerary.map((item, i) => (
            <div key={i} className="itinerary-item">
              <span>{item.name}</span>
              {item.note && <span className="row-sub"> {item.note}</span>}
            </div>
          ))}
        </div>
      )}
      <label>
        <span>thoughts</span>
        <textarea
          rows={2}
          value={fields.thoughts}
          onChange={(e) => setFields({ ...fields, thoughts: e.target.value })}
        />
      </label>
      <div className="editor-footer">
        <span className="editor-meta">{error || meta}</span>
        <div className="editor-actions">
          <button className="action" onClick={() => onRate(log)}>
            {data.rating !== null ? 're-rank' : 'rate'}
          </button>
          <button className="action delete" onClick={remove}>
            delete
          </button>
          <button className="action save" onClick={submit} disabled={saving}>
            {saving ? 'saving' : 'save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function timeShort(iso: string | null): string {
  if (!iso) return '?'
  return new Date(iso)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()
    .replace(' ', '')
}

function SleepEditor({ log, onChange, onDelete }: EditorProps) {
  const data = log.data as SleepData
  const { error, remove } = useEditor(log, onChange, onDelete)

  return (
    <div className="editor">
      <span className="workout-meta">
        {timeShort(data.sleep_start)} to {timeShort(data.sleep_end)}
        {data.duration_min !== null ? `, ${formatDuration(data.duration_min)}` : ''}
        {` (night of ${data.night_date})`}
      </span>
      <div className="editor-footer">
        <span className="editor-meta">{error}</span>
        <div className="editor-actions">
          <button className="action delete" onClick={remove}>
            delete
          </button>
        </div>
      </div>
    </div>
  )
}

function LearningEditor({ log, onChange, onDelete }: EditorProps) {
  const data = log.data as LearningData
  const [note, setNote] = useState(data.note ?? '')
  const { saving, error, save, remove } = useEditor(log, onChange, onDelete)

  const meta = [
    data.field_name,
    data.resource_title,
    data.topic_name,
    data.kind,
    data.problems_count !== null ? `${data.problems_count} ${data.problems_type ?? ''} problems` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="editor">
      <span className="workout-meta">{meta}</span>
      <label>
        <span>note</span>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <EditorFooter
        saving={saving}
        error={error}
        onSave={() => save({ note: note.trim() || null })}
        onDelete={remove}
      />
    </div>
  )
}

function TaskLogEditor({ log, onChange, onDelete }: EditorProps) {
  const data = log.data as TaskData
  const [note, setNote] = useState(data.note ?? '')
  const { saving, error, save, remove } = useEditor(log, onChange, onDelete)
  const meta = [
    data.is_exam ? 'exam' : data.category,
    data.status,
    data.due_date ? `due ${data.due_date}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="editor">
      <span className="workout-meta">{meta}</span>
      <label>
        <span>note</span>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <EditorFooter
        saving={saving}
        error={error}
        onSave={() => save({ note: note.trim() || null })}
        onDelete={remove}
      />
    </div>
  )
}

export function WorkoutBreakdown({ data }: { data: WorkoutData }) {
  const meta = [
    data.date,
    data.duration_min !== null ? `${data.duration_min} min` : null,
    data.impression,
  ].filter(Boolean)

  return (
    <div className="workout-breakdown">
      <span className="workout-meta">{meta.join(' · ')}</span>
      {data.notes && <p className="workout-notes">{data.notes}</p>}
      {data.exercises.map((exercise) => (
        <div key={exercise.exercise_id} className="workout-exercise">
          <span className="workout-exercise-name">{exercise.name}</span>
          <span className="workout-sets">
            {exercise.sets
              .map((s) => {
                const reps = s.reps ?? '?'
                if (s.weight === null) return `${reps}`
                return `${reps} × ${s.weight}${s.unit && s.unit !== 'kg' ? ` ${s.unit}` : ''}`
              })
              .join(', ')}
          </span>
        </div>
      ))}
    </div>
  )
}

function WorkoutEditor({ log, onChange, onDelete }: EditorProps) {
  const data = log.data as WorkoutData
  const [note, setNote] = useState(data.note ?? '')
  const { saving, error, save, remove } = useEditor(log, onChange, onDelete)

  return (
    <div className="editor">
      <WorkoutBreakdown data={data} />
      <label>
        <span>note</span>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <EditorFooter
        meta={`wger session ${data.wger_session_id}`}
        saving={saving}
        error={error}
        onSave={() => save({ note: note.trim() || null })}
        onDelete={remove}
      />
    </div>
  )
}

interface EditorProps {
  log: Log
  onChange: (log: Log) => void
  onDelete: (id: string) => void
}

function useEditor(log: Log, onChange: (log: Log) => void, onDelete: (id: string) => void) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async (data: Record<string, unknown>) => {
    setSaving(true)
    setError('')
    try {
      onChange(await updateLog(log.id, { data }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    setError('')
    try {
      await deleteLog(log.id)
      onDelete(log.id)
      // a task-type entry cascades to deleting the real task server-side;
      // nudge the tasks panel to pick that up right away if it's open
      window.dispatchEvent(new Event('life-log-created'))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete failed')
    }
  }

  return { saving, error, save, remove }
}

function FoodEditor({ log, onChange, onDelete }: EditorProps) {
  const data = log.data as NutritionData
  const [fields, setFields] = useState({
    food_name: data.food_name,
    quantity: data.quantity,
    calories: String(data.calories),
    protein_g: String(data.protein_g),
    carbs_g: String(data.carbs_g),
    fat_g: String(data.fat_g),
  })
  const { saving, error, save, remove } = useEditor(log, onChange, onDelete)

  const set = (key: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields({ ...fields, [key]: e.target.value })

  const submit = () =>
    save({
      food_name: fields.food_name,
      quantity: fields.quantity,
      calories: Math.round(Number(fields.calories) || 0),
      protein_g: Number(fields.protein_g) || 0,
      carbs_g: Number(fields.carbs_g) || 0,
      fat_g: Number(fields.fat_g) || 0,
    })

  return (
    <div className="editor">
      <label>
        <span>food</span>
        <input value={fields.food_name} onChange={set('food_name')} />
      </label>
      <label>
        <span>quantity</span>
        <input value={fields.quantity} onChange={set('quantity')} />
      </label>
      <div className="editor-grid">
        <label>
          <span>cals</span>
          <input inputMode="numeric" value={fields.calories} onChange={set('calories')} />
        </label>
        <label>
          <span>protein</span>
          <input inputMode="decimal" value={fields.protein_g} onChange={set('protein_g')} />
        </label>
        <label>
          <span>carbs</span>
          <input inputMode="decimal" value={fields.carbs_g} onChange={set('carbs_g')} />
        </label>
        <label>
          <span>fat</span>
          <input inputMode="decimal" value={fields.fat_g} onChange={set('fat_g')} />
        </label>
      </div>
      <EditorFooter
        meta={data.usda_fdc_id ? `usda ${data.usda_fdc_id}` : 'estimated'}
        saving={saving}
        error={error}
        onSave={submit}
        onDelete={remove}
      />
    </div>
  )
}

function PersonEditor({ log, onChange, onDelete }: EditorProps) {
  const data = log.data as PersonData
  const [fields, setFields] = useState({
    name: data.name,
    email: data.email ?? '',
    phone: data.phone ?? '',
    context: data.context,
  })
  const { saving, error, save, remove } = useEditor(log, onChange, onDelete)

  const submit = () =>
    save({
      name: fields.name,
      email: fields.email.trim() || null,
      phone: fields.phone.trim() || null,
      context: fields.context,
    })

  return (
    <div className="editor">
      <label>
        <span>name</span>
        <input value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} />
      </label>
      <div className="editor-grid two">
        <label>
          <span>email</span>
          <input value={fields.email} onChange={(e) => setFields({ ...fields, email: e.target.value })} />
        </label>
        <label>
          <span>phone</span>
          <input value={fields.phone} onChange={(e) => setFields({ ...fields, phone: e.target.value })} />
        </label>
      </div>
      <label>
        <span>context</span>
        <textarea
          rows={2}
          value={fields.context}
          onChange={(e) => setFields({ ...fields, context: e.target.value })}
        />
      </label>
      <EditorFooter saving={saving} error={error} onSave={submit} onDelete={remove} />
    </div>
  )
}

function AlbumEditor({
  log,
  onChange,
  onDelete,
  onRate,
}: EditorProps & { onRate: (log: Log) => void }) {
  const data = log.data as AlbumData
  const [fields, setFields] = useState({
    artist: data.artist,
    title: data.title,
    thoughts: data.thoughts ?? '',
  })
  const { saving, error, save, remove } = useEditor(log, onChange, onDelete)

  const submit = () =>
    save({
      artist: fields.artist,
      title: fields.title,
      thoughts: fields.thoughts.trim() || null,
    })

  const meta =
    data.rating !== null && data.rating_tier
      ? `${data.rating_tier} ${data.rating.toFixed(1)}`
      : 'unrated'

  return (
    <div className="editor">
      <div className="editor-grid two">
        <label>
          <span>title</span>
          <input value={fields.title} onChange={(e) => setFields({ ...fields, title: e.target.value })} />
        </label>
        <label>
          <span>artist</span>
          <input value={fields.artist} onChange={(e) => setFields({ ...fields, artist: e.target.value })} />
        </label>
      </div>
      <label>
        <span>thoughts</span>
        <textarea
          rows={2}
          value={fields.thoughts}
          onChange={(e) => setFields({ ...fields, thoughts: e.target.value })}
        />
      </label>
      <div className="editor-footer">
        <span className="editor-meta">{error || meta}</span>
        <div className="editor-actions">
          <button className="action" onClick={() => onRate(log)}>
            {data.rating !== null ? 're-rank' : 'rate'}
          </button>
          <button className="action delete" onClick={remove}>
            delete
          </button>
          <button className="action save" onClick={submit} disabled={saving}>
            {saving ? 'saving' : 'save'}
          </button>
        </div>
      </div>
    </div>
  )
}

const SONG_STATUSES: SongStatus[] = ['loved', 'to_revisit', 'revisited']

function SongEditor({ log, onChange, onDelete }: EditorProps) {
  const data = log.data as SongData
  const [fields, setFields] = useState({
    title: data.title ?? '',
    artist: data.artist ?? '',
    context: data.context ?? '',
    source: data.source ?? '',
    thoughts: data.thoughts ?? '',
  })
  const [status, setStatus] = useState<SongStatus>(data.status)
  const { saving, error, save, remove } = useEditor(log, onChange, onDelete)

  const submit = () =>
    save({
      title: fields.title.trim() || null,
      artist: fields.artist.trim() || null,
      status,
      context: fields.context.trim() || null,
      source: fields.source.trim() || null,
      thoughts: fields.thoughts.trim() || null,
    })

  return (
    <div className="editor">
      <div className="editor-grid two">
        <label>
          <span>title</span>
          <input value={fields.title} onChange={(e) => setFields({ ...fields, title: e.target.value })} />
        </label>
        <label>
          <span>artist</span>
          <input value={fields.artist} onChange={(e) => setFields({ ...fields, artist: e.target.value })} />
        </label>
      </div>
      <div className="editor-grid two">
        <label>
          <span>context</span>
          <input value={fields.context} onChange={(e) => setFields({ ...fields, context: e.target.value })} />
        </label>
        <label>
          <span>source</span>
          <input value={fields.source} onChange={(e) => setFields({ ...fields, source: e.target.value })} />
        </label>
      </div>
      <label>
        <span>thoughts</span>
        <textarea
          rows={2}
          value={fields.thoughts}
          onChange={(e) => setFields({ ...fields, thoughts: e.target.value })}
        />
      </label>
      <label>
        <span>status</span>
        <div className="status-buttons">
          {SONG_STATUSES.map((s) => (
            <button
              key={s}
              className={`filter ${status === s ? 'active' : ''}`}
              onClick={() => setStatus(s)}
            >
              {SONG_STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </label>
      <EditorFooter saving={saving} error={error} onSave={submit} onDelete={remove} />
    </div>
  )
}

function EditorFooter({
  meta,
  saving,
  error,
  onSave,
  onDelete,
}: {
  meta?: string
  saving: boolean
  error: string
  onSave: () => void
  onDelete: () => void
}) {
  return (
    <div className="editor-footer">
      <span className="editor-meta">{error || meta || ''}</span>
      <div className="editor-actions">
        <button className="action delete" onClick={onDelete}>
          delete
        </button>
        <button className="action save" onClick={onSave} disabled={saving}>
          {saving ? 'saving' : 'save'}
        </button>
      </div>
    </div>
  )
}
