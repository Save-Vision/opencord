'use strict'
const {
  app, BrowserWindow, ipcMain, protocol, session, desktopCapturer, shell, dialog,
  Tray, Menu, nativeImage, clipboard, globalShortcut
} = require('electron')
const path = require('path')
const fs = require('fs')
const { Readable } = require('stream')
const { Store } = require('./store')
const { Network, importBlobFile, importBlobBuffer } = require('./network')
const { Updater } = require('./updater')

// --profile=name runs an isolated instance (own identity + data). Handy for testing
// several "friends" on one PC.
const profileArg = process.argv.find(a => a.startsWith('--profile='))
const profile = (profileArg ? profileArg.slice(10) : (process.env.OD_PROFILE || '')).replace(/[^a-z0-9_-]/gi, '')
app.setName('OpenDiscord')
if (profile) app.setPath('userData', path.join(app.getPath('appData'), 'OpenDiscord-' + profile))
if (process.env.OD_DATA_DIR) app.setPath('userData', path.resolve(process.env.OD_DATA_DIR))

const ROOT = path.join(__dirname, '..', '..')
const RENDERER_DIR = path.join(__dirname, '..', 'renderer')
const VENDOR = {
  'preact-htm.js': path.join(ROOT, 'node_modules', 'htm', 'preact', 'standalone.module.js')
}
const ICON = path.join(ROOT, 'build', 'icon.png')
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.json': 'application/json', '.zip': 'application/zip'
}
const mimeFor = (p) => MIME[path.extname(p).toLowerCase()]?.split(';')[0] || 'application/octet-stream'

protocol.registerSchemesAsPrivileged([
  { scheme: 'odapp', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'odblob', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let win = null
let tray = null
let store = null
let net = null
let updater = null
let quitting = false
let pendingScreen = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox('OpenDiscord failed to start', String(err && err.stack || err))
    app.exit(1)
  })
}

function showWindow () {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function send (channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

async function boot () {
  app.setAppUserModelId('app.opendiscord' + (profile ? '.' + profile : ''))
  store = new Store(app.getPath('userData')).load()
  net = new Network(store, {
    bootstrap: process.env.OD_BOOTSTRAP ? process.env.OD_BOOTSTRAP.split(',') : undefined,
    appVersion: app.getVersion()
  })
  updater = new Updater({ isEnabled: () => store.settings.autoUpdate !== false })
  updater.on('state', (st) => send('update', st))

  registerProtocols()
  registerMediaHandlers()
  registerIpc()
  wireNetwork()
  createWindow()
  createTray()
  updater.start()
  await net.start()
}

// System-wide mute/deafen keys, only registered while you are in a voice channel so they
// never steal shortcuts from other apps the rest of the time.
const HOTKEYS = { 'CommandOrControl+Shift+F9': 'toggle-mute', 'CommandOrControl+Shift+F10': 'toggle-deafen' }
function setVoiceHotkeys (on) {
  for (const [accel, action] of Object.entries(HOTKEYS)) {
    if (on && !globalShortcut.isRegistered(accel)) {
      try { globalShortcut.register(accel, () => send('hotkey', action)) } catch {}
    } else if (!on && globalShortcut.isRegistered(accel)) {
      globalShortcut.unregister(accel)
    }
  }
}

function createWindow () {
  const isMac = process.platform === 'darwin'
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 580,
    show: false,
    backgroundColor: '#0e0f12',
    title: 'OpenDiscord' + (profile ? ` (${profile})` : ''),
    icon: fs.existsSync(ICON) ? ICON : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: isMac ? undefined : { color: '#0e0f12', symbolColor: '#9aa0aa', height: 34 },
    trafficLightPosition: isMac ? { x: 14, y: 11 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false // keep voice/video running when minimised
    }
  })
  win.loadURL('odapp://app/index.html' + (profile ? '?profile=' + encodeURIComponent(profile) : ''))
  win.once('ready-to-show', () => win.show())
  win.on('close', (e) => {
    if (!quitting && tray && store.settings.closeToTray) { e.preventDefault(); win.hide() }
  })
  win.on('closed', () => { win = null })
  win.on('focus', () => { win.flashFrame(false); send('focus-change', true) })
  win.on('blur', () => send('focus-change', false))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('odapp://')) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    }
  })
}

