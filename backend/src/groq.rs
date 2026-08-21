use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::models::{
    Action, AlbumData, CadenceCompletionRequest, ItineraryEntry, LearningRequest, NutritionData,
    Parsed, PersonData, PlaceData, SongData, TaskRequest, TripData, WeightData,
};
use crate::usda;

const CHAT_URL: &str = "https://api.groq.com/openai/v1/chat/completions";
const MODELS: &[&str] = &["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: Message,
}

#[derive(Debug, Deserialize)]
struct Message {
    tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Debug, Deserialize)]
struct ToolCall {
    function: FunctionCall,
}

#[derive(Debug, Deserialize)]
struct FunctionCall {
    name: String,
    arguments: String,
}

fn tools() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "log_nutrition",
                "description": "Log a food or drink the user ate. Estimate portion weight and macros from the description, including Indian dishes (roti, dal, biryani, paneer, dosa, idli, samosa).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "food_name": {
                            "type": "string",
                            "description": "Short display name of the food or dish, e.g. 'Butter chicken with rice'"
                        },
                        "quantity": {
                            "type": "string",
                            "description": "Amount eaten as stated or inferred, e.g. '1 cup', '150g', '2 rotis'"
                        },
                        "quantity_g": {
                            "type": "number",
                            "description": "Best estimate of the total weight eaten in grams"
                        },
                        "usda_query": {
                            "type": "string",
                            "description": "Short generic search term for the USDA FoodData Central database, e.g. 'banana raw', 'chicken curry', 'roti'"
                        },
                        "calories": {
                            "type": "integer",
                            "description": "Estimated total kcal for the stated quantity"
                        },
                        "protein_g": { "type": "number", "description": "Estimated total protein in grams" },
                        "carbs_g": { "type": "number", "description": "Estimated total carbohydrates in grams" },
                        "fat_g": { "type": "number", "description": "Estimated total fat in grams" }
                    },
                    "required": ["food_name", "quantity", "quantity_g", "usda_query", "calories", "protein_g", "carbs_g", "fat_g"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "log_person",
                "description": "Log one or more people the user met or talked to, one array element per person.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "people": {
                            "type": "array",
                            "description": "Every person mentioned, as separate elements. Never combine two people into one element.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": { "type": "string", "description": "The person's name" },
                                    "email": { "type": "string", "description": "This person's email address if mentioned" },
                                    "phone": { "type": "string", "description": "This person's phone number if mentioned" },
                                    "context": {
                                        "type": "string",
                                        "description": "Where or how they met plus any notes worth remembering"
                                    }
                                },
                                "required": ["name", "context"]
                            }
                        }
                    },
                    "required": ["people"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "log_album",
                "description": "Log an album the user listened to in full. Never assign a rating here; ratings come from a separate ranking flow.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "artist": { "type": "string", "description": "Album artist" },
                        "title": { "type": "string", "description": "Album title" },
                        "thoughts": { "type": "string", "description": "The user's thoughts on the album, if any" }
                    },
                    "required": ["artist", "title"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "log_song",
                "description": "Log a single song: one the user loved, or one heard somewhere they want to catch and revisit later.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "Song title, omit when unknown" },
                        "artist": { "type": "string", "description": "Artist, omit when unknown" },
                        "status": {
                            "type": "string",
                            "enum": ["loved", "to_revisit", "revisited"],
                            "description": "loved when they express loving it; to_revisit when they want to catch, remember or find a song later; revisited when they came back to one"
                        },
                        "thoughts": { "type": "string", "description": "The user's thoughts, if any" },
                        "context": {
                            "type": "string",
                            "description": "Where or how it was heard, plus the song description when the title is unknown, e.g. 'dreamy synth at Blue Bottle'"
                        },
                        "source": { "type": "string", "description": "Short source label: radio, cafe, friend, tv, etc." }
                    },
                    "required": ["status"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "log_place",
                "description": "Log a venue the user visited: a cafe, restaurant, bar or dessert spot. Separate from food macros; this is about the place itself.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Venue name" },
                        "category": {
                            "type": "string",
                            "enum": ["coffee", "restaurant", "bar", "dessert", "other"],
                            "description": "Venue kind, inferred when unstated"
                        },
                        "order_text": { "type": "string", "description": "What the user ordered" },
                        "thoughts": { "type": "string", "description": "The user's impressions" },
                        "city": { "type": "string", "description": "City if mentioned" }
                    },
                    "required": ["name", "category"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "log_trip",
                "description": "Log a trip or destination the user visited.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "destination": { "type": "string", "description": "City, region or country visited" },
                        "itinerary_items": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Things done or seen on the trip"
                        },
                        "thoughts": { "type": "string", "description": "The user's impressions" },
                        "start_date": { "type": "string", "description": "YYYY-MM-DD if mentioned" },
                        "end_date": { "type": "string", "description": "YYYY-MM-DD if mentioned" }
                    },
                    "required": ["destination"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "log_itinerary_item",
                "description": "Add one item to an existing trip's itinerary, e.g. 'in Lisbon, add LX Factory'.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "destination": { "type": "string", "description": "Trip destination; omit to use the most recent open trip" },
                        "name": { "type": "string", "description": "The itinerary item" },
                        "note": { "type": "string", "description": "Optional note about the item" }
                    },
                    "required": ["name"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "log_sleep",
                "description": "Open or close a sleep session. 'sleeping now' starts one; 'just woke up' ends it.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["start", "end", "both"],
                            "description": "start when going to sleep, end when waking up, both when one phrase states a bedtime and that they are now awake"
                        },
                        "at": {
                            "type": "string",
                            "description": "ISO timestamp override when the user states a time, e.g. 'went to bed at 11'; compute from the current local time given in the system prompt. For action both, this is the bedtime."
                        },
                        "wake_at": {
                            "type": "string",
                            "description": "ISO timestamp for the wake-up time, only when action is both, e.g. 'slept from 12:35am to 7:25am' - at is 12:35am and wake_at is 7:25am"
                        }
                    },
                    "required": ["action"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "log_learning",
                "description": "Log study progress on a field the user is learning: lectures or chapters finished, problems done, or a note. Match field, resource and topic to the user's configured names listed in the system prompt.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "field": { "type": "string", "description": "The learning field this belongs to" },
                        "resource": { "type": "string", "description": "Resource name when mentioned, e.g. a lecture series or book" },
                        "topic": { "type": "string", "description": "Topic name when mentioned" },
                        "kind": {
                            "type": "string",
                            "enum": ["study", "problems", "note"],
                            "description": "study for watching or reading, problems for exercises, note otherwise"
                        },
                        "resource_progress": { "type": "integer", "description": "New unit reached, e.g. 7 for 'lecture 7'" },
                        "problems_count": { "type": "integer", "description": "How many problems were done" },
                        "problems_type": { "type": "string", "enum": ["theory", "implementation"] },
                        "confidence_signal": {
                            "type": "string",
                            "description": "up when the user felt good, down when shaky, or set:N for an explicit 1-5 rating"
                        },
                        "note": { "type": "string", "description": "Any remaining detail" }
                    },
                    "required": ["kind"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "log_workout",
                "description": "Log a gym workout. The session itself lives in wger; this pulls the latest one. Use when the user says they worked out, lifted, hit the gym, or similar.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "note": { "type": "string", "description": "Any free-text remark the user added, e.g. 'felt strong on squats'" },
                        "allow_not_today": {
                            "type": "boolean",
                            "description": "True only when the user explicitly asks to log a past session, e.g. 'log my last workout even though it was yesterday'"
                        }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "log_task",
                "description": "Create or update a task: homework, a project, or an extracurricular commitment (debate, robotics, outreach, volunteering, research, clubs, etc). Match the title against the user's open tasks listed in the system prompt when the entry refers to something already tracked; otherwise this creates a new one.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "Short task title. When updating an existing task, phrase this close to its tracked title so it matches." },
                        "category": { "type": "string", "description": "homework for schoolwork/studying (notes, reading, vocab, worksheets, memorization, etc.), project for larger multi-step deliverables, or a specific extracurricular label (debate, robotics, outreach, volunteering, research, clubs); personal only for non-school errands/to-dos" },
                        "due_date": { "type": "string", "description": "YYYY-MM-DD if a deadline is stated or already known for this task" },
                        "due_time": { "type": "string", "description": "HH:MM in 24-hour time, only when a specific clock time is stated for the deadline itself (e.g. 'presentation at 2pm', 'due by 11:59pm'), not for a vague time of day like 'morning' or 'tonight'" },
                        "effort_minutes": { "type": "integer", "description": "Estimated time needed in minutes, if stated or clearly implied" },
                        "status": {
                            "type": "string",
                            "enum": ["not_started", "in_progress", "done"],
                            "description": "in_progress when they say they started or are working on it, done when they say they finished or turned it in, not_started for a freshly added task"
                        },
                        "is_exam": { "type": "boolean", "description": "true only for a genuine test, exam, or quiz, so spaced study reminders get scheduled before the due date" },
                        "note": { "type": "string", "description": "any remaining detail" }
                    },
                    "required": ["title"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "log_cadence_completion",
                "description": "Mark one of the user's tracked cadences (recurring habits/routines) as done for the day, e.g. 'meditated', 'drank water', 'went for a run'. Only use when the entry matches one of the active cadences listed in the system prompt.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cadence_name": { "type": "string", "description": "The cadence that was completed, phrased close to its tracked name so it matches, e.g. 'Water', 'Meditation'." }
                    },
                    "required": ["cadence_name"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "log_weight",
                "description": "Log the user's own body weight, e.g. 'weighed 158 this morning', '72 kg', 'bodyweight 155 lbs'. This is body weight only, never food portion weights.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "value": { "type": "number", "description": "The body-weight number as stated" },
                        "unit": {
                            "type": "string",
                            "enum": ["lb", "kg"],
                            "description": "lb or kg; default lb when the user gives no unit"
                        }
                    },
                    "required": ["value"]
                }
            }
        }
    ])
}

