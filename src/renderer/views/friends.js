// Friends and private chats. A friendship is a private two-person "group" whose key comes
// from a key exchange between your identities (see main/crypto.js dmSecret). Requests go
// straight from your app to theirs; nothing stores them in between.
import { html, useState, useEffect } from '../vendor/preact-htm.js'
import { api, model, voice, act } from '../lib/core.js'
import { DM_CALL, DM_TEXT, shortKey } from '../lib/model.js'
import { playTone } from '../lib/voice.js'
import { Icon } from '../lib/icons.js'
import { Avatar, startDmCall } from './chat.js'

export function openDm (g) {
  if (!g) return
  model.ui.stage = null
  model.selectGroup(g.id)
  model.selectChannel(g.id, DM_TEXT)
}

function added (r, name) {
  model.addGroup(r)
  const key = model.groups.get(r.id)?.dm
  model.toast(key && model.isFriend(key) ? `You and ${name || model.knownName(key)} are friends now` : `Friend request sent${name ? ' to ' + name : ''}`)
}

export async function addFriendByKey (key, name) {
  const r = await act(() => api.addFriend(key, name), 'Could not add friend')
  if (r) added(r, name)
  return r
}

export async function addFriendByCode (code) {
  const r = await act(() => api.addFriend(code.trim(), ''), 'Could not add friend')
  if (!r) return null
  if (r.existed) model.toast('Already in your friends list')
  else added(r, r.nameHint)
  return r
}

export async function acceptFriend (key) {
  const r = await act(() => api.acceptFriend(key), 'Could not accept')
  if (!r) return
  model.addGroup(r)
  openDm(model.groups.get(r.id))
  model.toast(`You and ${model.knownName(key) || 'your friend'} are friends now`)
}

export async function declineFriend (key) {
  await act(() => api.declineFriend(key))
}

export function removeFriendFlow (key) {
  const g = model.dmWith(key)
  const name = model.knownName(key) || 'this friend'
  const friend = model.isFriend(key)
  model.openModal('confirm', {
    title: friend ? `Remove ${name}?` : `Cancel your friend request to ${name}?`,
    body: friend
      ? 'This deletes your private chat with them from this device. You stay in any groups you share. You can add each other again later.'
      : 'Their app may already have the request. If they accept later, nothing happens unless you add them again.',
    confirm: friend ? 'Remove friend' : 'Cancel request',
    danger: true,
    onConfirm: async () => {
      if (g && voice.active?.gid === g.id) voice.leave()
      await act(() => api.removeFriend(key))
      if (g) model.removeGroup(g.id)
    }
  })
}

export const friendsList = () => model.dmsList().filter(g => model.isFriend(g.dm))

export function homeUnread () {
  let n = model.friends.incoming.length
  for (const g of model.dmsList()) n += model.unread(g, DM_TEXT).count
  return n
}

function dmStatus (g) {
  const k = g.dm
  if (!model.isFriend(k)) return 'Friend request sent'
  if (voice.inChannel(g.id, DM_CALL)) return 'In a call with you'
  if (g.voice.get(k)?.ch === DM_CALL) return 'Calling…'
  return g.online.has(k) ? 'Online' : 'Offline'
}

export function HomeSidebar ({ g, footer }) {
  const dms = model.dmsList()
  const reqs = model.friends.incoming.length
  return html`
    <aside class="sidebar home">
      <header class="group-header static"><h1>Friends & chats</h1></header>
      <div class="channels">
        <button class="channel nav ${!g ? 'active' : ''}" onClick=${() => model.openHome()}>
          <${Icon} name="users" size=${18} class="dim" /><span class="ch-name">Friends</span>
          ${reqs > 0 && html`<span class="badge">${reqs}</span>`}
        </button>
        <div class="section-head"><span>Private chats</span><button class="icon-btn small" title="Add a friend" onClick=${() => { model.ui.friendsTab = 'add'; model.openHome() }}><${Icon} name="plus" size=${16} /></button></div>
        ${dms.map((d) => {
          const k = d.dm
          const u = model.unread(d, DM_TEXT)
          const online = d.online.has(k)
          return html`
            <button key=${d.id} class="dm-item ${g?.id === d.id ? 'active' : ''} ${u.count ? 'unread' : ''} ${model.isFriend(k) ? '' : 'pending'}" onClick=${() => openDm(d)}>
              <${Avatar} name=${model.groupName(d)} color=${model.memberColor(d, k)} src=${model.memberAvatar(d, k)} size=${32} dot=${online ? 'online' : 'offline'} speaking=${voice.speaking.has(k)} />
              <div class="dm-meta"><b>${model.groupName(d)}</b><small>${dmStatus(d)}</small></div>
              ${u.count > 0 && html`<span class="badge">${u.count}</span>`}
              ${(d.voice.get(k)?.ch === DM_CALL || voice.inChannel(d.id, DM_CALL)) && html`<${Icon} name="phone" size=${14} class="good" />`}
            </button>`
        })}
        ${!dms.length && html`<p class="side-note">Add a friend to chat and call privately, outside any group.</p>`}
      </div>
      ${footer}
    </aside>`
}

