// The music bot on screen (lib/music.js does the playing): the music panel where you queue songs,
// the bot's tile in the call, its row under the voice channel, "Play in the call" on audio files
// in the chat, and the /play and /skip commands.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js'
import { model, voice, music, act, saveSettings } from '../lib/core.js'
import { positionOf, fmtDuration, isAudioFile } from '../lib/music.js'
import { Icon } from '../lib/icons.js'

export const musicOn = (g) => !!g && !g.kickedMe && model.appOn(g, 'music')
const inCallOf = (g) => !!g && voice.active?.gid === g.id

const addedBy = (g, k) => k === model.me.key ? 'added by you' : 'added by ' + model.memberName(g, k)
const NOT_ADDED = (g) => model.isMod(g, model.me.key)
  ? 'Add the Music app to this group first: group menu → Apps.'
  : "This group doesn't have the Music app. The owner or an admin can add it (group menu → Apps)."

// Redraw every second while a song plays (its progress)
function useSecond (on) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => set(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [on])
}

export function openMusic (g) {
  model.ui.music = { gid: g.id }
  model.emit()
}

function toggleMusic (g) {
  if (model.ui.music?.gid === g.id) model.ui.music = null
  else model.ui.music = { gid: g.id }
  model.emit()
}

// In the call controls and under "Voice connected"
export function MusicButton ({ g, round = false }) {
  if (!musicOn(g) || !inCallOf(g)) return null
  const q = music.queue(g, voice.active.ch)
  const playing = !!q.now && !q.now.paused
  const open = model.ui.music?.gid === g.id
  const title = q.now ? `Music: ${q.now.t}` : 'Music bot: play songs for everyone in the call'
  return round
    ? html`<button class="round music-toggle ${open || playing ? 'on' : ''}" title=${title} onClick=${() => toggleMusic(g)}><${Icon} name="disc" size=${22} class=${playing ? 'spin' : ''} /></button>`
    : html`<button class="btn music-toggle ${open ? 'on' : ''}" title=${title} onClick=${() => toggleMusic(g)}><${Icon} name="disc" size=${18} class=${playing ? 'spin' : ''} /></button>`
}

function NowPlaying ({ g, now, compact = false }) {
  const pos = positionOf(now)
  const pct = now.d ? Math.min(100, (pos / now.d) * 100) : null
  const time = now.d ? `${fmtDuration(pos)} / ${fmtDuration(now.d)}` : now.src === 'link' ? 'Live · ' + fmtDuration(pos) : fmtDuration(pos)
  const stop = (e) => e.stopPropagation()
  return html`
    <div class="mp-now ${compact ? 'compact' : ''}">
      <div class="mp-disc"><${Icon} name="disc" size=${compact ? 30 : 34} class=${now.paused ? '' : 'spin'} /></div>
      <div class="mp-meta">
        <b title=${now.t}>${now.t}</b>
        <small>${now.paused ? 'Paused · ' : ''}${addedBy(g, now.by)} · ${time}</small>
        ${pct != null && html`<div class="mp-bar"><i style=${{ width: pct + '%' }} /></div>`}
      </div>
      <div class="mp-ctl" onClick=${stop}>
        <button class="icon-btn" title=${now.paused ? 'Resume' : 'Pause'} onClick=${() => music.control(now.paused ? 'resume' : 'pause', now)}><${Icon} name=${now.paused ? 'play' : 'pause'} size=${18} /></button>
        <button class="icon-btn" title="Skip this song" onClick=${() => music.control('skip', now)}><${Icon} name="skip" size=${18} /></button>
      </div>
    </div>`
}

