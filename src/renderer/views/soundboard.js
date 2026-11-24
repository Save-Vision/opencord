// Soundboard: short clips the whole group shares (sound.add ops; the audio is a normal file that
// travels peer to peer). Playing one tells everyone in your voice channel to play it on their
// own PC; it never goes through your microphone, and everyone can turn the soundboard off or
// down in Settings › Voice & audio, or mute one person's sounds by muting them.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js'
import { api, model, voice, act, append, rid, blobUrl, fetchBlob, importFiles, fmtBytes } from '../lib/core.js'
import { MAX_SOUND_BYTES, MAX_SOUND_MS, MAX_SOUNDS } from '../lib/model.js'
import { playClip } from '../lib/sounds.js'
import { Icon } from '../lib/icons.js'
import { Modal } from './modals.js'

const lastPlay = new Map() // key -> time of their last clip (1 per second per person)

async function playSound (g, s, volume = 1) {
  if (!(await fetchBlob(s.h, g.id))) return
  await playClip(blobUrl({ h: s.h, m: s.m }), volume)
}

export function sendSound (g, s) {
  const now = Date.now()
  if (now - (lastPlay.get(model.me.key) || 0) < 1000) return
  lastPlay.set(model.me.key, now)
  if (!voice.active || voice.active.gid !== g.id) return
  api.sendEph(g.id, null, { type: 'sound', id: s.id, ch: voice.active.ch })
  model.lastSound = { gid: g.id, key: model.me.key, id: s.id, at: now }
  model.emit()
  if (!voice.deafened) playSound(g, s)
}

// Someone played a clip: play it if we're in that voice channel with them
export function onRemoteSound (gid, from, d) {
  const g = model.groups.get(gid)
  if (!g || !voice.inChannel(gid, d.ch) || voice.deafened) return
  if (g.voice.get(from)?.ch !== d.ch || g.removed.has(from)) return
  if (model.settings.localMutes?.[from]) return
  const now = Date.now()
  if (now - (lastPlay.get(from) || 0) < 1000) return
  lastPlay.set(from, now)
  const s = model.soundsOf(g).find(x => x.id === d.id)
  if (!s) return
  model.lastSound = { gid, key: from, id: s.id, at: now }
  model.emit()
  playSound(g, s, model.settings.volumes?.[from] ?? 1)
}

// Fetch the group's clips in the background once you're in a call, so they play right away
export function prefetchSounds (g) {
  for (const s of model.soundsOf(g)) if (s.s <= MAX_SOUND_BYTES) fetchBlob(s.h, g.id)
}

export function SoundboardButton ({ g }) {
  const [open, setOpen] = useState(false)
  const ref = useRef()
  useEffect(() => {
    if (!open) return
    prefetchSounds(g)
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    setTimeout(() => document.addEventListener('mousedown', off), 0)
    return () => document.removeEventListener('mousedown', off)
  }, [open])
  if (model.settings.sounds?.soundboard === false) return null
  return html`
    <span class="soundboard-anchor" ref=${ref}>
      <button class="btn ${open ? 'on' : ''}" title="Soundboard" onClick=${() => setOpen(!open)}><${Icon} name="music" size=${18} /></button>
      ${open && html`<${Soundboard} g=${g} onClose=${() => setOpen(false)} />`}
    </span>`
}

function Soundboard ({ g, onClose }) {
  const sounds = model.soundsOf(g)
  const canDelete = (s) => s.by === model.me.key || model.isMod(g, model.me.key)
  const del = (e, s) => {
    e.preventDefault()
    if (!canDelete(s)) return
    model.openModal('confirm', {
      title: 'Remove sound',
      body: `Remove "${s.name}" from the soundboard for everyone in ${model.groupName(g)}?`,
      confirm: 'Remove',
      danger: true,
      onConfirm: () => act(() => append(g.id, 'sound.delete', { id: s.id }))
    })
  }
  const recent = model.lastSound?.gid === g.id && Date.now() - model.lastSound.at < 1500 ? model.lastSound.id : null
  return html`
    <div class="soundboard">
      <div class="sb-head"><b>Soundboard</b><small>${sounds.length}/${MAX_SOUNDS}</small></div>
      <div class="sb-grid">
        ${sounds.map(s => html`
          <button key=${s.id} class="sb-sound ${recent === s.id ? 'playing' : ''}" title=${`${s.name} · ${(s.dur / 1000).toFixed(1)} s · added by ${model.memberName(g, s.by)}${canDelete(s) ? '\nRight-click to remove' : ''}`}
            onClick=${() => sendSound(g, s)} onContextMenu=${(e) => del(e, s)}>
            <span class="sb-emoji">${s.emoji || '🔊'}</span><span class="sb-name">${s.name}</span>
          </button>`)}
        ${sounds.length < MAX_SOUNDS && !g.kickedMe && html`
          <button class="sb-sound add" title="Add a sound" onClick=${() => { onClose(); model.openModal('addSound', { gid: g.id }) }}>
            <${Icon} name="plus" size=${18} /><span class="sb-name">Add</span>
          </button>`}
      </div>
      ${!sounds.length && html`<p class="muted sb-empty">No sounds yet. Add short clips (up to ${MAX_SOUND_MS / 1000} s) everyone in this group can play in calls.</p>`}
    </div>`
}

