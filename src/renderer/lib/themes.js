// The five looks of the app, each in a light and a dark mode. A theme sets its own colours,
// fonts, corners and icon style (styles.css + themes.css: html[data-theme][data-mode],
// icons.js: iconStyle). main.js has a copy of the window colours (THEME_CHROME) for the title
// bar buttons Windows draws itself.
//
// settings.mode: 'light' | 'dark' | 'system' (follow Windows/macOS) | null (the theme's own:
// XP and Glass are light, the others dark)

export const THEMES = [
  { id: 'standard', name: 'Standard', hint: 'Calm and simple, floating panels with soft shadows', icons: 'line', mode: 'dark' },
  { id: 'minimal', name: 'Minimal', hint: 'Nothing but the content: no borders, no shadows, quiet icons', icons: 'quiet', mode: 'light' },
  { id: 'xp', name: 'XP Classic', hint: 'Blue title bars, bevelled buttons and colourful icons', icons: 'xp', mode: 'light' },
  { id: 'glass', name: 'Glass', hint: 'Frosted see-through panels over a slowly moving background', icons: 'thin', mode: 'light' },
  { id: 'oled', name: 'OLED', hint: 'True black with bright, glowing colours', icons: 'neon', mode: 'dark' }
]

export const THEME_IDS = THEMES.map(t => t.id)
export const MODES = ['light', 'dark', 'system']

export function normalizeTheme (id) {
  return THEME_IDS.includes(id) ? id : 'standard'
}

export function themeInfo (id) {
  return THEMES.find(t => t.id === normalizeTheme(id))
}

// The mode actually shown: 'light' or 'dark'
export function resolveMode (settings, systemDark = true) {
  const m = settings?.mode
  if (m === 'light' || m === 'dark') return m
  if (m === 'system') return systemDark ? 'dark' : 'light'
  return themeInfo(settings?.theme).mode
}

const systemDark = () => typeof window === 'undefined' || !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches

// Puts the theme and mode on <html> so the CSS can pick them up. The animated background only
// runs in Glass, when it's switched on, and the window is visible (see themes.css .backdrop).
export function applyTheme (settings, doc = document, dark = systemDark()) {
  const id = normalizeTheme(settings?.theme)
  const root = doc.documentElement
  const mode = resolveMode(settings, dark)
  const anim = settings?.animatedBg !== false ? 'on' : 'off'
  if (root.dataset.theme !== id) root.dataset.theme = id
  if (root.dataset.mode !== mode) root.dataset.mode = mode
  if (root.dataset.anim !== anim) root.dataset.anim = anim
  return id
}

// Re-render when Windows switches between light and dark (only matters for mode 'system')
export function watchSystemMode (onChange) {
  const mq = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)')
  mq?.addEventListener?.('change', onChange)
}
