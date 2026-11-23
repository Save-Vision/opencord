import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js'
import { api, model, voice, act, append, rid, saveSettings, blobUrl, COLORS, fmtRate, fmtBytes, initials } from '../lib/core.js'
import { SCREEN_PRESETS } from '../lib/voice.js'
import { getMic, stopMic, noiseMode, isDenoised } from '../lib/denoise.js'
import { extOf } from '../lib/highlight.js'
import { Icon } from '../lib/icons.js'
import { Avatar, CodeView, MarkdownView, useBlobText } from './chat.js'
import { participantsOf } from './stage.js'
import { NetworkHealth } from './nethealth.js'
import { AvatarCropper, useImagePicker } from './avatar.js'
import { restartForUpdate, updateStatusText } from './updates.js'

function Modal ({ title, children, wide = false, onClose = () => model.closeModal() }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])
  return html`
    <div class="modal-backdrop" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-label=${title}>
        <header><h3>${title}</h3><button class="icon-btn" onClick=${onClose} title="Close"><${Icon} name="x" /></button></header>
        ${children}
      </div>
    </div>`
}

export function Modals () {
  const m = model.ui.modal
  if (!m) return null
  const C = {
    addGroup: AddGroupModal,
    invite: InviteModal,
    channel: ChannelModal,
    renameGroup: RenameGroupModal,
    confirm: ConfirmModal,
    settings: SettingsModal,
    screen: ScreenPickerModal,
    image: ImageModal,
    groupIcon: GroupIconModal,
    textFile: TextFileModal
  }[m.name]
  return C ? html`<${C} ...${m.props} />` : null
}

// ---------------------------------------------------------------- groups

export function AddGroupModal ({ tab: initialTab = 'create' }) {
  const [tab, setTab] = useState(initialTab)
  const [name, setName] = useState(model.me.name ? `${model.me.name}'s group` : 'Our group')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    const g = await act(() => api.createGroup(name))
    setBusy(false)
    if (!g) return
    model.addGroup(g)
    model.selectGroup(g.id)
    model.openModal('invite', { gid: g.id, fresh: true })
  }
  const join = async () => {
    setBusy(true)
    const g = await act(() => api.joinGroup(code))
    setBusy(false)
    if (!g) return
    model.addGroup(g)
    model.selectGroup(g.id)
    model.closeModal()
    model.toast(g.existed ? "You're already in this group" : 'Joined! History syncs as soon as a friend in the group is online.')
  }
  return html`
    <${Modal} title="Add a group">
      <div class="tabs">
        <button class=${tab === 'create' ? 'active' : ''} onClick=${() => setTab('create')}>Create</button>
        <button class=${tab === 'join' ? 'active' : ''} onClick=${() => setTab('join')}>Join with invite</button>
      </div>
      ${tab === 'create'
        ? html`
          <div class="modal-body">
            <label>Group name<input value=${name} maxLength="64" autoFocus onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && create()} /></label>
            <p class="hint">A fresh 256-bit secret is generated on this device. Only people you give the invite code to can find or join the group.</p>
          </div>
          <footer><button class="btn primary" disabled=${busy || !name.trim()} onClick=${create}>Create group</button></footer>`
        : html`
          <div class="modal-body">
            <label>Invite code<textarea class="mono" rows="3" value=${code} autoFocus placeholder="OD1-…" onInput=${(e) => setCode(e.target.value.trim())} /></label>
            ${code.startsWith('ODF1-')
              ? html`<p class="hint warn-text">That's a friend code, not a group invite. Add it under Friends (the top button in the left bar).</p>`
              : html`<p class="hint">Ask a friend for the code (Group menu → Invite people).</p>`}
          </div>
          <footer><button class="btn primary" disabled=${busy || !code.startsWith('OD1-')} onClick=${join}>Join group</button></footer>`}
    <//>`
}

function InviteModal ({ gid, fresh }) {
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => { api.getInvite(gid).then(setCode) }, [gid])
  const copy = async () => { await api.copy(code); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  return html`
    <${Modal} title=${fresh ? 'Group created — invite your friends' : 'Invite friends'}>
      <div class="modal-body">
        <div class="invite-box">
          <code class="mono">${code}</code>
          <button class="btn primary" onClick=${copy}><${Icon} name=${copied ? 'check' : 'copy'} size=${16} /> ${copied ? 'Copied' : 'Copy'}</button>
        </div>
        <div class="callout warn">
          <${Icon} name="lock" size=${16} />
          <div>This code <b>is</b> the group key. Anyone who has it can join and read the full history, so send it privately (in person, or over Signal/WhatsApp) — never post it publicly.</div>
        </div>
      </div>
      <footer><button class="btn" onClick=${() => model.closeModal()}>Done</button></footer>
    <//>`
}

