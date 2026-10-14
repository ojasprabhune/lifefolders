import { useState } from 'react'
import {
  getFontRotates,
  getFontTheme,
  getHiddenDomains,
  getShowClock,
  getTheme,
  getThemeRotates,
  saveHiddenDomains,
  setFontRotates,
  setFontTheme,
  setShowClock,
  setTheme,
  setThemeRotates,
  type FontTheme,
  type Theme,
} from './api'
import { DOMAINS } from './domains'
import { lastPanel } from './lastPanel'

function resolvedTheme(stored: Theme | null): Theme {
  return stored ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
}

const THEME_OPTIONS: { id: Theme; label: string; swatch: [string, string, string] }[] = [
  { id: 'light', label: 'light', swatch: ['#fbf3ea', '#2b2521', '#e4402a'] },
  { id: 'dark', label: 'dark', swatch: ['#1c1713', '#f2ece3', '#ef4a34'] },
  { id: 'slate', label: 'slate', swatch: ['#10131a', '#e0e0e0', '#4c6df1'] },
  { id: 'graphite', label: 'graphite', swatch: ['#121212', '#e0e0e0', '#888888'] },
  { id: 'teal', label: 'teal', swatch: ['#0f1613', '#e0e0e0', '#2a9d94'] },
  { id: 'atlantic', label: 'atlantic', swatch: ['#0d151c', '#e0e0e0', '#3fa0e0'] },
  { id: 'moss', label: 'moss', swatch: ['#121710', '#e0e0e0', '#76af5a'] },
  { id: 'plum', label: 'plum', swatch: ['#16121a', '#e0e0e0', '#a87dc0'] },
  { id: 'clay', label: 'clay', swatch: ['#181410', '#e0e0e0', '#c7906b'] },
]

const FONT_OPTIONS: {
  id: FontTheme
  label: string
  family: string
  italic: boolean
  weight: number
}[] = [
  { id: 'default', label: 'default', family: "'mencken-std-text', serif", italic: true, weight: 400 },
  { id: 'folio', label: 'folio', family: "'Libron', Georgia, serif", italic: true, weight: 400 },
  { id: 'press', label: 'press', family: "'Space Grotesk', sans-serif", italic: false, weight: 600 },
  { id: 'signal', label: 'signal', family: "'Archivo', sans-serif", italic: false, weight: 800 },
]

