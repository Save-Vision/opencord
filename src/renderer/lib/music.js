// The music bot (the Music app): everyone in a voice channel can queue songs, as music files from
// their computer, audio files shared in the chat, or links to an audio file or an internet radio
// stream. There's no server and no shared player: a song plays from the computer of whoever
// queued it. Their app decodes it and sends it to everyone in the channel as one more audio track
// of the call (voice.js, the 'music' transceiver), in stereo at up to 160 kbps.
//
// Each app keeps its own part of the queue in its voice state ({ q, play }), and every app puts
// the parts together the same way: oldest first. The song that's playing finishes; then the app
// whose song is next starts it. Leaving the channel takes your songs out of the queue.
//
// Anyone in the channel can pause, resume or skip what's playing. A queued song can be removed by
// whoever added it, or by the owner or an admin. Those requests go to the app that queued the
// song, which checks them. A link is only ever fetched by the app of whoever added it (main.js,
// odweb://), never by friends' apps.

export const MAX_QUEUE = 25 // songs per person
const SOURCES = ['file', 'chat', 'link']
const AUDIO_EXT = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|webm|weba)$/i

const str = (s, n) => typeof s === 'string' ? s.trim().slice(0, n) : ''
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')
const titleOf = (name) => str(String(name || '').replace(AUDIO_EXT, '').replace(/[_]+/g, ' '), 120) || 'Untitled'

// A music part from someone's voice state, checked (null: nothing queued)
export function cleanMusic (m, now = Date.now()) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.q)) return null
  const q = []
  const ids = new Set()
  for (const e of m.q.slice(0, MAX_QUEUE)) {
    if (!e || typeof e !== 'object') continue
    const id = str(e.id, 32)
    if (!id || ids.has(id) || !Number.isFinite(e.at)) continue
    ids.add(id)
    q.push({
      id,
      t: str(e.t, 120) || 'Untitled',
      d: Number.isFinite(e.d) && e.d > 0 ? Math.min(Math.round(e.d), 86400) : null,
      at: e.at,
      src: SOURCES.includes(e.src) ? e.src : 'file'
    })
  }
  if (!q.length) return null
  const p = m.play
  const play = p && typeof p === 'object' && ids.has(p.id)
    ? { id: p.id, pos: Number.isFinite(p.pos) && p.pos >= 0 ? p.pos : 0, paused: !!p.paused, recv: now }
    : null
  return { q, play }
}