function RenameGroupModal ({ gid }) {
  const g = model.groups.get(gid)
  const [name, setName] = useState(model.groupName(g))
  const save = async () => { await act(() => append(gid, 'group.rename', { name: name.trim() })); model.closeModal() }
  return html`
    <${Modal} title="Rename group">
      <div class="modal-body"><label>Name<input value=${name} maxLength="64" autoFocus onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && save()} /></label></div>
      <footer><button class="btn primary" disabled=${!name.trim()} onClick=${save}>Save</button></footer>
    <//>`
}

function ChannelModal ({ gid, kind = 'text', chId = null }) {
  const g = model.groups.get(gid)
  const existing = chId ? g.channels.get(chId) : null
  const [k, setK] = useState(existing?.kind || kind)
  const [name, setName] = useState(existing?.name || '')
  const clean = k === 'text' ? name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '') : name.trim()
  const save = async () => {
    if (!clean) return
    if (existing) await act(() => append(gid, 'channel.rename', { id: chId, name: clean }))
    else {
      const id = rid()
      const ok = await act(() => append(gid, 'channel.create', { id, name: clean, kind: k }))
      if (ok && k === 'text') model.selectChannel(gid, id)
    }
    model.closeModal()
  }
  const del = () => model.openModal('confirm', {
    title: 'Delete channel',
    body: `Delete ${existing.kind === 'text' ? '#' : ''}${existing.name} for everyone?`,
    confirm: 'Delete channel',
    danger: true,
    onConfirm: () => act(() => append(gid, 'channel.delete', { id: chId }))
  })
  return html`
    <${Modal} title=${existing ? 'Edit channel' : 'Create channel'}>
      <div class="modal-body">
        ${!existing && html`
          <div class="kind-pick">
            <button class=${k === 'text' ? 'active' : ''} onClick=${() => setK('text')}><${Icon} name="hash" /><div><b>Text</b><small>Messages, images, files</small></div></button>
            <button class=${k === 'voice' ? 'active' : ''} onClick=${() => setK('voice')}><${Icon} name="speaker" /><div><b>Voice</b><small>Talk, video, screen share</small></div></button>
          </div>`}
        <label>Channel name<input value=${name} maxLength="48" autoFocus placeholder=${k === 'text' ? 'new-channel' : 'Gaming'} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && save()} /></label>
      </div>
      <footer>
        ${existing && html`<button class="btn danger-ghost" onClick=${del}>Delete channel</button>`}
        <div class="spacer" />
        <button class="btn primary" disabled=${!clean} onClick=${save}>${existing ? 'Save' : 'Create'}</button>
      </footer>
    <//>`
}

function ConfirmModal ({ title, body, confirm = 'OK', danger = false, onConfirm }) {
  return html`
    <${Modal} title=${title}>
      <div class="modal-body"><p>${body}</p></div>
      <footer>
        <div class="spacer" />
        <button class="btn" onClick=${() => model.closeModal()}>Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" autoFocus onClick=${() => { model.closeModal(); onConfirm() }}>${confirm}</button>
      </footer>
    <//>`
}

function GroupIconModal ({ gid }) {
  const g = model.groups.get(gid)
  const [cropping, setCropping] = useState(null)
  const [fileInput, pickImage] = useImagePicker(setCropping)
  if (!g) return null
  const save = async (icon) => {
    const ok = await act(() => append(gid, 'group.icon', { icon }), 'Could not change the picture')
    if (!ok) return
    model.toast(icon ? 'Group picture updated' : 'Group picture removed')
    model.closeModal()
  }
  return html`
    <${Modal} title="Group picture">
      <div class="modal-body">
        ${fileInput}
        ${cropping
          ? html`<${AvatarCropper} image=${cropping} onCancel=${() => setCropping(null)} onDone=${(url) => { setCropping(null); save(url) }} />`
          : html`
            <div class="profile-editor">
              <button class="avatar-pick" title="Upload a picture" onClick=${pickImage}>
                ${g.icon ? html`<img class="group-icon big" src=${g.icon} alt="" />` : html`<div class="group-icon big placeholder">${initials(model.groupName(g))}</div>`}
                <span class="avatar-pick-overlay"><${Icon} name="camera" size=${24} /></span>
              </button>
              <div class="row center avatar-actions">
                <button class="btn sm" onClick=${pickImage}>${g.icon ? 'Change picture' : 'Upload picture'}</button>
                ${g.icon && html`<button class="btn sm" onClick=${() => save(null)}>Remove</button>`}
              </div>
              <p class="hint">Everyone in ${model.groupName(g)} sees it. It syncs with the history, so friends who are offline get it later.</p>
            </div>`}
      </div>
    <//>`
}

