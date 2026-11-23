'use strict'
// Link previews, made by the SENDER when they post a link: fetch the page, read its
// Open Graph / meta tags and shrink the preview image to a small JPEG. The result travels
// inside a signed op, so friends see the preview without their app ever contacting the site
// (it can't learn who read the link), and it still shows when the site is gone.
const { net, nativeImage } = require('electron')

const PAGE_LIMIT = 2 * 1024 * 1024 // some pages (YouTube) put their meta tags after ~1 MB of inline script
const IMAGE_LIMIT = 4 * 1024 * 1024
const TIMEOUT = 7000
const MAX_THUMB_CHARS = 30 * 1024
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 OpenDiscord-LinkPreview/1.0'

function isPrivateHost (host) {
  host = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return true
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]]
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (host.includes(':')) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
  return !host.includes('.') // single-label names are local
}

async function fetchLimited (url, limit, accept) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await net.fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept, 'accept-language': 'en,*;q=0.5' } })
    if (!res.ok || !res.body) return null
    const finalUrl = new URL(res.url || url)
    if (!/^https?:$/.test(finalUrl.protocol) || isPrivateHost(finalUrl.hostname)) return null
    const reader = res.body.getReader()
    const chunks = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      size += value.length
      if (size >= limit) { reader.cancel().catch(() => {}); break }
    }
    return { type: (res.headers.get('content-type') || '').toLowerCase(), url: finalUrl.href, body: Buffer.concat(chunks).subarray(0, limit) }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }
function decode (s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}
const clean = (s, max) => decode(s || '').replace(/\s+/g, ' ').trim().slice(0, max)

function parseMeta (html) {
  const head = html.split(/<\/head>/i)[0]
  const meta = {}
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {}
    for (const m of tag.matchAll(/([a-z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? ''
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase()
    if (key && attrs.content != null && !(key in meta)) meta[key] = attrs.content
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]
  return { meta, title }
}

async function thumbnail (src) {
  const img = await fetchLimited(src, IMAGE_LIMIT, 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8')
  if (!img || !img.type.startsWith('image/')) return null
  let image = nativeImage.createFromBuffer(img.body)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  if (width < 16 || height < 16) return null
  const scale = Math.min(1, 480 / width, 360 / height)
  image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' })
  for (const q of [78, 65, 50, 38]) {
    const url = 'data:image/jpeg;base64,' + image.toJPEG(q).toString('base64')
    if (url.length <= MAX_THUMB_CHARS) return { image: url, w: image.getSize().width, h: image.getSize().height }
  }
  return null
}

// YouTube shows a cookie-consent page instead of the video page in some regions; its
// oEmbed endpoint gives the title and thumbnail directly.
const YOUTUBE = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)$/i
async function youtube (url) {
  const res = await fetchLimited('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url.href), 64 * 1024, 'application/json')
  if (!res) return null
  let o
  try { o = JSON.parse(res.body.toString('utf8')) } catch { return null }
  if (!o || !o.title) return null
  const embed = { url: url.href, site: 'YouTube', title: clean(o.title, 200), description: clean(o.author_name, 120), color: '#ff0000' }
  if (/^https:\/\/i\.ytimg\.com\//.test(o.thumbnail_url || '')) {
    const t = await thumbnail(o.thumbnail_url.replace(/\/hqdefault\.jpg$/, '/mqdefault.jpg'))
    if (t) Object.assign(embed, t, { large: true, video: true })
  }
  return embed
}

async function linkPreview (raw) {
  let url
  try { url = new URL(String(raw)) } catch { return null }
  if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) return null
  if (YOUTUBE.test(url.hostname)) return youtube(url)
  const page = await fetchLimited(url.href, PAGE_LIMIT, 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5')
  if (!page) return null
  if (page.type.startsWith('image/')) {
    const t = await thumbnail(page.url)
    return t ? { url: url.href, kind: 'image', ...t } : null
  }
  if (!page.type.includes('html')) return null
  const { meta, title } = parseMeta(page.body.toString('utf8'))
  const pick = (...keys) => keys.map(k => meta[k]).find(v => v && v.trim())
  const embed = {
    url: url.href,
    site: clean(pick('og:site_name', 'application-name', 'twitter:site') || url.hostname.replace(/^www\./, ''), 80),
    title: clean(pick('og:title', 'twitter:title') || title, 200),
    description: clean(pick('og:description', 'twitter:description', 'description'), 350)
  }
  const color = pick('theme-color')
  if (/^#[0-9a-f]{6}$/i.test(color || '')) embed.color = color
  if (!embed.title && !embed.description) return null
  const imageSrc = pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src')
  if (imageSrc) {
    try {
      const abs = new URL(decode(imageSrc), page.url)
      if (/^https?:$/.test(abs.protocol) && !isPrivateHost(abs.hostname)) {
        const t = await thumbnail(abs.href)
        if (t) {
          Object.assign(embed, t)
          // Wide images go under the text, small/square ones to the side
          embed.large = t.w >= 300 && t.w / t.h >= 1.3 && /summary_large_image/.test(meta['twitter:card'] || 'summary_large_image')
        }
      }
    } catch {}
  }
  return embed
}

module.exports = { linkPreview, parseMeta, isPrivateHost }
