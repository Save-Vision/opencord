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
const datadir = require('./datadir')
const { linkPreview } = require('./linkpreview')
const c = require('./crypto')

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
  'preact-htm.js': path.join(ROOT, 'node_modules', 'htm', 'preact', 'standalone.module.js'),
  'emoji.json': path.join(ROOT, 'node_modules', 'unicode-emoji-json', 'data-by-group.json'),
  'rnnoise.wasm': () => rnnoiseWasm()
}

// The RNNoise model (Apache-2.0, @shiguredo/rnnoise-wasm) ships as a base64 blob inside its
// JS loader. The renderer runs it in an AudioWorklet with its own tiny loader
// (renderer/lib/rnnoise-worklet.js), so we hand it just the raw .wasm bytes.
let rnnoiseBytes = null
function rnnoiseWasm () {
  if (!rnnoiseBytes) {
    const js = fs.readFileSync(path.join(ROOT, 'node_modules', '@shiguredo', 'rnnoise-wasm', 'dist', 'rnnoise.js'), 'utf8')
    const b64 = js.match(/[A-Za-z0-9+/]{100000,}={0,2}/)
    if (!b64) throw new Error('RNNoise model not found')
    rnnoiseBytes = Buffer.from(b64[0], 'base64')
  }
  return rnnoiseBytes
}
const ICON = path.join(ROOT, 'build', 'icon.png')
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.json': 'application/json', '.zip': 'application/zip', '.wasm': 'application/wasm'
}
const mimeFor = (p) => MIME[path.extname(p).toLowerCase()]?.split(';')[0] || 'application/octet-stream'

