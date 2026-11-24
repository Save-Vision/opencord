// Backups: your identity (secret key, name, picture), your groups' keys and your friends, in one
// file locked with a password (scrypt + AES-256-GCM, see main/store.js). Messages aren't in it:
// after a restore they come back from friends, like on a new PC.
import { html, useState } from '../vendor/preact-htm.js'
import { api, model, act, fmtStamp } from '../lib/core.js'
import { shortKey } from '../lib/model.js'
import { Icon } from '../lib/icons.js'
import { Modal } from './modals.js'

const MIN_PASSWORD = 8

function strength (pw) {
  let s = 0
  if (pw.length >= 12) s++
  if (pw.length >= 16) s++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++
  if (/\d/.test(pw)) s++
  if (/[^\w\s]/.test(pw) || /\s/.test(pw.trim())) s++
  return pw.length < MIN_PASSWORD ? 0 : Math.min(3, 1 + Math.floor(s / 2))
}

export function AccountSettings () {
  const last = model.settings.lastBackup
  const groups = model.groupsList().length
  const friends = [...model.groups.values()].filter(g => g.dm).length
  return html`
    <h4>Your account</h4>
    <p class="hint">Your account is a key pair that lives only on this PC. There's no server to reset it from, so if this PC breaks or you reinstall Windows, a backup is the only way to keep your name, groups and friends.</p>
    <div class="account-box">
      <div><small>Public key</small><code class="mono" title=${model.me.key}>${shortKey(model.me.key)}</code></div>
      <div><small>Groups</small><b>${groups}</b></div>
      <div><small>Friends</small><b>${friends}</b></div>
      <div><small>Secret key on disk</small><b class=${model.me.sealed ? 'good' : 'warn'}>${model.me.sealed ? 'Encrypted' : 'Not encrypted'}</b></div>
    </div>
    <h4>Backup</h4>
    <div class="callout ${last ? '' : 'warn'}">
      <${Icon} name=${last ? 'check' : 'alert'} size=${18} />
      <span>${last ? `Last backup: ${fmtStamp(last)}. Make a new one after joining groups or adding friends.` : "You haven't made a backup yet."}</span>
    </div>
    <div class="row">
      <button class="btn primary" onClick=${() => model.openModal('backup')}><${Icon} name="archive" size=${16} /> Create backup…</button>
      <button class="btn" onClick=${() => model.openModal('restore')}><${Icon} name="upload" size=${16} /> Restore from backup…</button>
    </div>
    <p class="hint">The backup holds your secret key, profile, your groups' keys and your friends, locked with a password. Messages and files aren't in it: after a restore your app gets them again from friends when they're online.</p>`
}

export function BackupModal ({ testPath }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const s = strength(pw)
  const ok = pw.length >= MIN_PASSWORD && pw === pw2 && !busy
  const save = async () => {
    if (!ok) return
    setBusy(true)
    const file = await act(() => api.backupExport(pw, testPath), 'Backup failed')
    setBusy(false)
    if (file) {
      model.settings = { ...model.settings, lastBackup: Date.now() }
      model.closeModal()
      model.toast('Backup saved to ' + file)
    }
  }
  return html`
    <${Modal} title="Create a backup">
      <div class="modal-body">
        <p>Choose a password for the backup file. You'll need it to restore, and nobody can recover it for you.</p>
        <label>Password<input type="password" value=${pw} autoFocus autocomplete="new-password" onInput=${(e) => setPw(e.target.value)} /></label>
        <div class="pw-meter s${s}"><span /><span /><span /></div>
        <small class="hint">${pw.length < MIN_PASSWORD ? `At least ${MIN_PASSWORD} characters.` : ['', 'Okay. Longer is better: try a short sentence.', 'Good.', 'Strong.'][s]}</small>
        <label>Repeat password<input type="password" value=${pw2} autocomplete="new-password" onInput=${(e) => setPw2(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && save()} /></label>
        ${pw2 && pw !== pw2 && html`<p class="error-text">The passwords don't match.</p>`}
        <p class="hint">Keep the file somewhere other than this PC (a USB stick, cloud storage). It's useless without the password.</p>
      </div>
      <footer>
        <div class="spacer" />
        <button class="btn" onClick=${() => model.closeModal()}>Cancel</button>
        <button class="btn primary" disabled=${!ok} onClick=${save}>${busy ? 'Saving…' : 'Save backup…'}</button>
      </footer>
    <//>`
}

export function RestoreModal ({ testPath }) {
  const [file, setFile] = useState(null) // { path, name, key, created }
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const pick = async () => {
    setErr('')
    try {
      const f = await api.backupPick(testPath)
      if (f) setFile(f)
    } catch (e) { setErr(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
  }
  const restore = async () => {
    if (!file || !pw || busy) return
    setBusy(true)
    setErr('')
    try {
      await api.backupRestore(file.path, pw)
      model.toast('Restored. Restarting…')
    } catch (e) {
      setBusy(false)
      setErr(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  const same = file?.key === model.me.key
  const fresh = !model.me.name && !model.groups.size
  return html`
    <${Modal} title="Restore from a backup">
      <div class="modal-body">
        ${!file
          ? html`
            <p>Pick the backup file you saved (it ends in <code>.odbackup</code>).</p>
            <button class="btn primary" onClick=${pick}><${Icon} name="file" size=${16} /> Choose backup file…</button>`
          : html`
            <div class="backup-file">
              <${Icon} name="archive" size=${22} />
              <div><b>${file.name || 'Unnamed account'}</b><small class="mono">${shortKey(file.key)}${file.created ? ' · saved ' + fmtStamp(file.created) : ''}</small></div>
              <button class="btn sm" onClick=${() => { setFile(null); setPw('') }}>Change</button>
            </div>
            <label>Backup password<input type="password" value=${pw} autoFocus onInput=${(e) => setPw(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && restore()} /></label>
            ${!fresh && html`<p class="hint warn-text"><${Icon} name="alert" size=${13} /> ${same
              ? 'This is the account you use now. Restoring puts back the groups and friends from the backup.'
              : `This replaces the account on this PC (${model.me.name || 'unnamed'}). It isn't deleted: it's moved to a folder in the app's data folder.`}</p>`}
            <p class="hint">OpenDiscord restarts. Your messages come back from friends once they're online; until then, those chats are read-only.</p>`}
        ${err && html`<p class="error-text">${err}</p>`}
      </div>
      <footer>
        <div class="spacer" />
        <button class="btn" onClick=${() => model.closeModal()}>Cancel</button>
        ${file && html`<button class="btn primary" disabled=${!pw || busy} onClick=${restore}>${busy ? 'Restoring…' : 'Restore and restart'}</button>`}
      </footer>
    <//>`
}

// Shown once after starting with an account this PC couldn't unlock (copied data folder)
export function AccountNote () {
  const n = model.accountNote
  if (!n || n.kind !== 'locked' || model.ui.accountNoteSeen) return null
  return html`
    <div class="banner warn account-note">
      <${Icon} name="alert" size=${16} />
      <span>The account in this data folder was encrypted by another PC or Windows user, so it couldn't be opened here. It was moved aside (not deleted) and you start fresh. Restore a backup to get it back.</span>
      <button class="btn sm" onClick=${() => model.openModal('restore')}>Restore</button>
      <button class="icon-btn small" onClick=${() => { model.ui.accountNoteSeen = true; model.emit() }}><${Icon} name="x" size=${14} /></button>
    </div>`
}
