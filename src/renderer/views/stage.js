import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js'
import { model, voice, act, fmtRate, saveSettings } from '../lib/core.js'
import { Icon } from '../lib/icons.js'
import { Avatar } from './chat.js'
import { openMemberMenu } from './members.js'

function Video ({ stream, muted = true, fit = 'contain', onDblClick }) {
  const ref = useRef()
  useEffect(() => {
    const el = ref.current
    if (el && el.srcObject !== stream) { el.srcObject = stream || null; el.play?.().catch(() => {}) }
  }, [stream])
  return html`<video ref=${ref} autoplay playsinline muted=${muted} style=${{ objectFit: fit }} onDblClick=${onDblClick} />`
}

// Screen shares can be zoomed (mouse wheel, toward the cursor) and panned (drag). Works in
// fullscreen too. Clicks don't change the spotlight while zoomed in.
const MAX_ZOOM = 8
function ZoomableScreen ({ stream, onDblClick }) {
  const wrap = useRef()
  const drag = useRef(null)
  const [z, setZ] = useState({ s: 1, x: 0, y: 0 })
  useEffect(() => setZ({ s: 1, x: 0, y: 0 }), [stream])
  const clamp = (s, x, y) => {
    const el = wrap.current
    if (!el || s <= 1) return { s: 1, x: 0, y: 0 }
    const w = el.clientWidth
    const h = el.clientHeight
    return { s, x: Math.min(0, Math.max(w - w * s, x)), y: Math.min(0, Math.max(h - h * s, y)) }
  }
  const zoomAt = (factor, cx, cy) => setZ((cur) => {
    const s = Math.min(MAX_ZOOM, Math.max(1, cur.s * factor))
    // keep the point under the cursor where it is
    return clamp(s, cx - (cx - cur.x) * (s / cur.s), cy - (cy - cur.y) * (s / cur.s))
  })
  const center = (factor) => {
    const el = wrap.current
    if (el) zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2)
  }
  const onWheel = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const r = wrap.current.getBoundingClientRect()
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top)
  }
  const onPointerDown = (e) => {
    if (z.s <= 1 || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, ox: z.x, oy: z.y, moved: false }
  }
  const onPointerMove = (e) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    setZ(cur => clamp(cur.s, d.ox + dx, d.oy + dy))
  }
  const onPointerUp = () => { setTimeout(() => { drag.current = null }, 0) }
  const zoomed = z.s > 1.001
  return html`
    <div class="zoom-wrap ${zoomed ? 'zoomed' : ''} ${drag.current?.moved ? 'dragging' : ''}" ref=${wrap}
      onWheel=${onWheel} onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp}
      onClick=${(e) => { if (zoomed || drag.current?.moved) e.stopPropagation() }}>
      <div class="zoom-inner" style=${{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})` }}>
        <${Video} stream=${stream} onDblClick=${onDblClick} />
      </div>
      <div class="zoom-controls" onClick=${(e) => e.stopPropagation()} onPointerDown=${(e) => e.stopPropagation()}>
        <button title="Zoom out" disabled=${!zoomed} onClick=${() => center(1 / 1.5)}><${Icon} name="zoomOut" size=${16} /></button>
        <button class="zoom-pct" title="Reset zoom" onClick=${() => setZ({ s: 1, x: 0, y: 0 })}>${Math.round(z.s * 100)}%</button>
        <button title="Zoom in (or scroll over the stream)" disabled=${z.s >= MAX_ZOOM} onClick=${() => center(1.5)}><${Icon} name="zoomIn" size=${16} /></button>
      </div>
    </div>`
}

export function participantsOf (g, chId) {
  const keys = []
  if (voice.inChannel(g.id, chId)) keys.push(model.me.key)
  for (const [k, st] of g.voice) if (st.ch === chId && !keys.includes(k)) keys.push(k)
  return keys
}

export function connLabel (call) {
  if (!call) return { text: 'waiting…', cls: 'warn' }
  if (call.state === 'failed') return { text: 'no direct path', cls: 'bad' }
  if (call.state !== 'connected') return { text: call.state === 'new' ? 'connecting…' : call.state + '…', cls: 'warn' }
  const s = call.stats
  if (!s) return { text: 'connected', cls: 'good' }
  const where = s.path === 'lan' ? 'LAN' : 'direct'
  return { text: `${s.rtt != null ? s.rtt + ' ms · ' : ''}${where}${s.family ? ' · ' + s.family : ''}`, cls: s.rtt != null && s.rtt > 120 ? 'warn' : 'good' }
}

// What we're actually sending (worst case across viewers), e.g. "Sending 1920×1080 · 60 fps · 9.8 Mbps · H264 (GPU)"
function sendStatsLabel (fallback) {
  const all = [...voice.calls.values()].map(c => c.stats?.sendScreen).filter(Boolean)
  if (!all.length) return fallback || ''
  const s = all.reduce((a, b) => (b.w * b.fps < a.w * a.fps ? b : a))
  const gpu = s.encoder && !/libvpx|openh264|libaom|unknown/i.test(s.encoder) ? ' (GPU)' : ''
  const lim = s.limit && s.limit !== 'none' ? ` · limited by ${s.limit}` : ''
  return `Sending ${s.w}×${s.h} · ${s.fps} fps · ${fmtRate(s.kbps)}${s.codec ? ' · ' + s.codec + gpu : ''}${lim}`
}

function fullscreen (e) {
  const tile = e.currentTarget.closest('.tile')
  if (document.fullscreenElement) document.exitFullscreen()
  else tile?.requestFullscreen?.()
}

export function VoiceStage ({ g, ch }) {
  const joined = voice.inChannel(g.id, ch.id)
  const keys = participantsOf(g, ch.id)
  // focus: null = automatic (spotlight the first friend who is streaming), 'grid' = no spotlight
  const [focus, setFocus] = useState(null)

  if (!joined) {
    return html`
      <section class="stage idle">
        <div class="stage-join">
          <div class="intro-icon big"><${Icon} name="speaker" size=${44} /></div>
          <h1>${g.dm ? model.groupName(g) : ch.name}</h1>
          <p>${keys.length ? `${keys.map(k => model.memberName(g, k)).join(', ')} ${keys.length > 1 ? 'are' : 'is'} here.` : 'Nobody is here yet.'}</p>
          <div class="stage-avatars">${keys.map(k => html`<${Avatar} key=${k} name=${model.memberName(g, k)} color=${model.memberColor(g, k)} src=${model.memberAvatar(g, k)} size=${56} />`)}</div>
          <button class="btn primary lg" onClick=${() => act(() => voice.join(g.id, ch.id))}>${g.dm ? (keys.length ? 'Join call' : 'Start call') : 'Join voice'}</button>
          <small class="muted">Audio, video and screen shares go directly between you, encrypted with DTLS-SRTP.</small>
        </div>
      </section>`
  }

  const stateOf = (k) => (k === model.me.key ? voice.statePayload() : g.voice.get(k) || {})
  const ids = keys.flatMap(k => (stateOf(k).screen ? [k + ':screen', k] : [k]))
  const autoId = keys.filter(k => k !== model.me.key && stateOf(k).screen).map(k => k + ':screen')[0] || null
  const focusId = focus === 'grid' ? null : focus && ids.includes(focus) ? focus : autoId
  const toggle = (id) => setFocus(focusId === id ? 'grid' : id)

  const screens = []
  const people = []
  for (const k of keys) {
    const me = k === model.me.key
    const st = stateOf(k)
    const call = me ? null : voice.calls.get(k)
    const name = model.memberName(g, k)
    if (st.screen) {
      const stream = me ? voice.local.screen : call?.remoteStreams.screen
      const s = call?.stats?.screen
      screens.push({
        id: k + ':screen',
        el: html`
          <div class="tile screen" onClick=${() => toggle(k + ':screen')}>
            ${stream ? (me ? html`<${Video} stream=${stream} onDblClick=${fullscreen} />` : html`<${ZoomableScreen} stream=${stream} onDblClick=${fullscreen} />`) : html`<div class="tile-wait">Connecting to stream…</div>`}
            <div class="tile-label"><span class="live">LIVE</span> ${me ? 'Your screen' : name + "'s screen"}</div>
            <div class="tile-stats">${me ? sendStatsLabel(st.screenLabel) : s ? `${s.w}×${s.h} · ${s.fps} fps · ${fmtRate(s.kbps)}${s.codec ? ' · ' + s.codec : ''}` : ''}</div>
            <button class="tile-fs" title="Fullscreen" onClick=${(e) => { e.stopPropagation(); fullscreen(e) }}><${Icon} name="maximize" size=${18} /></button>
          </div>`
      })
    }
    const cam = st.cam ? (me ? voice.local.cam : call?.remoteStreams.cam) : null
    const conn = me ? null : connLabel(call)
    people.push({
      id: k,
      el: html`
        <div class="tile person ${voice.speaking.has(k) ? 'speaking' : ''}" onClick=${() => toggle(k)} onContextMenu=${(e) => openMemberMenu(e, g, k)}>
          ${cam
            ? html`<${Video} stream=${cam} fit="cover" />`
            : html`<${Avatar} name=${name} color=${model.memberColor(g, k)} src=${model.memberAvatar(g, k)} size=${84} speaking=${voice.speaking.has(k)} />`}
          <div class="tile-label">
            <${MuteIcons} g=${g} k=${k} st=${st} size=${15} />
            ${me ? name + ' (you)' : name}
          </div>
          ${conn && html`<div class="tile-conn ${conn.cls}" title="Connection to ${name}"><${Icon} name="signal" size=${13} /> ${conn.text}</div>`}
          ${!me && html`
            <label class="tile-volume" title=${'Volume for ' + name} onClick=${(e) => e.stopPropagation()}>
              <${Icon} name="speaker" size=${14} />
              <input type="range" min="0" max="1" step="0.05" value=${model.settings.volumes?.[k] ?? 1}
                onInput=${(e) => voice.setVolume(k, +e.target.value)}
                onChange=${(e) => saveSettings({ volumes: { ...model.settings.volumes, [k]: +e.target.value } })} />
            </label>`}
        </div>`
    })
  }

  const tiles = [...screens, ...people]
  const focused = focusId && tiles.find(t => t.id === focusId)
  const failed = [...voice.calls.values()].some(c => c.state === 'failed')

  return html`
    <section class="stage">
      <header class="chat-header">
        <${Icon} name="speaker" size=${20} class="dim" />
        <h2>${g.dm ? 'Call with ' + model.groupName(g) : ch.name}</h2>
        <span class="header-note"><${Icon} name="shield" size=${13} /> Peer-to-peer · end-to-end encrypted</span>
      </header>
      ${failed && html`<div class="banner bad">A direct connection to someone could not be established. Both of you may be behind strict NAT/CGNAT — see README → "If a call won't connect".</div>`}
      <div class="tiles ${focused ? 'has-focus' : ''} n${Math.min(tiles.length, 9)}">
        ${focused
          ? html`<div class="focus-area">${focused.el}</div><div class="strip">${tiles.filter(t => t !== focused).map(t => html`<div key=${t.id}>${t.el}</div>`)}</div>`
          : tiles.map(t => html`<div class="cell" key=${t.id}>${t.el}</div>`)}
      </div>
      <${CallControls} />
    </section>`
}

// Deafened / muted / muted by a moderator / muted for me
export function MuteIcons ({ g, k, st, size = 14 }) {
  const server = model.isServerMuted(g, k)
  const local = k !== model.me.key && model.settings.localMutes?.[k]
  return html`
    ${st.deaf ? html`<${Icon} name="headphonesOff" size=${size} class="bad" title="Deafened" />` : server ? html`<span class="server-mute" title="Muted by a moderator"><${Icon} name="micOff" size=${size} /></span>` : st.muted ? html`<${Icon} name="micOff" size=${size} class="bad" title="Muted" />` : null}
    ${local && html`<${Icon} name="volumeX" size=${size} class="bad" title="Muted for you" />`}`
}

export function CallControls () {
  return html`
    <div class="call-controls">
      <button class="round ${voice.muted ? 'off' : ''}" title=${(voice.muted ? 'Unmute' : 'Mute') + ' (Ctrl+Shift+F9)'} onClick=${() => voice.toggleMute()}>
        <${Icon} name=${voice.muted ? 'micOff' : 'mic'} size=${22} />
      </button>
      <button class="round ${voice.deafened ? 'off' : ''}" title=${(voice.deafened ? 'Undeafen' : 'Deafen') + ' (Ctrl+Shift+F10)'} onClick=${() => voice.toggleDeafen()}>
        <${Icon} name=${voice.deafened ? 'headphonesOff' : 'headphones'} size=${22} />
      </button>
      <button class="round ${voice.local.cam ? 'on' : ''}" title=${voice.local.cam ? 'Turn camera off' : 'Turn camera on'} onClick=${() => voice.toggleCamera()}>
        <${Icon} name=${voice.local.cam ? 'camera' : 'cameraOff'} size=${22} />
      </button>
      <button class="round ${voice.local.screen ? 'on' : ''}" title=${voice.local.screen ? 'Stop sharing' : 'Share your screen'}
        onClick=${() => voice.local.screen ? voice.stopScreen() : model.openModal('screen')}>
        <${Icon} name="screenUp" size=${22} />
      </button>
      <button class="round hangup" title="Disconnect" onClick=${() => voice.leave()}><${Icon} name="leave" size=${22} /></button>
    </div>`
}