function TextFileModal ({ a }) {
  const have = model.blobs.get(a.h)?.state === 'have'
  const text = useBlobText(a, have)
  const ext = extOf(a.n)
  const md = ext === 'md' || ext === 'markdown'
  const [source, setSource] = useState(false)
  return html`
    <${Modal} title=${a.n} wide>
      ${md && html`
        <div class="tabs">
          <button class=${!source ? 'active' : ''} onClick=${() => setSource(false)}>Preview</button>
          <button class=${source ? 'active' : ''} onClick=${() => setSource(true)}>Source</button>
        </div>`}
      <div class="modal-body text-file-body">
        ${text == null ? html`<p class="muted">Loading…</p>` : md && !source ? html`<${MarkdownView} text=${text} />` : html`<${CodeView} text=${text} ext=${md ? 'md' : ext} />`}
      </div>
      <footer>
        <button class="btn" disabled=${text == null} onClick=${() => { api.copy(text); model.toast('Copied to clipboard') }}><${Icon} name="copy" size=${16} /> Copy text</button>
        <div class="spacer" />
        <button class="btn" onClick=${() => act(() => api.saveBlob(a.h, a.n))}><${Icon} name="download" size=${16} /> Save</button>
        <button class="btn primary" onClick=${() => model.closeModal()}>Close</button>
      </footer>
    <//>`
}

function ImageModal ({ a }) {
  return html`
    <div class="lightbox" onClick=${() => model.closeModal()}>
      <img src=${blobUrl(a)} alt=${a.n} onClick=${(e) => e.stopPropagation()} />
      <div class="lightbox-bar" onClick=${(e) => e.stopPropagation()}>
        <span>${a.n}</span>
        <button class="btn" onClick=${() => act(() => api.saveBlob(a.h, a.n))}><${Icon} name="download" size=${16} /> Save</button>
      </div>
    </div>`
}

// ---------------------------------------------------------------- screen share

