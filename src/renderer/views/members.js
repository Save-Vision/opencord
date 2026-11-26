// Member list, the private-chat profile panel, and the right-click menu for a person
// (friend actions, volume, and moderation: mute for everyone, move, disconnect, roles, kick).
import { html, useEffect, useRef, useLayoutEffect, useState } from '../vendor/preact-htm.js'
import { api, model, voice, act, append, saveSettings } from '../lib/core.js'
import { shortKey, DM_CALL } from '../lib/model.js'
import { Icon } from '../lib/icons.js'
import { Avatar, startDmCall } from './chat.js'
import { useNetStatus, hasProblem } from './nethealth.js'
import { addFriendByKey, acceptFriend, openDm, removeFriendFlow } from './friends.js'
import { versionNote } from './compat.js'
import { STATUS_LABEL } from '../lib/presence.js'

export function openMemberMenu (e, g, key) {
  e.preventDefault()
  e.stopPropagation()
  model.ui.menu = { gid: g.id, key, x: e.clientX, y: e.clientY }
  model.emit()
}

const closeMenu = () => { model.ui.menu = null; model.emit() }

// ---------------------------------------------------------------- moving people between voice channels

// The voice channel someone is in (null: none)
function voiceChannelOf (g, k) {
  if (k === model.me.key) return voice.active?.gid === g.id ? voice.active.ch : null
  return g.voice.get(k)?.ch || null
}

// Move someone to another voice channel (ch) or disconnect them (ch = null). Yourself: just switch.
// Their own app checks that you may (owner or admin, voice.onMove).
export function moveMember (g, k, ch) {
  if (k === model.me.key) {
    if (!ch) return voice.leave()
    const viewing = model.ui.stage?.gid === g.id
    return act(() => voice.join(g.id, ch.id)).then(() => {
      if (viewing && voice.inChannel(g.id, ch.id)) { model.ui.stage = { gid: g.id, ch: ch.id }; model.emit() }
    })
  }
  const name = model.memberName(g, k)
  api.sendEph(g.id, k, { type: 'move', ch: ch ? ch.id : null })
  model.toast(ch ? `Moved ${name} to ${ch.name}` : `Disconnected ${name}`)
}

// Drag a person (in the channel list or a call tile) onto another voice channel: yourself to
// switch channels, anyone else if you're the owner or an admin
let dragged = null // { gid, key }

const clearVoiceDrop = () => { for (const el of document.querySelectorAll('.voice-drop')) el.classList.remove('voice-drop') }

export function memberDragProps (g, k) {
  const me = k === model.me.key
  if (g.dm || g.kickedMe || (!me && !model.canModerate(g, model.me.key, k))) return {}
  return {
    draggable: true,
    onDragStart: (e) => {
      dragged = { gid: g.id, key: k }
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/od-member', k)
      e.stopPropagation()
    },
    onDragEnd: () => { dragged = null; clearVoiceDrop() }
  }
}

export function voiceDropProps (g, ch) {
  const ok = () => !!dragged && dragged.gid === g.id && !!voiceChannelOf(g, dragged.key) && voiceChannelOf(g, dragged.key) !== ch.id
  return {
    onDragOver: (e) => {
      if (!ok()) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (!e.currentTarget.classList.contains('voice-drop')) { clearVoiceDrop(); e.currentTarget.classList.add('voice-drop') }
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('voice-drop') },
    onDrop: (e) => {
      if (!ok()) return
      e.preventDefault()
      e.stopPropagation()
      const k = dragged.key
      dragged = null
      clearVoiceDrop()
      moveMember(g, k, ch)
    }
  }
}

export function RoleBadge ({ g, k }) {
  const r = model.roleOf(g, k)
  if (r === 'owner') return html`<span class="role owner" title="Group owner"><${Icon} name="crown" size=${13} /></span>`
  if (r === 'admin') return html`<span class="role admin" title="Admin: can mute, move and kick members"><${Icon} name="shieldPlain" size=${13} /></span>`
  return null
}

