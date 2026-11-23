import { useState, useEffect } from '../vendor/preact-htm.js'
import { Model } from './model.js'
import { Voice } from './voice.js'

export const api = window.od
export const model = new Model()
export const voice = new Voice({ api, model })

export const COLORS = ['#2dd4bf', '#f472b6', '#fbbf24', '#60a5fa', '#a78bfa', '#f87171', '#4ade80', '#fb923c']

export function useModel () {
  const [, force] = useState(0)
  useEffect(() => model.subscribe(() => force(n => n + 1)), [])
  return model
}

export const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')

export function cleanErr (e) {
  return String(e?.message || e).replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, '')
}

export async function act (fn, prefix) {
  try { return await fn() } catch (e) {
    console.error(e)
    model.toast((prefix ? prefix + ': ' : '') + cleanErr(e), 'error')
    return undefined
  }
}

export async function append (gid, kind, data) {
  const op = await api.append(gid, kind, data)
  model.applyOps(gid, [op])
  return op
}

export async function saveSettings (patch) {
  model.settings = await api.setSettings(patch)
  model.emit()
  return model.settings
}

// ---- formatting ----

export function fmtBytes (n) {
  if (!(n >= 0)) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i]
}

export const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function fmtDay (t) {
  const d = new Date(t)
  const today = new Date()
  const yest = new Date(Date.now() - 864e5)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yest.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

export function fmtStamp (t) {
  const day = fmtDay(t)
  return (day === 'Today' || day === 'Yesterday' ? day + ' at ' : new Date(t).toLocaleDateString() + ' ') + fmtTime(t)
}

export function initials (name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean)
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2)
  return s.toUpperCase()
}

export function fmtRate (kbps) {
  if (!kbps) return '0 kbps'
  return kbps >= 1000 ? (kbps / 1000).toFixed(1) + ' Mbps' : kbps + ' kbps'
}

// ---- blobs ----

export const blobUrl = (a) => `odblob://file/${a.h}?type=${encodeURIComponent(a.m || '')}`

export function blobState (hash, gid, size) {
  let st = model.blobs.get(hash)
  if (!st) {
    st = { state: 'checking' }
    model.blobs.set(hash, st)
    api.hasBlob(hash).then((has) => {
      st.state = has ? 'have' : 'missing'
      if (!has && size <= (model.settings.autoDownloadMB || 0) * 1024 * 1024) fetchBlob(hash, gid)
      model.emit()
    })
  }
  return st
}

export async function fetchBlob (hash, gid) {
  const st = model.blobs.get(hash) || {}
  model.blobs.set(hash, st)
  if (st.state === 'fetching' || st.state === 'have') return st.state === 'have'
  st.state = 'fetching'
  st.err = null
  model.emit()
  try {
    await api.fetchBlob(hash, gid)
    st.state = 'have'
  } catch (e) {
    st.state = 'error'
    st.err = cleanErr(e)
  }
  model.emit()
  return st.state === 'have'
}

export function onBlobProgress (hash, r, s) {
  const st = model.blobs.get(hash) || {}
  if (r < 0) st.state = 'have'
  else { if (st.state !== 'have') st.state = 'fetching'; st.r = r; st.s = s }
  model.blobs.set(hash, st)
  model.emit()
}

// After a friend comes online, files that were unavailable might be fetchable now.
export function retryMissingBlobs () {
  for (const [h, st] of model.blobs) if (st.state === 'error' || st.state === 'missing') model.blobs.delete(h)
}

export async function importFiles ({ paths, files }) {
  const out = []
  if (paths && paths.length) out.push(...await api.importPaths(paths))
  for (const f of files || []) {
    const bytes = new Uint8Array(await f.arrayBuffer())
    const ext = (f.type.split('/')[1] || 'bin').replace('jpeg', 'jpg')
    out.push(await api.importData(f.name || `pasted-${Date.now()}.${ext}`, f.type, bytes))
  }
  // Record image dimensions so receivers can reserve space before the image arrives
  for (const a of out) {
    if (!/^image\//.test(a.m)) continue
    try {
      const img = new Image()
      img.src = blobUrl(a)
      await img.decode()
      a.w = img.naturalWidth
      a.hh = img.naturalHeight
    } catch {}
  }
  return out
}

// ---- notifications ----

export function handleNewOps (gid, ops) {
  const g = model.groups.get(gid)
  if (!g) return
  for (const op of ops) {
    if (op.k !== 'msg' || op.a === model.me.key) continue
    if (Date.now() - op.t > 2 * 60 * 1000) continue // history arriving via sync — don't spam
    const ch = g.channels.get(op.d.ch)
    const th = typeof op.d.th === 'string' && !op.d.also ? op.d.th : null
    // Thread replies only notify people in the thread (or mentioned), like Slack
    if (th && !model.follows(g, th) && !model.mentionsMe(op.d.text)) continue
    const here = model.ui.focused && model.ui.gid === gid && !model.ui.stage && !model.ui.planner && !model.ui.games
    const threadHere = model.ui.focused && model.ui.gid === gid && !model.ui.stage && !model.ui.planner
    const viewing = th ? threadHere && model.ui.thread?.id === th : here && model.currentChannel(g)?.id === op.d.ch
    if (viewing) continue
    api.attention()
    if (!model.settings.notifications) continue
    try {
      const author = op.d.bot ? 'Claude' : model.memberName(g, op.a)
      const where = g.dm ? author : `${author} · #${ch?.name || 'channel'}`
      const n = new Notification(th ? where + ' · thread' : where, {
        body: (op.d.text || '').slice(0, 180) || (op.d.att?.length ? '📎 sent a file' : ''),
        icon: model.memberAvatar(g, op.a) || undefined,
        silent: false
      })
      n.onclick = () => {
        api.showWindow()
        model.ui.stage = null
        model.selectGroup(gid)
        model.selectChannel(gid, op.d.ch)
        if (th) model.openThread(gid, th)
      }
    } catch {}
  }
}
