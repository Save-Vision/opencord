import { html, render, useState, useEffect, useRef } from './vendor/preact-htm.js'
import { api, model, voice, useModel, act, initials, handleNewOps, onBlobProgress, retryMissingBlobs } from './lib/core.js'
import { shortKey } from './lib/model.js'
import { Icon } from './lib/icons.js'
import { ChatView, Avatar } from './views/chat.js'
import { VoiceStage, participantsOf, connLabel } from './views/stage.js'
import { Modals, ProfileEditor } from './views/modals.js'

// ---------------------------------------------------------------- shell

function App () {
  useModel()
  const g = model.currentGroup()
  const stage = model.ui.stage && g && model.ui.stage.gid === g.id ? g.channels.get(model.ui.stage.ch) : null
  const ch = g ? model.currentChannel(g) : null

  useEffect(() => {
    let total = 0
    for (const grp of model.groups.values()) total += model.groupUnread(grp).count
    document.title = (total ? `(${total}) ` : '') + 'OpenDiscord' + (model.profile ? ` · ${model.profile}` : '')
    api.setUnread(total)
  })

  if (!model.me.name) return html`<${TitleBar} /><${Onboarding} /><${Toasts} />`

  return html`
    <${TitleBar} g=${g} />
    <div class="app">
      <${Rail} />
      ${g ? html`<${Sidebar} g=${g} ch=${ch} stage=${stage} />` : html`<aside class="sidebar"><div class="channels" /><${UserPanel} /></aside>`}
      <main class="main">
        ${!g
          ? html`<${Welcome} />`
          : stage && !stage.deleted
            ? html`<${VoiceStage} g=${g} ch=${stage} />`
            : ch
              ? html`<${ChatView} g=${g} ch=${ch} />`
              : html`<${Syncing} g=${g} />`}
      </main>
      ${g && !stage && html`<${Members} g=${g} />`}
    </div>
    <${Modals} />
    <${Toasts} />`
}

function TitleBar ({ g }) {
  return html`
    <div class="titlebar ${model.platform}">
      <div class="brand"><span class="logo-dot" />OpenDiscord${model.profile && html`<span class="profile-tag">${model.profile}</span>`}</div>
      <div class="title-center">${g ? model.groupName(g) : ''}</div>
    </div>`
}

function Rail () {
  const groups = [...model.groups.values()].sort((a, b) => a.joinedAt - b.joinedAt)
  const cur = model.ui.gid
  return html`
    <nav class="rail">
      ${groups.map((g) => {
        const u = model.groupUnread(g)
        const name = model.groupName(g)
        return html`
          <div key=${g.id} class="rail-item ${g.id === cur ? 'active' : ''} ${u.count ? 'unread' : ''}">
            <span class="pill" />
            <button class="rail-btn" title=${name} onClick=${() => { model.ui.stage = null; model.selectGroup(g.id) }}>
              ${initials(name)}
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
      <hr />
      ${item('leave', 'Leave group', () => model.openModal('confirm', {
        title: `Leave ${model.groupName(g)}?`,
        body: 'This deletes the group and its history from this device. You can rejoin later with an invite code, and history will sync back from your friends.',
        confirm: 'Leave group',
        danger: true,
        onConfirm: async () => {
          if (voice.active?.gid === g.id) voice.leave()
          await act(() => api.leaveGroup(g.id))
          model.removeGroup(g.id)
        }
      }), 'danger')}
    </div>`
}

function Sidebar ({ g, ch, stage }) {
  const [menu, setMenu] = useState(false)
  const text = model.channelsOf(g, 'text')
  const voiceChs = model.channelsOf(g, 'voice')
  const openText = (c) => { model.ui.stage = null; model.selectChannel(g.id, c.id) }
  const openVoice = (c) => {
    model.ui.stage = { gid: g.id, ch: c.id }
    model.emit()
    if (!voice.inChannel(g.id, c.id)) act(() => voice.join(g.id, c.id))
  }
  const edit = (e, c) => { e.stopPropagation(); model.openModal('channel', { gid: g.id, chId: c.id }) }
  return html`
    <aside class="sidebar">
      <header class="group-header" onClick=${() => setMenu(!menu)}>
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
                  <div key=${k} class="voice-user ${voice.speaking.has(k) ? 'speaking' : ''}">
                    <${Avatar} name=${model.memberName(g, k)} color=${model.memberColor(g, k)} size=${22} speaking=${voice.speaking.has(k)} />
                    <span class="vu-name">${model.memberName(g, k)}</span>
                    ${st.screen && html`<span class="live">LIVE</span>`}
                    ${st.cam && html`<${Icon} name="camera" size=${14} class="dim" />`}
                    ${st.deaf ? html`<${Icon} name="headphonesOff" size=${14} class="bad" />` : st.muted ? html`<${Icon} name="micOff" size=${14} class="bad" />` : null}
                  </div>`
              })}
            </div>`
        })}
      </div>
      ${voice.active && voice.active.gid && html`<${VoicePanel} />`}
      <${UserPanel} />
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
  const status = failed ? 'Some peers unreachable' : connecting ? 'Connecting…' : 'Voice connected'
  return html`
    <div class="voice-panel">
      <div class="vp-row">
        <div class="vp-status ${failed ? 'bad' : connecting ? 'warn' : 'good'}" title=${calls.map(x => model.memberName(g, x.key) + ': ' + connLabel(x).text).join('\n') || 'Nobody else here yet'}>
          <${Icon} name="signal" size=${16} />
          <div><b>${status}</b><small>${c?.name || 'Voice'} / ${model.groupName(g)}${rtt != null ? ` · ${rtt} ms` : ''}</small></div>
        </div>
        <button class="icon-btn" title="Disconnect" onClick=${() => voice.leave()}><${Icon} name="leave" size=${18} /></button>
      </div>
      <div class="vp-actions">
        <button class="btn ${voice.local.cam ? 'on' : ''}" onClick=${() => voice.toggleCamera()} title="Camera"><${Icon} name=${voice.local.cam ? 'camera' : 'cameraOff'} size=${18} /></button>
        <button class="btn ${voice.local.screen ? 'on' : ''}" onClick=${() => voice.local.screen ? voice.stopScreen() : model.openModal('screen')} title=${voice.local.screen ? 'Stop sharing' : 'Share screen'}><${Icon} name="screenUp" size=${18} /></button>
        <button class="btn" onClick=${() => { model.ui.stage = { gid: voice.active.gid, ch: voice.active.ch }; model.selectGroup(voice.active.gid) }} title="Open call view"><${Icon} name="maximize" size=${18} /></button>
      </div>
    </div>`
}

