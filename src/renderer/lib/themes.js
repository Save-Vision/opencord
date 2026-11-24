// The four looks of the app. Each one sets its own colours, fonts, corners and icon style
// (styles.css: html[data-theme=…], icons.js: iconStyle). main.js has a copy of the window
// colours (THEME_CHROME) for the title bar buttons Windows draws itself.

export const THEMES = [
  { id: 'standard', name: 'Standard', hint: 'Dark and calm, floating panels with soft shadows', icons: 'line' },
  { id: 'xp', name: 'XP Classic', hint: 'Blue title bars, beige windows, bevelled buttons and colourful icons', icons: 'xp' },
  { id: 'glass', name: 'Glass', hint: 'Light and clean, frosted see-through panels over a slowly moving background', icons: 'thin' },
  { id: 'oled', name: 'OLED', hint: 'True black for OLED screens, with bright neon colours', icons: 'neon' }
]

export const THEME_IDS = THEMES.map(t => t.id)

export function normalizeTheme (id) {
  return THEME_IDS.includes(id) ? id : 'standard'
}

export function themeInfo (id) {
  return THEMES.find(t => t.id === normalizeTheme(id))
}

// Puts the theme on <html> so the CSS can pick it up. The animated background only runs in
// Glass, when it's switched on, and the window is visible (see styles.css .backdrop).
export function applyTheme (settings, doc = document) {
  const id = normalizeTheme(settings?.theme)
  const root = doc.documentElement
  if (root.dataset.theme !== id) root.dataset.theme = id
  const anim = settings?.animatedBg !== false ? 'on' : 'off'
  if (root.dataset.anim !== anim) root.dataset.anim = anim
  return id
}
