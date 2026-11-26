'use strict'
// How OpenDiscord sits in the operating system:
//
// 1. Starting with the computer (Settings → Network → Startup). Windows keeps the entry in the
//    Run list of the registry, a Mac in its Login Items. Only an installed copy registers itself;
//    dev, test and --profile runs leave the system alone (tests get a stand-in, see main.js).
//    Started "in the background", the app comes up with only its tray icon.
//
// 2. The taskbar icon on Windows. Windows caches the picture of a pinned or Start menu shortcut
//    by the file it points to (OpenDiscord.exe), so after the logo changed, a pinned app kept
//    showing the old one, although the new .exe has the new icon. The app writes its icon into an
//    .ico file whose name changes with the picture, points its own shortcuts at that file and has
//    Explorer reload icons: a file name it has never seen can't come from the cache.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const HIDDEN_ARG = '--hidden'

// ---------------------------------------------------------------- start with the computer

// `app` is Electron's app (getLoginItemSettings / setLoginItemSettings), or a stand-in in tests
function makeAutostart ({ app, platform = process.platform, exe, supported, settings, saveSettings }) {
  const args = (hidden) => hidden ? [HIDDEN_ARG] : []
  const hiddenPref = () => settings().startHidden !== false

  function info () {
    if (!supported) return { supported: false }
    if (platform === 'win32') {
      const hidden = hiddenPref()
      // Windows compares the whole command line, arguments included
      const s = app.getLoginItemSettings({ path: exe, args: args(hidden) })
      const enabled = !!s.openAtLogin
      // switched off in Task Manager → Startup apps (or Windows Settings → Apps → Startup)
      return { supported: true, enabled, blocked: enabled && s.executableWillLaunchAtLogin === false, hidden, canHide: true }
    }
    const s = app.getLoginItemSettings()
    // macOS 13+: 'enabled', 'requires-approval' (System Settings → General → Login Items), ...
    return { supported: true, enabled: !!s.openAtLogin || s.status === 'enabled', approval: s.status === 'requires-approval', hidden: false, canHide: false }
  }

  function set ({ enabled, hidden }) {
    if (!supported) throw new Error('Only the installed app can start with your computer')
    hidden = hidden == null ? hiddenPref() : !!hidden
    if (platform === 'win32') {
      // `enabled` also turns it back on in Task Manager: the user just asked for it here
      app.setLoginItemSettings({ openAtLogin: !!enabled, path: exe, args: args(hidden), enabled: true })
    } else {
      app.setLoginItemSettings({ openAtLogin: !!enabled })
    }
    saveSettings({ startHidden: hidden })
    return info()
  }

  return { info, set }
}

// ---------------------------------------------------------------- the taskbar icon (Windows)

// An .ico file with one picture per size: { size, png } (Windows reads PNG at 256 px) or
// { size, bgra } (raw pixels, written as a classic 32-bit bitmap, which every reader of small
// icons understands)
function icoBitmap (size, bgra) {
  const rowMask = Math.ceil(size / 32) * 4
  const head = Buffer.alloc(40)
  head.writeUInt32LE(40, 0) // header size
  head.writeInt32LE(size, 4)
  head.writeInt32LE(size * 2, 8) // the picture and its mask
  head.writeUInt16LE(1, 12) // planes
  head.writeUInt16LE(32, 14) // bits per pixel
  head.writeUInt32LE(size * size * 4 + rowMask * size, 20)
  const pixels = Buffer.alloc(size * size * 4)
  const mask = Buffer.alloc(rowMask * size)
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y // bottom-up
    bgra.copy(pixels, row * size * 4, y * size * 4, (y + 1) * size * 4)
    for (let x = 0; x < size; x++) {
      if (bgra[(y * size + x) * 4 + 3] === 0) mask[row * rowMask + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return Buffer.concat([head, pixels, mask])
}

function buildIco (images) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0) // reserved
  head.writeUInt16LE(1, 2) // 1 = icon
  head.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  const data = images.map(img => img.png || icoBitmap(img.size, img.bgra))
  let offset = head.length + dir.length
  images.forEach((img, i) => {
    const o = i * 16
    const side = img.size >= 256 ? 0 : img.size // 0 means 256
    dir.writeUInt8(side, o)
    dir.writeUInt8(side, o + 1)
    dir.writeUInt16LE(1, o + 4) // colour planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32LE(data[i].length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += data[i].length
  })
  return Buffer.concat([head, dir, ...data])
}

const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

// Points every shortcut in `dirs` that starts `exe` at `ico`. Returns the shortcuts it changed.
// `shell` is Electron's (readShortcutLink / writeShortcutLink); everything else the shortcut
// holds (arguments, the app ID the taskbar groups windows by) stays as it is.
function refreshShortcuts ({ exe, ico, dirs, shell }) {
  const changed = []
  for (const dir of dirs) {
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!/\.lnk$/i.test(name)) continue
      const file = path.join(dir, name)
      let link
      try { link = shell.readShortcutLink(file) } catch { continue }
      if (!samePath(link.target, exe) || samePath(link.icon, ico)) continue
      try { if (shell.writeShortcutLink(file, 'update', { icon: ico, iconIndex: 0 })) changed.push(file) } catch {}
    }
  }
  return changed
}

// Where Windows keeps the shortcuts that show the app's icon
function shortcutDirs (app) {
  const roaming = app.getPath('appData')
  const dirs = [
    path.join(roaming, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
    path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ]
  try { dirs.push(app.getPath('desktop')) } catch {}
  return dirs
}

// Writes the .ico (named after the picture it holds) and points the shortcuts at it
function updateWindowsIcons ({ app, shell, nativeImage, iconPng, exe, execFile }) {
  const src = fs.readFileSync(iconPng)
  const img = nativeImage.createFromBuffer(src)
  if (img.isEmpty()) return []
  const hash = crypto.createHash('sha256').update(src).digest('hex').slice(0, 12)
  const dir = path.join(app.getPath('userData'), 'icons')
  const ico = path.join(dir, `OpenDiscord-${hash}.ico`)
  if (!fs.existsSync(ico)) {
    const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    const images = sizes.map((size) => {
      const pic = img.resize({ width: size, height: size, quality: 'best' })
      return size >= 256 ? { size, png: pic.toPNG() } : { size, bgra: pic.toBitmap() } // toBitmap: BGRA on Windows
    })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(ico + '.tmp', buildIco(images))
    fs.renameSync(ico + '.tmp', ico)
  }
  const changed = refreshShortcuts({ exe, ico, dirs: shortcutDirs(app), shell })
  if (changed.length) {
    // Explorer reloads the icons of the taskbar, Start menu and desktop
    const tool = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ie4uinit.exe')
    try { execFile(tool, ['-show'], { windowsHide: true }, () => {}) } catch {}
  }
  return changed
}

module.exports = { HIDDEN_ARG, makeAutostart, buildIco, refreshShortcuts, updateWindowsIcons }
