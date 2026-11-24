import { h } from '../vendor/preact-htm.js'

// The OpenDiscord logo: a speech bubble with three connected dots inside, you and your friends
// talking directly to each other. Same drawing as build/icon.png (scripts/make-icon.js).
// Its colours come from the theme (--logo-a, --logo-b, --logo-ink in themes.css).

export const LOGO_BUBBLE = 'M32 12.5c-11.6 0-20.5 7.9-20.5 17.8 0 5.3 2.6 10 6.8 13.3L16.6 52l9.6-4.6c1.8.4 3.8.7 5.8.7 11.6 0 20.5-7.9 20.5-17.8S43.6 12.5 32 12.5z'
export const LOGO_NODES = [[32, 21.5], [23.5, 36], [40.5, 36]]

function ensureDefs () {
  if (typeof document === 'undefined' || document.getElementById('od-logo-defs')) return
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.id = 'od-logo-defs'
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.position = 'absolute'
  svg.innerHTML = '<defs><linearGradient id="od-logo-grad" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" style="stop-color: var(--logo-a)"/><stop offset="1" style="stop-color: var(--logo-b)"/></linearGradient></defs>'
  document.body.appendChild(svg)
}

export function Logo ({ size = 20, title }) {
  ensureDefs()
  const [a, b, c] = LOGO_NODES
  return h('svg', { class: 'logo', width: size, height: size, viewBox: '0 0 64 64', role: title ? 'img' : undefined, 'aria-hidden': title ? undefined : 'true' }, [
    title ? h('title', null, title) : null,
    h('rect', { class: 'lg-tile', x: 2, y: 2, width: 60, height: 60, rx: 17 }),
    h('path', { class: 'lg-bubble', d: LOGO_BUBBLE }),
    h('path', { class: 'lg-mesh', d: `M${a[0]} ${a[1]}L${b[0]} ${b[1]}L${c[0]} ${c[1]}Z`, fill: 'none', 'stroke-width': 3, 'stroke-linejoin': 'round' }),
    ...LOGO_NODES.map(([x, y], i) => h('circle', { key: i, cx: x, cy: y, r: 4.6, fill: 'url(#od-logo-grad)' }))
  ])
}