const SYSTEM_PROMPT: &str = "You parse one short personal log entry into tool calls. \
Entries are either food eaten (log_nutrition) or people met (log_person). \
For food, estimate realistic portion weights: a roti is about 40g, a naan about 90g, \
a dosa about 120g, an idli about 40g, a samosa about 100g, a typical restaurant curry \
serving about 250g, a cup of cooked rice about 160g. Scale macros to the full stated \
quantity. If the entry names multiple foods, combine them into one dish entry with \
summed macros and pick the dominant component for usda_query. \
For people, extract each name and keep all remaining detail in context. \
If the entry mentions meeting more than one person, put each person in their own \
people element: match emails and phone numbers to the right person and repeat the \
shared context for each. Never combine two people into one element. \
For music, log_album is for full album listens and log_song for single songs. \
Song status: phrases like loved, obsessed with, or this song is great mean loved; \
catch, remember, come back to, find this later, heard at, or playing at mean \
to_revisit; came back to or finally listened again means revisited. \
When the user gives only a vague description and no song title, leave title out \
and put the description with the location in context. \
For gym sessions, phrases like worked out, lifted, or hit the gym mean log_workout; \
any extra remark goes in note. Set allow_not_today only when the user explicitly \
asks to log a session that was not today. \
Visiting a cafe, restaurant, bar or dessert spot is log_place; what they ate there \
can additionally be log_nutrition only when they describe the food as eaten. \
Trips to cities or countries are log_trip with itinerary_items for things done. \
Adding one thing to an existing trip is log_itinerary_item. \
Sleeping now or going to bed is log_sleep action start; waking up is action end; \
when a clock time is stated, compute the ISO timestamp from the current local time. \
A phrase stating both a bedtime and waking up means one log_sleep call with action \
both, at set to the stated bedtime, and wake_at set to the stated wake-up time - both \
are required together for action both, and if the wake time crosses midnight into the \
next day, that's still the correct date for wake_at, not the bedtime's date. \
Study progress, watched lectures, finished chapters, or practice problems are \
log_learning; match names against the configured fields listed below when present. \
Homework, projects, and extracurricular commitments (debate, robotics, outreach, \
volunteering, research, clubs, etc.) are log_task. A new title creates a task; \
wording close to an already-tracked task listed below updates it instead: set \
status done when they say they finished or turned it in, in_progress when they \
say they started or are working on it. Set is_exam true only for a real test, \
exam, or quiz — problem sets, homework, and projects are not exams. \
For the category field, default to \"homework\" for anything that's schoolwork for \
a class — notes, vocab, reading, worksheets, maps, packets, study guides, labs, \
outlines, and similar, even when they don't sound like a formal assignment — and \
only use \"project\" for a larger multi-step deliverable. Only use a specific \
extracurricular label (debate, robotics, outreach, volunteering, research, clubs) \
when the task is actually tied to that activity, and reserve \"personal\" for \
non-school errands and to-dos, not schoolwork. \
When a deadline is given as a bare weekday name (\"due Friday\", \"by Monday\") with no \
qualifier, resolve it to the nearest upcoming occurrence of that weekday - today itself \
if today is that weekday, otherwise the next date forward within the next 7 days. Only \
skip ahead to the following week when \"next\" is stated explicitly (\"next Friday\"). For \
\"in N days/weeks,\" add exactly that many days/weeks to the current local date given above. \
An entry starting with \"task:\" is always log_task, no matter what it otherwise sounds \
like - exclude that literal prefix from the title. An entry containing a \"#tag\" (e.g. \
\"clean the garage #personal\") is an explicit category override for log_task - use \
exactly that word, lowercased and without the #, as the category, and exclude the tag \
itself from the title. When a task's deadline names an actual clock time, not just a \
day (\"chem presentation friday at 2pm\", \"essay due 11:59pm\"), also set due_time so \
it lands on the calendar at that exact time instead of the default afternoon slot. An \
entry containing an explicit \"@time\" (e.g. \"dentist tuesday @3pm\") is a deterministic \
due_time override for log_task, the same idea as \"#tag\" for category - exclude it from \
the title too. \
A short phrase that names doing one of the active cadences (recurring habits/routines) \
listed below (\"meditated\", \
\"drank water\", \"journaled\") is log_cadence_completion with cadence_name matching the \
tracked cadence. Only call it when the entry clearly maps to a listed cadence; if nothing \
matches, use the most fitting other tool instead of inventing a cadence. \
A stated body weight (\"weighed 158 this morning\", \"158 lbs\", \"72 kg\", \"bodyweight \
155\") is log_weight, with the number as value and lb or kg as unit, defaulting to lb \
when no unit is given. Body weight is never a food portion: \"2 rotis\", \"150g of rice\", \
or \"a 200g steak\" is log_nutrition, not log_weight. \
Always call at least one tool.";

