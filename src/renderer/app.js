import { html, render, useEffect, useState, useRef } from './vendor/preact-htm.js'
import { api, model, voice, music, useModel, initials, handleNewOps, onBlobProgress, retryMissingBlobs } from './lib/core.js'
import { shortKey, HOME, DM_CALL } from './lib/model.js'
import { CALL_ID } from './lib/calls.js'
import { Icon } from './lib/icons.js'
import { loadClaudeInfo } from './lib/claude.js'
import { ChatView, Avatar, ThreadPanel } from './views/chat.js'
import { PlannerView, startReminders } from './views/planner.js'
import { VoiceStage, viewersOf, connLabel } from './views/stage.js'
import { Modals, ProfileEditor } from './views/modals.js'
import { NetworkHealth } from './views/nethealth.js'
import { initUpdates, UpdatePill } from './views/updates.js'
import { Members, DmProfile, MemberMenu } from './views/members.js'
import { HomeSidebar, FriendsPage, CallBanner, homeUnread, openDm } from './views/friends.js'
import { Sidebar } from './views/sidebar.js'
import { GamesView, notifyGameOps } from './views/games.js'
import { startChessBot } from './lib/chessbotplay.js'
import { SearchPanel } from './views/search.js'
import { UpdateRequired } from './views/compat.js'
import { AccountNote } from './views/account.js'
import { SoundboardButton, onRemoteSound } from './views/soundboard.js'
import { announceStatus, setMyStatus, startPresence, STATUS_LABEL } from './lib/presence.js'
import { startPoker } from './lib/pokerplay.js'
import { applyTheme, themeInfo, watchSystemMode } from './lib/themes.js'
import { Logo } from './lib/logo.js'
import { setIconStyle } from './lib/icons.js'
import { DockLayout } from './views/dock.js'
import { DocsView, FocusEditor } from './views/focus.js'
import { setMac, mod } from './lib/keys.js'
import { cleanMusic } from './lib/music.js'
import { MusicButton, MusicPanel } from './views/music.js'

// ---------------------------------------------------------------- shell

