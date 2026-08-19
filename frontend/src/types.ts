export interface NutritionData {
  food_name: string
  quantity: string
  calories: number
  protein_g: number
  carbs_g: number
  fat_g: number
  usda_fdc_id: string | null
}

export interface PersonData {
  name: string
  email: string | null
  phone: string | null
  context: string
  last_contacted: string | null
}

export interface AlbumData {
  artist: string
  title: string
  thoughts: string | null
  rating: number | null
  rating_tier: 'loved' | 'fine' | 'disliked' | null
  rank_position: number | null
}

export type SongStatus = 'loved' | 'to_revisit' | 'revisited'

export interface SongData {
  title: string | null
  artist: string | null
  status: SongStatus
  thoughts: string | null
  context: string | null
  source: string | null
}

export interface WorkoutSet {
  weight: number | null
  reps: number | null
  rir: number | null
  rest_s: number | null
  unit: string | null
}

export interface WorkoutExercise {
  exercise_id: number
  name: string
  sets: WorkoutSet[]
}

export interface WorkoutData {
  wger_session_id: number
  date: string
  notes: string | null
  note: string | null
  impression: string | null
  duration_min: number | null
  exercises: WorkoutExercise[]
  total_sets: number
  total_volume: number | null
}

export interface WeightData {
  value: number
  unit: 'lb' | 'kg'
  workout_id: string | null
}

export type PlaceCategory = 'coffee' | 'restaurant' | 'bar' | 'dessert' | 'other'

export interface PlaceData {
  name: string
  category: PlaceCategory
  order_text: string | null
  thoughts: string | null
  city: string | null
  address: string | null
  rating: number | null
  rating_tier: Tier | null
  rank_position: number | null
}

export interface ItineraryEntry {
  name: string
  note: string | null
}

export interface TripData {
  destination: string
  start_date: string | null
  end_date: string | null
  itinerary: ItineraryEntry[]
  thoughts: string | null
  rating: number | null
  rating_tier: Tier | null
  rank_position: number | null
}

export interface SleepData {
  sleep_start: string | null
  sleep_end: string | null
  duration_min: number | null
  night_date: string
}

export interface LearningData {
  field_id: string | null
  field_name: string | null
  resource_id: string | null
  resource_title: string | null
  topic_id: string | null
  topic_name: string | null
  kind: 'study' | 'problems' | 'note'
  resource_progress: number | null
  problems_count: number | null
  problems_type: string | null
  note: string | null
}

export interface TaskData {
  task_id: string
  title: string
  category: string
  due_date: string | null
  due_time: string | null
  status: 'not_started' | 'in_progress' | 'done'
  is_exam: boolean
  action: 'created' | 'status' | 'rescheduled' | 'note' | 'moved'
  note: string | null
}

export interface Task {
  id: string
  title: string
  category: string
  due_date: string | null
  due_time: string | null
  effort_minutes: number | null
  status: 'not_started' | 'in_progress' | 'done'
  is_exam: boolean
  note: string | null
  created_at: string
  completed_at: string | null
}

export interface TaskCheckpoint {
  id: string
  task_id: string
  offset_days: number
  due_date: string
  status: 'todo' | 'done'
}

export interface TaskWithCheckpoints extends Task {
  checkpoints: TaskCheckpoint[]
}

export interface CadenceData {
  cadence_id: string
  cadence_name: string
}

export interface Cadence {
  id: string
  name: string
  target_frequency: 'daily' | 'weekly'
  active: boolean
  created_at: string
}

export interface CadenceCompletions {
  dates: string[]
  current_streak: number
  longest_streak: number
}

export type ParsedType =
  | 'nutrition'
  | 'person'
  | 'album'
  | 'song'
  | 'workout'
  | 'learning'
  | 'place'
  | 'trip'
  | 'sleep'
  | 'task'
  | 'cadence_completion'
  | 'weight'
  | 'focus_session'

export interface Log {
  id: string
  created_at: string
  raw_input: string
  parsed_type: ParsedType
  data:
    | NutritionData
    | PersonData
    | AlbumData
    | SongData
    | WorkoutData
    | PlaceData
    | TripData
    | SleepData
    | LearningData
    | TaskData
    | CadenceData
    | WeightData
    | FocusSessionData
}

export interface Field {
  id: string
  name: string
  goal_text: string | null
  timeline_text: string | null
  created_at: string
}

export interface FieldSummary extends Field {
  units_done: number
  units_total: number
  topics_done: number
  topics_total: number
  problems_theory: number
  problems_implementation: number
  streak: number
}

export interface Resource {
  id: string
  field_id: string
  kind: 'pdf' | 'url' | 'manual'
  title: string
  uri: string | null
  total_units: number | null
  unit_label: string | null
  current_unit: number
  structure: string | null
}

export interface Topic {
  id: string
  field_id: string
  name: string
  ord: number
  status: 'todo' | 'in_progress' | 'done'
  confidence: number | null
  source_resource_id: string | null
}

export interface FieldDetail extends Field {
  resources: Resource[]
  topics: Topic[]
  problems_theory: number
  problems_implementation: number
  streak: number
}

export interface ProposedTopic {
  name: string
  source_resource_id: string | null
}

export interface CreateResponse {
  logs: Log[]
  notice: string | null
}

export interface DailyNote {
  date: string
  today_text: string
  tomorrow_text: string
  updated_at: string
}

export interface FocusSessionData {
  session_id: string
  task_id: string | null
  cadence_id: string | null
  title: string
  planned_minutes: number
  actual_minutes: number
  completed: boolean
}

export interface FocusSession {
  id: string
  task_id: string | null
  cadence_id: string | null
  planned_minutes: number
  actual_minutes: number | null
  started_at: string
  ended_at: string | null
  completed: boolean
}

export interface StartedSession extends FocusSession {
  title: string
}

export type Tier = 'loved' | 'fine' | 'disliked'

export interface Opponent {
  id: string
  label: string
}

export interface RankComparison {
  opponent_id: string
  preferred: 'this' | 'that'
}

export type RankResponse =
  | { done: false; next_opponent: Opponent }
  | { done: true; rating: number; rank_position: number }

export interface AlbumGroups {
  loved: Log[]
  fine: Log[]
  disliked: Log[]
  unrated: Log[]
}

export interface PendingLog {
  tempId: string
  raw_input: string
  failed: boolean
}

export type Entry =
  | { kind: 'log'; log: Log; justParsed: boolean }
  | { kind: 'pending'; pending: PendingLog }

export type Category =
  | 'all'
  | 'nutrition'
  | 'person'
  | 'music'
  | 'workout'
  | 'place'
  | 'trip'
  | 'learning'
  | 'sleep'
  | 'task'
  | 'cadence_completion'

export type RankDomain = 'album' | 'place' | 'trip'