async fn chat(
    http: &reqwest::Client,
    api_key: &str,
    raw_text: &str,
    context: &str,
    forced_tool: Option<&str>,
) -> Result<Vec<(String, Value)>> {
    let mut last_err = anyhow!("no groq models attempted");
    let system = format!("{SYSTEM_PROMPT}\n\n{context}");
    let tool_choice = match forced_tool {
        Some(name) => json!({ "type": "function", "function": { "name": name } }),
        None => json!("required"),
    };

    for model in MODELS {
        let body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": raw_text }
            ],
            "tools": tools(),
            "tool_choice": tool_choice,
            "temperature": 0.2
        });

        let resp = match http
            .post(CHAT_URL)
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = e.into();
                continue;
            }
        };

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            tracing::warn!(%status, model, "groq request failed: {text}");
            last_err = anyhow!("groq {model} returned {status}");
            continue;
        }

        let parsed: ChatResponse = resp.json().await?;
        let calls = parsed
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.tool_calls)
            .unwrap_or_default();

        if calls.is_empty() {
            last_err = anyhow!("groq {model} returned no tool call");
            continue;
        }

        return calls
            .into_iter()
            .take(8)
            .map(|call| {
                let args: Value = serde_json::from_str(&call.function.arguments)
                    .context("tool call arguments were not valid JSON")?;
                Ok((call.function.name, args))
            })
            .collect();
    }

    Err(last_err)
}