function App () {
  useModel()
  const theme = applyTheme(model.settings)
  setIconStyle(themeInfo(theme).icons)
  document.documentElement.dataset.focus = model.ui.focused === false ? 'off' : 'on'
  const g = model.currentGroup()
  const home = model.ui.gid === HOME || !!g?.dm
  const stage = model.ui.stage && g && model.ui.stage.gid === g.id ? g.channels.get(model.ui.stage.ch) : null
  const ch = g ? model.currentChannel(g) : null
  // Apps the group doesn't have (lib/apps.js) aren't shown, except a game opened from its card
  const games = !stage && g && model.ui.games?.gid === g.id && (!!model.ui.games.id || model.appOn(g, 'games'))
  const docsUi = !stage && !games && g && model.ui.docs?.gid === g.id && model.appOn(g, 'docs') ? model.ui.docs : null
  const focusDoc = docsUi?.id ? g.docs.get(docsUi.id) : null
  const planner = !stage && !games && !docsUi && g && model.ui.planner?.gid === g.id && model.appOn(g, model.ui.planner.tab)
  document.documentElement.classList.toggle('focus-on', !!focusDoc)
  const thread = !stage && !planner && g && model.ui.thread?.gid === g.id
  const search = !stage && !planner && g && model.ui.search?.gid === g.id
  // A board has its chat in the thread next to it; the games list has nothing on the side
  const side = g && !stage && !planner && !(games && !model.ui.games.id)

  useEffect(() => {
    let total = 0
    for (const grp of model.groups.values()) total += model.groupUnread(grp).count
    total += model.friends.incoming.length
    document.title = (total ? `(${total}) ` : '') + 'OpenDiscord' + (model.profile ? ` · ${model.profile}` : '')
    api.setUnread(total)
  })

  if (!model.me.name) return html`<${Backdrop} /><${TitleBar} /><${Onboarding} /><${Modals} /><${Toasts} />`

  const footer = html`${voice.active && voice.active.gid && html`<${VoicePanel} />`}<${UserPanel} />`
  const blocks = {
    rail: html`<${Rail} home=${home} />`,
    nav: home
        ? html`<${HomeSidebar} g=${g} footer=${footer} />`
        : g ? html`<${Sidebar} g=${g} ch=${ch} stage=${stage} footer=${footer} />` : html`<aside class="sidebar"><div class="channels" />${footer}</aside>`,
    main: html`
      <main class="main">
        <${AccountNote} />
        ${home && !g
          ? html`<${FriendsPage} />`
          : !g
            ? html`<${Welcome} />`
            : stage && !stage.deleted
              ? html`<${VoiceStage} g=${g} ch=${stage} />`
              : games
                ? html`<${GamesView} g=${g} />`
                : docsUi
                ? html`<${DocsView} g=${g} />`
                : planner
                ? html`<${PlannerView} g=${g} />`
                : ch
                  ? html`<${ChatView} g=${g} ch=${ch} />`
                  : html`<${Syncing} g=${g} />`}
      </main>`,
    side: search
      ? html`<${SearchPanel} g=${g} />`
      : side && (thread ? html`<${ThreadPanel} key=${model.ui.thread.id} g=${g} />` : g.dm ? html`<${DmProfile} g=${g} />` : html`<${Members} g=${g} />`)
  }
  return html`
    <${Backdrop} />
    <${TitleBar} g=${g} home=${home} />
    <${DockLayout} blocks=${blocks} />
    ${focusDoc && !model.docDeleted(g, focusDoc) && html`<${FocusEditor} key=${focusDoc.id} g=${g} doc=${focusDoc} />`}
    <${CallBanner} />
    <${MemberMenu} />
    <${MusicPanel} />
    <${Modals} />
    <${UpdateRequired} />
    <${Toasts} />`
}

// The moving colours behind the Glass theme's frosted panels (hidden in the other themes).
// Four soft blobs that only move with transforms, so the GPU does the work; paused when the
// window is in the background, switched off in Settings > Appearance or by reduced motion.
function Backdrop () {
  return html`<div class="backdrop" aria-hidden="true"><i /><i /><i /><i /></div>`
}

function TitleBar ({ g, home }) {
  return html`
    <div class="titlebar ${model.platform}">
      <div class="brand"><${Logo} size=${18} />OpenDiscord${model.profile && html`<span class="profile-tag">${model.profile}</span>`}</div>
      <div class="title-center">${g ? (g.dm ? '@' + model.groupName(g) : model.groupName(g)) : home ? 'Friends' : ''}</div>
      <div class="title-right"><${UpdatePill} /></div>
    </div>`
}

export function GroupIcon ({ g, size = 48 }) {
  const name = model.groupName(g)
  return g.icon
    ? html`<img class="group-icon" src=${g.icon} alt="" draggable="false" style=${{ width: size + 'px', height: size + 'px' }} />`
    : html`<span class="group-initials">${initials(name)}</span>`
}

