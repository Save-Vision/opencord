// AI noise suppression on the audio thread. RNNoise is a small recurrent neural network
// trained to tell speech from noise (fans, keyboards, hiss, hum). It works on 10 ms frames
// (480 samples at 48 kHz); the browser hands us 128-sample blocks, so input and output are
// buffered. Added latency: one frame (10 ms).
//
// The WebAssembly module is compiled on the main thread and passed in processorOptions.
// It only needs three trivial imports, so no Emscripten loader is required.

const FRAME = 480
const RING = FRAME * 4

class RnnoiseProcessor extends AudioWorkletProcessor {
  constructor (options) {
    super()
    this.ready = false
    this.enabled = true
    this.port.onmessage = (e) => { if (e.data && 'enabled' in e.data) this.enabled = !!e.data.enabled }
    try {
      const opts = options.processorOptions || {}
      const mod = opts.module instanceof WebAssembly.Module ? opts.module : new WebAssembly.Module(opts.bytes)
      let inst = null
      inst = new WebAssembly.Instance(mod, {
        env: {
          __assert_fail: () => { throw new Error('rnnoise assertion failed') },
          emscripten_resize_heap: (want) => {
            const mem = inst.exports.memory
            try { mem.grow(Math.ceil((want - mem.buffer.byteLength) / 65536)); return 1 } catch { return 0 }
          }
        },
        wasi_snapshot_preview1: { fd_write: () => 0 }
      })
      const ex = this.ex = inst.exports
      if (ex.emscripten_stack_init) ex.emscripten_stack_init()
      if (ex.__wasm_call_ctors) ex.__wasm_call_ctors()
      if (ex.rnnoise_get_frame_size() !== FRAME) throw new Error('unexpected RNNoise frame size')
      this.st = ex.rnnoise_create(0)
      this.pIn = ex.malloc(FRAME * 4)
      this.pOut = ex.malloc(FRAME * 4)
      if (!this.st || !this.pIn || !this.pOut) throw new Error('RNNoise could not allocate memory')
      this.inBuf = new Float32Array(FRAME)
      this.inLen = 0
      // Output ring, primed with one frame of silence. That's exactly enough that a 128-sample
      // block is always available, whatever the alignment of 480 vs 128.
      this.ring = new Float32Array(RING)
      this.head = 0
      this.size = FRAME
      this.vad = 0
      this.ready = true
      this.port.postMessage({ ready: true })
    } catch (err) {
      this.port.postMessage({ error: String((err && err.message) || err) })
    }
  }

  _frame () {
    const ex = this.ex
    const heap = new Float32Array(ex.memory.buffer) // re-create: memory can grow
    const i0 = this.pIn >> 2
    for (let i = 0; i < FRAME; i++) heap[i0 + i] = this.inBuf[i] * 32768 // RNNoise expects 16-bit scale
    this.vad = ex.rnnoise_process_frame(this.st, this.pOut, this.pIn)
    const out = new Float32Array(ex.memory.buffer, this.pOut, FRAME)
    let tail = (this.head + this.size) % RING
    for (let i = 0; i < FRAME; i++) {
      this.ring[tail] = out[i] / 32768
      tail = tail + 1 === RING ? 0 : tail + 1
    }
    this.size = Math.min(RING, this.size + FRAME)
  }

  process (inputs, outputs) {
    const inp = inputs[0] && inputs[0][0]
    const out = outputs[0] && outputs[0][0]
    if (!out) return true
    if (!inp) { out.fill(0); return true }
    if (!this.ready || !this.enabled) { out.set(inp); return true }
    for (let i = 0; i < inp.length; i++) {
      this.inBuf[this.inLen++] = inp[i]
      if (this.inLen === FRAME) { this._frame(); this.inLen = 0 }
    }
    const n = Math.min(out.length, this.size)
    for (let i = 0; i < n; i++) {
      out[i] = this.ring[this.head]
      this.head = this.head + 1 === RING ? 0 : this.head + 1
    }
    if (n < out.length) out.fill(0, n)
    this.size -= n
    return true
  }
}

registerProcessor('rnnoise', RnnoiseProcessor)