function ScreenPickerModal () {
  const s = model.settings.screen
  const [sources, setSources] = useState(null)
  const [tab, setTab] = useState('screen')
  const [sel, setSel] = useState(null)
  const [preset, setPreset] = useState(s.preset)
  const [hint, setHint] = useState(s.contentHint)
  const [audio, setAudio] = useState(!!s.audio)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => api.screenSources().then((list) => {
      if (!alive) return
      setSources(list)
      setSel(cur => cur && list.some(x => x.id === cur) ? cur : (list.find(x => x.kind === 'screen') || list[0])?.id || null)
    }).catch(e => model.toast('Could not list screens: ' + e.message, 'error'))
    load()
    const iv = setInterval(load, 4000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  const g = model.currentGroup()
  const viewers = voice.active ? Math.max(1, participantsOf(model.groups.get(voice.active.gid), voice.active.ch).length - 1) : 1
  const p = SCREEN_PRESETS[preset]
  const go = async () => {
    setBusy(true)
    try {
      await voice.startScreen({ sourceId: sel, preset, audio, contentHint: hint })
      saveSettings({ screen: { preset, contentHint: hint, audio } })
      model.closeModal()
    } catch (e) {
      model.toast('Screen share failed: ' + e.message, 'error')
    }
    setBusy(false)
  }
  const list = (sources || []).filter(x => x.kind === tab)
  return html`
    <${Modal} title="Share your screen" wide>
      <div class="tabs">
        <button class=${tab === 'screen' ? 'active' : ''} onClick=${() => setTab('screen')}>Screens</button>
        <button class=${tab === 'window' ? 'active' : ''} onClick=${() => setTab('window')}>Application windows</button>
      </div>
      <div class="modal-body">
        <div class="source-grid">
          ${!sources && html`<p class="muted">Loading…</p>`}
          ${sources && !list.length && html`<p class="muted">Nothing to share here.</p>`}
          ${list.map(x => html`
            <button key=${x.id} class="source ${sel === x.id ? 'active' : ''}" onClick=${() => setSel(x.id)} onDblClick=${go}>
              ${x.thumb ? html`<img src=${x.thumb} />` : html`<div class="thumb-empty" />`}
              <span>${x.icon && html`<img class="app-icon" src=${x.icon} />`}${x.name}</span>
            </button>`)}
        </div>
        <div class="screen-opts">
          <label>Quality
            <select value=${preset} onChange=${(e) => setPreset(e.target.value)}>
              ${Object.entries(SCREEN_PRESETS).map(([k, v]) => html`<option value=${k}>${v.label} (up to ${fmtRate(v.kbps)})</option>`)}
            </select>
          </label>
          <label>Optimise for
            <select value=${hint} onChange=${(e) => setHint(e.target.value)}>
              <option value="motion">Smooth motion (games, video)</option>
              <option value="detail">Sharp text (code, documents)</option>
            </select>
          </label>
          ${model.platform === 'win32' && html`
            <label class="check" title="Captures all system audio. Others in the call may hear their own voice echoed back unless you use headphones and turn their volume down.">
              <input type="checkbox" checked=${audio} onChange=${(e) => setAudio(e.target.checked)} /> Share system audio
            </label>`}
        </div>
        <p class="hint">Your upload needed: about <b>${fmtRate(p.kbps * viewers)}</b> (${fmtRate(p.kbps)} × ${viewers} viewer${viewers > 1 ? 's' : ''}). In a mesh every friend gets their own copy straight from you — no server re-encoding, no quality caps.</p>
      </div>
      <footer><div class="spacer" /><button class="btn" onClick=${() => model.closeModal()}>Cancel</button><button class="btn primary" disabled=${!sel || busy} onClick=${go}><${Icon} name="screenUp" size=${16} /> Go live</button></footer>
    <//>`
}

// ---------------------------------------------------------------- settings

function Toggle ({ checked, onChange, label, hint }) {
  return html`
    <label class="toggle-row">
      <div><b>${label}</b>${hint && html`<small>${hint}</small>`}</div>
      <input type="checkbox" class="switch" checked=${checked} onChange=${(e) => onChange(e.target.checked)} />
    </label>`
}

// Tests the microphone exactly as a call would send it (including the noise filter), and can
// play it back so you can hear what your friends hear.
function MicMeter ({ audio }) {
  const [level, setLevel] = useState(0)
  const [on, setOn] = useState(false)
  const [hear, setHear] = useState(false)
  const [ai, setAi] = useState(null)
  const out = useRef()
  useEffect(() => {
    if (!on) return
    let stream; let ctx; let raf
    let alive = true
    getMic(audio, { onFallback: (e) => model.toast('AI noise suppression could not start: ' + e.message, 'error') }).then((s) => {
      if (!alive) { stopMic(s); return }
      stream = s
      setAi(isDenoised(s))
      ctx = new AudioContext()
      const an = ctx.createAnalyser()
      an.fftSize = 512
      ctx.createMediaStreamSource(s).connect(an)
      const buf = new Float32Array(an.fftSize)
      const tick = () => {
        an.getFloatTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += v * v
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 6))
        raf = requestAnimationFrame(tick)
      }
      tick()
      if (out.current) {
        out.current.srcObject = s
        if (out.current.setSinkId && audio.outputId) out.current.setSinkId(audio.outputId === 'default' ? '' : audio.outputId).catch(() => {})
      }
    }).catch(e => { model.toast('Mic test failed: ' + e.message, 'error'); setOn(false) })
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      stopMic(stream)
      ctx?.close()
      if (out.current) out.current.srcObject = null
    }
  }, [on, audio.inputId, audio.noiseMode, audio.echoCancellation, audio.autoGainControl])
  useEffect(() => {
    const el = out.current
    if (!el) return
    el.muted = !hear
    if (hear) el.play().catch(() => {})
  }, [hear, on])
  return html`
    <div class="mic-test">
      <button class="btn" onClick=${() => setOn(!on)}>${on ? 'Stop test' : 'Test microphone'}</button>
      <div class="meter"><i style=${{ width: (on ? level * 100 : 0) + '%' }} /></div>
      ${on && html`<label class="check" title="Use headphones, or you'll get feedback"><input type="checkbox" checked=${hear} onChange=${(e) => setHear(e.target.checked)} /> Hear yourself</label>`}
      <audio ref=${out} autoplay muted />
    </div>
    ${on && ai !== null && html`<p class="hint">${ai
      ? 'This is your mic after AI noise suppression. Type, or let a fan run: the meter should stay low until you speak. Turn on "Hear yourself" (with headphones) to listen.'
      : 'This is your mic as your friends hear it.'}</p>`}`
}