const POLISH_MODEL: &str = "openai/gpt-oss-20b";

const POLISH_PROMPT: &str = "You clean up a raw voice transcript of one short personal log entry \
about food, people, music, gym, places, travel, sleep or studying. \
Fix punctuation and capitalization. Remove filler words (um, uh, like, you know) and false starts. \
Apply spoken self-corrections: 'at 7, no wait, 8' becomes 'at 8'. \
Fix words the transcriber misheard when context makes the intent obvious, \
especially number homophones: 'ate to rotis' means 'ate 2 rotis', 'for eggs' means '4 eggs', \
and 'ate' where a number belongs means 8, so 'at 7, no wait, ate' becomes 'at 8'. \
Write spoken emails and phone numbers as addresses and digits: \
'sarah dot kim at gmail dot com' becomes 'sarah.kim@gmail.com'. \
Never drop a quantity, name, food, time or unit. Do not add, summarize, rephrase or answer anything. \
Output only the cleaned transcript, nothing else.";

/// Clean up a whisper transcript with a small fast model. Returns the raw
/// transcript untouched if the cleanup call fails or its output looks wrong,
/// so transcription never gets worse than whisper alone.
pub async fn polish(http: &reqwest::Client, api_key: &str, transcript: &str) -> String {
    let raw = transcript.trim();
    if raw.is_empty() {
        return String::new();
    }
    let body = json!({
        "model": POLISH_MODEL,
        "temperature": 0,
        "max_tokens": 500,
        "messages": [
            {"role": "system", "content": POLISH_PROMPT},
            {"role": "user", "content": raw},
        ],
    });
    let cleaned = async {
        let resp = http
            .post(CHAT_URL)
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        let value: Value = resp.json().await.ok()?;
        let text = value["choices"][0]["message"]["content"].as_str()?.trim();
        Some(text.trim_matches('"').trim().to_owned())
    }
    .await;
    match cleaned {
        Some(text) if usable_polish(raw, &text) => text,
        _ => raw.to_owned(),
    }
}

