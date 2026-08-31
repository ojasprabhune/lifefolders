import { useState } from 'react'
import { getHiddenDomains, getShowClock, getTheme, saveHiddenDomains, setShowClock, setTheme } from './api'
import { DOMAINS } from './domains'

function resolvedTheme(stored: 'light' | 'dark' | null): 'light' | 'dark' {
  return stored ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
}

export function Guide() {
  const [hidden, setHidden] = useState<string[]>(() => getHiddenDomains())
  const [theme, setThemeState] = useState(() => resolvedTheme(getTheme()))
  const [showClock, setShowClockState] = useState(() => getShowClock())

  const toggle = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]
    setHidden(next)
    saveHiddenDomains(next)
  }

  const toggleTheme = (dark: boolean) => {
    const next = dark ? 'dark' : 'light'
    setTheme(next)
    setThemeState(next)
  }

  const toggleClock = (show: boolean) => {
    setShowClock(show)
    setShowClockState(show)
  }

  return (
    <div className="app guide">
      <header>
        <h1 className="brand">guide</h1>
        <a className="guide-link" href="#/">
          back
        </a>
      </header>

      <section>
        <h2>how it works</h2>
        <p>
          Type anything into the input and press enter. The entry is parsed into one of two
          types, food or person, and shows up in the day's log. Click any row to edit its
          fields or delete it.
        </p>
      </section>

      <section>
        <h2>food</h2>
        <p>
          Name the food and the amount. Quantities can be loose ("a bowl of", "2 rotis",
          "150g"). Calories and macros are looked up in the USDA FoodData Central database
          and scaled to your portion. Entries without a clean USDA match are estimated and
          marked <em>estimated</em> in the editor.
        </p>
        <ul>
          <li>a banana</li>
          <li>2 rotis with dal</li>
          <li>butter chicken with naan at Vik's</li>
          <li>half a cup of cold brew with oat milk</li>
        </ul>
        <p className="schema">
          fields: food, quantity, cals, protein, carbs, fat
        </p>
      </section>

      <section>
        <h2>people</h2>
        <p>
          Start with who you met, then add anything worth remembering. Emails and phone
          numbers are picked out automatically; everything else lands in context.
        </p>
        <ul>
          <li>met Alex Chen at the coffee shop, works on robotics, alex@berkeley.edu</li>
          <li>ran into Priya from high school at BART, catching up next week</li>
        </ul>
        <p className="schema">fields: name, email, phone, context</p>
      </section>

      <section>
        <h2>music</h2>
        <p>
          Log an album after a full listen, or a single song. Songs heard in public with no
          known title go into a revisit queue; describe what you heard and where. Albums get
          rated by comparison, not numbers: hit <em>rate</em> on an album row, pick a tier,
          then answer a few this-or-that matchups. The 0 to 10 score comes from where the
          album lands among everything else you've ranked.
        </p>
        <ul>
          <li>listened to Blonde by Frank Ocean, loved the back half</li>
          <li>obsessed with Idioteque by Radiohead</li>
          <li>catch that dreamy synth song playing at the cafe right now</li>
        </ul>
        <p className="schema">
          album fields: title, artist, thoughts, rating. song fields: title, artist, status,
          context, source, thoughts
        </p>
      </section>

      <section>
        <h2>soma</h2>
        <p>
          Log the session itself in wger during the workout. Then say "worked out" here and
          the latest wger session is pulled in with its exercises, sets and volume. Only
          sessions from today are logged unless you explicitly ask otherwise. Set data is
          owned by wger; the note field is editable here. Body weight lives here too: say a
          weight and it's logged and charted as a trend on the soma page.
        </p>
        <ul>
          <li>worked out</li>
          <li>worked out, felt strong on squats</li>
          <li>log my last gym session even though it was yesterday</li>
          <li>weighed 158 this morning</li>
          <li>72 kg</li>
        </ul>
        <p className="schema">
          workout fields: date, exercises and sets (read-only), impression, duration, note.
          weight fields: value, unit
        </p>
      </section>

      <section>
        <h2>places</h2>
        <p>
          Log venues separately from food: the spot, what you ordered, what you thought.
          Places get the same comparison-based rating as albums, ranked within their
          category (coffee, restaurant, bar, dessert).
        </p>
        <ul>
          <li>went to Blue Bottle, got a cortado, solid but pricey</li>
        </ul>
      </section>

      <section>
        <h2>travel</h2>
        <p>
          Log destinations with a small itinerary, then add to it later. Trips rank like
          albums.
        </p>
        <ul>
          <li>went to Lisbon, did tram 28, Belem, lots of pastel de nata</li>
          <li>in Lisbon, add LX Factory</li>
        </ul>
      </section>

      <section>
        <h2>solace</h2>
        <p>
          Two phrases open and close a night: the entry shows a quiet sleeping state until
          you wake, then morphs into the duration. State a time and it is used instead of
          the clock. The solace tab tracks rolling averages, bedtime consistency, a streak
          against an 8 hour goal, and a short daily note reacting to your actual recent
          pattern instead of generic advice.
        </p>
        <p>
          <em>fullscreen</em> opens the whole picture on its own page: the bedtime to aim
          for tonight, a row per night showing when you were actually asleep, how far your
          bedtime and wake time have drifted, which weekdays you give up first, and how
          your nights cluster. Panels appear as you log enough nights to make them mean
          something.
        </p>
        <ul>
          <li>sleeping now</li>
          <li>just woke up</li>
          <li>went to bed at 11, just woke up</li>
        </ul>
      </section>

      <section>
        <h2>learning</h2>
        <p>
          Set up a field in the learning tab: add PDFs, links or named resources, then
          generate and edit a topic plan. Daily progress is logged here in the input;
          names resolve against your configured fields and resources.
        </p>
        <ul>
          <li>watched CS 285 lecture 7</li>
          <li>did 6 implementation problems on actor-critic, felt shaky</li>
          <li>read chapter 3 of Sutton and Barto, feeling confident</li>
        </ul>
      </section>

      <section>
        <h2>cadence</h2>
        <p>
          Define a cadence in the cadences tab, then log a completion the same way as everything
          else: say you did it and it matches an active cadence by name. Hydration is just a
          cadence named "Water."
        </p>
        <p>
          Each one repeats on its own schedule &mdash; every N days, or every N weeks on whichever
          weekdays you pick. Daily is just "every 1 day"; "every 2 weeks on mon/wed/fri" and
          "every 3 days" work the same way. Hit <em>manage</em> and click a cadence's schedule to
          change it later; renaming leaves the schedule alone, and changing the interval restarts
          the count from that day.
        </p>
        <p>
          The grid shows the last few months plus your current and longest streaks. A day it was
          never due on is faded, not a miss &mdash; skipping it can't break anything, and the
          streak counts scheduled turns you hit rather than calendar days. Doing something a day
          late still clears the turn it was owed for. A cadence that's "once a week, any day"
          gets a single bar per week instead of seven dots, since that's what the target actually
          is.
        </p>
        <p>
          The panel shows one cadence at a time. <em>fullscreen</em> opens every grid at once on
          its own page, three or four across, scrolling as far as your list goes.
        </p>
        <ul>
          <li>meditated</li>
          <li>drank water</li>
          <li>journaled before bed</li>
        </ul>
      </section>

      <section>
        <h2>sidequests</h2>
        <p>
          Homework, projects, extracurriculars, exams — anything with a deadline. A new title
          creates one; wording close to an already-tracked title updates it instead, whether
          that's rescheduling, marking it done, or moving it to a different category. Start an
          entry with <em>task:</em> to force it to log as a sidequest no matter how it reads,
          and add a <em>#tag</em> anywhere to pin its category exactly, e.g. "clean the garage
          #personal." Set is_exam true (the model does this itself for real tests/quizzes) and
          it gets spaced study reminders 7, 3, and 1 day out, plus its own section in the panel
          regardless of category. Whichever of those pills has arrived (and isn't checked off
          yet) highlights in red so it's obvious you're due to study; expand the card to see which
          day each one lands on. Drag a card onto a different section to recategorize it.
          Progress notes ("did 1 module of X") build a running history instead of overwriting
          the last one — the panel shows the latest line under the title. Deadlines read as days
          rather than dates: <em>today</em>, <em>tomorrow</em>, <em>monday</em>, and once
          something is a week or more out, <em>fri sep 4</em> — a bare weekday would repeat by
          then. Overdue says how late it is. Hover any of them for the exact date. A deadline
          with an
          actual clock time ("presentation friday at 2pm") syncs to the calendar at that exact
          time instead of the usual afternoon placeholder; add <em>@time</em> anywhere (e.g.
          "dentist tuesday @3pm") to pin the time exactly, the same idea as #tag for category.
          The third marker is <em>note:</em> — everything after it becomes the note, word for
          word, instead of leaving the model to decide what counts as one. The fourth is a
          length: write <em>1 hr</em>, <em>40min</em> or <em>2h30</em> anywhere in the entry and
          it becomes the estimate, and drops out of the title. Only a number with a unit counts,
          so "read 30 pages" and "the 1968 paper" stay as they are. You can also set or change it
          from the pill next to the title when a card is expanded. The estimate is what the day
          plan builds its blocks out of — without one everything gets a flat half hour, which is
          how three hours of work ends up scheduled into thirty minutes. Say "remove the due
          date on X" to take a deadline off without touching the sidequest itself.
          Marking one done tucks it into the <em>resolved</em> dropdown at the bottom of the
          panel instead of cluttering the open sections. Expand a card to see its clarity
          sessions, the total time they add up to, and an &times; on each to drop one &mdash; and
          to edit its title and note directly. Typed entries still add a line to the note; editing the box replaces
          what's there, so a note can be corrected and not only grown. The same edit is available
          on any sidequest row in the timeline, and either way it's the same note.
        </p>
        <ul>
          <li>psych mcq exam due next friday</li>
          <li>task: return library books #personal</li>
          <li>do 1 module of psych notes</li>
          <li>psych notes note: started module 4</li>
          <li>remove the due date on the ptsa award</li>
          <li>dentist appointment tuesday @3pm</li>
          <li>physics ps5 1 hr</li>
        </ul>
        <p className="schema">
          fields: title, category, due date, due time, effort minutes, status, is exam, note
        </p>
      </section>

      <section>
        <h2>clarity</h2>
        <p>
          A live timer in the clarity tab, attached to a sidequest or a cadence. Pick "sidequest"
          for an open one (or type a new one) or "cadence" to work against a habit you're
          tracking, choose a length (25/30/45/60 or custom), and start — the countdown mirrors
          into the browser tab title so it's glanceable from another tab. It chimes when the
          time is up. Running long? "+5 min" tacks five more minutes onto the current session
          without restarting it. Wrapped up before the timer did? Hit "finished early" — it ends
          the session the same as running out the clock (chimes, marks a tied cadence done for
          the day). Hit stop instead if you're abandoning the session rather than finishing it;
          that one doesn't count as done. Stop asks which you meant before it ends anything,
          since the two sit next to each other and mean opposite things — the clock keeps
          running while it asks, and "keep going" backs out. Either way a session is logged to the timeline and
          shows in the sidequest's history (expand one in the sidequests panel).
          Hit pause to freeze the clock without ending the session — paused time doesn't count
          against your minutes worked. The session keeps running even if you navigate elsewhere;
          a little pill in the corner shows the remaining time and jumps back to the timer when
          tapped. It survives a reload too — the session lives on the server, so refreshing (or
          closing the tab and coming back) picks the countdown up where it was, still paused if
          you left it paused. Leave it running past its planned time with nothing watching and
          it gets closed out at whatever you planned, counted as a stop rather than a finish.
          The ▷ on a sidequest row jumps straight here with it selected.
        </p>
      </section>

      <section>
        <h2>daily plan</h2>
        <p>
          Two boxes under the input: <em>today</em> and <em>tomorrow</em>. Jot the day's plan
          and anything to carry forward — they autosave as you type. Whatever you put in
          tomorrow's box seeds the next day's today box automatically, so a running plan
          carries over on its own. Page back through the last 7 days with the arrows; older
          days stay editable.
        </p>
      </section>

      <section>
        <h2>voice</h2>
        <p>
          Hold the mic button to speak instead of typing. The transcript is cleaned up
          before it lands: fillers and false starts go, self-corrections apply ("at 7,
          no wait, 8" becomes "at 8"), spoken emails become addresses. It drops into the
          textbox for a quick glance before you submit with enter or the arrow.
        </p>
      </section>

      <section>
        <h2>wishlist</h2>
        <p>
          Everywhere else in here is for things you already did. This is for things you want to do
          later. Start the entry with <em>wish:</em> and it lands on the list instead of the
          timeline. That prefix is the only way in &mdash; guessing from tense put too much on the
          list uninvited, so now "want to listen to Igor" is just a normal music log and
          "wish: Igor" is the one that goes on the list. Nothing fills this in for you; it's only
          what you put there.
        </p>
        <p>
          The good part is it crosses itself off. When you later log the thing for real, it
          notices, marks it done, and tells you how long it sat there. You can also add items by
          hand at the top of the wishlist tab, tick one off with <em>done</em>, or drop it with the
          &times;. Finished ones collapse into a <em>done</em> dropdown at the bottom with how long
          each one waited.
        </p>
        <ul>
          <li>wish: Igor</li>
          <li>wish: read Educated at some point</li>
          <li>wish: that ramen place downtown</li>
          <li>wish: learn linear algebra</li>
        </ul>
      </section>

      <section>
        <h2>commands</h2>
        <p>
          The same box that records things can also change them. Most entries are a record of
          something that happened; some are an instruction about something already tracked, and
          those get carried out instead of logged. The difference is the verb: "finished the
          chem lab writeup" reports, "push the chem lab writeup to friday" instructs. A command
          writes nothing to the timeline &mdash; it does the thing and replies with a line
          telling you what changed, and cmd+Z puts it back.
        </p>
        <p>
          Start an entry with <em>/</em> to force it to be read as a command no matter how it's
          worded, the same idea as <em>task:</em> for sidequests. Commands only ever act on
          sidequests and cadences you already have; if nothing matches the name you used, it
          says so and changes nothing rather than guessing at the wrong one.
        </p>
        <p>
          Asking what to do with the day is a command too. "what should i do first" lays out{' '}
          <em>the script</em> &mdash; today's day plan, at the top of the sidequests panel. Each
          block is as long as that sidequest's estimate says it is, lunch and dinner are left
          free, and it plans what's actually due today before anything that isn't. The same thing
          happens from the <em>plan it</em> button on the section itself.
        </p>
        <p>
          The script is yours to rearrange after that. Change how long a block runs and everything
          under it shifts to match; the &plus; on any block drops something in right after it, a
          break or another sidequest; the &times; takes one out. Set the times it runs between at
          the top &mdash; the finish-by time starts at the bedtime solace is already asking you
          for. Run past that and it says by how much, and offers the one thing worth dropping:
          work that isn't due today before anything that is, never an exam if there's an
          alternative, and the smallest thing that actually gets you under the line.
        </p>
        <ul>
          <li>push everything due tomorrow to friday</li>
          <li>mark the chem lab writeup done</li>
          <li>move the drone club poster to homework</li>
          <li>what should i do first</li>
          <li>/start 30 on psych notes</li>
          <li>delete that</li>
        </ul>
        <p className="schema">
          reschedule &middot; clear a due date &middot; set status &middot; recategorize &middot;
          delete a sidequest &middot; start a timer &middot; plan the day &middot; delete the last
          entry
        </p>
      </section>

      <section>
        <h2>search</h2>
        <p>
          Everything above only writes. Search is how you read it back. Most of what it's for is
          sidequests: what was that history assignment called, when was the last psych quiz, what
          did you write in the note on a project three weeks ago. Paging the date arrows back a
          day at a time only works for about a week &mdash; this doesn't have that limit.
        </p>
        <p>
          It matches the raw text you typed <em>and</em> every parsed field, so a sidequest title,
          a note buried inside one, a food, an album, or a person all hit. Results are grouped by
          day, newest first, and each row expands into the same editor as the timeline, so you can
          fix an old entry in place instead of navigating to its date first. Press <em>/</em>
          anywhere outside a text box to jump here. Hidden domains stay hidden in results.
        </p>
        <ul>
          <li>psych &mdash; every quiz, note and study session on it</li>
          <li>drone &mdash; when club work actually got done</li>
          <li>a person's name, an album title, a food you keep eating</li>
        </ul>
      </section>

      <section>
        <h2>tips</h2>
        <ul>
          <li>One thing per entry parses best. Log a meal as separate items for cleaner macros.</li>
          <li>Use the arrows next to the date to browse past days.</li>
          <li>Numbers are editable. Click a row and correct anything the parser got wrong.</li>
        </ul>
      </section>

      <section>
        <h2>appearance</h2>
        <p>
          Dark mode follows your system's light/dark setting until you flip this, which pins it.
          The clock is a small Pacific-time readout pinned to the top right, digits fading in as
          they change. Both are stored on this device only.
        </p>
        <div className="theme-switches">
          <label className="theme-switch">
            <input type="checkbox" checked={theme === 'dark'} onChange={(e) => toggleTheme(e.target.checked)} />
            <span className="theme-switch-track">
              <span className="theme-switch-thumb" />
            </span>
            dark mode
          </label>
          <label className="theme-switch">
            <input type="checkbox" checked={showClock} onChange={(e) => toggleClock(e.target.checked)} />
            <span className="theme-switch-track">
              <span className="theme-switch-thumb" />
            </span>
            pst clock
          </label>
        </div>
      </section>

      <section>
        <h2>hidden</h2>
        <p>
          Check a domain to hide it everywhere — its nav link, its filter chip, and its
          entries in the timeline. Stored on this device only, so it doesn't affect anything
          synced elsewhere.
        </p>
        <ul className="hidden-list">
          {DOMAINS.map((d) => (
            <li key={d.id}>
              <label>
                <input
                  type="checkbox"
                  checked={hidden.includes(d.id)}
                  onChange={() => toggle(d.id)}
                />
                {d.label}
              </label>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
