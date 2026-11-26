import { h } from '../vendor/preact-htm.js'

// 24×24 stroke icons. Strings are path data; arrays [cx, cy, r] are circles.
const ICONS = {
  hash: ['M4 9h16', 'M4 15h16', 'M10 3 8 21', 'M16 3l-2 18'],
  speaker: ['M11 5 6 9H2v6h4l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M19 5a10 10 0 0 1 0 14'],
  mic: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
  micOff: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3', 'M3 3l18 18'],
  headphones: ['M3 18v-6a9 9 0 0 1 18 0v6', 'M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z', 'M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z'],
  headphonesOff: ['M3 18v-6a9 9 0 0 1 15.4-6.4', 'M21 12v6', 'M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3', 'M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z', 'M3 3l18 18'],
  leave: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  screen: ['M3 4h18v12H3z', 'M8 20h8', 'M12 16v4'],
  screenUp: ['M3 4h18v12H3z', 'M8 20h8', 'M12 16v4', 'M12 13V7', 'M9 10l3-3 3 3'],
  camera: ['M15 10l5-3v10l-5-3z', 'M3 6h12v12H3z'],
  cameraOff: ['M15 10l5-3v10l-5-3z', 'M3 6h12v12H3z', 'M2 2l20 20'],
  settings: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  plus: ['M12 5v14', 'M5 12h14'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  copy: ['M9 9h11v11H9z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  reply: ['M9 17l-5-5 5-5', 'M4 12h11a5 5 0 0 1 5 5v2'],
  edit: ['M17 3l4 4L8 20H4v-4L17 3z'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14'],
  smile: [[12, 12, 10], 'M8 14s1.5 2 4 2 4-2 4-2', 'M9 9h.01', 'M15 9h.01'],
  clip: ['M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5'],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', [9, 7, 4], 'M22 21v-2a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8'],
  userPlus: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', [9, 7, 4], 'M19 8v6', 'M22 11h-6'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  signal: ['M2 20h.01', 'M7 20v-4', 'M12 20v-8', 'M17 20V8', 'M22 20V4'],
  maximize: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'],
  chevronDown: ['M6 9l6 6 6-6'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
  check: ['M20 6 9 17l-5-5'],
  zap: ['M13 2 3 14h9l-1 8 10-12h-9l1-8z'],
  send: ['M22 2 11 13', 'M22 2l-7 20-4-9-9-4 20-7z'],
  pencilLine: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z'],
  globe: [[12, 12, 10], 'M2 12h20', 'M12 2a15 15 0 0 1 0 20', 'M12 2a15 15 0 0 0 0 20'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M9 12l2 2 4-4'],
  shieldPlain: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  crown: ['M2 18h20', 'M3 15 2 6l5.5 4L12 4l4.5 6L22 6l-1 9z'],
  pin: ['M12 17v5', 'M9 10.8V4h6v6.8l3 3.2v2H6v-2z', 'M8 4h8'],
  phone: ['M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z'],
  zoomIn: [[11, 11, 7], 'M21 21l-4.3-4.3', 'M11 8v6', 'M8 11h6'],
  zoomOut: [[11, 11, 7], 'M21 21l-4.3-4.3', 'M8 11h6'],
  search: [[11, 11, 7], 'M21 21l-4.3-4.3'],
  userX: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', [9, 7, 4], 'M17 8l5 5', 'M22 8l-5 5'],
  arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
  chevronRight: ['M9 6l6 6-6 6'],
  at: [[12, 12, 4], 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8'],
  image: ['M3 3h18v18H3z', [8.5, 8.5, 1.5], 'M21 15l-5-5L5 21'],
  code: ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6'],
  folder: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
  play: ['M6 4l14 8-14 8z'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z'],
  more: [[12, 12, 1], [19, 12, 1], [5, 12, 1]],
  volumeX: ['M11 5 6 9H2v6h4l5 4V5z', 'M22 9l-6 6', 'M16 9l6 6'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', [12, 12, 3]],
  eyeOff: ['M9.9 4.2A9.1 9.1 0 0 1 12 4c6.5 0 10 8 10 8a18 18 0 0 1-2.2 3.2', 'M14.1 14.2a3 3 0 0 1-4.2-4.2', 'M17.5 17.5A10 10 0 0 1 12 20c-6.5 0-10-8-10-8a18 18 0 0 1 5.5-5.5', 'M2 2l20 20'],
  calendar: ['M3 5h18v16H3z', 'M16 3v4', 'M8 3v4', 'M3 10h18'],
  tasks: ['M3 6l2 2 4-4', 'M3 16l2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'],
  apps: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  bot: ['M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z', 'M12 8V4.5', 'M12 3.5v0', 'M9 13v1', 'M15 13v1', 'M10 17h4', 'M2 13v2', 'M22 13v2'],
  thread: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', 'M8 9h8', 'M8 13h5'],
  clock: [[12, 12, 10], 'M12 6v6l4 2'],
  chevronLeft: ['M15 6l-6 6 6 6'],
  link: ['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'],
  // a knight
  chess: ['M8 21h10', 'M9 18h8', 'M16 18c.5-3 .5-6-1-9.5-1-2.5-3.5-5-7-5.5l.5 2.5L6 8l-1 3 2.5 1L11 9.5c.5 1.5-.5 3.5-2.5 5.5L9 18'],
  sparkle: ['M12 3l1.9 5.6a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z'],
  flag: ['M4 22V4', 'M4 4h12l-2 4 2 4H4'],
  flip: ['M7 4v16', 'M3 8l4-4 4 4', 'M17 20V4', 'M13 16l4 4 4-4'],
  stop: ['M6 6h12v12H6z'],
  poll: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  music: ['M9 18V5l12-2v13', [6, 18, 3], [18, 16, 3]],
  // a record: the music bot
  disc: [[12, 12, 9], [12, 12, 2.5], 'M16.8 7.2a6.5 6.5 0 0 1 1.5 2.6'],
  pause: ['M7 5h3.5v14H7z', 'M13.5 5H17v14h-3.5z'],
  skip: ['M5 5l10 7-10 7z', 'M19 5v14'],
  // two playing cards
  cards: ['M4 6.5 11 4l3.5 12.5-7 2.5z', 'M14 4.5h5a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1h-4', 'M8.5 10.5l1 3'],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  archive: ['M3 4h18v4H3z', 'M5 8v12h14V8', 'M10 12h4'],
  upload: ['M12 21V9', 'M7 14l5-5 5 5', 'M5 3h14'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
  folderPlus: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M12 11v6', 'M9 14h6'],
  doc: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M8 13h8', 'M8 17h5'],
  focus: [[12, 12, 3], 'M3 8V5a2 2 0 0 1 2-2h3', 'M16 3h3a2 2 0 0 1 2 2v3', 'M21 16v3a2 2 0 0 1-2 2h-3', 'M8 21H5a2 2 0 0 1-2-2v-3'],
  sun: [[12, 12, 4], 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  monitor: ['M3 4h18v12H3z', 'M8 20h8', 'M12 16v4'],
  heading: ['M6 4v16', 'M18 4v16', 'M6 12h12'],
  bold: ['M7 4h6a4 4 0 0 1 0 8H7z', 'M7 12h7a4 4 0 0 1 0 8H7z'],
  italic: ['M19 4h-9', 'M14 20H5', 'M15 4 9 20'],
  strike: ['M16 5.5A4 4 0 0 0 12 4h-1a3.5 3.5 0 0 0-1 6.9', 'M8 18.5a4 4 0 0 0 4 1.5h1a3.5 3.5 0 0 0 2.5-6', 'M4 12h16'],
  list: ['M9 6h11', 'M9 12h11', 'M9 18h11', [4.5, 6, 1], [4.5, 12, 1], [4.5, 18, 1]],
  listOrdered: ['M10 6h11', 'M10 12h11', 'M10 18h11', 'M4 4h1v5', 'M4 9h2', 'M6 20H3.5c0-1.5 2.5-2 2.5-3.5a1.25 1.25 0 0 0-2.4-.5'],
  quote: ['M5 7h5v5c0 3-2 5-4.5 5.5', 'M14 7h5v5c0 3-2 5-4.5 5.5'],
  table: ['M3 4h18v16H3z', 'M3 10h18', 'M3 15h18', 'M10 4v16'],
  minus: ['M5 12h14'],
  help: [[12, 12, 10], 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3', 'M12 17h.01'],
  ticket: ['M3 7a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-3a2 2 0 0 0 0-4z', 'M13 5v2', 'M13 11v2', 'M13 17v2']
}

// Each theme draws the same shapes its own way (lib/themes.js picks the style):
//   line  2 px strokes in the text colour (Standard)
//   thin  1.6 px hairlines, like system symbols (Glass)
//   neon  bold strokes with a soft glow (OLED; the glow is CSS, see themes.css)
//   quiet 1.5 px, a little faded (Minimal)
//   xp    glossy colour icons: a dark outline under a top-lit gradient, colour per meaning
let style = 'line'
export function setIconStyle (s) { style = s || 'line' }
export const iconStyle = () => style

const STROKE = { line: 2, thin: 1.6, neon: 2.3, quiet: 1.5 }

// XP colours: what the icon is about decides its colour, like the old Windows icon sets did
const XP_HUE = {
  green: ['mic', 'phone', 'check', 'play', 'speaker', 'headphones', 'camera', 'music', 'shield', 'shieldPlain', 'plus', 'userPlus', 'signal', 'download', 'disc', 'skip', 'pause'],
  yellow: ['folder', 'folderPlus', 'crown', 'zap', 'smile', 'lock', 'ticket', 'archive', 'clip', 'poll', 'cards', 'pin', 'inbox'],
  red: ['micOff', 'headphonesOff', 'cameraOff', 'volumeX', 'x', 'trash', 'leave', 'userX', 'stop', 'alert', 'flag', 'calendar'],
  gray: ['settings', 'edit', 'doc', 'focus', 'monitor', 'heading', 'bold', 'italic', 'strike', 'list', 'listOrdered', 'quote', 'table', 'minus', 'pencilLine', 'chess', 'clock', 'more', 'chevronDown', 'chevronRight', 'chevronLeft', 'flip', 'code'],
  purple: ['moon', 'sparkle', 'at'],
  sun: ['sun']
}
const HUE_OF = {}
for (const [hue, names] of Object.entries(XP_HUE)) for (const n of names) HUE_OF[n] = hue
// [top, bottom, outline]
const XP_COLORS = {
  blue: ['#9cc8ff', '#2160d8', '#0a2a73'],
  green: ['#b6f08a', '#2f9a1c', '#11470a'],
  yellow: ['#ffe58a', '#e09a12', '#6b4300'],
  red: ['#ffb0a0', '#d8321c', '#6a0f05'],
  gray: ['#f2f2ee', '#8a8d93', '#34373d'],
  purple: ['#e2c2ff', '#7a3fd0', '#33115e'],
  sun: ['#fff1a0', '#f0a018', '#7a4a00']
}

// The gradients live once in the page; every XP icon points at them
function ensureXpDefs () {
  if (typeof document === 'undefined' || document.getElementById('xp-icon-defs')) return
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.id = 'xp-icon-defs'
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.position = 'absolute'
  const defs = document.createElementNS(NS, 'defs')
  for (const [hue, [top, bottom]] of Object.entries(XP_COLORS)) {
    const g = document.createElementNS(NS, 'linearGradient')
    g.id = 'xpg-' + hue
    // user space: straight lines have no height, so a bounding-box gradient would vanish
    g.setAttribute('gradientUnits', 'userSpaceOnUse')
    for (const [k, v] of [['x1', 0], ['y1', 2], ['x2', 0], ['y2', 22]]) g.setAttribute(k, v)
    for (const [off, c] of [['0', top], ['0.55', bottom], ['1', bottom]]) {
      const st = document.createElementNS(NS, 'stop')
      st.setAttribute('offset', off)
      st.setAttribute('stop-color', c)
      g.appendChild(st)
    }
    defs.appendChild(g)
  }
  svg.appendChild(defs)
  document.body.appendChild(svg)
}

const shape = (p, i, extra) => Array.isArray(p)
  ? h('circle', { key: i, cx: p[0], cy: p[1], r: p[2], ...extra })
  : h('path', { key: i, d: p, ...extra })

export function Icon ({ name, size = 20, class: cls = '', title }) {
  const parts = ICONS[name] || []
  const base = {
    class: `icon icon-${style} ${cls}`,
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': title ? undefined : 'true'
  }
  if (style === 'xp') {
    ensureXpDefs()
    const hue = HUE_OF[name] || 'blue'
    return h('svg', base, [
      title ? h('title', null, title) : null,
      h('g', { key: 'o', stroke: XP_COLORS[hue][2], 'stroke-width': 3.6 }, parts.map((p, i) => shape(p, i))),
      h('g', { key: 'f', stroke: `url(#xpg-${hue})`, 'stroke-width': 2 }, parts.map((p, i) => shape(p, i)))
    ])
  }
  return h('svg', { ...base, stroke: 'currentColor', 'stroke-width': STROKE[style] || 2 }, [
    title ? h('title', null, title) : null,
    ...parts.map((p, i) => shape(p, i))
  ])
}
