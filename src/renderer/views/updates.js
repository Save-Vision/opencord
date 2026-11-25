// Update notifications: the title-bar "Restart to update" button and the restart prompt.
// The main process (src/main/updater.js) does the checking, downloading and verifying.
import { html } from '../vendor/preact-htm.js'
import { api, model, voice, act } from '../lib/core.js'
import { Icon } from '../lib/icons.js'

export function initUpdates () {
  api.updateState().then((s) => { model.update = s; model.emit() }).catch(() => {})
  api.on('update', (s) => {
    const was = model.update?.status
    model.update = s
    if (s.status === 'ready' && was !== 'ready') model.toast(`OpenDiscord ${s.version} is ready. Restart when it suits you.`)
    if (s.status === 'available' && was !== 'available') model.toast(`OpenDiscord ${s.version} is out. Download it with the button at the top.`)
    model.emit()
  })
}

// On a Mac: download the new version's disk image, then drag it into Applications
export function downloadUpdate () {
  const u = model.update
  if (u?.status !== 'available') return
  model.openModal('confirm', {
    title: `Download OpenDiscord ${u.version}?`,
    body: 'Your browser downloads it. Open the downloaded file, drag OpenDiscord into Applications and choose Replace, then open it again. Your groups and messages stay where they are.',
    confirm: 'Download',
    onConfirm: () => act(() => api.installUpdate(), 'Could not open the download')
  })
}

export function restartForUpdate () {
  const u = model.update
  if (u?.status === 'available') return downloadUpdate()
  if (u?.status !== 'ready') return
  const parts = [`Version ${u.version} has been downloaded and verified. Restarting takes a few seconds`]
  parts[0] += voice.active ? ' and will drop you from the call.' : '.'
  if (u.portable) parts.push('You are using the portable version, so this installs OpenDiscord on this PC (no admin needed) and future updates install automatically. Afterwards, start it from the Start menu or the desktop shortcut instead of the portable file.')
  model.openModal('confirm', {
    title: 'Restart to update?',
    body: parts.join(' '),
    confirm: 'Restart now',
    onConfirm: () => act(() => api.installUpdate(), 'Update failed')
  })
}

export function UpdatePill () {
  const u = model.update
  if (u?.status !== 'ready' && u?.status !== 'available') return null
  return html`
    <button class="update-pill" title=${`Install OpenDiscord ${u.version}`} onClick=${restartForUpdate}>
      <${Icon} name="download" size=${13} /> ${u.status === 'available' ? 'Download update' : 'Restart to update'}
    </button>`
}

export function updateStatusText (u) {
  if (!u) return 'Checking…'
  if (!u.supported) return 'Automatic updates only work in the installed app. When running from source, use git pull.'
  switch (u.status) {
    case 'checking': return 'Checking for updates…'
    case 'latest': return 'You have the latest version.'
    case 'downloading': return `Downloading ${u.version}… ${u.percent || 0}%`
    case 'ready': return `Version ${u.version} is ready to install.`
    case 'available': return `Version ${u.version} is out. Download it and drag it into Applications.`
    case 'installing': return 'Installing…'
    case 'error': return `Couldn't check for updates: ${u.error}`
    default: return 'Not checked yet.'
  }
}