function createTray () {
  if (!fs.existsSync(ICON)) return
  try {
    const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 })
    tray = new Tray(img)
    tray.setToolTip('OpenDiscord' + (profile ? ` (${profile})` : ''))
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open OpenDiscord', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit() } }
    ]))
    tray.on('click', showWindow)
  } catch { tray = null }
}

function registerProtocols () {
  protocol.handle('odapp', async (req) => {
    const url = new URL(req.url)
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    let file = null
    if (rel.startsWith('vendor/')) file = VENDOR[rel.slice(7)] || null
    else {
      const p = path.normalize(path.join(RENDERER_DIR, rel))
      if (p.startsWith(RENDERER_DIR + path.sep)) file = p
    }
    if (!file) return new Response('Not found', { status: 404 })
    try {
      const body = await fs.promises.readFile(file)
      return new Response(body, { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  // odblob://file/<sha256>?type=image/png — serves files from the local blob store,
  // with Range support so audio/video attachments can be scrubbed.
  protocol.handle('odblob', async (req) => {
    const url = new URL(req.url)
    const hash = url.pathname.replace(/^\/+/, '')
    if (!/^[0-9a-f]{64}$/.test(hash) || !store.hasBlob(hash)) return new Response('Not found', { status: 404 })
    const file = store.blobPath(hash)
    const size = (await fs.promises.stat(file)).size
    let type = url.searchParams.get('type') || 'application/octet-stream'
    if (!/^(image|video|audio)\/[\w.+-]+$/.test(type) || type === 'image/svg+xml') type = 'application/octet-stream'
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' }
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '')
    if (range && size > 0) {
      const start = range[1] ? Math.min(+range[1], size - 1) : Math.max(0, size - (+range[2] || 0))
      const end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) }
      })
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { ...headers, 'content-length': String(size) } })
  })
}

function registerMediaHandlers () {
  const ses = session.defaultSession
  const allowed = new Set(['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection'])
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))

  // The renderer shows its own picker, tells us the chosen source, then calls
  // getDisplayMedia(); we answer that request with the chosen source.
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sel = pendingScreen
    pendingScreen = null
    try {
      if (!sel) throw new Error('no source selected')
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      const source = sources.find(s => s.id === sel.id)
      if (!source) throw new Error('source gone')
      const streams = { video: source }
      if (sel.audio && process.platform === 'win32') streams.audio = 'loopback'
      callback(streams)
    } catch {
      callback({})
    }
  })
}

function groupPayload (g) {
  return { id: g.id, nameHint: g.nameHint, joinedAt: g.joinedAt, ops: g.ops }
}

function appendAndBroadcast (gid, kind, data) {
  const op = store.append(gid, kind, data)
  net.broadcastOps(gid, [op])
  return op
}

