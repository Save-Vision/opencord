import { html, render, useState, useEffect, useRef } from './vendor/preact-htm.js'
import { api, model, voice, useModel, act, initials, handleNewOps, onBlobProgress, retryMissingBlobs } from './lib/core.js'
import { shortKey, HOME, DM_CALL } from './lib/model.js'
import { Icon } from './lib/icons.js'
import { ChatView, Avatar, leaveGroupFlow } from './views/chat.js'
import { VoiceStage, participantsOf, connLabel, MuteIcons } from './views/stage.js'
import { Modals, ProfileEditor } from './views/modals.js'
import { NetworkHealth } from './views/nethealth.js'
import { initUpdates, UpdatePill } from './views/updates.js'
import { Members, DmProfile, MemberMenu, openMemberMenu } from './views/members.js'
import { HomeSidebar, FriendsPage, CallBanner, homeUnread, openDm } from './views/friends.js'

// ---------------------------------------------------------------- shell

function App () {
  useModel()
  const g = model.currentGroup()
  const home = model.ui.gid === HOME || !!g?.dm
  const stage = model.ui.stage && g && model.ui.stage.gid === g.id ? g.channels.get(model.ui.stage.ch) : null
  const ch = g ? model.currentChannel(g) : null

  useEffect(() => {
    let total = 0
    for (const grp of model.groups.values()) total += model.groupUnread(grp).count
    total += model.friends.incoming.length
    document.title = (total ? `(${total}) ` : '') + 'OpenDiscord' + (model.profile ? ` · ${model.profile}` : '')
    api.setUnread(total)
  })

  if (!model.me.name) return html`<${TitleBar} /><${Onboarding} /><${Toasts} />`

  const footer = html`${voice.active && voice.active.gid && html`<${VoicePanel} />`}<${UserPanel} />`
  return html`
    <${TitleBar} g=${g} home=${home} />
    <div class="app">
      <${Rail} home=${home} />
      ${home
        ? html`<${HomeSidebar} g=${g} footer=${footer} />`
        : g ? html`<${Sidebar} g=${g} ch=${ch} stage=${stage} footer=${footer} />` : html`<aside class="sidebar"><div class="channels" />${footer}</aside>`}
      <main class="main">
        ${home && !g
          ? html`<${FriendsPage} />`
          : !g
            ? html`<${Welcome} />`
            : stage && !stage.deleted
              ? html`<${VoiceStage} g=${g} ch=${stage} />`
              : ch
                ? html`<${ChatView} g=${g} ch=${ch} />`
                : html`<${Syncing} g=${g} />`}
      </main>
      ${g && !stage && (g.dm ? html`<${DmProfile} g=${g} />` : html`<${Members} g=${g} />`)}
    </div>
    <${CallBanner} />
    <${MemberMenu} />
    <${Modals} />
    <${Toasts} />`
}

function TitleBar ({ g, home }) {
  return html`
    <div class="titlebar ${model.platform}">
      <div class="brand"><span class="logo-dot" />OpenDiscord${model.profile && html`<span class="profile-tag">${model.profile}</span>`}</div>
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
      ${groups.length > 0 && html`<div class="rail-sep" />`}
      <div class="rail-item">
        <button class="rail-btn add" title="Create or join a group" onClick=${() => model.openModal('addGroup')}><${Icon} name="plus" size=${22} /></button>
      </div>
    </nav>`
}

function GroupMenu ({ g, onClose }) {
  const ref = useRef()
  useEffect(() => {
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    setTimeout(() => document.addEventListener('mousedown', off), 0)
    return () => document.removeEventListener('mousedown', off)
  }, [])
  const item = (icon, label, fn, cls = '') => html`<button class=${cls} onClick=${() => { onClose(); fn() }}><span>${label}</span><${Icon} name=${icon} size=${16} /></button>`
  return html`
    <div class="dropdown" ref=${ref}>
      ${item('userPlus', 'Invite people', () => model.openModal('invite', { gid: g.id }), 'accent')}
      ${item('hash', 'Create text channel', () => model.openModal('channel', { gid: g.id, kind: 'text' }))}
      ${item('speaker', 'Create voice channel', () => model.openModal('channel', { gid: g.id, kind: 'voice' }))}
      ${item('edit', 'Rename group', () => model.openModal('renameGroup', { gid: g.id }))}
      ${item('image', 'Change group picture', () => model.openModal('groupIcon', { gid: g.id }))}
      <hr />
      ${item('leave', 'Leave group', () => leaveGroupFlow(g), 'danger')}
    </div>`
}

