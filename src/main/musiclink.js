'use strict'
// Links for the music bot (renderer/lib/music.js): a direct link to an audio file or an internet
// radio stream, or a playlist file (.m3u, .pls) that points to one. Only the app of whoever
// queued the link fetches it; friends' apps get the sound through the call, never from the site.
//
// The page plays a link through odweb://media/<token> (main.js). Only links checked here get a
// token, and only audio comes back through it, so the page can't use it to fetch anything else.
const crypto = require('crypto')

// Sites that only play music on their own pages and apps
const WALLED = [
  [/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i, 'YouTube'],
  [/(^|\.)spotify\.com$/i, 'Spotify'],
  [/(^|\.)soundcloud\.com$/i, 'SoundCloud'],
  [/(^|\.)music\.apple\.com$/i, 'Apple Music'],
  [/(^|\.)deezer\.com$/i, 'Deezer'],
  [/(^|\.)tidal\.com$/i, 'Tidal'],
  [/(^|\.)twitch\.tv$/i, 'Twitch']
]
const AUDIO_PATH = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|webm|weba)$/i
const PLAYLIST_TYPE = /^(audio\/(x-)?mpegurl|audio\/x-scpls|application\/pls\+xml|application\/x-mpegurl|application\/vnd\.apple\.mpegurl)$/i
const PLAYLIST_PATH = /\.(m3u8?|pls)$/i

// What the page may receive through odweb://
function isAudioResponse (type, url) {
  if (/^audio\/[\w.+-]+$/i.test(type) || /^application\/ogg$/i.test(type) || /^video\/(mp4|webm|ogg)$/i.test(type)) return !PLAYLIST_TYPE.test(type)
  // some servers send music files without a proper type
  return (!type || /^application\/octet-stream$/i.test(type)) && AUDIO_PATH.test(new URL(url).pathname)
}

// The first stream a playlist points to
function playlistTarget (text) {
  const m = /^\s*(?:File\d+\s*=\s*)?(https?:\/\/\S+)/im.exec(text)
  return m ? m[1] : null
}

const contentType = (res) => (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()

async function readText (res, max) {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let n = 0
  while (n < max) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
    n += value.length
  }
  reader.cancel().catch(() => {})
  return Buffer.concat(chunks).subarray(0, max).toString('utf8')
}

function titleFrom (u, res) {
  const icy = (res.headers.get('icy-name') || '').replace(/[\u0000-\u001f]/g, '').trim()
  if (icy) return icy.slice(0, 120)
  const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '').replace(AUDIO_PATH, '').trim()
  return (last && !/^(stream|live|listen|radio|;)$/i.test(last) ? last : u.hostname.replace(/^www\./, '')).slice(0, 120)
}

// Checks a link and finds the stream behind it: { url, title, live }
async function resolveMusicLink (raw, { fetch, timeoutMs = 12000, depth = 0 }) {
  let u
  try { u = new URL(String(raw || '').trim()) } catch { throw new Error("That isn't a link") }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https links can be played')
  const walled = WALLED.find(([re]) => re.test(u.hostname))
  if (walled) throw new Error(`${walled[1]} only plays its music on its own website and apps. Use a music file, or a link to an audio file or a radio stream.`)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetch(u.href, { signal: ctrl.signal })
  } catch {
    clearTimeout(timer)
    throw new Error(`Couldn't reach ${u.hostname}`)
  }
  try {
    if (!res.ok) throw new Error(`${u.hostname} answered ${res.status}${res.statusText ? ' ' + res.statusText : ''}`)
    const type = contentType(res)
    const final = new URL(res.url || u.href)
    if (PLAYLIST_TYPE.test(type) || (PLAYLIST_PATH.test(final.pathname) && !isAudioResponse(type, final.href))) {
      const text = await readText(res, 64 * 1024)
      if (/#EXT-X-/i.test(text)) throw new Error("HLS streams (.m3u8) can't be played. Look for the station's MP3 or AAC stream link.")
      const next = playlistTarget(text)
      if (!next || depth >= 2) throw new Error('No stream found in that playlist')
      return await resolveMusicLink(next, { fetch, timeoutMs, depth: depth + 1 })
    }
    if (!isAudioResponse(type, final.href)) {
      throw new Error(type === 'text/html' ? "That link is a web page, not a music file or a radio stream" : `That link isn't audio (${type || 'unknown type'})`)
    }
    return { url: final.href, title: titleFrom(final, res), live: !!res.headers.get('icy-name') || !res.headers.get('content-length') }
  } finally {
    clearTimeout(timer)
    // a radio stream never ends: stop downloading it now, the player fetches it again
    ctrl.abort()
    res.body?.cancel?.().catch(() => {})
  }
}

// Tokens for links the page may play (newest 200)
class MusicLinks {
  constructor () { this.map = new Map() }
  add (url) {
    const token = crypto.randomBytes(16).toString('hex')
    this.map.set(token, url)
    while (this.map.size > 200) this.map.delete(this.map.keys().next().value)
    return 'odweb://media/' + token
  }

  get (token) { return this.map.get(token) || null }
}

// odweb://media/<token>: the audio of a checked link, with seeking (Range) passed on
async function serveMusicLink (req, { links, fetch }) {
  const token = new URL(req.url).pathname.replace(/^\/+/, '')
  const target = /^[0-9a-f]{32}$/.test(token) ? links.get(token) : null
  if (!target) return new Response('Not found', { status: 404 })
  const headers = {}
  const range = req.headers.get('range')
  if (range && /^bytes=\d*-\d*$/.test(range)) headers.range = range
  let res
  try { res = await fetch(target, { headers }) } catch { return new Response('Unreachable', { status: 502 }) }
  const type = contentType(res)
  if (!res.ok || !isAudioResponse(type, res.url || target)) {
    res.body?.cancel?.().catch(() => {})
    return new Response('Not audio', { status: res.ok ? 415 : res.status })
  }
  const out = new Headers({ 'content-type': type || 'application/octet-stream', 'access-control-allow-origin': 'odapp://app', 'x-content-type-options': 'nosniff' })
  for (const h of ['content-length', 'content-range', 'accept-ranges']) {
    const v = res.headers.get(h)
    if (v) out.set(h, v)
  }
  return new Response(res.body, { status: res.status, headers: out })
}

module.exports = { resolveMusicLink, MusicLinks, serveMusicLink, isAudioResponse, playlistTarget }