const order = (a, b) => a.at - b.at || (a.by < b.by ? -1 : a.by > b.by ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// The channel's queue from everyone's parts ([{ key, music }], music already cleaned):
// what's playing (now) and what comes after it (next), oldest first. If two apps happen to play
// at once, the older song counts and the other one goes back to waiting.
export function channelQueue (parts) {
  const all = []
  let now = null
  for (const { key, music } of parts) {
    if (!music) continue
    for (const e of music.q) {
      const item = { ...e, by: key }
      all.push(item)
      if (music.play?.id === e.id) {
        const playing = { ...item, pos: music.play.pos, paused: music.play.paused, recv: music.play.recv }
        if (!now || order(playing, now) < 0) now = playing
      }
    }
  }
  const next = all.filter(e => !(now && e.by === now.by && e.id === now.id)).sort(order)
  return { now, next }
}

// Where the song playing is now, in seconds
export function positionOf (now, t = Date.now()) {
  if (!now) return 0
  const pos = now.paused ? now.pos : now.pos + Math.max(0, t - (now.recv || t)) / 1000
  return now.d ? Math.min(pos, now.d) : pos
}

export function fmtDuration (s) {
  if (!Number.isFinite(s) || s < 0) return ''
  s = Math.floor(s)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export const isAudioFile = (f) => !!f && (/^audio\//.test(f.type || '') || AUDIO_EXT.test(f.name || ''))

// How long a song is (null: unknown or a live stream; undefined: it can't be played)
function probeDuration (url, cors) {
  return new Promise((resolve) => {
    const el = new Audio()
    let done = false
    const finish = (d) => {
      if (done) return
      done = true
      el.removeAttribute('src')
      el.load()
      resolve(d)
    }
    el.preload = 'metadata'
    if (cors) el.crossOrigin = 'anonymous'
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : null)
    el.onerror = () => finish(undefined)
    setTimeout(() => finish(null), 8000)
    el.src = url
  })
}

export class MusicBot {
  constructor ({ api, model, voice }) {
    this.api = api
    this.model = model
    this.voice = voice
    this.mine = [] // my part of the queue: { id, t, d, at, src, url, revoke }
    this.cur = null // the song I play: { id, el, node, loading }
    this.ctx = null
    this.dest = null
    this.monitor = null // plays my own song to me
  }

  get active () { return this.voice.active }
  get me () { return this.model.me.key }
  group () { return this.active ? this.model.groups.get(this.active.gid) : null }
  enabled (g) { return !!g && this.model.appOn(g, 'music') }

  // ---------- the queue ----------

  // My part, as it goes into my voice state
  payload () {
    if (!this.mine.length) return undefined
    const el = this.cur?.el
    return {
      q: this.mine.map(({ id, t, d, at, src }) => ({ id, t, d, at, src })),
      play: this.cur ? { id: this.cur.id, pos: Math.round((el.currentTime || 0) * 10) / 10, paused: !this.cur.loading && el.paused } : null
    }
  }

  // The queue of a voice channel, as everyone in it sees it
  queue (g, ch) {
    if (!g || !ch) return { now: null, next: [] }
    const parts = []
    for (const [k, st] of g.voice) if (st.ch === ch && k !== this.me) parts.push({ key: k, music: st.music })
    if (this.voice.inChannel(g.id, ch)) parts.push({ key: this.me, music: cleanMusic(this.payload()) })
    return channelQueue(parts)
  }

  // Why I can't add songs right now (null: I can)
  blocked (g = this.group()) {
    if (!this.active || !g) return 'Join a voice channel first, then add songs.'
    if (!this.enabled(g)) {
      return this.model.isMod(g, this.me)
        ? 'Add the Music app to this group first: group menu → Apps.'
        : "This group doesn't have the Music app. The owner or an admin can add it (group menu → Apps)."
    }
    if (this.voice.serverMuted) return "A moderator muted you, so you can't play music."
    return null
  }

  async addFiles (files) {
    const why = this.blocked()
    if (why) { this.model.toast(why, 'error'); return 0 }
    const list = [...(files || [])].filter(isAudioFile)
    if (!list.length) { this.model.toast('Those aren\'t music files', 'error'); return 0 }
    const items = []
    for (const f of list) {
      const url = URL.createObjectURL(f)
      const d = await probeDuration(url, false)
      if (d === undefined) { URL.revokeObjectURL(url); this.model.toast(`Can't play ${f.name}: this kind of file isn't supported`, 'error'); continue }
      items.push({ t: titleOf(f.name), d, src: 'file', url, revoke: true })
    }
    return this._add(items)
  }

  // An audio file someone shared in the chat (already on this PC)
  async addChat (a) {
    const why = this.blocked()
    if (why) { this.model.toast(why, 'error'); return 0 }
    const url = `odblob://file/${a.h}?type=${encodeURIComponent(a.m || '')}`
    const d = await probeDuration(url, true)
    if (d === undefined) { this.model.toast(`Can't play ${a.n}`, 'error'); return 0 }
    return this._add([{ t: titleOf(a.n), d, src: 'chat', url }])
  }

  // A link to an audio file or a radio stream: this app fetches it (main.js checks it first)
  async addLink (link) {
    const why = this.blocked()
    if (why) { this.model.toast(why, 'error'); return 0 }
    const r = await this.api.musicLink(link)
    return this._add([{ t: titleOf(r.title), d: null, src: 'link', url: r.url }])
  }

  _add (items) {
    const why = this.blocked()
    if (why) {
      for (const it of items) if (it.revoke) URL.revokeObjectURL(it.url)
      this.model.toast(why, 'error')
      return 0
    }
    const at = Date.now()
    let n = 0
    for (const it of items) {
      if (this.mine.length >= MAX_QUEUE) {
        if (it.revoke) URL.revokeObjectURL(it.url)
        this.model.toast(`You can queue up to ${MAX_QUEUE} songs at a time`, 'error')
        continue
      }
      this.mine.push({ id: rid(), at: at + n, ...it })
      n++
    }
    if (n) {
      const q = this.queue(this.group(), this.active.ch)
      const first = items[0]
      this.model.toast(q.now || n > 1 ? (n > 1 ? `Added ${n} songs to the queue` : `Added “${first.t}” to the queue`) : `Playing “${first.t}”`)
      this._changed()
    }
    return n
  }

  // ---------- controls ----------

  // Pause, resume, skip or remove a song in my channel ({ id, by } from the queue)
  control (act, item) {
    if (!item || !this.active) return
    if (item.by === this.me) return this._apply(act, item.id, this.me)
    this.api.sendEph(this.active.gid, item.by, { type: 'music', act, id: item.id })
  }

  // Someone in my channel asks me to do something with a song I queued
  onRequest (gid, from, d) {
    const g = this.group()
    if (!g || g.id !== gid || typeof d.id !== 'string') return
    if (g.voice.get(from)?.ch !== this.active.ch || g.removed.has(from)) return
    if (d.act === 'remove' && !this.model.isMod(g, from)) return
    this._apply(d.act, d.id, from)
  }

  _apply (act, id, by) {
    const e = this.mine.find(x => x.id === id)
    if (!e) return
    const playing = this.cur?.id === id
    const g = this.group()
    const who = by === this.me ? null : this.model.memberName(g, by)
    if (act === 'skip' && playing) {
      this._finish(id)
      if (who) this.model.toast(`${who} skipped “${e.t}”`)
    } else if (act === 'remove' && !playing) {
      this._finish(id)
      if (who) this.model.toast(`${who} took “${e.t}” out of the queue`)
    } else if (act === 'pause' && playing) {
      this.cur.el.pause()
    } else if (act === 'resume' && playing) {
      this.cur.el.play().catch(() => {})
    }
  }

  // ---------- playing ----------

  // Start my song when it's my turn; step back if someone else's song is playing
  tick () {
    const g = this.group()
    if (!g) return
    if (this.mine.length && (!this.enabled(g) || this.voice.serverMuted)) {
      this.model.toast(this.voice.serverMuted ? 'A moderator muted you, so your songs left the queue' : 'The Music app was removed from this group')
      this.clear()
      this.voice._broadcastState()
      return
    }
    const { now, next } = this.queue(g, this.active.ch)
    if (this.cur && !(now && now.by === this.me && now.id === this.cur.id)) {
      this._stop()
      this.voice._broadcastState()
      this.model.emit()
    }
    if (!now && !this.cur && next[0]?.by === this.me) {
      const e = this.mine.find(x => x.id === next[0].id)
      if (e) this._start(e)
    }
  }

  // The track that goes to everyone in the channel while I play something
  sendTrack () {
    return this.cur && this.dest ? this.dest.stream.getAudioTracks()[0] || null : null
  }

  _ensureAudio () {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback', sampleRate: 48000 })
      this.dest = this.ctx.createMediaStreamDestination()
      this.monitor = new Audio()
      this.monitor.srcObject = this.dest.stream
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
    this.applyOutput()
    this.monitor.play().catch(() => {})
  }

  // My own song, as I hear it: the music volume, silent while deafened
  applyOutput () {
    if (!this.monitor) return
    const s = this.model.settings.music || {}
    this.monitor.volume = Math.max(0, Math.min(1, s.volume ?? 0.5))
    this.monitor.muted = this.voice.deafened || !!s.muted
    const out = this.model.settings.audio?.outputId
    if (this.monitor.setSinkId && out) this.monitor.setSinkId(out === 'default' ? '' : out).catch(() => {})
  }

  _start (e) {
    this._ensureAudio()
    const el = new Audio()
    el.crossOrigin = 'anonymous'
    el.preload = 'auto'
    const cur = { id: e.id, el, node: null, loading: true }
    this.cur = cur
    const mine = () => this.cur === cur
    const update = () => { if (mine()) { this.voice._broadcastState(); this.model.emit() } }
    const fail = (why) => {
      if (!mine()) return
      this.model.toast(`Couldn't play “${e.t}”${why ? ': ' + why : ''}`, 'error')
      this._finish(e.id)
    }
    // a stream that never starts mustn't hold up the queue
    const timer = setTimeout(() => { if (mine() && cur.loading) fail('it took too long to load') }, 20000)
    el.onplaying = () => { clearTimeout(timer); cur.loading = false; update() }
    el.onpause = update
    el.onseeked = update
    el.onloadedmetadata = () => {
      if (Number.isFinite(el.duration) && el.duration > 0 && e.d !== Math.round(el.duration)) { e.d = Math.round(el.duration); update() }
    }
    el.onended = () => { clearTimeout(timer); if (mine()) this._finish(e.id) }
    el.onerror = () => { clearTimeout(timer); fail(el.error?.code === 4 ? 'the format isn\'t supported or the link stopped working' : '') }
    try {
      cur.node = this.ctx.createMediaElementSource(el)
      cur.node.connect(this.dest)
    } catch (err) { return fail(err.message) }
    el.src = e.url
    this.voice.refreshTracks()
    update()
    el.play().catch((err) => { if (err.name !== 'AbortError') fail('') })
  }

  _stop () {
    const cur = this.cur
    if (!cur) return
    this.cur = null
    cur.el.onerror = cur.el.onended = cur.el.onpause = cur.el.onplaying = null
    cur.el.pause()
    cur.el.removeAttribute('src')
    cur.el.load()
    try { cur.node?.disconnect() } catch {}
    this.voice.refreshTracks()
  }

  // A song of mine is over (played, skipped, removed or broken): out of the queue
  _finish (id) {
    if (this.cur?.id === id) this._stop()
    const i = this.mine.findIndex(x => x.id === id)
    if (i >= 0) {
      const [e] = this.mine.splice(i, 1)
      if (e.revoke) URL.revokeObjectURL(e.url)
    }
    this._changed()
  }

  _changed () {
    this.tick()
    this.voice._broadcastState()
    this.model.emit()
  }

  // Leaving the channel takes my songs with me
  clear () {
    this._stop()
    for (const e of this.mine) if (e.revoke) URL.revokeObjectURL(e.url)
    this.mine = []
    this.model.emit()
  }
}