function FriendRow ({ g }) {
  const k = g.dm
  const name = model.groupName(g)
  return html`
    <div class="friend-row" onClick=${() => openDm(g)}>
      <${Avatar} name=${name} color=${model.memberColor(g, k)} src=${model.memberAvatar(g, k)} size=${36} dot=${g.online.has(k) ? 'online' : 'offline'} />
      <div class="fr-meta"><b>${name}</b><small>${dmStatus(g)}</small></div>
      <div class="fr-actions" onClick=${(e) => e.stopPropagation()}>
        <button class="round-btn" title="Message" onClick=${() => openDm(g)}><${Icon} name="at" size=${18} /></button>
        <button class="round-btn" title="Call" onClick=${() => startDmCall(g)}><${Icon} name="phone" size=${18} /></button>
        <button class="round-btn danger" title="Remove friend" onClick=${() => removeFriendFlow(k)}><${Icon} name="userX" size=${18} /></button>
      </div>
    </div>`
}

function AddFriend () {
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const mine = model.friends.code
  const copy = async () => { await api.copy(mine); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  const send = async () => {
    setBusy(true)
    const r = await addFriendByCode(code)
    setBusy(false)
    if (r) { setCode(''); model.ui.friendsTab = 'pending'; model.emit() }
  }
  const valid = /^ODF1-[A-Za-z0-9_-]{20,}$/.test(code.trim()) || /^[0-9a-f]{64}$/i.test(code.trim())
  return html`
    <div class="add-friend">
      <h3>Add a friend</h3>
      <p class="muted">Swap friend codes, then one of you adds the other. Their app gets the request directly from yours as soon as you're both online.</p>
      <label>Your friend code</label>
      <div class="invite-box"><code class="mono">${mine}</code><button class="btn primary" onClick=${copy}><${Icon} name=${copied ? 'check' : 'copy'} size=${16} /> ${copied ? 'Copied' : 'Copy'}</button></div>
      <label>Friend's code</label>
      <div class="row add-row">
        <input class="mono" value=${code} placeholder="ODF1-…" onInput=${(e) => setCode(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && valid && send()} />
        <button class="btn primary" disabled=${!valid || busy} onClick=${send}>Send friend request</button>
      </div>
      ${code.trim().startsWith('OD1-') && html`<p class="warn-text">That's a group invite, not a friend code. Use the + in the left bar to join a group.</p>`}
      <div class="callout">
        <${Icon} name="shield" size=${16} />
        <div>A friend code is your public key and name. It's safe to share: it lets people send you friend requests, but they can't read anything. You can also add people from any group you share: click their name in the member list.</div>
      </div>
    </div>`
}

export function FriendsPage () {
  const friends = friendsList()
  const { incoming, outgoing } = model.friends
  const tab = model.ui.friendsTab || (incoming.length ? 'pending' : friends.length ? 'online' : 'add')
  const setTab = (t) => { model.ui.friendsTab = t; model.emit() }
  const online = friends.filter(g => g.online.has(g.dm))
  const list = tab === 'online' ? online : friends
  return html`
    <section class="chat friends-page">
      <header class="chat-header">
        <${Icon} name="users" size=${22} class="dim" />
        <h2>Friends</h2>
        <div class="friends-tabs">
          <button class=${tab === 'online' ? 'active' : ''} onClick=${() => setTab('online')}>Online</button>
          <button class=${tab === 'all' ? 'active' : ''} onClick=${() => setTab('all')}>All</button>
          <button class=${tab === 'pending' ? 'active' : ''} onClick=${() => setTab('pending')}>Pending${incoming.length > 0 && html`<span class="badge">${incoming.length}</span>`}</button>
          <button class="add ${tab === 'add' ? 'active' : ''}" onClick=${() => setTab('add')}>Add friend</button>
        </div>
      </header>
      <div class="friends-body">
        ${tab === 'add' && html`<${AddFriend} />`}
        ${(tab === 'online' || tab === 'all') && html`
          <div class="section-head"><span>${tab === 'online' ? 'Online' : 'All friends'} — ${list.length}</span></div>
          ${list.map(g => html`<${FriendRow} key=${g.id} g=${g} />`)}
          ${!list.length && html`
            <div class="friends-empty">
              <${Icon} name="users" size=${44} />
              <p>${friends.length ? 'None of your friends are online right now.' : 'No friends yet. Share your friend code to get started.'}</p>
              ${!friends.length && html`<button class="btn primary" onClick=${() => setTab('add')}>Add a friend</button>`}
            </div>`}`}
        ${tab === 'pending' && html`
          <div class="section-head"><span>Incoming — ${incoming.length}</span></div>
          ${incoming.map(r => html`
            <div key=${r.key} class="friend-row">
              <${Avatar} name=${r.name || '?'} color=${r.color || '#8b93a1'} size=${36} />
              <div class="fr-meta"><b>${r.name || 'Someone'}</b><small class="mono">Wants to be your friend · ${shortKey(r.key)}</small></div>
              <div class="fr-actions">
                <button class="round-btn good" title="Accept" onClick=${() => acceptFriend(r.key)}><${Icon} name="check" size=${18} /></button>
                <button class="round-btn danger" title="Decline" onClick=${() => declineFriend(r.key)}><${Icon} name="x" size=${18} /></button>
              </div>
            </div>`)}
          ${!incoming.length && html`<p class="side-note">No incoming requests.</p>`}
          <div class="section-head"><span>Sent — ${outgoing.length}</span></div>
          ${outgoing.map(r => html`
            <div key=${r.key} class="friend-row">
              <${Avatar} name=${r.name || model.knownName(r.key) || '?'} color=${model.memberColor(null, r.key)} src=${model.memberAvatar(null, r.key)} size=${36} />
              <div class="fr-meta"><b>${r.name || model.knownName(r.key) || 'Friend ' + r.key.slice(0, 4)}</b><small>Waiting for them to accept. Delivered as soon as they're online.</small></div>
              <div class="fr-actions">
                <button class="round-btn danger" title="Cancel request" onClick=${() => removeFriendFlow(r.key)}><${Icon} name="x" size=${18} /></button>
              </div>
            </div>`)}
          ${!outgoing.length && html`<p class="side-note">No requests waiting.</p>`}`}
      </div>
    </section>`
}

// A friend is in your private call and you aren't: ring until you answer or decline.
export function CallBanner () {
  const dismissed = model.ui.dismissedCalls || (model.ui.dismissedCalls = new Set())
  const ringing = model.dmsList().filter((d) => {
    const st = d.voice.get(d.dm)
    return st?.ch === DM_CALL && !voice.inChannel(d.id, DM_CALL) && !dismissed.has(d.id + ':' + st.sid)
  })
  const on = ringing.length > 0
  useEffect(() => {
    if (!on) return
    playTone('ring')
    const t = setInterval(() => playTone('ring'), 2200)
    return () => clearInterval(t)
  }, [on])
  if (!on) return null
  const d = ringing[0]
  const name = model.groupName(d)
  return html`
    <div class="call-banner">
      <${Avatar} name=${name} color=${model.memberColor(d, d.dm)} src=${model.memberAvatar(d, d.dm)} size=${44} speaking />
      <div><b>${name}</b><small>is calling you…</small></div>
      <button class="round-btn good" title="Accept" onClick=${() => startDmCall(d)}><${Icon} name="phone" size=${20} /></button>
      <button class="round-btn danger" title="Decline" onClick=${() => { dismissed.add(d.id + ':' + d.voice.get(d.dm).sid); model.emit() }}><${Icon} name="x" size=${20} /></button>
    </div>`
}