protocol.registerSchemesAsPrivileged([
  { scheme: 'odapp', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'odblob', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
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
  store = new Store(await openDataDir()).load()
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

// The data folder can live anywhere (Settings → Storage). A scheduled move runs here, before
// anything opens the files, with a small window if it takes more than a moment.
async function openDataDir () {
  const defaultDir = app.getPath('userData')
  if (process.env.OD_DATA_DIR) return defaultDir
  let splash = null
  try {
    return await datadir.prepareDataDir(defaultDir, () => {
      if (splash) return
      splash = new BrowserWindow({ width: 380, height: 120, frame: false, resizable: false, backgroundColor: '#111214', webPreferences: { sandbox: true } })
      splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;height:100vh;display:grid;place-items:center;background:#111214;color:#e3e5e8;font:15px Segoe UI,system-ui,sans-serif">Moving your OpenDiscord data…</body>'))
    })
  } finally {
    if (splash) splash.destroy()
  }
}

function relaunch () {
  quitting = true
  // The portable .exe runs from a temp folder; restart the .exe the user actually opened.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE
  app.relaunch(exe ? { execPath: exe, args: process.argv.slice(1) } : undefined)
  app.quit()
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
      backgroundThrottling: false, // keep voice/video running when minimised
      autoplayPolicy: 'no-user-gesture-required' // a friend's call audio, or being moved by a moderator, must play without a click
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
    if (rel.startsWith('vendor/')) {
      file = VENDOR[rel.slice(7)] || null
      if (typeof file === 'function') {
        try { return new Response(file(), { headers: { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream' } }) } catch (err) {
          return new Response(String(err.message), { status: 500 })
        }
      }
    } else {
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
    // Only the app page may fetch() blobs (text/code previews); text is served as opaque bytes, never rendered
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': 'odapp://app' }
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
  // online: peers already connected (their peer-join may have fired before the renderer knew the group)
  const online = net?.started ? net.peersIn(g.id).map(p => net.peerInfo(p)) : []
  return { id: g.id, nameHint: g.nameHint, joinedAt: g.joinedAt, ops: g.ops, membership: store.membershipInfo(g), dm: g.dm || null, online }
}

const sendFriends = () => send('friends', store.friendsInfo())

// Opening a private chat: join it and ring the friend directly. The direct connection also
// speeds up the first contact after they accept.
function connectFriend (group, key) {
  net.joinGroup(group)
  if (!store.isFriend(key)) net.sendFriendRequest(key)
  sendFriends()
  return groupPayload(group)
}

const MEMBERSHIP_KINDS = new Set(['group.init', 'member.role', 'member.kick'])
function sendMembership (gid) {
  const g = store.groups.get(gid)
  if (g) send('membership', gid, store.membershipInfo(g))
}

function appendAndBroadcast (gid, kind, data, make = () => store.append(gid, kind, data)) {
  const op = make()
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
    peers: net.onlinePeers(),
    friends: store.friendsInfo()
  }))

  handle('friends:info', () => store.friendsInfo())
  handle('friend:add', (code, name) => {
    const existed = !!store.dmWith(c.parseFriendCode(code).key)
    const { group, key } = store.addFriend(code, name)
    return { ...connectFriend(group, key), existed }
  })
  handle('friend:accept', (key) => connectFriend(store.acceptFriend(key), key))
  handle('friend:decline', (key) => { store.declineFriend(key); sendFriends(); return true })
  handle('friend:remove', (key) => {
    net.cancelFriendRequest(key)
    const g = store.removeFriend(key)
    if (g) net.leaveGroup(g)
    sendFriends()
    return g ? g.id : null
  })

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
    const { group, existed, rekeyed } = store.joinGroup(invite)
    if (!existed || rekeyed) net.joinGroup(group)
    if (rekeyed) sendMembership(group.id)
    return { ...groupPayload(group), existed, rekeyed }
  })
  // Moderation. Kicking rotates the group key (see store.kick). The op goes out first, so the
  // kicked person's app learns why it lost access; then the network re-checks everyone and
  // cuts them off. The op only holds the new key sealed to the remaining members.
  handle('member:kick', (gid, key) => {
    const op = store.kick(gid, key)
    net.broadcastOps(gid, [op])
    net.membershipChanged(gid)
    sendMembership(gid)
    return op
  })
  handle('member:role', (gid, key, role) => {
    const op = appendAndBroadcast(gid, 'member.role', { key, role }, () => store.setRole(gid, key, role))
    net.membershipChanged(gid)
    sendMembership(gid)
    return op
  })
  handle('group:leave', (id) => {
    const g = store.leaveGroup(id)
    if (g) net.leaveGroup(g)
    return true
  })
  handle('group:invite', (id) => store.inviteFor(id))

  handle('op:append', (gid, kind, data) => {
    if (MEMBERSHIP_KINDS.has(kind)) throw new Error('Use the moderation actions for ' + kind)
    return appendAndBroadcast(gid, kind, data)
  })
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

  handle('link:preview', (url) => store.settings.linkPreviews === false ? null : linkPreview(url))

  handle('storage:info', async () => ({
    dir: store.dir,
    defaultDir: app.getPath('userData'),
    locked: !!process.env.OD_DATA_DIR,
    size: await datadir.dirSize(store.dir)
  }))
  handle('storage:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose where OpenDiscord keeps your data', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  handle('storage:check', (picked) => {
    if (process.env.OD_DATA_DIR) throw new Error('The data folder is fixed by OD_DATA_DIR')
    return datadir.checkTarget(app.getPath('userData'), picked || null)
  })
  handle('storage:move', (dir, existing) => {
    const target = datadir.checkTarget(app.getPath('userData'), dir)
    datadir.scheduleMove(app.getPath('userData'), target.dir, !!existing && target.existing)
    setTimeout(relaunch, 300)
    return true
  })
  handle('storage:open', () => shell.openPath(store.dir))

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
  net.on('friend-request', (key) => {
    sendFriends()
    if (win && !win.isFocused()) win.flashFrame(true)
  })
  net.on('warning', (err) => console.warn('[net]', err && err.message))
  net.on('ops', (g, ops) => {
    send('ops', g, ops)
    if (ops.some(op => MEMBERSHIP_KINDS.has(op.k))) sendMembership(g)
    if (store.groups.get(g)?.dm) sendFriends() // the friend posting = they accepted
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
