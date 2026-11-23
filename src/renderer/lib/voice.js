// Voice / video / screen sharing over a full WebRTC mesh: one RTCPeerConnection per friend,
// media flows directly between you (DTLS-SRTP encrypted, end-to-end — there is no server
// in the media path to decrypt it). Signalling (SDP/ICE) travels over the already
// encrypted + authenticated Hyperswarm connection, so it cannot be tampered with.
//
// Each connection has four fixed transceivers, negotiated once:
//   0 mic audio · 1 screen video · 2 screen audio · 3 camera video
// Starting/stopping a share is just replaceTrack(), no renegotiation round-trip.

const SLOTS = [
  { name: 'mic', kind: 'audio' },
  { name: 'screen', kind: 'video' },
  { name: 'screenAudio', kind: 'audio' },
  { name: 'cam', kind: 'video' }
]

export const SCREEN_PRESETS = {
  '720p30': { w: 1280, h: 720, fps: 30, kbps: 4000, label: '720p · 30 fps' },
  '1080p30': { w: 1920, h: 1080, fps: 30, kbps: 6000, label: '1080p · 30 fps' },
  '1080p60': { w: 1920, h: 1080, fps: 60, kbps: 10000, label: '1080p · 60 fps' },
  '1440p60': { w: 2560, h: 1440, fps: 60, kbps: 16000, label: '1440p · 60 fps' },
  '2160p30': { w: 3840, h: 2160, fps: 30, kbps: 20000, label: '4K · 30 fps' },
  '2160p60': { w: 3840, h: 2160, fps: 60, kbps: 32000, label: '4K · 60 fps' }
}

const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')

