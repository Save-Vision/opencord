'use strict'
const {
  app, BrowserWindow, ipcMain, protocol, session, desktopCapturer, shell, dialog,
  Tray, Menu, nativeImage, clipboard, globalShortcut, safeStorage, powerMonitor, nativeTheme, systemPreferences
} = require('electron')
const path = require('path')
const { attachContextMenu } = require('./contextmenu')
const fs = require('fs')
const { Readable } = require('stream')
const { Store } = require('./store')
const { Network, importBlobFile, importBlobBuffer } = require('./network')
const { Updater } = require('./updater')
const datadir = require('./datadir')
const { linkPreview } = require('./linkpreview')
const { Claude } = require('./claude')
const poker = require('./poker')
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
let claude = null
let quitting = false
let pendingScreen = null
let accountNote = null // { kind: 'locked', folder }: the old account couldn't be unlocked on this PC
// Tests run with OD_DATA_DIR; some test-only switches below only work then
const TESTING = !!process.env.OD_DATA_DIR
const testInt = (name) => TESTING && /^\d+$/.test(process.env[name] || '') ? Number(process.env[name]) : undefined

// opendiscord:// links (one-time invites and friend links). Clicking one starts the app, or
// hands the link to the running one (second-instance on Windows/Linux, open-url on macOS).
const LINK_RE = /^opendiscord:\/\/(join|friend)\//i
let uiReady = false
let pendingLink = (process.argv.find(a => LINK_RE.test(a))) || null
function openLink (url) {
  if (!url || !LINK_RE.test(url)) return
  if (uiReady && win && !win.isDestroyed()) send('open-link', url)
  else pendingLink = url
  if (win) showWindow()
}
app.on('open-url', (e, url) => { e.preventDefault(); openLink(url) })

// Only an installed copy registers itself for opendiscord://; test, dev and --profile runs
// leave the system alone. (The installer registers it too, see "protocols" in package.json.)
function registerLinkHandler () {
  if (!app.isPackaged || process.env.OD_DATA_DIR || profile) return
  try {
    const exe = process.env.PORTABLE_EXECUTABLE_FILE
    if (exe) app.setAsDefaultProtocolClient('opendiscord', exe)
    else if (!app.isDefaultProtocolClient('opendiscord')) app.setAsDefaultProtocolClient('opendiscord')
  } catch {}
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    showWindow()
    openLink((argv || []).find(a => LINK_RE.test(a)))
  })
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

