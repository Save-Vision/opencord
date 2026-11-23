'use strict'
// @claude: answers come from the Anthropic API, called from this PC with the user's own API
// key. There is no shared key and no server in between: someone without a key simply can't
// ask. The key is encrypted with the OS keychain (Electron safeStorage), lives in claude.json
// in the data folder, never reaches the UI process and is never synced to friends.

const fs = require('fs')
const path = require('path')
const Anthropic = require('@anthropic-ai/sdk')

const MODELS = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5', price: [4, 20] }, // $ per million tokens in / out
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', price: [2, 10] },
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5', price: [0.1, 0.5] }
}
const DEFAULT_MODEL = 'claude-opus-5-5'
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE = 5 * 1024 * 1024
const MAX_TEXT_FILE = 60 * 1024
const MAX_PROMPT = 120 * 1024

// Tests point this at a local fake of the API; only a loopback address is accepted, so a
// stray environment variable can never send the key anywhere else.
function testBaseURL () {
  const u = process.env.OD_CLAUDE_BASE_URL
  return u && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(u) ? u : undefined
}

// A message the user can act on, from the SDK's typed errors
function friendly (err) {
  const api = err?.error?.error?.message
  let text
  if (err instanceof Anthropic.APIUserAbortError) text = 'Stopped'
  else if (err instanceof Anthropic.AuthenticationError) text = 'Anthropic rejected your API key. Check it in Settings > Claude.'
  else if (err instanceof Anthropic.PermissionDeniedError) text = 'Your API key isn\'t allowed to do this' + (api ? ': ' + api : '.')
  else if (err instanceof Anthropic.NotFoundError) text = 'That model isn\'t available for your API key.'
  else if (err instanceof Anthropic.RateLimitError) text = 'Anthropic\'s rate limit for your key was hit. Try again in a minute.'
  else if (err instanceof Anthropic.OverloadedError) text = 'Claude is overloaded right now. Try again shortly.'
  else if (err instanceof Anthropic.InternalServerError) text = 'Anthropic had a server error. Try again shortly.'
  else if (err instanceof Anthropic.BadRequestError) text = api || 'Anthropic refused the request.'
  else if (err instanceof Anthropic.APIConnectionError) text = 'Couldn\'t reach api.anthropic.com. Are you online?'
  else text = api || err?.message || String(err)
  const out = new Error(text)
  out.aborted = err instanceof Anthropic.APIUserAbortError
  return out
}

class Claude {
  constructor ({ dir, safeStorage, store }) {
    this.file = path.join(dir, 'claude.json')
    this.safe = safeStorage
    this.store = store
    this.running = new Map() // request id -> MessageStream
  }