/// A cleaned transcript should be roughly the same size as the raw one;
/// anything far shorter or longer means the model dropped content or chatted.
fn usable_polish(raw: &str, cleaned: &str) -> bool {
    if cleaned.is_empty() || cleaned.contains('\n') {
        return false;
    }
    let raw_words = raw.split_whitespace().count();
    let cleaned_words = cleaned.split_whitespace().count();
    cleaned_words >= raw_words.div_ceil(3) && cleaned_words <= raw_words + raw_words / 2 + 3
}

const SLEEP_INSIGHT_MODEL: &str = "openai/gpt-oss-20b";

const SLEEP_INSIGHT_PROMPT: &str = "You are a terse sleep coach. You get a list of someone's recent \
nights (date, weekday, duration, bedtime, wake time). Reply with exactly one short sentence, under 160 \
characters, that reacts to a SPECIFIC pattern in this actual data - a number, a trend, a comparison \
between nights - never a generic 'get more sleep' or 'great job'. Encouraging when the pattern is good, \
direct but not scolding when it isn't. Output only the sentence: no quotes, no preamble, no markdown.";

/// One-line reaction to a recent-nights summary, generated fresh once a day
/// and cached by the caller. Returns None on any failure so the caller can
/// fall back without caching a broken response.
pub async fn sleep_insight(http: &reqwest::Client, api_key: &str, nights_summary: &str) -> Option<String> {
    let body = json!({
        "model": SLEEP_INSIGHT_MODEL,
        "temperature": 0.4,
        "max_tokens": 100,
        "messages": [
            {"role": "system", "content": SLEEP_INSIGHT_PROMPT},
            {"role": "user", "content": nights_summary},
        ],
    });
    let resp = http
        .post(CHAT_URL)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let value: Value = resp.json().await.ok()?;
    let text = value["choices"][0]["message"]["content"].as_str()?.trim();
    let text = text.trim_matches('"').trim();
    if text.is_empty() || text.len() > 400 {
        return None;
    }
    Some(text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::usable_polish;

    #[test]
    fn polish_guard_accepts_normal_cleanup() {
        assert!(usable_polish(
            "um so I ate like two rotis with dal you know",
            "I ate 2 rotis with dal."
        ));
        assert!(usable_polish("sleeping now", "Sleeping now."));
    }

    #[test]
    fn polish_guard_rejects_dropped_or_added_content() {
        let raw = "met Sarah Kim at the hackathon she works on compilers";
        assert!(!usable_polish(raw, "Met Sarah."));
        assert!(!usable_polish(
            raw,
            "Met Sarah Kim at the hackathon. She works on compilers. \
             Networking events like hackathons are a great way to meet engineers \
             and build long lasting professional relationships over time."
        ));
        assert!(!usable_polish(raw, ""));
        assert!(!usable_polish(raw, "Sure, here is the cleaned transcript:\nMet Sarah Kim."));
    }
}

fn as_f64(args: &Value, key: &str) -> Result<f64> {
    args.get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| anyhow!("missing numeric field {key}"))
}

fn as_str(args: &Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("missing field {key}"))
}