function SettingsModal ({ tab: initialTab = 'profile' }) {
  const [tab, setTab] = useState(initialTab)
  const tabs = [['profile', 'My profile'], ['voice', 'Voice & audio'], ['screen', 'Screen share'], ['network', 'Network'], ['storage', 'Storage'], ['privacy', 'Privacy & security'], ['updates', 'Updates']]
  return html`
    <${Modal} title="Settings" wide>
      <div class="settings">
        <nav>${tabs.map(([k, label]) => html`<button key=${k} class=${tab === k ? 'active' : ''} onClick=${() => setTab(k)}>${label}</button>`)}</nav>
        <div class="settings-body">
          ${tab === 'profile' && html`<${ProfileSettings} />`}
          ${tab === 'voice' && html`<${VoiceSettings} />`}
          ${tab === 'screen' && html`<${ScreenSettings} />`}
          ${tab === 'network' && html`<${NetworkSettings} />`}
          ${tab === 'storage' && html`<${StorageSettings} />`}
          ${tab === 'privacy' && html`<${PrivacySettings} />`}
          ${tab === 'updates' && html`<${UpdateSettings} />`}
        </div>
      </div>
    <//>`
}

export function ProfileEditor ({ onSaved, cta = 'Save' }) {
  const [name, setName] = useState(model.me.name || '')
  const [color, setColor] = useState(model.me.color)
  const [avatar, setAvatar] = useState(model.me.avatar || null)
  const [cropping, setCropping] = useState(null)
  const [fileInput, pickImage] = useImagePicker(setCropping)
  const save = async () => {
    const me = await act(() => api.setProfile({ name: name.trim(), color, avatar }))
    if (me) { model.me = me; model.emit(); onSaved?.() }
  }
  if (cropping) {
    return html`<${AvatarCropper} image=${cropping} onCancel=${() => setCropping(null)} onDone=${(url) => { setAvatar(url); setCropping(null) }} />`
  }
  return html`
    <div class="profile-editor">
      ${fileInput}
      <button class="avatar-pick" title="Change profile picture" onClick=${pickImage}>
        <${Avatar} name=${name || '?'} color=${color} src=${avatar} size=${88} />
        <span class="avatar-pick-overlay"><${Icon} name="camera" size=${24} /></span>
      </button>
      <div class="row center avatar-actions">
        <button class="btn sm" onClick=${pickImage}>${avatar ? 'Change picture' : 'Upload picture'}</button>
        ${avatar && html`<button class="btn sm" onClick=${() => setAvatar(null)}>Remove</button>`}
      </div>
      <label>Display name<input value=${name} maxLength="32" autoFocus placeholder="What your friends call you" onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && name.trim() && save()} /></label>
      <div class="swatches">${COLORS.map(c => html`<button key=${c} class=${c === color ? 'active' : ''} style=${{ background: c }} onClick=${() => setColor(c)} title=${c} />`)}</div>
      <button class="btn primary" disabled=${!name.trim()} onClick=${save}>${cta}</button>
    </div>`
}

function ProfileSettings () {
  return html`<h4>My profile</h4><${ProfileEditor} onSaved=${() => model.toast('Profile updated')} />`
}