function Rail ({ home }) {
  const groups = model.groupsList()
  const cur = model.ui.gid
  const hu = homeUnread()
  const inDmCall = voice.active && model.groups.get(voice.active.gid)?.dm
  return html`
    <nav class="rail">
      <div class="rail-item ${home ? 'active' : ''} ${hu ? 'unread' : ''}">
        <span class="pill" />
        <button class="rail-btn home" title="Friends & private chats" onClick=${() => model.openHome()}>
          <${Icon} name="users" size=${24} />
          ${hu > 0 && html`<span class="badge">${hu}</span>`}
          ${inDmCall && html`<span class="rail-voice"><${Icon} name="phone" size=${10} /></span>`}
        </button>
      </div>
      <div class="rail-sep" />
      ${groups.map((g) => {
        const u = model.groupUnread(g)
        const name = model.groupName(g)
        return html`
          <div key=${g.id} class="rail-item ${g.id === cur ? 'active' : ''} ${u.count ? 'unread' : ''}">
            <span class="pill" />
            <button class="rail-btn ${g.icon ? 'has-img' : ''}" title=${name} onClick=${() => { model.ui.stage = null; model.selectGroup(g.id) }}>
              <${GroupIcon} g=${g} />
              ${u.mentions > 0 && html`<span class="badge">${u.mentions}</span>`}
              ${voice.active?.gid === g.id && html`<span class="rail-voice"><${Icon} name="speaker" size=${11} /></span>`}
            </button>
          </div>`
      })}
      ${model.joins.filter(j => !model.groups.has(j.gid)).map(j => html`
        <div key=${'j' + j.id} class="rail-item joining">
          <button class="rail-btn" title=${`Joining ${j.name || 'a group'}… someone from the group needs to be online`} onClick=${() => model.openModal('addGroup', { tab: 'join' })}>
            <span class="group-initials">${initials(j.name || '?')}</span>
            <span class="rail-spin" />
          </button>
        </div>`)}
      ${groups.length > 0 && html`<div class="rail-sep" />`}
      <div class="rail-item">
        <button class="rail-btn add" title="Create or join a group" onClick=${() => model.openModal('addGroup')}><${Icon} name="plus" size=${22} /></button>
      </div>
    </nav>`
}

function VoicePanel () {
  const g = model.groups.get(voice.active.gid)
  const c = g?.channels.get(voice.active.ch)
  const calls = [...voice.calls.values()]
  const connecting = calls.some(x => x.state !== 'connected' && x.state !== 'failed')
  const failed = calls.some(x => x.state === 'failed')
  const rtts = calls.map(x => x.stats?.rtt).filter(x => x != null)
  const rtt = rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null
  const status = failed ? 'Some peers unreachable' : connecting ? 'Connecting…' : g?.dm && !calls.length ? 'Ringing…' : 'Voice connected'
  const where = g?.dm ? 'Call with ' + model.groupName(g) : `${c?.name || 'Voice'} / ${model.groupName(g)}`
  const open = () => {
    model.ui.stage = { gid: voice.active.gid, ch: voice.active.ch }
    model.selectGroup(voice.active.gid)
  }
  return html`
    <div class="voice-panel">
      <div class="vp-row">
        <button class="vp-status ${failed ? 'bad' : connecting ? 'warn' : 'good'}" onClick=${open} title=${'Open the call\n' + (calls.map(x => model.memberName(g, x.key) + ': ' + connLabel(x).text).join('\n') || 'Nobody else here yet')}>
          <${Icon} name="signal" size=${16} />
          <div><b>${status}</b><small>${where}${rtt != null ? ` · ${rtt} ms` : ''}</small></div>
        </button>
        <button class="icon-btn" title="Disconnect" onClick=${() => voice.leave()}><${Icon} name="leave" size=${18} /></button>
      </div>
      ${voice.serverMuted && html`<div class="vp-note"><${Icon} name="micOff" size=${13} /> A moderator muted you</div>`}
      ${voice.local.screen && g && html`<${StreamWatchers} g=${g} />`}
      ${voice.local.screen && voice.screenBlack && html`<button class="vp-note warn" onClick=${() => model.openModal('screenBlack')}><${Icon} name="alert" size=${13} /> Your share looks black · what helps</button>`}
      <div class="vp-actions">
        <button class="btn ${voice.local.cam ? 'on' : ''}" onClick=${() => voice.toggleCamera()} title="Camera"><${Icon} name=${voice.local.cam ? 'camera' : 'cameraOff'} size=${18} /></button>
        <button class="btn ${voice.local.screen ? 'on' : ''}" onClick=${() => voice.local.screen ? voice.stopScreen() : model.openModal('screen')} title=${voice.local.screen ? 'Stop sharing' : 'Share screen'}><${Icon} name="screenUp" size=${18} /></button>
        ${g && !g.dm && html`<${SoundboardButton} g=${g} />`}
        ${g && html`<${MusicButton} g=${g} />`}
        <button class="btn" onClick=${open} title="Open call view"><${Icon} name="maximize" size=${18} /></button>
      </div>
    </div>`
}

