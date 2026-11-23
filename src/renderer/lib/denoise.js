// Microphone → RNNoise (AudioWorklet, see rnnoise-worklet.js) → a new MediaStream that is
// what we actually send. The model (~3.6 MB) is compiled once and reused.

let ctxPromise = null
let modulePromise = null
const pipelines = new WeakMap() // processed stream -> { raw, src, node }

export const noiseMode = (a) => a?.noiseMode || (a?.noiseSuppression === false ? 'off' : 'ai')

function loadModel () {
  if (!modulePromise) {
    modulePromise = fetch('vendor/rnnoise.wasm')
      .then((r) => { if (!r.ok) throw new Error('model missing (' + r.status + ')'); return r.arrayBuffer() })
      .then(async (bytes) => ({ bytes, module: await WebAssembly.compile(bytes) }))
    modulePromise.catch(() => { modulePromise = null })
  }
  return modulePromise
}

function context () {
  if (!ctxPromise) {
    ctxPromise = (async () => {
      const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
      await ctx.audioWorklet.addModule('lib/rnnoise-worklet.js')
      return ctx
    })()
    ctxPromise.catch(() => { ctxPromise = null })
  }
  return ctxPromise
}

function waitReady (node) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the noise filter did not start')), 5000)
    node.port.onmessage = (e) => {
      if (e.data?.ready) { clearTimeout(t); resolve() }
      if (e.data?.error) { clearTimeout(t); reject(new Error(e.data.error)) }
    }
  })
}

export async function denoise (raw) {
  const [ctx, model] = await Promise.all([context(), loadModel()])
  if (ctx.state !== 'running') await ctx.resume().catch(() => {})
  const opts = (processorOptions) => ({ numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions })
  let node
  try {
    node = new AudioWorkletNode(ctx, 'rnnoise', opts({ module: model.module }))
  } catch {
    node = new AudioWorkletNode(ctx, 'rnnoise', opts({ bytes: model.bytes })) // module not transferable here: compile in the worklet
  }
  await waitReady(node)
  const src = ctx.createMediaStreamSource(raw)
  const dest = ctx.createMediaStreamDestination()
  dest.channelCount = 1
  src.connect(node).connect(dest)
  const stream = dest.stream
  pipelines.set(stream, { raw, src, node })
  // If the device disappears, end the processed track too so callers notice
  raw.getAudioTracks()[0]?.addEventListener('ended', () => stream.getTracks().forEach(t => t.stop()))
  return stream
}

export function isDenoised (stream) { return !!stream && pipelines.has(stream) }

// Stop a mic stream from getMic(), including the raw device behind a processed one.
export function stopMic (stream) {
  if (!stream) return
  stream.getTracks().forEach(t => t.stop())
  const p = pipelines.get(stream)
  if (!p) return
  pipelines.delete(stream)
  p.raw.getTracks().forEach(t => t.stop())
  try { p.src.disconnect() } catch {}
  try { p.node.disconnect() } catch {}
  p.node.port.close?.()
}

// Shared by calls and the mic test in Settings.
export async function getMic (a, { onFallback } = {}) {
  const mode = noiseMode(a)
  const raw = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: a.inputId && a.inputId !== 'default' ? { exact: a.inputId } : undefined,
      echoCancellation: a.echoCancellation,
      // With the AI filter, the browser's own filter is off: RNNoise works best on the raw signal
      noiseSuppression: mode === 'standard',
      autoGainControl: a.autoGainControl,
      channelCount: 1,
      sampleRate: 48000
    },
    video: false
  })
  if (mode !== 'ai') return raw
  try {
    return await denoise(raw)
  } catch (err) {
    console.warn('[voice] AI noise suppression unavailable', err)
    onFallback?.(err)
    raw.getAudioTracks()[0]?.applyConstraints({ noiseSuppression: true }).catch(() => {})
    return raw
  }
}