  _read () { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { return {} } }
  _write (data) {
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  _key () {
    const d = this._read()
    if (d.enc) {
      try { return this.safe.decryptString(Buffer.from(d.enc, 'base64')) } catch { return null }
    }
    return d.plain || null
  }

  _client (key) { return new Anthropic({ apiKey: key, baseURL: testBaseURL(), maxRetries: 2, timeout: 120000 }) }

  info () {
    const d = this._read()
    const month = new Date().toISOString().slice(0, 7)
    return {
      hasKey: !!(d.enc || d.plain),
      hint: d.hint || '',
      encrypted: !!d.enc,
      usage: d.usage && d.usage.month === month ? d.usage : { month, answers: 0, usd: 0 },
      models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })),
      defaultModel: DEFAULT_MODEL
    }
  }

  // Checks the key with Anthropic (listing models is free) before keeping it
  async setKey (raw) {
    const key = String(raw || '').trim()
    if (!KEY_RE.test(key)) throw new Error('That doesn\'t look like an Anthropic API key. Keys start with sk-ant-.')
    try { await this._client(key).models.list({ limit: 1 }) } catch (err) { throw friendly(err) }
    const d = this._read()
    delete d.enc
    delete d.plain
    if (this.safe.isEncryptionAvailable()) d.enc = this.safe.encryptString(key).toString('base64')
    else d.plain = key // no keychain (some Linux desktops): kept as a file only this user can read
    d.hint = key.slice(-4)
    this._write(d)
    return this.info()
  }

  clearKey () {
    const d = this._read()
    delete d.enc
    delete d.plain
    delete d.hint
    this._write(d)
    return this.info()
  }

  // Attachments of the message that asked: images as images, small text files as text
  _attachments (atts = []) {
    const out = []
    for (const a of atts.slice(0, 6)) {
      if (!a || typeof a.h !== 'string' || !/^[0-9a-f]{64}$/.test(a.h) || !this.store.hasBlob(a.h)) continue
      const file = this.store.blobPath(a.h)
      let size = 0
      try { size = fs.statSync(file).size } catch { continue }
      if (IMAGE_TYPES.has(a.m) && size <= MAX_IMAGE) {
        out.push({ type: 'image', source: { type: 'base64', media_type: a.m, data: fs.readFileSync(file).toString('base64') } })
      } else if (a.text && size <= MAX_TEXT_FILE) {
        const text = fs.readFileSync(file, 'utf8')
        if (!text.includes('\u0000')) out.push({ type: 'text', text: `<file name="${String(a.n || 'file').replace(/[<>"]/g, '')}">\n${text}\n</file>` })
      }
    }
    return out
  }

  // req: { system, prompt, attachments, model, web }. onUpdate(text, status) while it writes.
  async ask (id, req, onUpdate) {
    const key = this._key()
    if (!key) throw new Error('Add your Anthropic API key in Settings > Claude first.')
    const model = MODELS[req.model] ? req.model : DEFAULT_MODEL
    const content = [...this._attachments(req.attachments), { type: 'text', text: String(req.prompt || '').slice(-MAX_PROMPT) }]
    const messages = [{ role: 'user', content }]
    const tools = req.web ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] : undefined
    const client = this._client(key)
    let text = ''
    const sources = new Map()
    const usage = { input: 0, output: 0, searches: 0 }
    let stop = null
    try {
      // A turn that searches the web can pause; sending it back lets the server continue
      for (let round = 0; round < 4; round++) {
        const stream = client.messages.stream({
          model,
          max_tokens: 4000,
          system: String(req.system || ''),
          messages,
          ...(tools ? { tools } : {})
        })
        this.running.set(id, stream)
        stream.on('text', (delta) => { text += delta; onUpdate(text, null) })
        stream.on('streamEvent', (ev) => {
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use') onUpdate(text, 'Searching the web…')
        })
        const msg = await stream.finalMessage()
        usage.input += (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0) + (msg.usage.cache_creation_input_tokens || 0)
        usage.output += msg.usage.output_tokens || 0
        usage.searches += msg.usage.server_tool_use?.web_search_requests || 0
        for (const b of msg.content) {
          if (b.type !== 'text') continue
          for (const c of b.citations || []) if (c.type === 'web_search_result_location' && c.url && sources.size < 5) sources.set(c.url, c.title || c.url)
        }
        stop = msg.stop_reason
        if (stop !== 'pause_turn') break
        messages.push({ role: 'assistant', content: msg.content })
      }
    } catch (err) {
      throw friendly(err)
    } finally {
      this.running.delete(id)
    }
    this._count(model, usage)
    return { text, stop, model, sources: [...sources].map(([url, title]) => ({ url, title })) }
  }

  cancel (id) {
    const s = this.running.get(id)
    if (s) s.abort()
  }

  // Rough cost of this month's answers, shown in Settings (web searches are billed on top)
  _count (model, usage) {
    const d = this._read()
    const month = new Date().toISOString().slice(0, 7)
    if (!d.usage || d.usage.month !== month) d.usage = { month, answers: 0, usd: 0, searches: 0 }
    const [pin, pout] = MODELS[model].price
    d.usage.answers++
    d.usage.searches = (d.usage.searches || 0) + usage.searches
    d.usage.usd = Math.round((d.usage.usd + (usage.input * pin + usage.output * pout) / 1e6) * 10000) / 10000
    this._write(d)
  }
}

module.exports = { Claude, MODELS, DEFAULT_MODEL }