// While you share: who is watching
function StreamWatchers ({ g }) {
  const keys = viewersOf(g, voice.active.ch, model.me.key)
  return html`
    <div class="vp-note watchers" title=${keys.map(k => model.memberName(g, k)).join(', ')}>
      <${Icon} name="eye" size=${13} />
      ${keys.length ? html`<span>${keys.length <= 3 ? keys.map(k => model.memberName(g, k)).join(', ') : keys.length + ' people'} watching your stream</span>` : html`<span>Nobody is watching your stream yet</span>`}
    </div>`
}

function StatusMenu ({ onClose }) {
  const ref = useRef()
  useEffect(() => {
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    const esc = (e) => { if (e.key === 'Escape') onClose() }
    setTimeout(() => document.addEventListener('mousedown', off), 0)
    window.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc) }
  }, [])
  const cur = model.settings.status || 'online'
  const opt = (s, hint) => html`
    <button class=${cur === s ? 'active' : ''} onClick=${() => { onClose(); setMyStatus(s) }}>
      <i class="presence ${s === 'invisible' ? 'offline' : s}" />
      <div><b>${STATUS_LABEL[s]}</b><small>${hint}</small></div>
      ${cur === s && html`<${Icon} name="check" size=${14} />`}
    </button>`
  return html`
    <div class="status-menu" ref=${ref}>
      ${opt('online', Number(model.settings.autoAway) ? `Away after ${model.settings.autoAway} min without input` : 'Always online')}
      ${opt('away', "Friends see you're not at your PC")}
      ${opt('invisible', "You look offline but can still chat")}
      <button class="status-profile" onClick=${() => { onClose(); model.openModal('settings', { tab: 'profile' }) }}><${Icon} name="settings" size=${14} /><span>Edit profile</span></button>
    </div>`
}

function UserPanel () {
  const me = model.me
  const [menu, setMenu] = useState(false)
  const pres = model.presence(null, me.key)
  const st = model.myStatus()
  return html`
    <div class="user-panel">
      ${menu && html`<${StatusMenu} onClose=${() => setMenu(false)} />`}
      <button class="up-me" title="Set your status" onClick=${() => setMenu(!menu)}>
        <${Avatar} name=${me.name} color=${me.color} src=${me.avatar} size=${34} dot=${pres} speaking=${voice.speaking.has(me.key)} />
        <div class="up-name" title=${'Public key ' + me.key}><b>${me.name}</b><small>${st === 'online' ? shortKey(me.key) : STATUS_LABEL[st] + (st === 'away' && model.settings.status !== 'away' ? ' (idle)' : '')}</small></div>
      </button>
      <button class="icon-btn ${voice.muted || voice.serverMuted ? 'bad' : ''}" title=${voice.serverMuted ? 'Muted by a moderator' : voice.muted ? 'Unmute' : 'Mute'} onClick=${() => voice.toggleMute()}><${Icon} name=${voice.muted || voice.serverMuted ? 'micOff' : 'mic'} size=${18} /></button>
      <button class="icon-btn ${voice.deafened ? 'bad' : ''}" title=${voice.deafened ? 'Undeafen' : 'Deafen'} onClick=${() => voice.toggleDeafen()}><${Icon} name=${voice.deafened ? 'headphonesOff' : 'headphones'} size=${18} /></button>
      <button class="icon-btn" title="Settings" onClick=${() => model.openModal('settings')}><${Icon} name="settings" size=${18} /></button>
    </div>`
}

