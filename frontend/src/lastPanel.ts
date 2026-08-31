// Which domain panel was open before you left for a full-page route. The walls,
// the guide and the clarity timer replace the whole screen, and their "back"
// link used to drop you on a bare home page - so opening a focus session from
// sidequests and finishing it lost the panel you were working in.
//
// sessionStorage rather than a module variable so it survives the reload a
// hard navigation causes, and rather than localStorage so a new tab starts
// clean instead of reopening yesterday's panel.
const KEY = 'life_last_panel'

export function rememberPanel(route: string) {
  sessionStorage.setItem(KEY, route)
}

export function lastPanel(): string {
  const stored = sessionStorage.getItem(KEY)
  return stored && stored.startsWith('#/') ? stored : '#/'
}