function Sidebar ({ g, ch, stage, footer }) {
  const [menu, setMenu] = useState(false)
  const text = model.channelsOf(g, 'text')
  const voiceChs = model.channelsOf(g, 'voice')
  const openText = (c) => { model.ui.stage = null; model.selectChannel(g.id, c.id) }
  const openVoice = (c) => {
    model.ui.stage = { gid: g.id, ch: c.id }
    model.emit()
    if (!voice.inChannel(g.id, c.id) && !g.kickedMe) act(() => voice.join(g.id, c.id))
  }
  const edit = (e, c) => { e.stopPropagation(); model.openModal('channel', { gid: g.id, chId: c.id }) }
  return html`
    <aside class="sidebar">
      <header class="group-header" onClick=${() => setMenu(!menu)}>
        ${g.icon && html`<img class="gh-icon" src=${g.icon} alt="" />`}
        <h1>${model.groupName(g)}</h1>
        <${Icon} name=${menu ? 'x' : 'chevronDown'} size=${18} />
      </header>
      ${menu && html`<${GroupMenu} g=${g} onClose=${() => setMenu(false)} />`}
      <div class="channels">
        <button class="invite-cta" onClick=${() => model.openModal('invite', { gid: g.id })}><${Icon} name="userPlus" size=${16} /> Invite friends</button>
        <div class="section-head"><span>Text channels</span><button class="icon-btn small" title="Create text channel" onClick=${() => model.openModal('channel', { gid: g.id, kind: 'text' })}><${Icon} name="plus" size=${16} /></button></div>
        ${text.map((c) => {
          const u = model.unread(g, c.id)
          const active = !stage && ch?.id === c.id
          return html`
            <button key=${c.id} class="channel ${active ? 'active' : ''} ${u.count ? 'unread' : ''}" onClick=${() => openText(c)}>
              <${Icon} name="hash" size=${18} class="dim" /><span class="ch-name">${c.name}</span>
              ${u.mentions > 0 && html`<span class="badge">${u.mentions}</span>`}
              <span class="ch-edit" title="Edit channel" onClick=${(e) => edit(e, c)}><${Icon} name="settings" size=${14} /></span>
            </button>`
        })}
        <div class="section-head"><span>Voice channels</span><button class="icon-btn small" title="Create voice channel" onClick=${() => model.openModal('channel', { gid: g.id, kind: 'voice' })}><${Icon} name="plus" size=${16} /></button></div>
        ${voiceChs.map((c) => {
          const keys = participantsOf(g, c.id)
          return html`
            <div key=${c.id}>
              <button class="channel ${stage?.id === c.id ? 'active' : ''} ${voice.inChannel(g.id, c.id) ? 'connected' : ''}" onClick=${() => openVoice(c)}>
                <${Icon} name="speaker" size=${18} class="dim" /><span class="ch-name">${c.name}</span>
                <span class="ch-edit" title="Edit channel" onClick=${(e) => edit(e, c)}><${Icon} name="settings" size=${14} /></span>
              </button>
              ${keys.map((k) => {
                const me = k === model.me.key
                const st = me ? voice.statePayload() : g.voice.get(k) || {}
                return html`
                  <div key=${k} class="voice-user ${voice.speaking.has(k) ? 'speaking' : ''}" onContextMenu=${(e) => openMemberMenu(e, g, k)} title="Right-click for options">
                    <${Avatar} name=${model.memberName(g, k)} color=${model.memberColor(g, k)} src=${model.memberAvatar(g, k)} size=${22} speaking=${voice.speaking.has(k)} />
                    <span class="vu-name">${model.memberName(g, k)}</span>
                    ${st.screen && html`<span class="live">LIVE</span>`}
                    ${st.cam && html`<${Icon} name="camera" size=${14} class="dim" />`}
                    <${MuteIcons} g=${g} k=${k} st=${st} />
                  </div>`
              })}
            </div>`
        })}
      </div>
      ${footer}
    </aside>`
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
        <div class="vp-status ${failed ? 'bad' : connecting ? 'warn' : 'good'}" title=${calls.map(x => model.memberName(g, x.key) + ': ' + connLabel(x).text).join('\n') || 'Nobody else here yet'}>
          <${Icon} name="signal" size=${16} />
          <div><b>${status}</b><small>${where}${rtt != null ? ` · ${rtt} ms` : ''}</small></div>
        </div>
        <button class="icon-btn" title="Disconnect" onClick=${() => voice.leave()}><${Icon} name="leave" size=${18} /></button>
      </div>
      ${voice.serverMuted && html`<div class="vp-note"><${Icon} name="micOff" size=${13} /> A moderator muted you</div>`}
      <div class="vp-actions">
        <button class="btn ${voice.local.cam ? 'on' : ''}" onClick=${() => voice.toggleCamera()} title="Camera"><${Icon} name=${voice.local.cam ? 'camera' : 'cameraOff'} size=${18} /></button>
        <button class="btn ${voice.local.screen ? 'on' : ''}" onClick=${() => voice.local.screen ? voice.stopScreen() : model.openModal('screen')} title=${voice.local.screen ? 'Stop sharing' : 'Share screen'}><${Icon} name="screenUp" size=${18} /></button>
        <button class="btn" onClick=${open} title="Open call view"><${Icon} name="maximize" size=${18} /></button>
      </div>
    </div>`
}

function UserPanel () {
  const me = model.me
  return html`
    <div class="user-panel">
      <${Avatar} name=${me.name} color=${me.color} src=${me.avatar} size=${34} dot="online" speaking=${voice.speaking.has(me.key)} />
      <div class="up-name" title=${'Public key ' + me.key}><b>${me.name}</b><small>${shortKey(me.key)}</small></div>
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
      <div class="hero-mark"><span /><span /><span /></div>
      <h1>Hey ${model.me.name}!</h1>
      <p>Create a group for you and your friends, join one with an invite code, or add a friend for private chats and calls. Everything goes straight from device to device — no accounts, no servers, no upload limits.</p>
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
        <div class="hero-mark"><span /><span /><span /></div>
        <h1>Welcome to OpenDiscord</h1>
        <p>Your identity is a key pair that was just generated on this device. Pick a name your friends will see.</p>
        <${ProfileEditor} cta="Continue" />
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
  model.platform = init.platform
  model.profile = init.profile
  model.version = init.version
  model.setFriends(init.friends)
  document.body.classList.add('platform-' + init.platform)
  for (const g of init.groups) model.addGroup(g)
  for (const p of init.peers) for (const gid of p.groups) model.peerJoin(gid, p.key, p)

  api.on('ops', (gid, ops) => {
    if (!model.groups.has(gid)) return
    const fresh = model.applyOps(gid, ops)
    handleNewOps(gid, fresh)
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
    }
  })
  api.on('blob-progress', onBlobProgress)
  api.on('focus-change', (f) => { model.ui.focused = f; model.emit() })
  api.on('hotkey', (action) => {
    if (action === 'toggle-mute') voice.toggleMute()
    if (action === 'toggle-deafen') voice.toggleDeafen()
  })
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); voice.toggleMute() }
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); model.openModal('settings') }
  })
  window.addEventListener('beforeunload', () => voice.leave(true))
  window.__od = { model, voice } // handy for poking around in DevTools (Ctrl+Shift+I)

  render(html`<${App} />`, document.getElementById('root'))
}

boot().catch((err) => {
  console.error(err)
  document.getElementById('root').textContent = 'Failed to start: ' + err.message
})