function setFmtp (sec, pt, extra) {
  const fmt = (entries) => [...entries].map(([k, v]) => `${k}=${v}`).join(';')
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`)
  if (!re.test(sec)) return sec.replace(new RegExp(`(a=rtpmap:${pt} [^\\r\\n]*)`), `$1\r\na=fmtp:${pt} ` + fmt(Object.entries(extra)))
  return sec.replace(re, (_m, params) => {
    const kv = new Map(params.split(';').filter(Boolean).map((p) => {
      const [k, ...v] = p.trim().split('=')
      return [k, v.join('=')]
    }))
    for (const [k, v] of Object.entries(extra)) kv.set(k, String(v))
    return `a=fmtp:${pt} ` + fmt(kv)
  })
}

// The remote description's fmtp parameters configure OUR encoders, so this is where we
// ask for better quality than WebRTC's conservative defaults:
//  - Opus: higher bitrate for voice, stereo 160 kbps for screen audio
//  - screen video: start bandwidth estimation high instead of crawling up from 300 kbps
function mungeRemoteSdp (sdp, { voiceBitrate, screenStartKbps }) {
  let audioIndex = 0
  let videoIndex = 0
  return sdp.split(/\r\n(?=m=)/).map((sec) => {
    if (sec.startsWith('m=audio')) {
      const which = audioIndex++
      const pt = /a=rtpmap:(\d+) opus\/48000/i.exec(sec)?.[1]
      if (!pt) return sec
      return setFmtp(sec, pt, which === 0
        ? { maxaveragebitrate: voiceBitrate, useinbandfec: 1 }
        : { maxaveragebitrate: 160000, stereo: 1, 'sprop-stereo': 1, useinbandfec: 1 })
    }
    if (sec.startsWith('m=video') && videoIndex++ === 0) {
      for (const m of [...sec.matchAll(/a=rtpmap:(\d+) (VP8|VP9|H264|AV1|H265)\/90000/gi)]) {
        sec = setFmtp(sec, m[1], { 'x-google-start-bitrate': screenStartKbps, 'x-google-min-bitrate': 400 })
      }
    }
    return sec
  }).join('\r\n')
}

// Pick a screen-share codec the GPU can encode, so 1080p60+ doesn't melt the CPU.
// Chromium often under-reports powerEfficient for WebRTC, but in practice H.264 is
// hardware-encoded on Windows/macOS with any recent GPU (NVENC/AMF/QuickSync/VideoToolbox)
// and falls back to the fast OpenH264 software encoder otherwise, so it's the default.
async function detectHardwareCodec () {
  const caps = (window.RTCRtpSender?.getCapabilities('video')?.codecs || []).map(c => c.mimeType.toLowerCase())
  for (const codec of ['H264', 'AV1', 'VP9']) {
    try {
      const r = await navigator.mediaCapabilities.encodingInfo({
        type: 'webrtc',
        video: { contentType: 'video/' + codec, width: 1920, height: 1080, bitrate: 8e6, framerate: 60 }
      })
      if (r.supported && r.powerEfficient) return codec
    } catch {}
  }
  return caps.includes('video/h264') ? 'H264' : 'VP8'
}

function pickCodec (codecs, name) {
  const want = 'video/' + String(name).toLowerCase()
  const list = (codecs || []).filter(c => c.mimeType.toLowerCase() === want)
  if (!list.length) return null
  const fmtp = (c) => c.sdpFmtpLine || ''
  let c = list[0]
  if (want === 'video/h264') {
    c = list.find(x => /packetization-mode=1/.test(fmtp(x)) && /profile-level-id=64/i.test(fmtp(x))) ||
      list.find(x => /packetization-mode=1/.test(fmtp(x))) || c
  } else if (want === 'video/vp9') {
    c = list.find(x => /profile-id=0/.test(fmtp(x))) || c
  }
  return { mimeType: c.mimeType, clockRate: c.clockRate, sdpFmtpLine: c.sdpFmtpLine }
}

let toneCtx = null
export function playTone (kind) {
  try {
    toneCtx = toneCtx || new AudioContext()
    const seq = { join: [523, 784], leave: [784, 523], mute: [440], unmute: [660], connect: [660, 880] }[kind] || [600]
    const t0 = toneCtx.currentTime
    seq.forEach((f, i) => {
      const o = toneCtx.createOscillator()
      const gain = toneCtx.createGain()
      o.type = 'sine'
      o.frequency.value = f
      gain.gain.setValueAtTime(0.0001, t0 + i * 0.09)
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + i * 0.09 + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.12)
      o.connect(gain).connect(toneCtx.destination)
      o.start(t0 + i * 0.09)
      o.stop(t0 + i * 0.09 + 0.14)
    })
  } catch {}
}

export class Voice {
  constructor ({ api, model }) {
    this.api = api
    this.model = model
    this.active = null // { gid, ch, sid }
    this.calls = new Map()
    this.local = { mic: null, screen: null, cam: null }
    this.screenOpts = null
    this.muted = false
    this.deafened = false
    this.mutedBeforeDeafen = false
    this.micError = null
    this.speaking = new Set()
    this.levels = new Map()
    this.audioCtx = null
    this.meters = new Map() // key -> { analyser, buf, src, lastLoud }
    this.meterTimer = null
    this.statsTimer = null
    this.autoCodec = 'VP8'
    detectHardwareCodec().then((c) => { this.autoCodec = c })
  }

  screenCodec () {
    const c = this.settings.screen.codec
    return !c || c === 'auto' ? this.autoCodec : c
  }

  get settings () { return this.model.settings }
  get myKey () { return this.model.me.key }

  inChannel (gid, ch) { return !!this.active && this.active.gid === gid && this.active.ch === ch }

  // ---------- lifecycle ----------

  async join (gid, ch) {
    if (this.inChannel(gid, ch)) return
    if (this.active) this.leave(true)
    const sid = rid()
    this.active = { gid, ch, sid }
    this.micError = null
    this.model.emit()
    let mic = null
    try {
      mic = await this._getMic()
    } catch (err) {
      this.micError = err.name === 'NotAllowedError' ? 'Microphone permission denied' : 'No microphone available (' + err.message + ')'
      this.model.toast(this.micError + ' — you joined listen-only', 'error')
    }
    if (this.active?.sid !== sid) { mic?.getTracks().forEach(t => t.stop()); return } // left meanwhile
    this.local.mic = mic
    this._applyMute()
    for (const call of this.calls.values()) this._attachLocalTracks(call)
    this._ensureAudioCtx()
    if (this.local.mic) this._meter(this.myKey, this.local.mic)
    this._startTimers()
    this._broadcastState()
    const g = this.model.groups.get(gid)
    for (const [key, st] of g.voice) {
      if (st.ch === ch && g.online.has(key)) this._ensureCall(key, st)
    }
    this.api.voiceHotkeys(true)
    playTone('join')
    this.model.emit()
  }

  leave (silent = false) {
    if (!this.active) return
    const { gid } = this.active
    for (const call of [...this.calls.values()]) this._closeCall(call)
    for (const kind of ['mic', 'screen', 'cam']) {
      this.local[kind]?.getTracks().forEach(t => t.stop())
      this.local[kind] = null
    }
    for (const m of this.meters.values()) m.src.disconnect()
    this.meters.clear()
    this.speaking.clear()
    this.active = null
    this.screenOpts = null
    clearInterval(this.meterTimer)
    clearInterval(this.statsTimer)
    this.api.sendEph(gid, null, { type: 'voice', ch: null })
    this.api.voiceHotkeys(false)
    if (!silent) playTone('leave')
    this.model.emit()
  }

  statePayload () {
    if (!this.active) return { type: 'voice', ch: null }
    return {
      type: 'voice',
      ch: this.active.ch,
      sid: this.active.sid,
      muted: this.muted || !this.local.mic,
      deaf: this.deafened,
      screen: !!this.local.screen,
      screenLabel: this.screenOpts ? SCREEN_PRESETS[this.screenOpts.preset]?.label : null,
      cam: !!this.local.cam
    }
  }

  _broadcastState (to = null) {
    if (!this.active) return
    this.api.sendEph(this.active.gid, to, this.statePayload())
  }

  // ---------- events from the app ----------

  onRemoteVoiceState (gid, key, st) {
    if (!this.active || gid !== this.active.gid) return
    const call = this.calls.get(key)
    if (st.ch === this.active.ch && st.sid) {
      if (!call || call.remoteSid !== st.sid) {
        if (call) this._closeCall(call)
        this._ensureCall(key, st)
        playTone('connect')
      }
    } else if (call) {
      this._closeCall(call)
      playTone('leave')
    }
    this.model.emit()
  }

  onPeerOnline (gid, key) {
    if (this.active && this.active.gid === gid) this._broadcastState(key)
  }

  onPeerOffline (gid, key) {
    const call = this.calls.get(key)
    if (call && this.active?.gid === gid) this._closeCall(call)
  }

  onRtc (gid, key, msg) {
    if (!this.active || gid !== this.active.gid || msg.to !== this.active.sid) return
    const call = this.calls.get(key)
    if (!call || call.remoteSid !== msg.from) return
    call.chain = call.chain.then(() => this._handleSignal(call, msg)).catch(err => console.warn('[rtc]', err))
  }

  // ---------- peer connections ----------

  _iceServers () {
    const urls = (this.settings.stunServers || []).filter(u => /^stuns?:/i.test(u.trim()))
    return urls.length ? [{ urls }] : []
  }

  _ensureCall (key, st) {
    const initiator = this.myKey > key
    const pc = new RTCPeerConnection({ iceServers: this._iceServers(), bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' })
    const call = {
      key,
      remoteSid: st.sid,
      pc,
      initiator,
      transceivers: [],
      remote: {},
      remoteStreams: {},
      audioEls: {},
      pendingCands: [],
      chain: Promise.resolve(),
      state: 'connecting',
      stats: null,
      prevBytes: new Map(),
      restartedAt: 0
    }
    pc.onicecandidate = (e) => { if (e.candidate) this._signal(call, { cand: e.candidate.toJSON() }) }
    pc.ontrack = (e) => this._onTrack(call, e)
    pc.onconnectionstatechange = () => {
      call.state = pc.connectionState
      if (pc.connectionState === 'connected') {
        this._applyAllSenderParams(call)
        this._readStats(call).then((st) => { call.stats = st; this.model.emit() }, () => {})
      }
      if (pc.connectionState === 'failed' && call.initiator && Date.now() - call.restartedAt > 5000) {
        call.restartedAt = Date.now()
        pc.restartIce()
      }
      this.model.emit()
    }
    if (initiator) {
      pc.onnegotiationneeded = () => this._makeOffer(call)
      for (const slot of SLOTS) call.transceivers.push(pc.addTransceiver(slot.kind, { direction: 'sendrecv' }))
      this._attachLocalTracks(call)
    }
    this.calls.set(key, call)
    this.model.emit()
    return call
  }

  _closeCall (call) {
    if (this.calls.get(call.key) === call) this.calls.delete(call.key)
    try { call.pc.close() } catch {}
    for (const el of Object.values(call.audioEls)) { el.pause(); el.srcObject = null }
    const m = this.meters.get(call.key)
    if (m) { m.src.disconnect(); this.meters.delete(call.key) }
    this.speaking.delete(call.key)
    this.model.emit()
  }

  async _makeOffer (call) {
    try {
      await call.pc.setLocalDescription()
      this._signal(call, { desc: call.pc.localDescription.toJSON() })
    } catch (err) { console.warn('[rtc] offer failed', err) }
  }

  _signal (call, payload) {
    if (!this.active) return
    this.api.sendEph(this.active.gid, call.key, { type: 'rtc', from: this.active.sid, to: call.remoteSid, ...payload })
  }

  async _handleSignal (call, msg) {
    const pc = call.pc
    if (pc.signalingState === 'closed') return
    if (msg.desc && typeof msg.desc.sdp === 'string') {
      const preset = SCREEN_PRESETS[this.settings.screen.preset] || SCREEN_PRESETS['1080p60']
      const desc = {
        type: msg.desc.type,
        sdp: mungeRemoteSdp(msg.desc.sdp, {
          voiceBitrate: this.settings.audio.voiceBitrate || 96000,
          screenStartKbps: Math.round(Math.min(preset.kbps * 0.5, 8000))
        })
      }
      if (desc.type === 'offer') {
        if (call.initiator) return
        await pc.setRemoteDescription(desc)
        if (!call.transceivers.length) {
          call.transceivers = pc.getTransceivers().slice(0, SLOTS.length)
          for (const t of call.transceivers) t.direction = 'sendrecv'
          this._attachLocalTracks(call)
        }
        await pc.setLocalDescription()
        this._signal(call, { desc: pc.localDescription.toJSON() })
      } else if (desc.type === 'answer') {
        if (pc.signalingState !== 'have-local-offer') return
        await pc.setRemoteDescription(desc)
      }
      const cands = call.pendingCands
      call.pendingCands = []
      for (const c of cands) await pc.addIceCandidate(c).catch(() => {})
      this._applyAllSenderParams(call)
    } else if (msg.cand) {
      if (!pc.remoteDescription) call.pendingCands.push(msg.cand)
      else await pc.addIceCandidate(msg.cand).catch(() => {})
    }
  }

  _localTracks () {
    return [
      this.local.mic?.getAudioTracks()[0] || null,
      this.local.screen?.getVideoTracks()[0] || null,
      this.local.screen?.getAudioTracks()[0] || null,
      this.local.cam?.getVideoTracks()[0] || null
    ]
  }

  _attachLocalTracks (call) {
    const tracks = this._localTracks()
    call.transceivers.forEach((t, i) => {
      if (t.sender.track !== tracks[i]) t.sender.replaceTrack(tracks[i]).catch(err => console.warn('[rtc] replaceTrack', err))
    })
  }

  async _applySenderParams (call, i) {
    const t = call.transceivers[i]
    if (!t || !t.sender) return
    const params = t.sender.getParameters()
    if (!params.encodings || !params.encodings.length) return
    const enc = params.encodings[0]
    if (i === 0) {
      enc.maxBitrate = this.settings.audio.voiceBitrate || 96000
      enc.priority = 'high'
      enc.networkPriority = 'high'
    } else if (i === 1) {
      const p = SCREEN_PRESETS[this.screenOpts?.preset || this.settings.screen.preset] || SCREEN_PRESETS['1080p60']
      enc.maxBitrate = p.kbps * 1000
      enc.maxFramerate = p.fps
      enc.priority = 'high'
      enc.networkPriority = 'high'
      params.degradationPreference = (this.screenOpts?.contentHint || this.settings.screen.contentHint) === 'detail'
        ? 'maintain-resolution'
        : 'maintain-framerate'
      const codec = pickCodec(params.codecs, this.screenCodec())
      if (codec) enc.codec = codec
    } else if (i === 2) {
      enc.maxBitrate = 160000
    } else if (i === 3) {
      enc.maxBitrate = 2500000
      enc.maxFramerate = 30
    }
    try { await t.sender.setParameters(params) } catch (err) {
      console.warn('[rtc] setParameters', i, err.message)
      delete params.degradationPreference
      delete enc.codec
      try { await t.sender.setParameters(params) } catch {}
    }
  }

  _applyAllSenderParams (call) {
    for (let i = 0; i < call.transceivers.length; i++) this._applySenderParams(call, i)
  }

  _onTrack (call, e) {
    const idx = call.pc.getTransceivers().indexOf(e.transceiver)
    const slot = SLOTS[idx]?.name
    if (!slot) return
    call.remote[slot] = e.track
    call.remoteStreams[slot] = new MediaStream([e.track])
    if (slot === 'mic' || slot === 'screenAudio') {
      const el = new Audio()
      el.autoplay = true
      el.srcObject = call.remoteStreams[slot]
      call.audioEls[slot] = el
      this._applyOutput(call.key, el)
      el.play().catch(() => {})
      if (slot === 'mic') {
        this._ensureAudioCtx()
        this._meter(call.key, call.remoteStreams[slot])
      }
    }
    this.model.emit()
  }

  // ---------- local media ----------

  async _getMic () {
    const a = this.settings.audio
    return navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: a.inputId && a.inputId !== 'default' ? { exact: a.inputId } : undefined,
        echoCancellation: a.echoCancellation,
        noiseSuppression: a.noiseSuppression,
        autoGainControl: a.autoGainControl,
        channelCount: 1,
        sampleRate: 48000
      },
      video: false
    })
  }

  async reloadMic () {
    if (!this.active) return
    const old = this.local.mic
    try {
      this.local.mic = await this._getMic()
    } catch (err) {
      this.model.toast('Could not open microphone: ' + err.message, 'error')
      return
    }
    old?.getTracks().forEach(t => t.stop())
    const m = this.meters.get(this.myKey)
    if (m) { m.src.disconnect(); this.meters.delete(this.myKey) }
    this._meter(this.myKey, this.local.mic)
    this._applyMute()
    for (const call of this.calls.values()) this._attachLocalTracks(call)
    this._broadcastState()
  }

  applyOutputDevice () {
    for (const call of this.calls.values()) for (const el of Object.values(call.audioEls)) this._applyOutput(call.key, el)
  }

  _applyOutput (key, el) {
    const vol = this.settings.volumes?.[key]
    el.volume = Math.max(0, Math.min(1, vol == null ? 1 : vol))
    el.muted = this.deafened
    const out = this.settings.audio.outputId
    if (el.setSinkId && out) el.setSinkId(out === 'default' ? '' : out).catch(() => {})
  }

  setVolume (key, vol) {
    const call = this.calls.get(key)
    if (call) for (const el of Object.values(call.audioEls)) el.volume = vol
  }

  _applyMute () {
    const t = this.local.mic?.getAudioTracks()[0]
    if (t) t.enabled = !this.muted && !this.deafened
  }

  toggleMute () {
    if (this.deafened) { this.toggleDeafen(); return }
    this.muted = !this.muted
    this._applyMute()
    this._broadcastState()
    playTone(this.muted ? 'mute' : 'unmute')
    this.model.emit()
  }

  toggleDeafen () {
    this.deafened = !this.deafened
    if (this.deafened) { this.mutedBeforeDeafen = this.muted; this.muted = true } else { this.muted = this.mutedBeforeDeafen }
    this._applyMute()
    for (const call of this.calls.values()) for (const el of Object.values(call.audioEls)) el.muted = this.deafened
    this._broadcastState()
    playTone(this.deafened ? 'mute' : 'unmute')
    this.model.emit()
  }

  async startScreen ({ sourceId, preset, audio, contentHint }) {
    if (!this.active) throw new Error('Join a voice channel first')
    const p = SCREEN_PRESETS[preset] || SCREEN_PRESETS['1080p60']
    const wantAudio = !!audio && this.model.platform === 'win32'
    await this.api.selectScreen(sourceId, wantAudio)
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // Cap by height so ultrawide monitors keep their full width (e.g. 3840×1080 at "1080p")
      video: { width: { max: p.w * 2 }, height: { max: p.h }, frameRate: { ideal: p.fps, max: p.fps } },
      audio: wantAudio
    })
    const vt = stream.getVideoTracks()[0]
    vt.contentHint = contentHint === 'detail' ? 'detail' : 'motion'
    try { await vt.applyConstraints({ width: { max: p.w * 2 }, height: { max: p.h }, frameRate: { max: p.fps } }) } catch {}
    vt.addEventListener('ended', () => { if (this.local.screen === stream) this.stopScreen() })
    this.local.screen?.getTracks().forEach(t => t.stop())
    this.local.screen = stream
    this.screenOpts = { preset, contentHint, audio: wantAudio }
    for (const call of this.calls.values()) { this._attachLocalTracks(call); this._applyAllSenderParams(call) }
    this._broadcastState()
    this.model.emit()
  }

  stopScreen () {
    if (!this.local.screen) return
    this.local.screen.getTracks().forEach(t => t.stop())
    this.local.screen = null
    this.screenOpts = null
    for (const call of this.calls.values()) this._attachLocalTracks(call)
    this._broadcastState()
    this.model.emit()
  }

  async toggleCamera () {
    if (!this.active) return
    if (this.local.cam) {
      this.local.cam.getTracks().forEach(t => t.stop())
      this.local.cam = null
    } else {
      try {
        this.local.cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } })
      } catch (err) {
        this.model.toast('Could not start camera: ' + err.message, 'error')
        return
      }
    }
    for (const call of this.calls.values()) { this._attachLocalTracks(call); this._applyAllSenderParams(call) }
    this._broadcastState()
    this.model.emit()
  }

  // ---------- speaking meters & stats ----------

  _ensureAudioCtx () {
    if (!this.audioCtx) this.audioCtx = new AudioContext()
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {})
  }

  _meter (key, stream) {
    const old = this.meters.get(key)
    if (old) { old.src.disconnect(); this.meters.delete(key) }
    try {
      const src = this.audioCtx.createMediaStreamSource(stream)
      const analyser = this.audioCtx.createAnalyser()
      analyser.fftSize = 512
      src.connect(analyser)
      this.meters.set(key, { src, analyser, buf: new Float32Array(analyser.fftSize), lastLoud: 0 })
    } catch (err) { console.warn('[voice] meter', err) }
  }

  _startTimers () {
    clearInterval(this.meterTimer)
    clearInterval(this.statsTimer)
    this.meterTimer = setInterval(() => this._tickMeters(), 80)
    this.statsTimer = setInterval(() => this._tickStats(), 2000)
  }

  _tickMeters () {
    const now = Date.now()
    let changed = false
    for (const [key, m] of this.meters) {
      m.analyser.getFloatTimeDomainData(m.buf)
      let sum = 0
      for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i]
      const rms = Math.sqrt(sum / m.buf.length)
      this.levels.set(key, rms)
      const self = key === this.myKey
      const loud = rms > 0.018 && !(self && (this.muted || this.deafened))
      if (loud) m.lastLoud = now
      const speaking = now - m.lastLoud < 280
      if (speaking !== this.speaking.has(key)) {
        changed = true
        if (speaking) this.speaking.add(key)
        else this.speaking.delete(key)
      }
    }
    if (changed) this.model.emit()
  }

  async _tickStats () {
    for (const call of this.calls.values()) {
      try { call.stats = await this._readStats(call) } catch {}
    }
    this.model.emit()
  }

  async _readStats (call) {
    const report = await call.pc.getStats()
    let pair = null
    report.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = report.get(r.selectedCandidatePairId)
    })
    if (!pair) report.forEach((r) => { if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r })
    const out = { rtt: null, path: null, family: null, inKbps: 0, outKbps: 0, screen: null, sendScreen: null }
    if (pair) {
      out.rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null
      const local = report.get(pair.localCandidateId)
      const remote = report.get(pair.remoteCandidateId)
      const addr = remote?.address || remote?.ip || ''
      out.family = addr.includes(':') ? 'IPv6' : addr ? 'IPv4' : null
      const types = [local?.candidateType, remote?.candidateType]
      out.path = types.includes('relay') ? 'relay' : types.every(t => t === 'host') ? 'lan' : 'direct'
      out.protocol = local?.protocol
    }
    const now = performance.now()
    const screenTrackId = call.remote.screen?.id
    const screenMid = call.transceivers[1]?.mid
    const codecName = (r) => report.get(r.codecId)?.mimeType?.split('/')[1]
    report.forEach((r) => {
      if (r.type !== 'inbound-rtp' && r.type !== 'outbound-rtp') return
      const prev = call.prevBytes.get(r.id)
      const bytes = r.type === 'inbound-rtp' ? r.bytesReceived : r.bytesSent
      if (prev) {
        const kbps = ((bytes - prev.bytes) * 8) / (now - prev.at)
        if (r.type === 'inbound-rtp') out.inKbps += kbps
        else out.outKbps += kbps
        const isScreen = r.kind === 'video' && (r.mid != null ? r.mid === screenMid : r.trackIdentifier === screenTrackId)
        if (isScreen && r.frameWidth) {
          const s = { w: r.frameWidth, h: r.frameHeight, fps: Math.round(r.framesPerSecond || 0), kbps: Math.round(kbps), codec: codecName(r) }
          if (r.type === 'inbound-rtp') out.screen = s
          else out.sendScreen = { ...s, limit: r.qualityLimitationReason, encoder: r.encoderImplementation }
        }
      }
      call.prevBytes.set(r.id, { bytes, at: now })
    })
    out.inKbps = Math.round(out.inKbps)
    out.outKbps = Math.round(out.outKbps)
    return out
  }
}
