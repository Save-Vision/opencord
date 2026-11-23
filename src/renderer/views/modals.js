import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js'
import { api, model, voice, act, append, rid, saveSettings, blobUrl, COLORS, fmtRate } from '../lib/core.js'
import { SCREEN_PRESETS } from '../lib/voice.js'
import { Icon } from '../lib/icons.js'
import { Avatar } from './chat.js'
import { participantsOf } from './stage.js'

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
    image: ImageModal
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
            <p class="hint">Ask a friend for the code (Group menu → Invite people).</p>
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

function MicMeter ({ deviceId }) {
  const [level, setLevel] = useState(0)
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!on) return
    let stream; let ctx; let raf
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined } }).then((s) => {
      stream = s
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
    }).catch(e => { model.toast('Mic test failed: ' + e.message, 'error'); setOn(false) })
    return () => { cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); ctx?.close() }
  }, [on, deviceId])
  return html`
    <div class="mic-test">
      <button class="btn" onClick=${() => setOn(!on)}>${on ? 'Stop test' : 'Test microphone'}</button>
      <div class="meter"><i style=${{ width: (on ? level * 100 : 0) + '%' }} /></div>
    </div>`
}

function SettingsModal ({ tab: initialTab = 'profile' }) {
  const [tab, setTab] = useState(initialTab)
  const tabs = [['profile', 'My profile'], ['voice', 'Voice & audio'], ['screen', 'Screen share'], ['network', 'Network'], ['privacy', 'Privacy & security']]
  return html`
    <${Modal} title="Settings" wide>
      <div class="settings">
        <nav>${tabs.map(([k, label]) => html`<button key=${k} class=${tab === k ? 'active' : ''} onClick=${() => setTab(k)}>${label}</button>`)}</nav>
        <div class="settings-body">
          ${tab === 'profile' && html`<${ProfileSettings} />`}
          ${tab === 'voice' && html`<${VoiceSettings} />`}
          ${tab === 'screen' && html`<${ScreenSettings} />`}
          ${tab === 'network' && html`<${NetworkSettings} />`}
          ${tab === 'privacy' && html`<${PrivacySettings} />`}
        </div>
      </div>
    <//>`
}

export function ProfileEditor ({ onSaved, cta = 'Save' }) {
  const [name, setName] = useState(model.me.name || '')
  const [color, setColor] = useState(model.me.color)
  const save = async () => {
    const me = await act(() => api.setProfile({ name: name.trim(), color }))
    if (me) { model.me = me; model.emit(); onSaved?.() }
  }
  return html`
    <div class="profile-editor">
      <${Avatar} name=${name || '?'} color=${color} size=${72} />
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
    <${MicMeter} deviceId=${a.inputId} />
    <${Toggle} label="Noise suppression" hint="Filters keyboard and fan noise" checked=${a.noiseSuppression} onChange=${(v) => set({ noiseSuppression: v }, true)} />
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
      <thead><tr><th>Friend</th><th>Path</th><th>Latency</th></tr></thead>
      <tbody>
        ${!peers.length && html`<tr><td colspan="3" class="muted">No friends online right now.</td></tr>`}
        ${peers.map(p => html`<tr key=${p.key}><td>${p.name}</td><td>${p.lan ? 'Same network (LAN)' : 'Direct over internet'} · ${p.family === 6 ? 'IPv6' : 'IPv4'}</td><td>${p.rtt != null ? p.rtt + ' ms' : '…'}</td></tr>`)}
      </tbody>
    </table>
    <p class="hint">Every connection is a direct, hole-punched UDP link. There is no relay fallback — that's the point.</p>
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
    <h4>Your public key</h4>
    <div class="invite-box"><code class="mono">${key}</code><button class="btn" onClick=${() => api.copy(key)}><${Icon} name="copy" size=${16} /> Copy</button></div>
    <p class="hint">Friends can compare the first characters with what they see for you in the member list tooltip to be sure it's really you.</p>`
}