// The identity's secret is kept encrypted with the OS keychain (DPAPI on Windows). If this PC
// can't decrypt it (the data folder came from another PC or Windows user), the old account is
// set aside, not deleted, and the app starts fresh with a way to restore a backup.
function openStore (dir) {
  const seal = safeStorage.isEncryptionAvailable() ? (s) => safeStorage.encryptString(s).toString('base64') : null
  const unseal = (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64'))
  try {
    return new Store(dir).load({ seal, unseal })
  } catch (err) {
    if (err.code !== 'IDENTITY_LOCKED') throw err
    accountNote = { kind: 'locked', folder: Store.setAside(dir, 'locked') }
    return new Store(dir).load({ seal, unseal })
  }
}

async function boot () {
  if (process.platform === 'win32') app.setAppUserModelId('app.opendiscord' + (profile ? '.' + profile : ''))
  store = openStore(await openDataDir())
  claude = new Claude({ dir: store.dir, safeStorage, store })
  net = new Network(store, {
    bootstrap: process.env.OD_BOOTSTRAP ? process.env.OD_BOOTSTRAP.split(',') : undefined,
    appVersion: app.getVersion(),
    // tests play a newer app this way
    proto: testInt('OD_TEST_PROTO'),
    minProto: testInt('OD_TEST_MIN_PROTO')
  })
  updater = new Updater({ isEnabled: () => store.settings.autoUpdate !== false })
  updater.on('state', (st) => send('update', st))

  registerProtocols()
  registerMediaHandlers()
  registerIpc()
  wireNetwork()
  createWindow()
  nativeTheme.on('updated', () => { if (store.settings.mode === 'system') applyChrome() })
  createTray()
  registerLinkHandler()
  updater.start()
  await net.start()
  startMaintenance()
}

// Hourly: turn superseded ops into stubs, fold logs into compressed segments, and drop
// friends' old files if the user asked for that (Settings → Storage).
function startMaintenance () {
  const run = () => {
    try { store.sweep() } catch (err) { console.warn('[store] sweep', err.message) }
    const days = Number(store.settings.cleanFriendsFilesDays) || 0
    store.cleanBlobs({ days, friends: days > 0 }).catch(() => {})
  }
  setTimeout(run, 30 * 1000).unref?.()
  setInterval(run, 60 * 60 * 1000).unref?.()
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

// Window colours per theme and mode (renderer/lib/themes.js): the background shown while the
// page loads and the caption buttons Windows draws over the right end of our title bar.
const THEME_CHROME = {
  'standard-dark': { bg: '#08090b', bar: '#08090b', symbol: '#9aa0aa' },
  'standard-light': { bg: '#d4d8de', bar: '#d4d8de', symbol: '#3a3f47' },
  'minimal-dark': { bg: '#121212', bar: '#121212', symbol: '#9a9a96' },
  'minimal-light': { bg: '#e8e7e3', bar: '#e8e7e3', symbol: '#4a4a46' },
  'xp-light': { bg: '#3a6ea5', bar: '#0d4fd0', symbol: '#ffffff' },
  'xp-dark': { bg: '#1c2638', bar: '#2f3b56', symbol: '#e8ebf2' },
  'glass-light': { bg: '#d5dceb', bar: '#dde3ef', symbol: '#2a2d33' },
  'glass-dark': { bg: '#10131a', bar: '#141820', symbol: '#d6d9df' },
  'oled-dark': { bg: '#000000', bar: '#000000', symbol: '#e6e6e6' },
  'oled-light': { bg: '#d9d9d5', bar: '#d9d9d5', symbol: '#262626' }
}
// The theme's own mode when the user didn't pick one
const THEME_MODE = { standard: 'dark', minimal: 'light', xp: 'light', glass: 'light', oled: 'dark' }
function themeMode () {
  const s = store?.settings || {}
  if (s.mode === 'light' || s.mode === 'dark') return s.mode
  if (s.mode === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return THEME_MODE[s.theme] || 'dark'
}
const chrome = () => THEME_CHROME[(THEME_MODE[store?.settings?.theme] ? store.settings.theme : 'standard') + '-' + themeMode()]

function applyChrome () {
  if (!win) return
  const c = chrome()
  try { win.setBackgroundColor(c.bg) } catch {}
  if (process.platform !== 'darwin') {
    try { win.setTitleBarOverlay({ color: c.bar, symbolColor: c.symbol, height: 34 }) } catch {}
  }
}

function createWindow () {
  const isMac = process.platform === 'darwin'
  const c = chrome()
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 580,
    show: false,
    backgroundColor: c.bg,
    title: 'OpenDiscord' + (profile ? ` (${profile})` : ''),
    icon: fs.existsSync(ICON) ? ICON : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: isMac ? undefined : { color: c.bar, symbolColor: c.symbol, height: 34 },
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
  attachContextMenu(win, { Menu, shell, clipboard })
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

const sendJoins = () => send('joins', store.joinsInfo())
const notice = (text, kind = 'info') => send('notice', { text, kind })

const JOIN_FAILED = {
  used: 'was already used by someone else',
  expired: 'has expired',
  revoked: 'was cancelled',
  denied: "isn't valid"
}

function appendAndBroadcast (gid, kind, data, make = () => store.append(gid, kind, data)) {
  const op = make()
  net.broadcastOps(gid, [op])
  return op
}

function registerIpc () {
  const handle = (ch, fn) => ipcMain.handle(ch, (_e, ...args) => fn(...args))

  handle('init', () => {
    uiReady = true
    const link = pendingLink
    pendingLink = null
    return {
      me: store.publicIdentity(),
      settings: store.settings,
      platform: process.platform,
      version: app.getVersion(),
      profile,
      groups: [...store.groups.values()].map(groupPayload),
      peers: net.onlinePeers(),
      friends: store.friendsInfo(),
      joins: store.joinsInfo(),
      compat: net.compatInfo(),
      accountNote,
      testing: TESTING,
      forceRelay: TESTING && !!process.env.OD_TEST_FORCE_RELAY,
      link
    }
  })

  // ---- backup & restore (Settings → Account) ----
  handle('backup:export', async (password, testPath) => {
    const text = store.exportBackup(String(password || ''))
    let file = TESTING && typeof testPath === 'string' ? testPath : null
    if (!file) {
      const stamp = new Date().toISOString().slice(0, 10)
      const safeName = (store.identity.name || 'account').replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'account'
      const r = await dialog.showSaveDialog(win, {
        title: 'Save your OpenDiscord backup',
        defaultPath: path.join(app.getPath('documents'), `OpenDiscord backup ${safeName} ${stamp}.odbackup`),
        filters: [{ name: 'OpenDiscord backup', extensions: ['odbackup'] }]
      })
      if (r.canceled || !r.filePath) return null
      file = r.filePath
    }
    await fs.promises.writeFile(file, text, { mode: 0o600 })
    store.setSettings({ lastBackup: Date.now() })
    return file
  })
  handle('backup:pick', async (testPath) => {
    let file = TESTING && typeof testPath === 'string' ? testPath : null
    if (!file) {
      const r = await dialog.showOpenDialog(win, { title: 'Choose your OpenDiscord backup', properties: ['openFile'], filters: [{ name: 'OpenDiscord backup', extensions: ['odbackup', 'json'] }] })
      if (r.canceled || !r.filePaths[0]) return null
      file = r.filePaths[0]
    }
    let head = null
    try { head = JSON.parse(await fs.promises.readFile(file, 'utf8')) } catch {}
    if (!head || head.kind !== 'opendiscord-backup') throw new Error("That isn't an OpenDiscord backup file")
    return { path: file, name: String(head.name || ''), key: String(head.key || ''), created: Number(head.created) || null }
  })
  handle('backup:restore', async (file, password) => {
    const b = Store.openBackup(await fs.promises.readFile(String(file), 'utf8'), password)
    await Promise.race([net.stop(), new Promise(resolve => setTimeout(resolve, 2500))])
    store.restoreBackup(b)
    // Tests can't follow a relaunch: they start the app again themselves
    setTimeout(() => { if (TESTING) { quitting = true; app.exit(0) } else relaunch() }, 200)
    return true
  })

  // ---- call fallback over the chat connection (network.js) ----
  handle('tunnel:open', (key) => net.openTunnel(String(key)))
  handle('tunnel:close', (key) => { net.closeTunnel(String(key)); return true })

  // ---- poker: card crypto with keys derived from this identity (poker.js) ----
  const tbl = (id) => { if (!/^[\w-]{1,32}$/.test(String(id))) throw new Error('Bad table'); return String(id) }
  const hnum = (h) => { if (!Number.isInteger(h) || h < 1) throw new Error('Bad hand'); return h }
  handle('poker:shuffle', (id, h, deck) => poker.shuffle(store.seed, tbl(id), hnum(h), deck || null))
  handle('poker:lock', (id, h, deck) => poker.lock(store.seed, tbl(id), hnum(h), deck))
  handle('poker:reveal', (id, h, idx) => poker.reveal(store.seed, tbl(id), hnum(h), Array.isArray(idx) ? idx : []))
  handle('poker:open', (locked, keys) => poker.open(String(locked), Array.isArray(keys) ? keys : []))
  handle('poker:open-mine', (id, h, j, locked, others) => poker.openMine(store.seed, tbl(id), hnum(h), j, String(locked), Array.isArray(others) ? others : []))

  // seconds since the last keyboard/mouse input anywhere (for "away")
  handle('idle:get', () => powerMonitor.getSystemIdleTime())

  handle('friends:info', () => store.friendsInfo())
  handle('friend:add', (code, name) => {
    const existed = !!store.dmWith(c.parseFriendCode(code).key)
    const { group, key } = store.addFriend(code, name)
    return { ...connectFriend(group, key), existed }
  })
  handle('friend:accept', (key) => connectFriend(store.acceptFriend(key), key))
  handle('friend:decline', (key) => { store.declineFriend(key); sendFriends(); return true })
  handle('friend:link', (ttl) => {
    const link = store.createFriendLink(Number(ttl) || 0)
    sendFriends()
    return link
  })
  handle('friend:link-revoke', (id) => { store.revokeFriendLink(String(id)); sendFriends(); return true })
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

  handle('settings:set', (patch) => {
    const s = store.setSettings(patch)
    if (patch && ('theme' in patch || 'mode' in patch)) applyChrome()
    return s
  })

  handle('group:create', (name) => {
    const g = store.createGroup(name)
    net.joinGroup(g)
    return groupPayload(g)
  })
  handle('group:join', (invite) => {
    // A one-time link: wait for a member to let us in (network 'joined' / 'join-failed')
    if (c.parseLink(invite)) {
      const r = store.startJoin(invite)
      if (r.group) return { ...groupPayload(r.group), existed: true }
      net.startJoin(r.join)
      sendJoins()
      return { pending: true, join: { id: r.join.id, gid: r.join.gid, name: r.join.name } }
    }
    const { group, existed, rekeyed } = store.joinGroup(invite)
    if (!existed || rekeyed) net.joinGroup(group)
    if (rekeyed) sendMembership(group.id)
    return { ...groupPayload(group), existed, rekeyed }
  })
  handle('join:cancel', (id) => {
    net.cancelJoin(id)
    store.dropJoin(id)
    sendJoins()
    return true
  })
  handle('invite:create', (gid, ttl) => {
    const { op, link } = store.createInvite(gid, Number(ttl) || 0)
    net.broadcastOps(gid, [op])
    net.refreshInvites()
    return { op, link }
  })
  handle('invite:revoke', (gid, id) => {
    const op = appendAndBroadcast(gid, 'invite.revoke', { id: String(id) })
    net.refreshInvites()
    return op
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

  handle('op:append', (gid, kind, data) => {
    if (MEMBERSHIP_KINDS.has(kind) || /^invite\.(create|used)$/.test(kind)) throw new Error('Use the dedicated action for ' + kind)
    const op = appendAndBroadcast(gid, kind, data)
    if (kind === 'group.settings') net.refreshInvites()
    return op
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
  // macOS: "Screen Recording" permission ('granted', 'denied', 'not-determined', …)
  handle('screen:access', () => process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted')
  handle('screen:privacy', () => {
    if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
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
    size: await datadir.dirSize(store.dir),
    messages: store.messageUsage(),
    files: await store.blobUsage()
  }))
  handle('storage:clean', async (days) => {
    const d = Math.max(0, Number(days) || 0)
    store.sweep()
    return store.cleanBlobs({ days: d, friends: true })
  })
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

  // @claude with the user's own API key (see claude.js). The key goes in once and never
  // comes back out to the UI.
  handle('claude:info', () => claude.info())
  handle('claude:set-key', (key) => claude.setKey(key))
  handle('claude:clear-key', () => claude.clearKey())
  handle('claude:ask', async (id, req) => {
    const rid = String(id)
    let last = 0
    let timer = null
    let pending = null
    // at most ~8 updates a second to the UI (it relays them to friends)
    const flush = () => { timer = null; if (pending) { send('claude-update', rid, pending.text, pending.status); pending = null } }
    try {
      return await claude.ask(rid, req || {}, (text, status) => {
        pending = { text, status }
        const now = Date.now()
        if (status || now - last > 120) { last = now; flush() } else if (!timer) timer = setTimeout(flush, 120)
      })
    } finally {
      clearTimeout(timer)
    }
  })
  handle('claude:cancel', (id) => { claude.cancel(String(id)); return true })

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
  net.on('compat', (list) => send('compat', list))
  net.on('restored', (gid) => sendMembership(gid))
  net.on('peer-join', (g, key, info) => send('peer-join', g, key, info))
  net.on('peer-leave', (g, key) => send('peer-leave', g, key))
  net.on('peer-update', (info) => send('peer-update', info))
  net.on('eph', (g, from, d) => send('eph', g, from, d))
  net.on('friend-request', (key) => {
    sendFriends()
    if (win && !win.isFocused()) win.flashFrame(true)
  })
  // Someone opened our one-time friend link: we're friends now
  net.on('friend-linked', (key, g) => {
    send('group-added', groupPayload(g))
    sendFriends()
    if (win && !win.isFocused()) win.flashFrame(true)
  })
  // The friend link we opened was used or expired: undo the pending private chat
  net.on('friend-rejected', (key, reason) => {
    const name = store.friends.outgoing[key]?.name || 'your friend'
    const g = store.removeFriend(key)
    if (g) { net.leaveGroup(g); send('group-removed', g.id) }
    sendFriends()
    notice(`The friend link from ${name} ${reason === 'used' ? 'was already used' : reason === 'expired' ? 'has expired' : 'is no longer valid'}. Ask them for a new one.`, 'error')
  })
  net.on('joined', (_id, { group, rekeyed }) => {
    if (rekeyed) sendMembership(group.id)
    send('group-added', groupPayload(group), { joined: true })
    sendJoins()
  })
  net.on('join-failed', (_id, reason, j) => {
    sendJoins()
    notice(`The invite to ${j?.name || 'the group'} ${JOIN_FAILED[reason] || 'did not work'}. Ask for a new link.`, 'error')
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