export function Guide() {
  const [hidden, setHidden] = useState<string[]>(() => getHiddenDomains())
  const [theme, setThemeState] = useState(() => resolvedTheme(getTheme()))
  const [font, setFontState] = useState(() => getFontTheme())
  const [showClock, setShowClockState] = useState(() => getShowClock())
  const [themeRotates, setThemeRotatesState] = useState(() => getThemeRotates())
  const [fontRotates, setFontRotatesState] = useState(() => getFontRotates())

  const toggle = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]
    setHidden(next)
    saveHiddenDomains(next)
  }

  const chooseTheme = (id: Theme) => {
    setTheme(id)
    setThemeState(id)
  }

  const chooseFont = (id: FontTheme) => {
    setFontTheme(id)
    setFontState(id)
  }

  const toggleThemeRotates = (on: boolean) => {
    setThemeRotates(on)
    setThemeRotatesState(on)
  }

  const toggleFontRotates = (on: boolean) => {
    setFontRotates(on)
    setFontRotatesState(on)
  }

  const toggleClock = (show: boolean) => {
    setShowClock(show)
    setShowClockState(show)
  }

  return (
    <div className="app guide">
      <header>
        <h1 className="brand">guide</h1>
        <a className="guide-link" href={lastPanel()}>
          back
        </a>
      </header>

      <section>
        <h2>how it works</h2>
        <ul>
          <li>Type or say anything, press enter. It gets sorted into the right domain.</li>
          <li>Click a row to edit or delete it.</li>
          <li>One thing per entry parses best.</li>
          <li>Arrows next to the date browse past days.</li>
        </ul>
      </section>

      <section>
        <h2>food</h2>
        <ul>
          <li>Name the food and a rough amount. Macros come from USDA.</li>
          <li>No clean match gets marked <em>estimated</em>.</li>
        </ul>
        <ul className="examples">
          <li>2 rotis with dal</li>
          <li>half a cup of cold brew with oat milk</li>
        </ul>
      </section>

      <section>
        <h2>people</h2>
        <ul>
          <li>Who you met, then anything worth remembering.</li>
          <li>Emails and phone numbers are picked out automatically.</li>
        </ul>
        <ul className="examples">
          <li>met Alex Chen at the coffee shop, works on robotics, alex@berkeley.edu</li>
        </ul>
      </section>

      <section>
        <h2>music</h2>
        <ul>
          <li>Log an album after a full listen, or a single song.</li>
          <li>An unknown song heard somewhere goes into a revisit queue.</li>
          <li>Hit <em>rate</em> on an album to rank it by this-or-that matchups.</li>
        </ul>
        <ul className="examples">
          <li>listened to Blonde by Frank Ocean, loved the back half</li>
          <li>catch that dreamy synth song playing at the cafe</li>
        </ul>
      </section>

      <section>
        <h2>soma</h2>
        <ul>
          <li>Log the workout in wger, then say "worked out" here to pull it in.</li>
          <li>Only today's session unless you say otherwise.</li>
          <li>Say a weight to log it and chart it on the soma page.</li>
        </ul>
        <ul className="examples">
          <li>worked out, felt strong on squats</li>
          <li>weighed 158 this morning</li>
        </ul>
      </section>

      <section>
        <h2>places &amp; travel</h2>
        <ul>
          <li>Places: the spot, what you got, what you thought. Ranked within their category.</li>
          <li>Trips: a destination with an itinerary you can add to later.</li>
        </ul>
        <ul className="examples">
          <li>went to Blue Bottle, got a cortado, solid but pricey</li>
          <li>in Lisbon, add LX Factory</li>
        </ul>
      </section>

      <section>
        <h2>solace</h2>
        <ul>
          <li>"sleeping now" starts a night, "just woke up" ends it.</li>
          <li>Say a time to use it instead of the clock.</li>
          <li>The tab shows averages, streaks and a daily note. <em>fullscreen</em> shows everything.</li>
        </ul>
        <ul className="examples">
          <li>went to bed at 11, just woke up</li>
        </ul>
      </section>

      <section>
        <h2>learning</h2>
        <ul>
          <li>Set up a field and its resources in the learning tab.</li>
          <li>Log progress here; names match your fields and resources.</li>
        </ul>
        <ul className="examples">
          <li>watched CS 285 lecture 7</li>
        </ul>
      </section>

      <section>
        <h2>cadence</h2>
        <ul>
          <li>Make a habit in the cadences tab, then say you did it.</li>
          <li>Schedules: every N days, or every N weeks on chosen weekdays.</li>
          <li>Days it wasn't due never count as misses. Late still counts.</li>
          <li><em>manage</em> edits schedules; <em>fullscreen</em> shows every grid.</li>
        </ul>
        <ul className="examples">
          <li>meditated</li>
          <li>drank water</li>
        </ul>
      </section>

      <section>
        <h2>sidequests</h2>
        <ul>
          <li>Anything with a deadline. A new title creates one; a known title updates it.</li>
          <li><em>task:</em> forces a sidequest.</li>
          <li><em>#tag</em> sets the category, <em>@3pm</em> the time.</li>
          <li><em>note:</em> makes the rest of the entry the note.</li>
          <li><em>1 hr</em>, <em>40min</em>, <em>2h30</em> set the estimate the day plan uses.</li>
          <li>Exams get study reminders 7, 3 and 1 day out.</li>
          <li>Drag a card to another section to recategorize.</li>
          <li>Expand a card to edit its title, note and estimate.</li>
        </ul>
        <ul className="examples">
          <li>psych mcq exam due next friday</li>
          <li>task: return library books #personal</li>
          <li>physics ps5 1 hr</li>
        </ul>
      </section>

      <section>
        <h2>clarity</h2>
        <ul>
          <li>A focus timer tied to a sidequest or cadence.</li>
          <li><em>+5 min</em> extends, <em>finished early</em> counts as done, stop doesn't.</li>
          <li>Survives reloads and navigating away; the corner pill jumps back.</li>
          <li>The ▷ on a sidequest starts one.</li>
        </ul>
      </section>

      <section>
        <h2>daily plan</h2>
        <ul>
          <li><em>today</em> and <em>tomorrow</em> boxes under the input. They autosave.</li>
          <li>Tomorrow's box becomes the next day's today.</li>
        </ul>
      </section>

      <section>
        <h2>voice</h2>
        <ul>
          <li>Hold the mic to talk. Fillers and self-corrections get cleaned up.</li>
          <li>The text lands in the box for a look before you send.</li>
        </ul>
      </section>

      <section>
        <h2>wishlist</h2>
        <ul>
          <li>Start with <em>wish:</em> to add something you want to do later.</li>
          <li>Crosses itself off when you log the real thing.</li>
        </ul>
        <ul className="examples">
          <li>wish: Igor</li>
        </ul>
      </section>

      <section>
        <h2>commands</h2>
        <ul>
          <li>Change tracked things instead of logging: reschedule, mark done, recategorize, delete.</li>
          <li><em>/</em> forces a command. cmd+Z undoes it.</li>
          <li>"what should i do first" builds today's script in the sidequests panel.</li>
          <li>Resize, add or remove blocks and the rest re-times itself.</li>
        </ul>
        <ul className="examples">
          <li>push everything due tomorrow to friday</li>
          <li>/start 30 on psych notes</li>
          <li>delete that</li>
        </ul>
      </section>

      <section>
        <h2>search</h2>
        <ul>
          <li>Finds any old entry by its text or fields, grouped by day.</li>
          <li>Press <em>/</em> outside a text box to open it. Rows edit in place.</li>
        </ul>
      </section>

      <section>
        <h2>appearance</h2>
        <ul>
          <li>A random dark theme each day. A pick holds until tomorrow.</li>
          <li>Turn off <em>change daily</em> to keep it.</li>
        </ul>
        <div className="theme-picker">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`theme-option${theme === opt.id ? ' active' : ''}`}
              onClick={() => chooseTheme(opt.id)}
            >
              <span className="theme-swatch">
                <span style={{ background: opt.swatch[0] }} />
                <span style={{ background: opt.swatch[1] }} />
                <span style={{ background: opt.swatch[2] }} />
              </span>
              {opt.label}
            </button>
          ))}
        </div>
        <div className="theme-switches">
          <label className="theme-switch">
            <input type="checkbox" checked={themeRotates} onChange={(e) => toggleThemeRotates(e.target.checked)} />
            <span className="theme-switch-track">
              <span className="theme-switch-thumb" />
            </span>
            change daily
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
        <h2>type</h2>
        <ul>
          <li>Same as color: random each day, <em>change daily</em> off to keep one.</li>
        </ul>
        <div className="theme-picker font-picker">
          {FONT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`theme-option${font === opt.id ? ' active' : ''}`}
              onClick={() => chooseFont(opt.id)}
            >
              <span
                className="font-sample"
                style={{ fontFamily: opt.family, fontStyle: opt.italic ? 'italic' : 'normal', fontWeight: opt.weight }}
              >
                life
              </span>
              {opt.label}
            </button>
          ))}
        </div>
        <div className="theme-switches">
          <label className="theme-switch">
            <input type="checkbox" checked={fontRotates} onChange={(e) => toggleFontRotates(e.target.checked)} />
            <span className="theme-switch-track">
              <span className="theme-switch-thumb" />
            </span>
            change daily
          </label>
        </div>
      </section>

      <section>
        <h2>hidden</h2>
        <ul>
          <li>Hides a domain's nav link, filter and entries. This device only.</li>
        </ul>
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