function VoiceSettings () {
  const a = model.settings.audio
  const [devices, setDevices] = useState([])
  useEffect(() => {
    const load = () => navigator.mediaDevices.enumerateDevices().then(setDevices)
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => navigator.mediaDevices.removeEventListener('devicechange', load)
  }, [])
  const set = async (patch, reloadMic = false) => {
    await saveSettings({ audio: patch })
    if (reloadMic) voice.reloadMic()
    else voice.applyOutputDevice()
  }
  const inputs = devices.filter(d => d.kind === 'audioinput')
  const outputs = devices.filter(d => d.kind === 'audiooutput')
  return html`
    <h4>Voice & audio</h4>
    <div class="grid2">
      <label>Microphone
        <select value=${a.inputId} onChange=${(e) => set({ inputId: e.target.value }, true)}>
          ${inputs.map(d => html`<option value=${d.deviceId}>${d.label || 'Microphone'}</option>`)}
        </select>
      </label>
      <label>Speakers / headphones
        <select value=${a.outputId} onChange=${(e) => set({ outputId: e.target.value })}>
          ${outputs.map(d => html`<option value=${d.deviceId}>${d.label || 'Output'}</option>`)}
        </select>
      </label>
    </div>
    <label>Noise suppression
      <select value=${noiseMode(a)} onChange=${(e) => set({ noiseMode: e.target.value, noiseSuppression: e.target.value !== 'off' }, true)}>
        <option value="ai">AI (RNNoise): removes fans, keyboard clicks, hiss and hum</option>
        <option value="standard">Standard: the browser's built-in filter (lighter)</option>
        <option value="off">Off: send the microphone as it is</option>
      </select>
    </label>
    <${MicMeter} audio=${a} />
    <${Toggle} label="Echo cancellation" hint="Needed if you use speakers instead of headphones" checked=${a.echoCancellation} onChange=${(v) => set({ echoCancellation: v }, true)} />
    <${Toggle} label="Automatic gain control" hint="Evens out your volume" checked=${a.autoGainControl} onChange=${(v) => set({ autoGainControl: v }, true)} />
    <label>Voice quality (Opus bitrate)
      <select value=${a.voiceBitrate} onChange=${(e) => set({ voiceBitrate: +e.target.value })}>
        <option value="32000">32 kbps — low bandwidth</option>
        <option value="64000">64 kbps — standard</option>
        <option value="96000">96 kbps — high (default)</option>
        <option value="128000">128 kbps — very high</option>
        <option value="192000">192 kbps — studio</option>
      </select>
    </label>
    <p class="hint">Applies to calls you join after changing it. Shortcuts while in a call: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F9</kbd> mute, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F10</kbd> deafen (work even when the app is in the background).</p>`
}

function ScreenSettings () {
  const s = model.settings.screen
  const codecs = [...new Set((window.RTCRtpSender?.getCapabilities('video')?.codecs || []).map(c => c.mimeType.split('/')[1]).filter(c => /^(VP8|VP9|H264|AV1|H265)$/i.test(c)))]
  return html`
    <h4>Screen share defaults</h4>
    <div class="grid2">
      <label>Quality
        <select value=${s.preset} onChange=${(e) => saveSettings({ screen: { preset: e.target.value } })}>
          ${Object.entries(SCREEN_PRESETS).map(([k, v]) => html`<option value=${k}>${v.label} · ${fmtRate(v.kbps)}</option>`)}
        </select>
      </label>
      <label>Video codec
        <select value=${s.codec} onChange=${(e) => saveSettings({ screen: { codec: e.target.value } })}>
          <option value="auto">Automatic (${voice.autoCodec} on this PC)</option>
          ${codecs.map(c => html`<option value=${c}>${{
            H264: 'H.264 (GPU-accelerated on most PCs)',
            H265: 'H.265/HEVC (GPU only — every viewer needs HEVC hardware decoding)',
            AV1: 'AV1 (best quality per bit, heavy on CPU without a recent GPU)',
            VP9: 'VP9 (software, CPU heavy at high resolutions)',
            VP8: 'VP8 (software, most compatible)'
          }[c] || c}</option>`)}
        </select>
      </label>
    </div>
    <p class="hint">Automatic picks a codec your graphics card can encode, so high resolutions don't max out your CPU. If the person sharing has a slow upload, pick a lower preset — in a mesh each viewer receives a separate stream.</p>`
}