export function Members ({ g }) {
  const online = []
  const offline = []
  for (const m of model.membersOf(g)) {
    if (model.presence(g, m.key) !== 'offline') online.push(m)
    else offline.push(m)
  }
  if (!g.members.has(model.me.key) && model.presence(g, model.me.key) !== 'offline') online.unshift({ key: model.me.key })
  const rank = (k) => (k === g.owner ? 0 : g.admins.has(k) ? 1 : 2)
  const byName = (a, b) => rank(a.key) - rank(b.key) || model.memberName(g, a.key).localeCompare(model.memberName(g, b.key))
  online.sort(byName)
  offline.sort(byName)
  const row = (m, isOnline) => {
    const k = m.key
    const me = k === model.me.key
    const info = g.online.get(k)
    const vs = g.voice.get(k) || (me && voice.active?.gid === g.id ? { ch: voice.active.ch } : null)
    const vch = vs?.ch ? g.channels.get(vs.ch) : null
    const pres = model.presence(g, k)
    const sub = vch && isOnline
      ? html`<${Icon} name="speaker" size=${12} /> ${vch.name}`
      : me ? (pres === 'away' ? 'You · Away' : 'You') : !isOnline ? 'Offline' : pres === 'away' ? 'Away' : (info?.rtt != null ? `${info.rtt} ms · ${info.lan ? 'LAN' : 'direct'}` : 'Online')
    return html`
      <div key=${k} class="member ${isOnline ? '' : 'off'} ${pres === 'away' ? 'away' : ''}" title=${`${model.memberName(g, k)}\nKey ${k}\nClick for profile and options`}
        onClick=${(e) => openMemberMenu(e, g, k)} onContextMenu=${(e) => openMemberMenu(e, g, k)}>
        <${Avatar} name=${model.memberName(g, k)} color=${model.memberColor(g, k)} src=${model.memberAvatar(g, k)} size=${32} dot=${pres} speaking=${voice.speaking.has(k)} />
        <div><b style=${{ color: isOnline ? model.memberColor(g, k) : undefined }}>${model.memberName(g, k)}<${RoleBadge} g=${g} k=${k} /></b><small>${sub}</small></div>
      </div>`
  }
  return html`
    <aside class="members">
      <div class="section-head"><span>Online — ${online.length}</span></div>
      ${online.map(m => row(m, true))}
      ${offline.length > 0 && html`<div class="section-head"><span>Offline — ${offline.length}</span></div>`}
      ${offline.map(m => row(m, false))}
      ${g.online.size === 0 && html`<${ConnectionHint} g=${g} />`}
      <div class="p2p-note"><${Icon} name="shield" size=${14} /><span>Direct P2P · end-to-end encrypted · no servers</span></div>
    </aside>`
}

export function DmProfile ({ g }) {
  const k = g.dm
  const name = model.groupName(g)
  const info = g.online.get(k)
  const friend = model.isFriend(k)
  const inCall = g.voice.get(k)?.ch === DM_CALL
  const pres = model.presence(g, k)
  const ver = versionNote(info)
  return html`
    <aside class="members dm-profile">
      <div class="dm-card">
        <div class="dm-banner" style=${{ '--c': model.memberColor(g, k) }} />
        <${Avatar} name=${name} color=${model.memberColor(g, k)} src=${model.memberAvatar(g, k)} size=${84} dot=${pres} />
        <h3>${name}</h3>
        <small class="mono" title=${k}>${shortKey(k)}</small>
        <div class="dm-status">${pres !== 'offline' ? (pres === 'away' ? 'Away' : info?.rtt != null ? `Online · ${info.rtt} ms · ${info.lan ? 'same network' : 'direct'}` : 'Online') : friend ? 'Offline' : 'Friend request pending'}${inCall && pres !== 'offline' ? ' · in a call' : ''}</div>
        ${ver && pres !== 'offline' && html`<small class="pc-version ${ver.cls}" title=${ver.hint}>${ver.text}</small>`}
        <div class="dm-actions">
          <button class="btn primary" onClick=${() => startDmCall(g)}><${Icon} name="phone" size=${16} /> ${inCall && !voice.inChannel(g.id, DM_CALL) ? 'Join call' : 'Call'}</button>
          <button class="btn danger-ghost" onClick=${() => removeFriendFlow(k)}>${friend ? 'Remove friend' : 'Cancel request'}</button>
        </div>
      </div>
      ${!info && html`<${ConnectionHint} g=${g} />`}
      <div class="p2p-note"><${Icon} name="lock" size=${14} /><span>Only your two devices hold this chat's key</span></div>
    </aside>`
}