function Syncing ({ g }) {
  const online = g.online.size
  return html`
    <div class="center-card">
      <div class="spinner" />
      <h2>${online ? 'Syncing history…' : 'Waiting for a friend'}</h2>
      <p>${online
        ? 'Receiving channels and messages directly from your friends.'
        : `You've joined ${model.groupName(g)}. There's no server holding the history, so it will appear as soon as someone in the group is online.`}</p>
      ${!online && html`<${NetworkHealth} gid=${g.id} />`}
    </div>`
}

function Welcome () {
  return html`
    <div class="center-card welcome">
      <div class="hero-logo"><${Logo} size=${76} title="OpenDiscord" /></div>
      <h1>Hey ${model.me.name}!</h1>
      <p>Create a group for you and your friends, join one with an invite link, or add a friend for private chats and calls. Everything goes straight from device to device — no accounts, no servers, no upload limits.</p>
      <div class="row center">
        <button class="btn primary lg" onClick=${() => model.openModal('addGroup', { tab: 'create' })}>Create a group</button>
        <button class="btn lg" onClick=${() => model.openModal('addGroup', { tab: 'join' })}>Join with invite</button>
        <button class="btn lg" onClick=${() => { model.ui.friendsTab = 'add'; model.openHome() }}>Add a friend</button>
      </div>
    </div>`
}

function Onboarding () {
  return html`
    <div class="onboarding">
      <div class="center-card">
        <div class="hero-logo"><${Logo} size=${76} title="OpenDiscord" /></div>
        <h1>Welcome to OpenDiscord</h1>
        <p>Your identity is a key pair that was just generated on this device. Pick a name your friends will see.</p>
        <${ProfileEditor} cta="Continue" />
        <p class="hint onboarding-restore">Used OpenDiscord before? <a onClick=${() => model.openModal('restore')}>Restore from a backup</a></p>
      </div>
    </div>`
}

function Toasts () {
  return html`<div class="toasts">${model.ui.toasts.map(t => html`<div key=${t.id} class="toast ${t.kind}">${t.text}</div>`)}</div>`
}

function notifyCall (g) {
  api.attention()
  if (!model.settings.notifications) return
  try {
    const n = new Notification(`${model.groupName(g)} is calling you`, { body: 'Open OpenDiscord to answer', icon: model.memberAvatar(g, g.dm) || undefined })
    n.onclick = () => { api.showWindow(); openDm(g) }
  } catch {}
}

// ---------------------------------------------------------------- boot