function NetworkSettings () {
  const st = model.settings
  const [stun, setStun] = useState((st.stunServers || []).join('\n'))
  const peers = []
  for (const g of model.groups.values()) for (const [k, info] of g.online) if (!peers.some(p => p.key === k)) peers.push({ ...info, key: k, name: model.memberName(g, k) })
  return html`
    <h4>Connections</h4>
    <table class="peers">
      <thead><tr><th>Friend</th><th>Path</th><th>Latency</th><th>Version</th></tr></thead>
      <tbody>
        ${!peers.length && html`<tr><td colspan="4" class="muted">No friends online right now.</td></tr>`}
        ${peers.map(p => html`<tr key=${p.key}><td>${p.name}</td><td>${p.lan ? 'Same network (LAN)' : 'Direct over internet'} · ${p.family === 6 ? 'IPv6' : 'IPv4'}</td><td>${p.rtt != null ? p.rtt + ' ms' : '…'}</td><td class=${p.version && model.version && p.version !== model.version ? 'warn-text' : ''}>${p.version || 'older than 0.2'}</td></tr>`)}
      </tbody>
    </table>
    <p class="hint">Every connection is a direct, hole-punched UDP link. There is no relay fallback — that's the point.</p>
    <h4>Connection check</h4>
    <${NetworkHealth} />
    <h4>STUN servers (for calls)</h4>
    <textarea class="mono" rows="3" value=${stun} onInput=${(e) => setStun(e.target.value)} />
    <div class="row"><button class="btn" onClick=${() => saveSettings({ stunServers: stun.split('\n').map(s => s.trim()).filter(s => /^stuns?:/i.test(s)) }).then(() => model.toast('Saved — applies to the next call'))}>Save STUN servers</button></div>
    <p class="hint">STUN servers only answer "what is my public IP:port?" so WebRTC can punch through your router. They never see or carry any audio, video or messages. Leave empty to use only LAN/IPv6 addresses. Relay (TURN) servers are intentionally not supported.</p>
    <h4>Behaviour</h4>
    <label>Automatically keep a copy of files up to
      <select value=${st.autoDownloadMB} onChange=${(e) => saveSettings({ autoDownloadMB: +e.target.value })}>
        ${[0, 10, 25, 100, 500, 2000].map(n => html`<option value=${n}>${n ? n + ' MB' : 'never'}</option>`)}
      </select>
    </label>
    <p class="hint">Keeping copies means friends can still get a file when the original sender is offline.</p>
    <${Toggle} label="Keep running in the tray when closed" hint="Stay online so friends can sync messages and files from you" checked=${st.closeToTray} onChange=${(v) => saveSettings({ closeToTray: v })} />
    <${Toggle} label="Desktop notifications" checked=${st.notifications} onChange=${(v) => saveSettings({ notifications: v })} />`
}

