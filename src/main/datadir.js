'use strict'
// Where your data (identity, groups, messages, files) lives. By default that's the app's
// userData folder. Settings → Storage can move it anywhere, e.g. a bigger drive. The choice is
// kept in a small pointer file in the default folder, and the move itself happens on the next
// start, before anything has the files open.
const fs = require('fs')
const path = require('path')

const DATA_ITEMS = ['identity.json', 'settings.json', 'groups', 'blobs']
const POINTER = 'data-location.json'

function readPointer (defaultDir) {
  try { return JSON.parse(fs.readFileSync(path.join(defaultDir, POINTER), 'utf8')) } catch { return null }
}

function writePointer (defaultDir, data) {
  fs.mkdirSync(defaultDir, { recursive: true })
  const file = path.join(defaultDir, POINTER)
  if (!data) { fs.rmSync(file, { force: true }); return }
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2))
  fs.renameSync(file + '.tmp', file)
}

const hasData = (dir) => fs.existsSync(path.join(dir, 'identity.json'))
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const inside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// The folder the Store should use right now.
function currentDataDir (defaultDir) {
  const p = readPointer(defaultDir)
  if (!p || !p.dir) return defaultDir
  return p.moveFrom || p.dir // a scheduled move hasn't happened yet
}

// Turn the folder the user picked into the folder we'll use: a dedicated "OpenDiscord"
// subfolder, unless they picked one that already holds OpenDiscord data.
function resolveTarget (picked) {
  if (hasData(picked) || path.basename(picked).toLowerCase() === 'opendiscord') return path.resolve(picked)
  return path.join(path.resolve(picked), 'OpenDiscord')
}

// Checks a target before scheduling a move. Returns { dir, existing } or throws.
function checkTarget (defaultDir, picked) {
  const from = currentDataDir(defaultDir)
  const dir = !picked || same(picked, defaultDir) ? defaultDir : resolveTarget(picked)
  if (same(dir, from)) throw new Error('Your data is already in that folder')
  if (inside(dir, from)) throw new Error("The new folder can't be inside the current data folder")
  if (inside(from, dir) && !hasData(dir)) throw new Error("The new folder can't contain the current data folder")
  fs.mkdirSync(dir, { recursive: true })
  const probe = path.join(dir, '.write-test-' + process.pid)
  try { fs.writeFileSync(probe, 'ok'); fs.rmSync(probe) } catch { throw new Error("Can't write to that folder") }
  return { dir, existing: hasData(dir) }
}

// Schedule the switch for the next start. existing=true just switches to the data already there.
function scheduleMove (defaultDir, dir, existing) {
  const from = currentDataDir(defaultDir)
  if (same(dir, defaultDir) && existing) return writePointer(defaultDir, null)
  writePointer(defaultDir, existing ? { dir } : { dir, moveFrom: from })
}

async function moveItem (src, dst) {
  try {
    await fs.promises.rename(src, dst)
  } catch (err) {
    if (err.code !== 'EXDEV' && err.code !== 'EPERM') throw err
    // Different drive: copy, then delete the original
    await fs.promises.cp(src, dst, { recursive: true, errorOnExist: false, force: true })
    await fs.promises.rm(src, { recursive: true, force: true })
  }
}

// Run at startup, before the Store is created. Finishes a scheduled move. Returns the data folder.
async function prepareDataDir (defaultDir, onProgress = () => {}) {
  const p = readPointer(defaultDir)
  if (!p || !p.dir) return defaultDir
  if (!p.moveFrom) {
    if (fs.existsSync(p.dir)) return p.dir
    // The drive is missing (unplugged?). Don't silently start a fresh identity somewhere else.
    throw new Error(`Your OpenDiscord data folder is not available:\n${p.dir}\n\nReconnect the drive, or delete ${path.join(defaultDir, POINTER)} to start from the default folder.`)
  }
  fs.mkdirSync(p.dir, { recursive: true })
  const items = DATA_ITEMS.filter(name => fs.existsSync(path.join(p.moveFrom, name)))
  for (const [i, name] of items.entries()) {
    onProgress(name, i, items.length)
    const dst = path.join(p.dir, name)
    if (fs.existsSync(dst)) await fs.promises.rm(dst, { recursive: true, force: true })
    await moveItem(path.join(p.moveFrom, name), dst)
  }
  if (same(p.dir, defaultDir)) writePointer(defaultDir, null)
  else writePointer(defaultDir, { dir: p.dir })
  return p.dir
}

async function dirSize (dir) {
  let total = 0
  const walk = async (d) => {
    let entries = []
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else try { total += (await fs.promises.stat(full)).size } catch {}
    }
  }
  for (const name of DATA_ITEMS) {
    const full = path.join(dir, name)
    try {
      const st = await fs.promises.stat(full)
      if (st.isDirectory()) await walk(full)
      else total += st.size
    } catch {}
  }
  return total
}

module.exports = { currentDataDir, checkTarget, scheduleMove, prepareDataDir, dirSize, hasData }
