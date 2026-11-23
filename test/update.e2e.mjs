// Tests the self-update flow of a packaged build against a local update feed:
// the app finds a "newer" version, downloads it, verifies its SHA-512 and offers a restart.
// It never installs anything: with a test feed, install-on-quit is off and nothing is clicked.
//
// Run after `npm run dist`: node test/update.e2e.mjs
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const createTestnet = require('hyperdht/testnet')
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const shots = path.join(root, 'test', 'screenshots')
fs.mkdirSync(shots, { recursive: true })

const exe = path.join(dist, 'win-unpacked', 'OpenDiscord.exe')
const latestYml = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8')
const installer = /^path:\s*(.+)$/m.exec(latestYml)[1].trim()
if (!fs.existsSync(exe) || !fs.existsSync(path.join(dist, installer))) throw new Error('Build first: npm run dist')
const appUpdateYml = fs.readFileSync(path.join(dist, 'win-unpacked', 'resources', 'app-update.yml'), 'utf8')
console.log('app-update.yml:', appUpdateYml.trim().replace(/\r?\n/g, ' | '))
const cacheDir = path.join(process.env.LOCALAPPDATA, /updaterCacheDirName:\s*(.+)/.exec(appUpdateYml)[1].trim())

// Pretend the build we just made is version 99.0.0. Same file, so the SHA-512 still matches.
const feedYml = latestYml.replace(/^version:.*$/m, 'version: 99.0.0')
let served = 0
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1))
  if (name === 'latest.yml') { res.writeHead(200, { 'content-type': 'text/yaml' }); return res.end(feedYml) }
  if (name === installer) {
    const file = path.join(dist, installer)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(file).size })
    served++
    return fs.createReadStream(file).pipe(res)
  }
  res.writeHead(404)
  res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const feed = `http://127.0.0.1:${server.address().port}/`

const testnet = await createTestnet(3)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'od-update-'))
const hadCache = fs.existsSync(cacheDir)
let app
let failed = false
try {
  app = await electron.launch({
    executablePath: exe,
    args: ['--profile=updatetest'],
    env: { ...process.env, OD_DATA_DIR: tmp, OD_UPDATE_URL: feed, OD_BOOTSTRAP: testnet.bootstrap.map(b => `${b.host}:${b.port}`).join(',') }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1320, height: 820 }).catch(() => {})
  await page.getByPlaceholder('What your friends call you').fill('Updater')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('.user-panel button[title="Settings"]').click()
  await page.getByRole('button', { name: 'Updates', exact: true }).click()
  console.log('▶ before:', (await page.locator('.update-status').textContent()).trim())
  const t0 = Date.now()
  await page.getByRole('button', { name: 'Check for updates' }).click()
  await page.locator('.update-pill').waitFor({ timeout: 120000 })
  console.log(`▶ downloaded + verified in ${Date.now() - t0} ms:`, (await page.locator('.update-status').textContent()).trim())
  await page.screenshot({ path: path.join(shots, '10-update-ready.png') })
  // From the Settings tab…
  await page.locator('.settings-body').getByRole('button', { name: 'Restart to update' }).click()
  await page.locator('.modal', { hasText: 'Restart to update?' }).waitFor()
  console.log('▶ prompt:', (await page.locator('.modal-body').textContent()).trim())
  await page.screenshot({ path: path.join(shots, '11-update-prompt.png') })
  await page.getByRole('button', { name: 'Cancel' }).click() // never actually install during tests
  // …and from the title bar
  await page.locator('.update-pill').click()
  await page.locator('.modal', { hasText: 'Restart to update?' }).waitFor()
  await page.getByRole('button', { name: 'Cancel' }).click()
  if (served !== 1) throw new Error('expected exactly one installer download, got ' + served)
  console.log('\n✅ update flow passed')
} catch (err) {
  failed = true
  console.error('\n❌ update flow failed:', err.message)
  try { await (await app.firstWindow()).screenshot({ path: path.join(shots, 'fail-update.png') }) } catch {}
} finally {
  await app?.close().catch(() => {})
  server.close()
  await testnet.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
  // Don't leave the 130 MB test download in %LOCALAPPDATA%
  if (!hadCache) fs.rmSync(cacheDir, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