// Shown under the member list when nobody else is connected, so "where are my friends?"
// has an answer instead of an empty list.
export function ConnectionHint ({ g }) {
  const st = useNetStatus(5000)
  const gs = st?.groups?.[g.id]
  const bad = hasProblem(st) || (gs && gs.found > gs.connected)
  return html`
    <button class="conn-hint ${bad ? 'bad' : ''}" onClick=${() => model.openModal('settings', { tab: 'network' })}>
      <${Icon} name="signal" size=${14} />
      <span>${!st ? 'Checking connection…' : bad ? 'Connection problem — see why' : "Can't see your friends? Check connection"}</span>
    </button>`
}

function kickFlow (g, k) {
  const name = model.memberName(g, k)
  model.openModal('confirm', {
    title: `Kick ${name}?`,
    body: `${name} is disconnected right away and ${model.groupName(g)} switches to a new key, so any old invite code they have stops working. They keep the messages they already have. To let them back in later, send them a new invite link.`,
    confirm: 'Kick',
    danger: true,
    onConfirm: async () => {
      const op = await act(() => api.kick(g.id, k), 'Could not kick')
      if (!op) return
      model.applyOps(g.id, [op])
      if (voice.active?.gid === g.id) voice.onModeration()
      model.toast(`${name} was removed. The group has a new key.`)
    }
  })
}

