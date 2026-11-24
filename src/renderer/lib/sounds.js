// Interface sounds (joining, leaving, muting, ringing), synthesized so there are no audio files
// to ship, and soundboard clips. Both play on the output device picked in Settings, at the
// volume set there.

let ctx = null
let sink = null
let getSettings = () => null

export function configureSounds (fn) { getSettings = fn }

function context () {
  if (!ctx) ctx = new AudioContext()
  const out = getSettings()?.audio?.outputId || 'default'
  if (out !== sink && ctx.setSinkId) {
    sink = out
    ctx.setSinkId(out === 'default' ? '' : out).catch(() => {})
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

// A soft mallet note: a sine with a quiet overtone two octaves up that fades faster
function mallet (c, bus, freq, at, { len = 0.45, level = 1, bright = 0.22 } = {}) {
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(level, at + 0.006)
  g.gain.exponentialRampToValueAtTime(0.0001, at + len)
  g.connect(bus)
  const o1 = c.createOscillator()
  o1.type = 'sine'
  o1.frequency.value = freq
  o1.connect(g)
  const g2 = c.createGain()
  g2.gain.setValueAtTime(bright, at)
  g2.gain.exponentialRampToValueAtTime(0.0001, at + len * 0.35)
  g2.connect(g)
  const o2 = c.createOscillator()
  o2.type = 'sine'
  o2.frequency.value = freq * 4
  o2.connect(g2)
  for (const o of [o1, o2]) { o.start(at); o.stop(at + len + 0.05) }
}

// [frequency, delay in s, options]
const N = { C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, G4: 392, E4: 329.63, A4: 440 }
const SOUNDS = {
  join: [[N.G4, 0], [N.C5, 0.075], [N.G5, 0.15, { len: 0.6 }]], // you joined: a bright rising chord
  leave: [[N.G5, 0], [N.C5, 0.08], [N.G4, 0.16, { len: 0.5, level: 0.8 }]], // you left / someone left
  connect: [[N.E5, 0], [N.A5, 0.09, { len: 0.5 }]], // someone joined your channel
  mute: [[N.E4, 0, { len: 0.18, level: 0.7, bright: 0.1 }]],
  unmute: [[N.A4, 0, { len: 0.18, level: 0.7, bright: 0.1 }]],
  ring: [[N.E5, 0], [N.G5, 0.12], [N.C6, 0.24, { len: 0.5 }], [N.E5, 0.75], [N.G5, 0.87], [N.C6, 0.99, { len: 0.5 }]],
  message: [[N.C6, 0, { len: 0.25, level: 0.5 }], [N.G5, 0.07, { len: 0.3, level: 0.5 }]],
  turn: [[N.D5, 0, { len: 0.3 }], [N.A5, 0.1, { len: 0.4 }]] // your turn in a game
}

export function playTone (kind) {
  const s = getSettings()?.sounds
  if (s && s.voice === false && kind !== 'ring') return
  const volume = s ? Math.max(0, Math.min(1, Number(s.volume ?? 0.6))) : 0.6
  if (!volume) return
  try {
    const c = context()
    const bus = c.createGain()
    bus.gain.value = 0.16 * volume
    bus.connect(c.destination)
    const t0 = c.currentTime + 0.01
    for (const [f, d, o] of SOUNDS[kind] || SOUNDS.unmute) mallet(c, bus, f, t0 + d, o)
    setTimeout(() => bus.disconnect(), 2000)
  } catch {}
}

// ---- soundboard clips ----

const playing = new Set()

export async function playClip (url, volume = 1) {
  const s = getSettings()
  if (s?.sounds?.soundboard === false) return null
  const v = Math.max(0, Math.min(1, volume * Number(s?.sounds?.soundboardVolume ?? 0.7)))
  if (!v) return null
  // a few at once at most; the oldest stops
  if (playing.size >= 3) { const first = playing.values().next().value; first.pause(); playing.delete(first) }
  const el = new Audio(url)
  el.volume = v
  const out = s?.audio?.outputId
  if (out && out !== 'default' && el.setSinkId) await el.setSinkId(out).catch(() => {})
  playing.add(el)
  const done = () => playing.delete(el)
  el.addEventListener('ended', done)
  el.addEventListener('error', done)
  // never longer than a soundboard clip may be
  setTimeout(() => { el.pause(); done() }, 8000)
  await el.play().catch(done)
  return el
}

export function stopClips () {
  for (const el of playing) el.pause()
  playing.clear()
}