function UserPanel () {
  const me = model.me
  return html`
    <div class="user-panel">
      <${Avatar} name=${me.name} color=${me.color} size=${34} dot="online" speaking=${voice.speaking.has(me.key)} />
      <div class="up-name" title=${'Public key ' + me.key}><b>${me.name}</b><small>${shortKey(me.key)}</small></div>
      <button class="icon-btn ${voice.muted ? 'bad' : ''}" title=${voice.muted ? 'Unmute' : 'Mute'} onClick=${() => voice.toggleMute()}><${Icon} name=${voice.muted ? 'micOff' : 'mic'} size=${18} /></button>
      <button class="icon-btn ${voice.deafened ? 'bad' : ''}" title=${voice.deafened ? 'Undeafen' : 'Deafen'} onClick=${() => voice.toggleDeafen()}><${Icon} name=${voice.deafened ? 'headphonesOff' : 'headphones'} size=${18} /></button>
      <button class="icon-btn" title="Settings" onClick=${() => model.openModal('settings')}><${Icon} name="settings" size=${18} /></button>
    </div>`
}

function Members ({ g }) {
  const online = []
  const offline = []
  for (const m of g.members.values()) {
    if (m.key === model.me.key || g.online.has(m.key)) online.push(m)
    else offline.push(m)
  }
  if (!g.members.has(model.me.key)) online.unshift({ key: model.me.key })
  const byName = (a, b) => model.memberName(g, a.key).localeCompare(model.memberName(g, b.key))
  online.sort(byName)
  offline.sort(byName)
  const row = (m, isOnline) => {
    const k = m.key
    const me = k === model.me.key
    const info = g.online.get(k)
    const vs = g.voice.get(k) || (me && voice.active?.gid === g.id ? { ch: voice.active.ch } : null)
    const vch = vs?.ch ? g.channels.get(vs.ch) : null
    const sub = vch
      ? html`<${Icon} name="speaker" size=${12} /> ${vch.name}`
      : me ? 'You' : isOnline ? (info?.rtt != null ? `${info.rtt} ms · ${info.lan ? 'LAN' : 'direct'}` : 'Online') : 'Offline'
    return html`
      <div key=${k} class="member ${isOnline ? '' : 'off'}" title=${`${model.memberName(g, k)}\nKey ${k}`}>
        <${Avatar} name=${model.memberName(g, k)} color=${model.memberColor(g, k)} size=${32} dot=${isOnline ? 'online' : 'offline'} speaking=${voice.speaking.has(k)} />
        <div><b style=${{ color: isOnline ? model.memberColor(g, k) : undefined }}>${model.memberName(g, k)}</b><small>${sub}</small></div>
      </div>`
  }
  return html`
    <aside class="members">
      <div class="section-head"><span>Online — ${online.length}</span></div>
      ${online.map(m => row(m, true))}
      ${offline.length > 0 && html`<div class="section-head"><span>Offline — ${offline.length}</span></div>`}
      ${offline.map(m => row(m, false))}
      <div class="p2p-note"><${Icon} name="shield" size=${14} /><span>Direct P2P · end-to-end encrypted · no servers</span></div>
    </aside>`
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
    </div>`
}

function Welcome () {
  return html`
    <div class="center-card welcome">
      <div class="hero-mark"><span /><span /><span /></div>
      <h1>Hey ${model.me.name}!</h1>
      <p>Create a group for you and your friends, or join one with an invite code. Everything goes straight from device to device — no accounts, no servers, no upload limits.</p>
      <div class="row center">
        <button class="btn primary lg" onClick=${() => model.openModal('addGroup', { tab: 'create' })}>Create a group</button>
        <button class="btn lg" onClick=${() => model.openModal('addGroup', { tab: 'join' })}>Join with invite</button>
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

// ---------------------------------------------------------------- boot

async function boot () {
  const init = await api.init()
  model.me = init.me
  model.settings = init.settings
  model.platform = init.platform
  model.profile = init.profile
  document.body.classList.add('platform-' + init.platform)
  for (const g of init.groups) model.addGroup(g)
  for (const p of init.peers) for (const gid of p.groups) model.peerJoin(gid, p.key, p)

  api.on('ops', (gid, ops) => {
    if (!model.groups.has(gid)) return
    const fresh = model.applyOps(gid, ops)
    handleNewOps(gid, fresh)
  })
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
  api.on('eph', (gid, from, d) => {
    switch (d.type) {
      case 'voice':
        model.setVoiceState(gid, from, d)
        voice.onRemoteVoiceState(gid, from, d)
        break
      case 'typing':
        model.setTyping(gid, d.ch, from)
        break
      case 'rtc':
        voice.onRtc(gid, from, d)
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