async function boot () {
  const init = await api.init()
  model.me = init.me
  model.settings = init.settings
  applyTheme(model.settings)
  model.platform = init.platform
  setMac(init.platform === 'darwin')
  model.profile = init.profile
  model.version = init.version
  model.compat = init.compat || []
  model.accountNote = init.accountNote || null
  model.forceRelay = !!init.forceRelay
  model.setFriends(init.friends)
  model.setJoins(init.joins)
  document.body.classList.add('platform-' + init.platform)
  for (const g of init.groups) model.addGroup(g)
  for (const p of init.peers) for (const gid of p.groups) model.peerJoin(gid, p.key, p)
  if (init.link) setTimeout(() => model.openModal('openLink', { url: init.link }), 300)

  // A one-time invite was accepted, or someone opened our friend link
  api.on('group-added', (payload, info) => {
    const isNew = !model.groups.has(payload.id)
    model.addGroup(payload)
    const g = model.groups.get(payload.id)
    if (info?.joined && isNew) {
      model.ui.stage = null
      model.selectGroup(g.id)
      model.toast(`You joined ${model.groupName(g)}!`)
    } else if (g.dm && isNew) {
      model.toast(`You and ${model.groupName(g)} are friends now`)
    }
  })
  api.on('group-removed', (gid) => model.removeGroup(gid))
  api.on('joins', (list) => model.setJoins(list))
  api.on('notice', (n) => model.toast(n.text, n.kind))
  api.on('compat', (list) => { model.compat = list || []; model.emit() })
  api.on('open-link', (url) => model.openModal('openLink', { url }))

  api.on('ops', (gid, ops) => {
    if (!model.groups.has(gid)) return
    const fresh = model.applyOps(gid, ops)
    handleNewOps(gid, fresh)
    notifyGameOps(api, gid, fresh)
    if (fresh.some(op => op.k === 'voice.mute' || op.k === 'member.role' || op.k === 'member.kick')) voice.onModeration()
  })
  api.on('membership', (gid, info) => {
    model.setMembership(gid, info)
    if (info?.kickedMe && voice.active?.gid === gid) {
      voice.leave()
      model.toast(`You were removed from ${model.groupName(model.groups.get(gid))}`, 'error')
    }
    voice.onModeration()
  })
  api.on('friends', (f) => model.setFriends(f))
  api.on('peer-join', (gid, key, info) => {
    model.peerJoin(gid, key, info)
    retryMissingBlobs()
    voice.onPeerOnline(gid, key)
    announceStatus(gid, key)
  })
  api.on('peer-leave', (gid, key) => {
    model.peerLeave(gid, key)
    voice.onPeerOffline(gid, key)
  })
  api.on('peer-update', (info) => model.peerUpdate(info))
  initUpdates()
  api.on('eph', (gid, from, d) => {
    switch (d.type) {
      case 'voice': {
        const g = model.groups.get(gid)
        const was = g?.voice.get(from)?.ch
        d.music = cleanMusic(d.music)
        d.call = typeof d.call === 'string' && CALL_ID.test(d.call) ? d.call : null
        d.black = d.black === true
        model.setVoiceState(gid, from, d)
        voice.onRemoteVoiceState(gid, from, d)
        if (g?.dm === from && d.ch === DM_CALL && was !== DM_CALL && !voice.inChannel(gid, DM_CALL)) notifyCall(g)
        break
      }
      case 'typing':
        model.setTyping(gid, d.ch, from)
        break
      case 'rtc':
        voice.onRtc(gid, from, d)
        break
      case 'move':
        voice.onMove(gid, from, d)
        break
      case 'music':
        music.onRequest(gid, from, d)
        break
      case 'claude':
        model.setClaudeDraft(gid, from, d)
        break
      case 'status':
        model.setStatus(from, d.s)
        break
      case 'sound':
        onRemoteSound(gid, from, d)
        break
      case 'doc':
        model.setDocPresence(gid, from, d)
        break
    }
  })
  api.on('blob-progress', onBlobProgress)
  api.on('focus-change', (f) => { model.ui.focused = f; model.emit() })
  api.on('hotkey', (action) => {
    if (action === 'toggle-mute') voice.toggleMute()
    if (action === 'toggle-deafen') voice.toggleDeafen()
  })
  // Escape with a dropdown's list open only closes that list (not the window or menu it's in)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    let open = false
    try { open = !!document.querySelector('select:open') } catch {}
    if (open) e.stopImmediatePropagation()
  }, true)
  window.addEventListener('keydown', (e) => {
    if (mod(e) && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); voice.toggleMute() }
    if (mod(e) && e.key === ',') { e.preventDefault(); model.openModal('settings') }
    if (mod(e) && !e.shiftKey && e.key.toLowerCase() === 'f' && model.me?.name && !model.ui.modal) { e.preventDefault(); model.openSearch(model.ui.search?.q || '') }
  })
  window.addEventListener('beforeunload', () => voice.leave(true))
  window.__od = { model, voice, music } // handy for poking around in DevTools (Ctrl+Shift+I)
  startReminders({ api })
  loadClaudeInfo()
  startPresence()
  startPoker()
  startChessBot()
  watchSystemMode(() => model.emit())

  render(html`<${App} />`, document.getElementById('root'))
}

boot().catch((err) => {
  console.error(err)
  document.getElementById('root').textContent = 'Failed to start: ' + err.message
})