fn opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Parse raw text into structured log entries. One entry usually yields one
/// tool call, but mentioning several people yields one log_person call each.
/// Nutrition entries are grounded against USDA FoodData Central; if no usable
/// match exists, the model's own estimates are kept and usda_fdc_id stays null.
pub async fn parse(
    http: &reqwest::Client,
    groq_key: &str,
    usda_key: &str,
    raw_text: &str,
    context: &str,
) -> Result<Vec<Action>> {
    // An entry starting with "task:" is an unambiguous, deterministic
    // override - skip the model's own tool judgment entirely rather than
    // just hinting, since a bare word (e.g. "exam") has already proven
    // unreliable as a soft signal.
    let forced_tool = raw_text
        .trim_start()
        .to_lowercase()
        .starts_with("task:")
        .then_some("log_task");
    let calls = chat(http, groq_key, raw_text, context, forced_tool).await?;
    let mut results = Vec::with_capacity(calls.len());
    for (name, args) in calls {
        match name.as_str() {
            "log_workout" => results.push(Action::Workout {
                note: opt_str(&args, "note"),
                allow_not_today: args
                    .get("allow_not_today")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }),
            "log_itinerary_item" => results.push(Action::ItineraryItem {
                destination: opt_str(&args, "destination"),
                name: as_str(&args, "name")?,
                note: opt_str(&args, "note"),
            }),
            "log_sleep" => {
                let action = as_str(&args, "action")?;
                if !matches!(action.as_str(), "start" | "end" | "both") {
                    bail!("sleep action must be start, end or both");
                }
                results.push(Action::Sleep {
                    action,
                    at: opt_str(&args, "at"),
                    wake_at: opt_str(&args, "wake_at"),
                });
            }
            "log_learning" => {
                let kind = as_str(&args, "kind")?;
                if !matches!(kind.as_str(), "study" | "problems" | "note") {
                    bail!("learning kind must be study, problems or note");
                }
                results.push(Action::Learning(LearningRequest {
                    field: opt_str(&args, "field"),
                    resource: opt_str(&args, "resource"),
                    topic: opt_str(&args, "topic"),
                    kind,
                    resource_progress: args.get("resource_progress").and_then(Value::as_i64),
                    problems_count: args.get("problems_count").and_then(Value::as_i64),
                    problems_type: opt_str(&args, "problems_type")
                        .filter(|t| matches!(t.as_str(), "theory" | "implementation")),
                    confidence_signal: opt_str(&args, "confidence_signal"),
                    note: opt_str(&args, "note"),
                }));
            }
            "log_task" => {
                let status = opt_str(&args, "status")
                    .filter(|s| matches!(s.as_str(), "not_started" | "in_progress" | "done"));
                results.push(Action::Task(TaskRequest {
                    title: as_str(&args, "title")?,
                    category: opt_str(&args, "category"),
                    due_date: opt_str(&args, "due_date"),
                    due_time: opt_str(&args, "due_time"),
                    effort_minutes: args.get("effort_minutes").and_then(Value::as_i64).map(|n| n as i32),
                    status,
                    is_exam: args.get("is_exam").and_then(Value::as_bool),
                    note: opt_str(&args, "note"),
                }));
            }
            "log_cadence_completion" => results.push(Action::Cadence(CadenceCompletionRequest {
                cadence_name: as_str(&args, "cadence_name")?,
            })),
            _ => results.extend(
                parse_call(http, usda_key, &name, args)
                    .await?
                    .into_iter()
                    .map(Action::Entry),
            ),
        }
    }
    if results.is_empty() {
        bail!("no entries parsed");
    }
    Ok(results)
}