function StorageSettings () {
  const [info, setInfo] = useState(null)
  const [pending, setPending] = useState(null) // { dir, existing } waiting for confirmation
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.storageInfo().then(setInfo, (e) => model.toast('Could not read the data folder: ' + e.message, 'error')) }, [])
  const choose = async (picked) => {
    const t = await act(() => api.checkStorage(picked))
    if (t) setPending(t)
  }
  const pick = async () => {
    const picked = await act(() => api.pickStorage())
    if (picked) choose(picked)
  }
  const go = async (useExisting) => {
    setBusy(true)
    if (voice.active) voice.leave(true)
    const ok = await act(() => api.moveStorage(pending.dir, useExisting))
    if (!ok) setBusy(false) // otherwise the app restarts
  }
  const isDefault = info && info.dir.toLowerCase() === info.defaultDir.toLowerCase()
  return html`
    <h4>Data folder</h4>
    <p class="hint">Your identity (your key pair), groups, messages and the files you've received live here. Pick a bigger drive if you share lots of large files.</p>
    <div class="invite-box">
      <code class="mono">${info ? info.dir : '…'}</code>
      <button class="btn" onClick=${() => api.openStorage()}><${Icon} name="folder" size=${16} /> Open</button>
    </div>
    <p class="hint">${info ? `${fmtBytes(info.size)} used${isDefault ? ' · default location' : ''}` : ''}</p>
    ${info?.locked
      ? html`<p class="hint warn-text">This folder is set by the OD_DATA_DIR environment variable, so it can't be changed here.</p>`
      : html`
        <div class="row">
          <button class="btn" disabled=${!info || busy} onClick=${pick}>Change folder…</button>
          ${info && !isDefault && html`<button class="btn" disabled=${busy} onClick=${() => choose(null)}>Move back to the default folder</button>`}
        </div>`}
    ${pending && html`
      <div class="callout ${pending.existing ? 'warn' : ''}">
        <${Icon} name="folder" size=${16} />
        <div>
          ${pending.existing
            ? html`
              <p><b>${pending.dir}</b> already holds OpenDiscord data, maybe another identity or an older copy.</p>
              <div class="row">
                <button class="btn primary" disabled=${busy} onClick=${() => go(true)}>Switch to the data that's there</button>
                <button class="btn danger" disabled=${busy} onClick=${() => go(false)}>Replace it with my current data</button>
                <button class="btn" disabled=${busy} onClick=${() => setPending(null)}>Cancel</button>
              </div>
              <p class="hint">Switching leaves your current data where it is. Replacing deletes the data in the new folder first.</p>`
            : html`
              <p>OpenDiscord restarts and moves your data${info ? ` (${fmtBytes(info.size)})` : ''} to <b>${pending.dir}</b>.${voice.active ? ' This ends your call.' : ''}</p>
              <div class="row">
                <button class="btn primary" disabled=${busy} onClick=${() => go(false)}>${busy ? 'Restarting…' : 'Move and restart'}</button>
                <button class="btn" disabled=${busy} onClick=${() => setPending(null)}>Cancel</button>
              </div>`}
        </div>
      </div>`}
    <p class="hint">The move happens on the next start, before anything opens the files. If the folder is on a drive that's missing later, OpenDiscord doesn't start with an empty profile. It asks you to reconnect the drive instead.</p>`
}

function UpdateSettings () {
  const u = model.update
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    await act(() => api.checkForUpdate())
    setChecking(false)
  }
  const busy = checking || u?.status === 'checking' || u?.status === 'downloading' || u?.status === 'installing'
  return html`
    <h4>OpenDiscord ${model.version}</h4>
    <div class="update-status ${u?.status || ''}">
      <${Icon} name=${u?.status === 'ready' || u?.status === 'latest' ? 'check' : u?.status === 'error' ? 'signal' : 'download'} size=${16} />
      <span>${updateStatusText(u)}</span>
    </div>
    ${u?.status === 'downloading' && html`<div class="progress update-progress"><i style=${{ width: (u.percent || 0) + '%' }} /></div>`}
    <div class="row">
      ${u?.status === 'ready'
        ? html`<button class="btn primary" onClick=${restartForUpdate}>Restart to update</button>`
        : html`<button class="btn" disabled=${!u?.supported || busy} onClick=${check}>${busy ? 'Checking…' : 'Check for updates'}</button>`}
      ${u?.releasesUrl && html`<button class="btn" onClick=${() => api.openExternal(u.releasesUrl)}>What's new</button>`}
    </div>
    <${Toggle} label="Install updates automatically" hint="Checks GitHub every few hours, downloads new versions in the background and installs them the next time you restart" checked=${model.settings.autoUpdate !== false} onChange=${(v) => saveSettings({ autoUpdate: v })} />
    <p class="hint">Updates are the releases published from the project's GitHub repository. Each download is checked against its published SHA-512 hash before it's installed. Checking for updates is the only time the app talks to a server other than the P2P network and STUN. Turn it off to avoid that; you can still check by hand.</p>
    ${u?.portable && html`<p class="hint">You're running the portable .exe. The first update installs OpenDiscord on this PC (per user, no admin needed). After that, start it from the Start menu or desktop. Your groups and messages carry over.</p>`}`
}

function PrivacySettings () {
  const key = model.me.key
  return html`
    <h4>How your data is protected</h4>
    <ul class="security-list">
      <li><${Icon} name="globe" size=${18} /><div><b>Finding each other</b><small>Each group announces sha256(secret) on the HyperDHT, a public peer-to-peer DHT. DHT nodes see that hash and your IP address — never the secret, names or messages.</small></div></li>
      <li><${Icon} name="lock" size=${18} /><div><b>Messages & files</b><small>Sent over Noise-encrypted Hyperswarm connections (X25519 + ChaCha20-Poly1305). Each friend must prove they know the group secret, bound to the session's handshake hash, before receiving anything.</small></div></li>
      <li><${Icon} name="shield" size=${18} /><div><b>Authenticity</b><small>Every message, edit and reaction is signed with the author's Ed25519 key, so nobody can forge or alter them while relaying.</small></div></li>
      <li><${Icon} name="speaker" size=${18} /><div><b>Calls & screen share</b><small>WebRTC DTLS-SRTP, directly between you. The DTLS fingerprints are exchanged over the authenticated channel, so no one can man-in-the-middle a call.</small></div></li>
      <li><${Icon} name="file" size=${18} /><div><b>On disk</b><small>History is stored unencrypted in your user profile folder, like most desktop apps. Protect your device with disk encryption (BitLocker/FileVault).</small></div></li>
    </ul>
    <h4>Link previews</h4>
    <${Toggle} label="Show previews for links I send" hint="Your app loads the page once when you send the message and attaches a small preview. Friends' apps never contact the site, so they don't reveal their IP address to it." checked=${model.settings.linkPreviews !== false} onChange=${(v) => saveSettings({ linkPreviews: v })} />
    <h4>Your public key</h4>
    <div class="invite-box"><code class="mono">${key}</code><button class="btn" onClick=${() => api.copy(key)}><${Icon} name="copy" size=${16} /> Copy</button></div>
    <p class="hint">Friends can compare the first characters with what they see for you in the member list tooltip to be sure it's really you.</p>`
}