export function MemberMenu () {
  const ref = useRef()
  const m = model.ui.menu
  const g = m && model.groups.get(m.gid)
  const [pos, setPos] = useState(null)
  const [moveOpen, setMoveOpen] = useState(false)
  useEffect(() => {
    if (!m) return
    setMoveOpen(false)
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) closeMenu() }
    const esc = (e) => { if (e.key === 'Escape') closeMenu() }
    setTimeout(() => document.addEventListener('mousedown', off), 0)
    window.addEventListener('keydown', esc)
    window.addEventListener('blur', closeMenu)
    return () => { document.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc); window.removeEventListener('blur', closeMenu) }
  }, [m])
  useLayoutEffect(() => {
    if (!m || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(m.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(m.y, window.innerHeight - r.height - 8)) })
  }, [m, moveOpen])
  if (!m || !g) return null

  const k = m.key
  const me = k === model.me.key
  const name = model.memberName(g, k)
  const role = model.roleOf(g, k)
  const mod = model.canModerate(g, model.me.key, k)
  const iAmOwner = g.owner === model.me.key
  const vs = g.voice.get(k)
  const inVoice = !!vs?.ch && g.channels.get(vs.ch)?.kind === 'voice'
  const serverMuted = model.isServerMuted(g, k)
  const localMuted = !!model.settings.localMutes?.[k]
  const vol = model.settings.volumes?.[k] ?? 1
  const dm = model.dmWith(k)
  const friend = model.isFriend(k)
  const incoming = model.friends.incoming.some(r => r.key === k)

  const item = (icon, label, fn, cls = '', disabled = false) => html`
    <button class=${cls} disabled=${disabled} onClick=${() => { closeMenu(); fn() }}><${Icon} name=${icon} size=${16} /><span>${label}</span></button>`
  const toggleLocalMute = async () => {
    await saveSettings({ localMutes: { ...model.settings.localMutes, [k]: !localMuted } })
    voice.applyOutputDevice()
  }
  const serverMute = async () => {
    await act(() => append(g.id, 'voice.mute', { key: k, on: !serverMuted }))
    voice.onModeration()
  }
  const setRole = async (r) => {
    const op = await act(() => api.setRole(g.id, k, r))
    if (op) { model.applyOps(g.id, [op]); model.toast(r === 'admin' ? `${name} is now an admin` : `${name} is no longer an admin`) }
  }
  const moveTo = (ch) => moveMember(g, k, ch)
  const targets = model.channelsOf(g, 'voice').filter(c => c.id !== vs?.ch)
  const pres = model.presence(g, k)
  const info = g.online.get(k)
  const ver = !me && pres !== 'offline' ? versionNote(info) : null
  const vch = vs?.ch && pres !== 'offline' ? g.channels.get(vs.ch) : null
  const shared = [...model.groups.values()].filter(x => x.id !== g.id && !x.dm && x.members.has(k) && !x.removed.has(k)).map(x => model.groupName(x))
  const readsClaude = me ? !!model.me.claude : !!g.members.get(k)?.claude

  return html`
    <div class="ctx-menu profile-menu" ref=${ref} style=${pos || { left: m.x + 'px', top: m.y + 'px', visibility: 'hidden' }} onContextMenu=${(e) => e.preventDefault()}>
      <div class="profile-card">
        <div class="pc-banner" style=${{ '--c': model.memberColor(g, k) }} />
        <${Avatar} name=${name} color=${model.memberColor(g, k)} src=${model.memberAvatar(g, k)} size=${64} dot=${pres} />
        <b class="pc-name">${name}${me ? ' (you)' : ''}</b>
        <small class="mono" title=${k}>${shortKey(k)}</small>
        <div class="pc-tags">
          <span class="pc-status ${pres}"><i class="presence ${pres}" /> ${STATUS_LABEL[pres]}</span>
          ${role !== 'member' && !g.dm && html`<span class="ctx-role ${role}"><${Icon} name=${role === 'owner' ? 'crown' : 'shieldPlain'} size=${12} /> ${role === 'owner' ? 'Owner' : 'Admin'}</span>`}
          ${vch && vch.kind === 'voice' && html`<span><${Icon} name="speaker" size=${12} /> ${vch.name}</span>`}
        </div>
        ${shared.length > 0 && html`<small class="pc-meta">Also in ${shared.slice(0, 3).join(', ')}${shared.length > 3 ? ` and ${shared.length - 3} more` : ''}</small>`}
        ${readsClaude && html`<small class="pc-meta"><${Icon} name="sparkle" size=${11} /> Lets Claude read ${me ? 'your' : 'their'} messages</small>`}
        ${ver && html`<small class="pc-version ${ver.cls}" title=${ver.hint}>${ver.text}${ver.cls === 'older' ? ' · older than yours' : ''}</small>`}
      </div>
      ${!me && html`
        <div class="ctx-group">
          ${friend
            ? item('at', 'Message', () => openDm(dm))
            : incoming
              ? item('userPlus', 'Accept friend request', () => acceptFriend(k))
              : dm
                ? item('check', 'Friend request sent', () => openDm(dm), '', false)
                : item('userPlus', 'Add friend', () => addFriendByKey(k, name))}
          ${friend && item('phone', 'Call', () => startDmCall(dm))}
        </div>
        <div class="ctx-group">
          <label class="ctx-volume" onClick=${(e) => e.stopPropagation()}>
            <span>User volume</span>
            <input type="range" min="0" max="1" step="0.05" value=${vol}
              onInput=${(e) => voice.setVolume(k, +e.target.value)}
              onChange=${(e) => saveSettings({ volumes: { ...model.settings.volumes, [k]: +e.target.value } })} />
          </label>
          ${item(localMuted ? 'speaker' : 'volumeX', localMuted ? 'Unmute for me' : 'Mute for me', toggleLocalMute)}
        </div>`}
      ${mod && html`
        <div class="ctx-group">
          ${item('micOff', serverMuted ? 'Unmute for everyone' : 'Mute for everyone', serverMute, serverMuted ? '' : 'warn')}
          ${inVoice && html`
            <button class="has-sub ${moveOpen ? 'open' : ''}" onClick=${() => setMoveOpen(!moveOpen)}><${Icon} name="arrowRight" size=${16} /><span>Move to</span><${Icon} name="chevronRight" size=${14} class="sub-arrow" /></button>
            ${moveOpen && html`<div class="ctx-sub">${targets.length ? targets.map(c => item('speaker', c.name, () => moveTo(c))) : html`<small class="muted">No other voice channels</small>`}</div>`}
            ${item('leave', 'Disconnect from voice', () => moveTo(null), 'warn')}`}
        </div>
        <div class="ctx-group">
          ${iAmOwner && (role === 'admin'
            ? item('shieldPlain', 'Remove admin', () => setRole('member'))
            : item('shieldPlain', 'Make admin', () => setRole('admin')))}
          ${item('userX', 'Kick ' + name, () => kickFlow(g, k), 'danger')}
        </div>`}
      <div class="ctx-group">
        ${item('copy', 'Copy key', () => { api.copy(k); model.toast('Key copied') })}
      </div>
    </div>`
}