function registerIpc () {
  const handle = (ch, fn) => ipcMain.handle(ch, (_e, ...args) => fn(...args))

  handle('init', () => ({
    me: store.publicIdentity(),
    settings: store.settings,
    platform: process.platform,
    version: app.getVersion(),
    profile,
    groups: [...store.groups.values()].map(groupPayload),
    peers: net.onlinePeers()
  }))

  handle('profile:set', (p) => {
    const me = store.setProfile(p || {})
    const ops = []
    for (const g of store.groups.values()) ops.push(appendAndBroadcast(g.id, 'profile', store.profileData()))
    for (const op of ops) send('ops', op.g, [op])
    return me
  })

  handle('settings:set', (patch) => store.setSettings(patch))

  handle('group:create', (name) => {
    const g = store.createGroup(name)
    net.joinGroup(g)
    return groupPayload(g)
  })
  handle('group:join', (invite) => {
    const { group, existed } = store.joinGroup(invite)
    if (!existed) net.joinGroup(group)
    return { ...groupPayload(group), existed }
  })
  handle('group:leave', (id) => {
    const g = store.leaveGroup(id)
    if (g) net.leaveGroup(g)
    return true
  })
  handle('group:invite', (id) => store.inviteFor(id))

  handle('op:append', (gid, kind, data) => appendAndBroadcast(gid, kind, data))
  ipcMain.on('eph', (_e, gid, to, data) => net.sendEphemeral(gid, to, data))

  handle('blob:import-paths', async (paths) => {
    const out = []
    for (const p of paths || []) {
      const st = await fs.promises.stat(p)
      if (!st.isFile()) continue
      const { hash, size } = await importBlobFile(store, p)
      out.push({ h: hash, s: size, n: path.basename(p).slice(0, 200), m: mimeFor(p) })
    }
    return out
  })
  handle('blob:import-data', (name, mime, bytes) => {
    const { hash, size } = importBlobBuffer(store, Buffer.from(bytes))
    return { h: hash, s: size, n: String(name || 'file').slice(0, 200), m: String(mime || 'application/octet-stream') }
  })
  handle('dialog:pick-files', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  handle('blob:has', (h) => store.hasBlob(h))
  handle('blob:fetch', async (h, gid) => {
    await net.fetchBlob(h, { groupId: gid, onProgress: (r, s) => send('blob-progress', h, r, s) })
    send('blob-progress', h, -1, -1)
    return true
  })
  handle('blob:save', async (h, name) => {
    if (!store.hasBlob(h)) throw new Error('File not downloaded yet')
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), path.basename(String(name || 'file'))) })
    if (r.canceled || !r.filePath) return null
    await fs.promises.copyFile(store.blobPath(h), r.filePath)
    shell.showItemInFolder(r.filePath)
    return r.filePath
  })

  handle('screen:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 400, height: 225 }, fetchWindowIcons: true })
    return sources
      .filter(s => !s.name.startsWith('OpenDiscord'))
      .map(s => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
      }))
  })
  handle('screen:select', (id, audio) => {
    pendingScreen = { id: String(id), audio: !!audio }
    setTimeout(() => { if (pendingScreen && pendingScreen.id === id) pendingScreen = null }, 15000)
    return true
  })

  handle('net:status', async () => ({ ...(await net.diagnostics()), version: app.getVersion(), platform: process.platform }))
  handle('net:retry', () => net.retry())

  handle('update:state', () => updater.state)
  handle('update:check', () => updater.check())
  handle('update:install', () => updater.install())

  handle('shell:open', (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url) })
  handle('clipboard:write', (text) => { clipboard.writeText(String(text)); return true })
  ipcMain.on('attention', () => { if (win && !win.isFocused()) win.flashFrame(true) })
  ipcMain.on('show-window', showWindow)
  ipcMain.on('voice-hotkeys', (_e, on) => setVoiceHotkeys(!!on))
  ipcMain.on('unread', (_e, count) => {
    if (tray) tray.setToolTip('OpenDiscord' + (count ? ` — ${count} unread` : ''))
    if (process.platform === 'darwin' || process.platform === 'linux') app.setBadgeCount(count || 0)
  })
}

function wireNetwork () {
  net.on('peer-join', (g, key, info) => send('peer-join', g, key, info))
  net.on('peer-leave', (g, key) => send('peer-leave', g, key))
  net.on('peer-update', (info) => send('peer-update', info))
  net.on('eph', (g, from, d) => send('eph', g, from, d))
  net.on('warning', (err) => console.warn('[net]', err && err.message))
  net.on('ops', (g, ops) => {
    send('ops', g, ops)
    // Keep a copy of small attachments so they stay available when the sender is offline.
    const limit = (store.settings.autoDownloadMB || 0) * 1024 * 1024
    for (const op of ops) {
      if (op.k !== 'msg' || !Array.isArray(op.d.att)) continue
      for (const a of op.d.att) {
        if (a && typeof a.h === 'string' && a.s <= limit && !store.hasBlob(a.h)) {
          net.fetchBlob(a.h, { groupId: g, onProgress: (r, s) => send('blob-progress', a.h, r, s) })
            .then(() => send('blob-progress', a.h, -1, -1), () => {})
        }
      }
    }
  })
}

app.on('before-quit', () => { quitting = true })
let stopping = false
app.on('will-quit', (e) => {
  globalShortcut.unregisterAll()
  if (stopping || !net) return
  e.preventDefault()
  stopping = true
  Promise.race([net.stop(), new Promise(resolve => setTimeout(resolve, 2500))]).finally(() => app.exit(0))
})
app.on('window-all-closed', () => { if (!tray) app.quit() })
app.on('activate', showWindow)