// The floating music panel (one at a time, for the channel you're in)
export function MusicPanel () {
  const ui = model.ui.music
  const g = ui && model.groups.get(ui.gid)
  const show = musicOn(g) && inCallOf(g)
  const q = show ? music.queue(g, voice.active.ch) : { now: null, next: [] }
  const ref = useRef()
  const fileRef = useRef()
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [drop, setDrop] = useState(false)
  useSecond(show && !!q.now && !q.now.paused)
  useEffect(() => {
    if (!show) return
    const off = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('.music-toggle, .modal, .toast')) { model.ui.music = null; model.emit() }
    }
    const esc = (e) => { if (e.key === 'Escape' && !model.ui.modal) { model.ui.music = null; model.emit() } }
    setTimeout(() => document.addEventListener('mousedown', off), 0)
    window.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc) }
  }, [show])
  if (!show) return null

  const me = model.me.key
  const mod = model.isMod(g, me)
  const ch = g.channels.get(voice.active.ch)
  const blocked = music.blocked(g)
  const s = model.settings.music || {}
  const vol = s.volume ?? 0.5
  const addLink = async (e) => {
    e.preventDefault()
    if (!link.trim() || busy) return
    setBusy(true)
    const n = await act(() => music.addLink(link.trim()))
    setBusy(false)
    if (n) setLink('')
  }
  const saveMusic = async (patch) => {
    await saveSettings({ music: patch })
    voice.applyOutputDevice()
  }
  const files = (e) => e.dataTransfer?.types?.includes('Files')

  return html`
    <div class="music-panel ${drop ? 'dropping' : ''}" ref=${ref}
      onDragOver=${(e) => { if (files(e)) { e.preventDefault(); setDrop(true) } }}
      onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDrop(false) }}
      onDrop=${(e) => { if (!files(e)) return; e.preventDefault(); setDrop(false); music.addFiles([...e.dataTransfer.files].filter(isAudioFile)) }}>
      <header class="mp-head">
        <span class="music-avatar"><${Icon} name="disc" size=${16} /></span>
        <div><b>Music</b><small>${g.dm ? 'In this call' : 'In ' + (ch?.name || 'this channel')} · everyone here hears it</small></div>
        <button class="icon-btn small" title="Close" onClick=${() => { model.ui.music = null; model.emit() }}><${Icon} name="x" size=${16} /></button>
      </header>
      ${q.now ? html`<${NowPlaying} g=${g} now=${q.now} />` : html`<div class="mp-empty">${q.next.length ? 'Starting the next song…' : 'Nothing is playing. Add a song below and everyone in the call hears it.'}</div>`}
      ${q.next.length > 0 && html`
        <div class="mp-queue">
          <div class="mp-label">Up next · ${q.next.length}</div>
          ${q.next.map((e, i) => html`
            <div class="mp-item" key=${e.by + ':' + e.id}>
              <span class="mp-n">${i + 1}</span>
              <div class="mp-meta"><span title=${e.t}>${e.t}</span><small>${addedBy(g, e.by)}${e.d ? ' · ' + fmtDuration(e.d) : e.src === 'link' ? ' · link' : ''}</small></div>
              ${(e.by === me || mod) && html`<button class="icon-btn small" title="Take it out of the queue" onClick=${() => music.control('remove', e)}><${Icon} name="x" size=${15} /></button>`}
            </div>`)}
        </div>`}
      ${blocked
        ? html`<p class="hint warn-text">${blocked}</p>`
        : html`
          <div class="mp-add">
            <button class="btn" onClick=${() => fileRef.current?.click()}><${Icon} name="music" size=${16} /> Add music files</button>
            <input type="file" multiple hidden ref=${fileRef} accept="audio/*,.mp3,.ogg,.oga,.opus,.wav,.flac,.m4a,.aac,.webm"
              onChange=${(e) => { const f = [...e.target.files]; e.target.value = ''; music.addFiles(f) }} />
          </div>
          <form class="mp-link" onSubmit=${addLink}>
            <input placeholder="Link to an audio file or a radio stream" value=${link} onInput=${(e) => setLink(e.target.value)} />
            <button class="btn primary" disabled=${!link.trim() || busy}>${busy ? 'Checking…' : 'Add'}</button>
          </form>`}
      <div class="mp-foot">
        <button class="icon-btn small" title=${s.muted ? 'Unmute music for me' : 'Mute music for me'} onClick=${() => saveMusic({ muted: !s.muted })}><${Icon} name=${s.muted ? 'volumeX' : 'speaker'} size=${16} /></button>
        <input type="range" min="0" max="1" step="0.05" value=${vol} disabled=${s.muted} title="Music volume (only for you)"
          onInput=${(e) => voice.setMusicVolume(+e.target.value)} onChange=${(e) => saveMusic({ volume: +e.target.value })} />
      </div>
      <small class="mp-note">A song plays from the computer of whoever added it, so it stays in the queue while they're in the call. Anyone here can pause or skip. Drop music files here to add them.</small>
    </div>`
}

// The bot's tile in the call
export function MusicTile ({ g, q }) {
  useSecond(!!q.now && !q.now.paused)
  return html`
    <div class="tile music-tile ${q.now && !q.now.paused ? 'playing' : ''}" onClick=${() => openMusic(g)}>
      ${q.now
        ? html`<${NowPlaying} g=${g} now=${q.now} compact />`
        : html`<div class="mp-now compact"><div class="mp-disc"><${Icon} name="disc" size=${30} /></div><div class="mp-meta"><b>${q.next[0]?.t || ''}</b><small>Up next · starting…</small></div></div>`}
      <div class="tile-label"><${Icon} name="bot" size=${14} /> Music${q.next.length ? ` · ${q.next.length} up next` : ''}</div>
    </div>`
}

// The bot under the voice channel in the channel list
export function MusicRow ({ g, c, q }) {
  const now = q.now
  const click = (e) => {
    e.stopPropagation()
    model.ui.stage = { gid: g.id, ch: c.id }
    if (voice.inChannel(g.id, c.id)) model.ui.music = { gid: g.id }
    model.emit()
  }
  return html`
    <div class="voice-user music-bot" title=${now ? `Music: ${now.t} (${addedBy(g, now.by)})` : 'Music bot'} onClick=${click}>
      <span class="music-avatar"><${Icon} name="disc" size=${13} class=${now && !now.paused ? 'spin' : ''} /></span>
      <span class="vu-name">Music <small>${now ? now.t : q.next.length + ' up next'}</small></span>
      ${now && !now.paused && html`<span class="eq" aria-hidden="true"><i /><i /><i /></span>`}
    </div>`
}

// On an audio file in the chat, while you're in this group's call
export function PlayInCall ({ g, a }) {
  if (!musicOn(g) || !inCallOf(g)) return null
  return html`<button class="icon-btn" title="Play in the call for everyone (music bot)" onClick=${() => act(() => music.addChat(a))}><${Icon} name="disc" /></button>`
}

// /play <link>, /play (opens the panel) and /skip in a text channel
export async function musicCommand (g, text) {
  if (!musicOn(g)) return model.toast(NOT_ADDED(g), 'error')
  if (!inCallOf(g)) return model.toast('Join a voice channel first, then play music there.', 'error')
  if (/^\/skip\b/i.test(text)) {
    const now = music.queue(g, voice.active.ch).now
    if (!now) return model.toast('Nothing is playing in your voice channel', 'error')
    music.control('skip', now)
    return model.toast(`Skipped “${now.t}”`)
  }
  const arg = text.replace(/^\/play\s*/i, '').trim()
  if (!arg) return openMusic(g)
  await act(() => music.addLink(arg))
}
