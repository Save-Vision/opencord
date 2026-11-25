// When apps are too far apart to sync (main/network.js compares protocol versions):
//  - this app is too old for a friend's: a screen that updates it (there's no way around it,
//    the friend's app won't take our messages)
//  - a friend's app is too old: a note in the chats you share, so you know why they're quiet
// Smaller version differences still work and only show up in profiles.
import { html, useEffect } from '../vendor/preact-htm.js'
import { api, model, act } from '../lib/core.js'
import { Icon } from '../lib/icons.js'
import { updateStatusText } from './updates.js'

export function cmpVersion (a, b) {
  const pa = String(a || '0').split(/[.-]/).map(n => parseInt(n, 10) || 0)
  const pb = String(b || '0').split(/[.-]/).map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}

const RELEASES = 'https://github.com/Save-Vision/opencord/releases/latest'

const names = (list) => {
  const out = []
  for (const c of list) {
    for (const gid of c.groups) {
      const g = model.groups.get(gid)
      if (g) { out.push(model.memberName(g, c.key)); break }
    }
  }
  return [...new Set(out)]
}

export function UpdateRequired () {
  const newer = model.compat.filter(c => c.reason === 'update-me')
  const u = model.update
  useEffect(() => {
    if (newer.length && u && u.supported && (u.status === 'latest' || u.status === 'error' || !u.status)) api.checkForUpdate().catch(() => {})
  }, [newer.length])
  if (!newer.length) return null
  const who = names(newer)
  const version = newer.map(c => c.version).filter(Boolean).sort(cmpVersion).pop()
  const busy = u?.status === 'checking' || u?.status === 'downloading' || u?.status === 'installing'
  return html`
    <div class="update-required">
      <div class="center-card">
        <div class="ur-icon"><${Icon} name="download" size=${34} /></div>
        <h1>Time to update</h1>
        <p>${who.length ? html`<b>${who.join(', ')}</b> ${who.length > 1 ? 'use' : 'uses'}` : 'A friend uses'} OpenDiscord ${version || 'a newer version'}, which this version (${model.version}) can't sync with anymore. Update to keep chatting.</p>
        ${u?.status === 'downloading' && html`<div class="ur-progress"><span style=${{ width: (u.percent || 0) + '%' }} /></div>`}
        <p class="muted">${updateStatusText(u)}</p>
        <div class="row center">
          ${u?.status === 'ready' || u?.status === 'available'
            ? html`<button class="btn primary lg" onClick=${() => act(() => api.installUpdate(), 'Update failed')}>${u.status === 'available' ? 'Download ' + u.version : 'Restart and update'}</button>`
            : html`<button class="btn primary lg" disabled=${busy || !u?.supported} onClick=${() => act(() => api.checkForUpdate())}>${busy ? 'Updating…' : 'Try again'}</button>`}
          ${(u?.status === 'error' || !u?.supported) && html`<button class="btn lg" onClick=${() => api.openExternal(RELEASES)}>Download from GitHub</button>`}
        </div>
      </div>
    </div>`
}

// In a chat: friends whose app is too old to sync with us
export function OutdatedBanner ({ g }) {
  const old = model.compat.filter(c => c.reason === 'update-them' && c.groups.includes(g.id))
  if (!old.length) return null
  const who = old.map(c => model.memberName(g, c.key))
  return html`
    <div class="banner warn">
      <${Icon} name="download" size=${16} />
      <span><b>${who.join(', ')}</b> ${who.length > 1 ? 'have' : 'has'} an old OpenDiscord${old[0].version ? ` (${old[0].version})` : ''} that can't sync with yours. Nothing you write reaches them until they update (their app does it on its own when it restarts).</span>
    </div>`
}

// "v0.5.2 · older than yours" for profiles
export function versionNote (info) {
  if (!info?.version) return null
  const d = cmpVersion(info.version, model.version)
  return { text: 'OpenDiscord ' + info.version, cls: d < 0 ? 'older' : d > 0 ? 'newer' : '', hint: d < 0 ? 'Older than yours. Some new things won\'t show up for them yet.' : d > 0 ? 'Newer than yours. Restart when an update is ready.' : '' }
}
