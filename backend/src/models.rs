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
    // The day the home timeline is showing, when it isn't today. Everything
    // the entry writes gets stamped onto that day instead of now.
    pub for_date: Option<String>,
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
    // Only set on a reschedule, so the timeline row can say what the date
    // moved *from* rather than only where it landed. Skipped when absent so
    // rows written before this existed and rows for every other action stay
    // the shape they already were.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_due_date: Option<chrono::NaiveDate>,
    // Same idea for a rename, and set only on one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_title: Option<String>,
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
    // A None due_date means "not mentioned, leave it alone", so there was no
    // way to say "there is no deadline any more" - this is that way.
    pub clear_due_date: bool,
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
    Command(CommandRequest),
    Wishlist(WishlistRequest),
}

#[derive(Debug)]
pub struct WishlistRequest {
    pub kind: String,
    pub title: String,
    pub detail: Option<String>,
}

// An instruction aimed at things already tracked, rather than a record of
// something that happened. Commands write no logs row of their own - they
// mutate existing state and come back as a notice.
pub enum CommandRequest {
    RescheduleTasks {
        titles: Vec<String>,
        filter: Option<String>,
        new_due_date: String,
        new_due_time: Option<String>,
    },
    ClearDueDate { title: String },
    SetTaskStatus { title: String, status: String },
    DeleteTask { title: String },
    RecategorizeTask { title: String, category: String },
    StartFocus { title: Option<String>, cadence_name: Option<String>, minutes: i32 },
    DeleteLastEntry,
    PlanToday,
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

#[cfg(test)]
mod tests {
    use super::TaskData;
    use uuid::Uuid;

    fn base() -> TaskData {
        TaskData {
            task_id: Uuid::nil(),
            title: "study for the math quiz".into(),
            category: "homework".into(),
            due_date: None,
            due_time: None,
            status: "not_started".into(),
            is_exam: false,
            action: "created".into(),
            note: None,
            previous_due_date: None,
            previous_title: None,
        }
    }

    // The frontend reads the absence of these two to decide whether a row can
    // say what it changed *from*, so they have to stay absent rather than
    // serialize as null - a null would still be falsy today, but the point is
    // that rows written before they existed and rows for every other action
    // are byte-identical to what they were.
    #[test]
    fn previous_fields_are_omitted_when_unset() {
        let json = serde_json::to_value(base()).unwrap();
        assert!(json.get("previous_due_date").is_none());
        assert!(json.get("previous_title").is_none());
        assert_eq!(json["action"], "created");
    }

    #[test]
    fn a_rename_carries_the_old_title_and_nothing_else_extra() {
        let data = TaskData {
            action: "renamed".into(),
            previous_title: Some("study for math quiz".into()),
            ..base()
        };
        let json = serde_json::to_value(data).unwrap();
        assert_eq!(json["previous_title"], "study for math quiz");
        assert_eq!(json["title"], "study for the math quiz");
        assert!(json.get("previous_due_date").is_none());
    }

    #[test]
    fn a_reschedule_carries_the_old_date() {
        let data = TaskData {
            action: "rescheduled".into(),
            previous_due_date: Some("2026-08-31".parse().unwrap()),
            due_date: Some("2026-09-04".parse().unwrap()),
            ..base()
        };
        let json = serde_json::to_value(data).unwrap();
        assert_eq!(json["previous_due_date"], "2026-08-31");
        assert_eq!(json["due_date"], "2026-09-04");
        assert!(json.get("previous_title").is_none());
    }
}