async fn parse_call(
    http: &reqwest::Client,
    usda_key: &str,
    name: &str,
    args: Value,
) -> Result<Vec<Parsed>> {
    match name {
        "log_nutrition" => {
            let food_name = as_str(&args, "food_name")?;
            let quantity = as_str(&args, "quantity")?;
            let quantity_g = as_f64(&args, "quantity_g")?;
            let usda_query = as_str(&args, "usda_query")?;
            let est_calories = as_f64(&args, "calories")?;
            let est_protein = as_f64(&args, "protein_g")?;
            let est_carbs = as_f64(&args, "carbs_g")?;
            let est_fat = as_f64(&args, "fat_g")?;

            let grounded = if quantity_g > 0.0 {
                usda::ground(http, usda_key, &usda_query, quantity_g)
                    .await
                    .unwrap_or_else(|e| {
                        tracing::warn!("usda lookup error: {e}");
                        None
                    })
            } else {
                None
            };

            // A grounded result far from the model's estimate usually means
            // the search matched the wrong food (e.g. plain butter for butter
            // chicken). Keep the estimate in that case.
            let usable = grounded.filter(|g| {
                g.calories > 0.0
                    && (est_calories <= 30.0
                        || (g.calories >= est_calories / 4.0 && g.calories <= est_calories * 4.0))
            });

            let data = match usable {
                Some(g) => {
                    tracing::info!(fdc_id = %g.fdc_id, desc = %g.description, "grounded in usda");
                    NutritionData {
                        food_name,
                        quantity,
                        calories: g.calories.round() as i64,
                        protein_g: (g.protein_g * 10.0).round() / 10.0,
                        carbs_g: (g.carbs_g * 10.0).round() / 10.0,
                        fat_g: (g.fat_g * 10.0).round() / 10.0,
                        usda_fdc_id: Some(g.fdc_id),
                    }
                }
                None => NutritionData {
                    food_name,
                    quantity,
                    calories: est_calories.round() as i64,
                    protein_g: est_protein,
                    carbs_g: est_carbs,
                    fat_g: est_fat,
                    usda_fdc_id: None,
                },
            };
            Ok(vec![Parsed::Nutrition(data)])
        }
        "log_person" => {
            let people = args
                .get("people")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("missing people array"))?;
            people
                .iter()
                .take(8)
                .map(|p| {
                    Ok(Parsed::Person(PersonData {
                        name: as_str(p, "name")?,
                        email: opt_str(p, "email"),
                        phone: opt_str(p, "phone"),
                        context: as_str(p, "context")?,
                        last_contacted: None,
                    }))
                })
                .collect()
        }
        "log_place" => {
            let category = as_str(&args, "category")?;
            if !crate::rank::PLACE_CATEGORIES.contains(&category.as_str()) {
                bail!("unexpected place category {category}");
            }
            Ok(vec![Parsed::Place(PlaceData {
                name: as_str(&args, "name")?,
                category,
                order_text: opt_str(&args, "order_text"),
                thoughts: opt_str(&args, "thoughts"),
                city: opt_str(&args, "city"),
                address: None,
                rating: None,
                rating_tier: None,
                rank_position: None,
            })])
        }
        "log_trip" => {
            let itinerary = args
                .get("itinerary_items")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|name| ItineraryEntry { name: name.to_string(), note: None })
                        .collect()
                })
                .unwrap_or_default();
            Ok(vec![Parsed::Trip(TripData {
                destination: as_str(&args, "destination")?,
                start_date: opt_str(&args, "start_date"),
                end_date: opt_str(&args, "end_date"),
                itinerary,
                thoughts: opt_str(&args, "thoughts"),
                rating: None,
                rating_tier: None,
                rank_position: None,
            })])
        }
        "log_album" => Ok(vec![Parsed::Album(AlbumData {
            artist: as_str(&args, "artist")?,
            title: as_str(&args, "title")?,
            thoughts: opt_str(&args, "thoughts"),
            rating: None,
            rating_tier: None,
            rank_position: None,
        })]),
        "log_song" => {
            let status = as_str(&args, "status")?;
            if !matches!(status.as_str(), "loved" | "to_revisit" | "revisited") {
                bail!("unexpected song status {status}");
            }
            Ok(vec![Parsed::Song(SongData {
                title: opt_str(&args, "title"),
                artist: opt_str(&args, "artist"),
                status,
                thoughts: opt_str(&args, "thoughts"),
                context: opt_str(&args, "context"),
                source: opt_str(&args, "source"),
            })])
        }
        "log_weight" => {
            let unit = opt_str(&args, "unit")
                .filter(|u| matches!(u.as_str(), "lb" | "kg"))
                .unwrap_or_else(|| "lb".to_string());
            Ok(vec![Parsed::Weight(WeightData {
                value: as_f64(&args, "value")?,
                unit,
                workout_id: None,
            })])
        }
        other => bail!("unexpected tool call {other}"),
    }
}