function clipDuration (url) {
  return new Promise((resolve, reject) => {
    const a = new Audio()
    a.preload = 'metadata'
    a.onloadedmetadata = () => resolve(a.duration * 1000)
    a.onerror = () => reject(new Error("That file can't be played as audio"))
    a.src = url
  })
}

const EMOJI = ['🔊', '😂', '👏', '🎉', '💥', '😱', '🥁', '🐐', '💀', '🤡', '🚨', '🎺', '👀', '🔥', '😴', '🦆']

export function AddSoundModal ({ gid }) {
  const g = model.groups.get(gid)
  const [file, setFile] = useState(null) // { f, url, dur }
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🔊')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef()
  useEffect(() => () => file && URL.revokeObjectURL(file.url), [file])
  const pick = async (f) => {
    setErr('')
    if (!f) return
    if (!/^audio\//.test(f.type)) return setErr('Pick an audio file (MP3, OGG, WAV, …)')
    if (f.size > MAX_SOUND_BYTES) return setErr(`That's ${fmtBytes(f.size)}; sounds can be up to ${fmtBytes(MAX_SOUND_BYTES)}.`)
    const url = URL.createObjectURL(f)
    try {
      const dur = await clipDuration(url)
      if (!(dur > 0) || dur > MAX_SOUND_MS + 50) { URL.revokeObjectURL(url); return setErr(`That clip is ${(dur / 1000).toFixed(1)} s long; sounds can be up to ${MAX_SOUND_MS / 1000} s.`) }
      setFile({ f, url, dur })
      if (!name) setName(f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 32))
    } catch (e) { URL.revokeObjectURL(url); setErr(e.message) }
  }
  const save = async () => {
    if (!file || !name.trim() || busy) return
    setBusy(true)
    const out = await act(() => importFiles({ files: [file.f] }), 'Could not add the sound')
    const a = out?.[0]
    const ok = a && await act(() => append(g.id, 'sound.add', { id: rid(), name: name.trim(), emoji, h: a.h, s: a.s, m: a.m, dur: Math.round(file.dur) }))
    setBusy(false)
    if (ok) { model.closeModal(); model.toast(`Added "${name.trim()}" to the soundboard`) }
  }
  return html`
    <${Modal} title="Add a sound">
      <div class="modal-body add-sound">
        <input ref=${input} type="file" accept="audio/*" hidden onChange=${(e) => pick(e.target.files[0])} />
        <button class="btn sound-file" onClick=${() => input.current.click()}>
          <${Icon} name="music" size=${18} /> ${file ? `${file.f.name} · ${(file.dur / 1000).toFixed(1)} s` : 'Choose an audio file…'}
        </button>
        ${file && html`<button class="btn sm" onClick=${() => playClip(file.url)}><${Icon} name="play" size=${12} /> Preview</button>`}
        ${err && html`<p class="error-text">${err}</p>`}
        <label>Name<input value=${name} maxLength="32" placeholder="Airhorn" onInput=${(e) => setName(e.target.value)} /></label>
        <div class="label">Emoji</div>
        <div class="sb-emojis">${EMOJI.map(e => html`<button key=${e} class=${e === emoji ? 'active' : ''} onClick=${() => setEmoji(e)}>${e}</button>`)}</div>
        <p class="hint">Up to ${MAX_SOUND_MS / 1000} seconds and ${fmtBytes(MAX_SOUND_BYTES)}. Everyone in ${g ? model.groupName(g) : 'the group'} can play it in calls.</p>
      </div>
      <footer>
        <div class="spacer" />
        <button class="btn" onClick=${() => model.closeModal()}>Cancel</button>
        <button class="btn primary" disabled=${!file || !name.trim() || busy} onClick=${save}>${busy ? 'Adding…' : 'Add sound'}</button>
      </footer>
    <//>`
}
