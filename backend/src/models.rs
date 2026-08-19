use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Serialize, FromRow, Clone)]
pub struct Log {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub raw_input: String,
    pub parsed_type: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct CreateLog {
    pub raw_text: String,
    pub tz_offset_min: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateLog {
    pub raw_input: Option<String>,
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub date: Option<String>,
    pub category: Option<String>,
    pub tz_offset_min: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NutritionData {
    pub food_name: String,
    pub quantity: String,
    pub calories: i64,
    pub protein_g: f64,
    pub carbs_g: f64,
    pub fat_g: f64,
    pub usda_fdc_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PersonData {
    pub name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub context: String,
    pub last_contacted: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AlbumData {
    pub artist: String,
    pub title: String,
    pub thoughts: Option<String>,
    pub rating: Option<f64>,
    pub rating_tier: Option<String>,
    pub rank_position: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SongData {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub status: String,
    pub thoughts: Option<String>,
    pub context: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkoutSet {
    pub weight: Option<f64>,
    pub reps: Option<i64>,
    pub rir: Option<f64>,
    pub rest_s: Option<i64>,
    pub unit: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkoutExercise {
    pub exercise_id: i64,
    pub name: String,
    pub sets: Vec<WorkoutSet>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkoutData {
    pub wger_session_id: i64,
    pub date: String,
    pub notes: Option<String>,
    pub note: Option<String>,
    pub impression: Option<String>,
    pub duration_min: Option<i64>,
    pub exercises: Vec<WorkoutExercise>,
    pub total_sets: i64,
    pub total_volume: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WeightData {
    pub value: f64,
    pub unit: String,
    pub workout_id: Option<Uuid>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PlaceData {
    pub name: String,
    pub category: String,
    pub order_text: Option<String>,
    pub thoughts: Option<String>,
    pub city: Option<String>,
    pub address: Option<String>,
    pub rating: Option<f64>,
    pub rating_tier: Option<String>,
    pub rank_position: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ItineraryEntry {
    pub name: String,
    pub note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TripData {
    pub destination: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub itinerary: Vec<ItineraryEntry>,
    pub thoughts: Option<String>,
    pub rating: Option<f64>,
    pub rating_tier: Option<String>,
    pub rank_position: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SleepData {
    pub sleep_start: Option<DateTime<Utc>>,
    pub sleep_end: Option<DateTime<Utc>>,
    pub duration_min: Option<i64>,
    pub night_date: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LearningData {
    pub field_id: Option<Uuid>,
    pub field_name: Option<String>,
    pub resource_id: Option<Uuid>,
    pub resource_title: Option<String>,
    pub topic_id: Option<Uuid>,
    pub topic_name: Option<String>,
    pub kind: String,
    pub resource_progress: Option<i64>,
    pub problems_count: Option<i64>,
    pub problems_type: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TaskData {
    pub task_id: Uuid,
    pub title: String,
    pub category: String,
    pub due_date: Option<chrono::NaiveDate>,
    pub due_time: Option<chrono::NaiveTime>,
    pub status: String,
    pub is_exam: bool,
    pub action: String,
    pub note: Option<String>,
}

#[derive(Debug)]
pub struct TaskRequest {
    pub title: String,
    pub category: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub effort_minutes: Option<i32>,
    pub status: Option<String>,
    pub is_exam: Option<bool>,
    pub note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CadenceData {
    pub cadence_id: Uuid,
    pub cadence_name: String,
}

#[derive(Debug)]
pub struct CadenceCompletionRequest {
    pub cadence_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FocusSessionData {
    pub session_id: Uuid,
    pub task_id: Option<Uuid>,
    pub cadence_id: Option<Uuid>,
    pub title: String,
    pub planned_minutes: i32,
    pub actual_minutes: i32,
    pub completed: bool,
}

#[derive(Debug)]
pub struct LearningRequest {
    pub field: Option<String>,
    pub resource: Option<String>,
    pub topic: Option<String>,
    pub kind: String,
    pub resource_progress: Option<i64>,
    pub problems_count: Option<i64>,
    pub problems_type: Option<String>,
    pub confidence_signal: Option<String>,
    pub note: Option<String>,
}

/// What one tool call asks the backend to do. Most calls carry a parsed
/// entry; the rest need database side effects beyond a plain insert.
pub enum Action {
    Entry(Parsed),
    Workout { note: Option<String>, allow_not_today: bool },
    ItineraryItem { destination: Option<String>, name: String, note: Option<String> },
    Sleep { action: String, at: Option<String>, wake_at: Option<String> },
    Learning(LearningRequest),
    Task(TaskRequest),
    Cadence(CadenceCompletionRequest),
}

pub enum Parsed {
    Nutrition(NutritionData),
    Person(PersonData),
    Album(AlbumData),
    Song(SongData),
    Place(PlaceData),
    Trip(TripData),
    Weight(WeightData),
}

impl Parsed {
    pub fn type_name(&self) -> &'static str {
        match self {
            Parsed::Nutrition(_) => "nutrition",
            Parsed::Person(_) => "person",
            Parsed::Album(_) => "album",
            Parsed::Song(_) => "song",
            Parsed::Place(_) => "place",
            Parsed::Trip(_) => "trip",
            Parsed::Weight(_) => "weight",
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Parsed::Nutrition(n) => serde_json::to_value(n).unwrap(),
            Parsed::Person(p) => serde_json::to_value(p).unwrap(),
            Parsed::Album(a) => serde_json::to_value(a).unwrap(),
            Parsed::Song(s) => serde_json::to_value(s).unwrap(),
            Parsed::Place(p) => serde_json::to_value(p).unwrap(),
            Parsed::Trip(t) => serde_json::to_value(t).unwrap(),
            Parsed::Weight(w) => serde_json::to_value(w).unwrap(),
        }
    }
}
