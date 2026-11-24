import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js'
import { api, model, voice, act, append, rid, saveSettings, blobUrl, COLORS, fmtRate, fmtBytes, initials, cleanErr } from '../lib/core.js'
import { MAX_FOLDER_DEPTH } from '../lib/model.js'
import { loadClaudeInfo } from '../lib/claude.js'
import { SCREEN_PRESETS, playTone } from '../lib/voice.js'
import { getMic, stopMic, noiseMode, isDenoised } from '../lib/denoise.js'
import { extOf } from '../lib/highlight.js'
import { Icon } from '../lib/icons.js'
import { Avatar, CodeView, MarkdownView, useBlobText } from './chat.js'
import { participantsOf } from './stage.js'
import { NetworkHealth } from './nethealth.js'
import { AvatarCropper, useImagePicker } from './avatar.js'
import { restartForUpdate, updateStatusText } from './updates.js'
import { EventModal, TaskModal } from './planner.js'
import { addFriendByCode } from './friends.js'
import { NewGameModal } from './games.js'
import { PollModal } from './polls.js'
import { AddSoundModal } from './soundboard.js'
import { BackupModal, RestoreModal, AccountSettings } from './account.js'
import { folderOptions, folderFits } from './sidebar.js'
import { THEMES, normalizeTheme, themeInfo } from '../lib/themes.js'
import { normalizeLayout, sameOrder, DEFAULT_ORDER } from '../lib/layout.js'
import { BLOCK_LABEL, resetLayout } from './dock.js'

export function Modal ({ title, children, wide = false, onClose = () => model.closeModal() }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])
  return html`
    <div class="modal-backdrop" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-label=${title}>
        <header><h3>${title}</h3><button class="icon-btn" onClick=${onClose} title="Close"><${Icon} name="x" /></button></header>
        ${children}
      </div>
    </div>`
}

export function Modals () {
  const m = model.ui.modal
  if (!m) return null
  const C = {
    addGroup: AddGroupModal,
    invite: InviteModal,
    channel: ChannelModal,
    renameGroup: RenameGroupModal,
    confirm: ConfirmModal,
    settings: SettingsModal,
    screen: ScreenPickerModal,
    image: ImageModal,
    groupIcon: GroupIconModal,
    textFile: TextFileModal,
    event: EventModal,
    task: TaskModal,
    openLink: OpenLinkModal,
    folder: FolderModal,
    newGame: NewGameModal,
    groupClaude: GroupClaudeModal,
    poll: PollModal,
    addSound: AddSoundModal,
    backup: BackupModal,
    restore: RestoreModal
  }[m.name]
  return C ? html`<${C} ...${m.props} />` : null
}

// ---------------------------------------------------------------- links & invites

const INVITE_TTLS = [[3600e3, '1 hour'], [864e5, '1 day'], [7 * 864e5, '7 days'], [30 * 864e5, '30 days']]
const isJoinLink = (s) => /^opendiscord:\/\/join\/[A-Za-z0-9_-]{100,}\/?$/i.test(s.trim())
const isFriendLink = (s) => /^opendiscord:\/\/friend\/[A-Za-z0-9_-]{80,}\/?$/i.test(s.trim())

// The readable parts of a link (the name inside it), for the confirmation screen
function peekLink (url) {
  try {
    const m = /^opendiscord:\/\/(join|friend)\/([A-Za-z0-9_-]+)/i.exec(url.trim())
    const bin = atob(m[2].replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0))
    const kind = m[1].toLowerCase()
    const at = kind === 'join' ? 85 : 65
    const name = new TextDecoder().decode(bytes.slice(at))
    const exp = kind === 'join' ? (((bytes[81] << 24) >>> 0) + (bytes[82] << 16) + (bytes[83] << 8) + bytes[84]) * 1000 : 0
    return { kind, name, exp }
  } catch { return null }
}

export function fmtExpiry (exp) {
  if (!exp) return 'never expires'
  const ms = exp - Date.now()
  if (ms <= 0) return 'expired'
  if (ms < 3600e3) return `expires in ${Math.max(1, Math.round(ms / 60000))} min`
  if (ms < 864e5) return `expires in ${Math.round(ms / 3600e3)} h`
  return `expires in ${Math.round(ms / 864e5)} days`
}

// Join a group with a one-time link (or an old OD1 code). Returns true when done or pending.
export async function joinWithLink (code) {
  const r = await act(() => api.joinGroup(code))
  if (!r) return false
  if (r.pending) {
    model.toast(`Waiting for someone from ${r.join.name || 'the group'} to let you in…`)
    return true
  }
  model.addGroup(r)
  model.selectGroup(r.id)
  model.toast(r.existed ? "You're already in this group" : 'Joined! History syncs as soon as a friend in the group is online.')
  return true
}

// Shown when an opendiscord:// link is clicked (in chat, or in another app)
function OpenLinkModal ({ url }) {
  const info = peekLink(url)
  const [busy, setBusy] = useState(false)
  if (!info) {
    return html`<${Modal} title="Link not recognized"><div class="modal-body"><p>This OpenDiscord link is damaged. Ask for a new one.</p></div><footer><button class="btn" onClick=${() => model.closeModal()}>Close</button></footer><//>`
  }
  const go = async () => {
    setBusy(true)
    const ok = info.kind === 'join' ? await joinWithLink(url) : await addFriendByCode(url)
    setBusy(false)
    if (ok) model.closeModal()
    if (ok && info.kind === 'friend') { model.ui.friendsTab = 'pending'; model.openHome() }
  }
  const expired = info.exp && info.exp < Date.now()
  return html`
    <${Modal} title=${info.kind === 'join' ? 'Group invite' : 'Friend link'}>
      <div class="modal-body link-card">
        <div class="intro-icon big"><${Icon} name=${info.kind === 'join' ? 'users' : 'userPlus'} size=${36} /></div>
        ${info.kind === 'join'
          ? html`<h2>Join ${info.name || 'this group'}?</h2><p class="hint">You'll be let in by whoever from the group is online. This link works once.${info.exp ? ' It ' + fmtExpiry(info.exp) + '.' : ''}</p>`
          : html`<h2>Add ${info.name || 'this person'} as a friend?</h2><p class="hint">You'll be friends right away. This link works once.</p>`}
        ${expired && html`<p class="hint warn-text">This link has expired. Ask for a new one.</p>`}
      </div>
      <footer>
        <button class="btn" onClick=${() => model.closeModal()}>Cancel</button>
        <button class="btn primary" disabled=${busy || expired} onClick=${go}>${info.kind === 'join' ? 'Join group' : 'Add friend'}</button>
      </footer>
    <//>`
}

// ---------------------------------------------------------------- groups

export function AddGroupModal ({ tab: initialTab = 'create' }) {
  const [tab, setTab] = useState(initialTab)
  const [name, setName] = useState(model.me.name ? `${model.me.name}'s group` : 'Our group')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    const g = await act(() => api.createGroup(name))
    setBusy(false)
    if (!g) return
    model.addGroup(g)
    model.selectGroup(g.id)
    model.openModal('invite', { gid: g.id, fresh: true })
  }
  const join = async () => {
    setBusy(true)
    const ok = await joinWithLink(code)
    setBusy(false)
    if (ok) model.closeModal()
  }
  const valid = isJoinLink(code) || /^OD1-[A-Za-z0-9_-]{20,}$/.test(code)
  return html`
    <${Modal} title="Add a group">
      <div class="tabs">
        <button class=${tab === 'create' ? 'active' : ''} onClick=${() => setTab('create')}>Create</button>
        <button class=${tab === 'join' ? 'active' : ''} onClick=${() => setTab('join')}>Join with invite</button>
      </div>
      ${tab === 'create'
        ? html`
          <div class="modal-body">
            <label>Group name<input value=${name} maxLength="64" autoFocus onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && create()} /></label>
            <p class="hint">A fresh 256-bit secret is generated on this device. Only people you give a one-time invite link to can join.</p>
          </div>
          <footer><button class="btn primary" disabled=${busy || !name.trim()} onClick=${create}>Create group</button></footer>`
        : html`
          <div class="modal-body">
            <label>Invite link<textarea class="mono" rows="3" value=${code} autoFocus placeholder="opendiscord://join/…" onInput=${(e) => setCode(e.target.value.trim())} /></label>
            ${isFriendLink(code) || code.startsWith('ODF1-')
              ? html`<p class="hint warn-text">That's a friend link, not a group invite. Add it under Friends (the top button in the left bar).</p>`
              : html`<p class="hint">Ask someone in the group for an invite link (group menu → Invite people). Each link works once.</p>`}
            ${model.joins.length > 0 && html`<${PendingJoins} />`}
          </div>
          <footer><button class="btn primary" disabled=${busy || !valid} onClick=${join}>Join group</button></footer>`}
    <//>`
}

function PendingJoins () {
  return html`
    <div class="pending-joins">
      <small>Waiting to be let in</small>
      ${model.joins.map(j => html`
        <div class="pending-join" key=${j.id}>
          <div class="spinner small" />
          <span><b>${j.name || 'A group'}</b> · someone from the group needs to be online</span>
          <button class="btn sm" onClick=${() => act(() => api.cancelJoin(j.id))}>Cancel</button>
        </div>`)}
    </div>`
}

function InviteModal ({ gid, fresh }) {
  const g = model.groups.get(gid)
  const [ttl, setTtl] = useState(7 * 864e5)
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!g) return null
  const allowed = model.canInvite(g)
  const mod = model.isMod(g, model.me.key)
  const adminsOnly = model.groupSettings(g).invites === 'admins'
  const active = model.activeInvites(g)
  const create = async () => {
    setBusy(true)
    const r = await act(() => api.createInvite(gid, ttl))
    setBusy(false)
    if (!r) return
    model.applyOps(gid, [r.op])
    setLink(r.link)
    setCopied(false)
  }
  const copy = async () => { await api.copy(link); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  const revoke = async (i) => {
    const op = await act(() => api.revokeInvite(gid, i.id))
    if (op) model.applyOps(gid, [op])
  }
  const setAdminsOnly = (v) => act(() => append(gid, 'group.settings', model.settingsWith(g, { invites: v ? 'admins' : 'all' })))
  return html`
    <${Modal} title=${fresh ? 'Group created — invite your friends' : 'Invite people'}>
      <div class="modal-body">
        ${!allowed
          ? html`<div class="callout"><${Icon} name="shield" size=${16} /><div>Only the owner and admins can invite people to <b>${model.groupName(g)}</b>. Ask one of them for a link.</div></div>`
          : link
            ? html`
              <div class="invite-box">
                <code class="mono">${link}</code>
                <button class="btn primary" onClick=${copy}><${Icon} name=${copied ? 'check' : 'copy'} size=${16} /> ${copied ? 'Copied' : 'Copy'}</button>
              </div>
              <p class="hint">Works <b>once</b> and ${fmtExpiry(Date.now() + ttl)}. Clicking it opens OpenDiscord. If an app doesn't make it clickable, they can paste it under “Join with invite”.</p>
              <button class="btn sm" onClick=${() => setLink('')}>Make another link</button>`
            : html`
              <p>Each invite link lets <b>one</b> person in. Once it's used, it stops working, so a forwarded or leaked link is harmless.</p>
              <div class="row">
                <label class="grow">Link expires after
                  <select value=${ttl} onChange=${(e) => setTtl(Number(e.target.value))}>${INVITE_TTLS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
                </label>
                <button class="btn primary create-invite" disabled=${busy} onClick=${create}><${Icon} name="link" size=${16} /> Create invite link</button>
              </div>`}
        ${active.length > 0 && html`
          <div class="invite-list">
            <small>Unused links</small>
            ${active.map(i => html`
              <div class="invite-row" key=${i.id}>
                <${Icon} name="ticket" size=${16} class="dim" />
                <span>by ${i.by === model.me.key ? 'you' : model.memberName(g, i.by)} · ${fmtExpiry(i.exp)}</span>
                ${(i.by === model.me.key || mod) && html`<button class="btn sm" onClick=${() => revoke(i)}>Cancel link</button>`}
              </div>`)}
          </div>`}
        ${mod && html`
          <${Toggle} label="Only the owner and admins can invite" hint="Members can't make invite links, and links made by members stop working" checked=${adminsOnly} onChange=${setAdminsOnly} />`}
        <div class="callout">
          <${Icon} name="lock" size=${16} />
          <div>Someone from the group has to be online when the link is opened. They check that it's unused, then hand over the group key, encrypted for the new person only.</div>
        </div>
      </div>
      <footer><button class="btn" onClick=${() => model.closeModal()}>Done</button></footer>
    <//>`
}

function RenameGroupModal ({ gid }) {
  const g = model.groups.get(gid)
  const [name, setName] = useState(model.groupName(g))
  const save = async () => { await act(() => append(gid, 'group.rename', { name: name.trim() })); model.closeModal() }
  return html`
    <${Modal} title="Rename group">
      <div class="modal-body"><label>Name<input value=${name} maxLength="64" autoFocus onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && save()} /></label></div>
      <footer><button class="btn primary" disabled=${!name.trim()} onClick=${save}>Save</button></footer>
    <//>`
}

function ChannelModal ({ gid, kind = 'text', chId = null, folder: presetFolder = null }) {
  const g = model.groups.get(gid)
  const existing = chId ? g.channels.get(chId) : null
  const [k, setK] = useState(existing?.kind || kind)
  const [name, setName] = useState(existing?.name || '')
  const was = existing ? model.channelFolder(g, chId)?.id || '' : ''
  const [folder, setFolder] = useState(existing ? was : presetFolder || '')
  const folders = folderOptions(g)
  const clean = k === 'text' ? name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '') : name.trim()
  const save = async () => {
    if (!clean) return
    if (existing) {
      if (clean !== existing.name) await act(() => append(gid, 'channel.rename', { id: chId, name: clean }))
      if (folder !== was) await act(() => append(gid, 'channel.move', { id: chId, folder: folder || null, order: Date.now() }))
    } else {
      const id = rid()
      const data = { id, name: clean, kind: k }
      if (folder) data.folder = folder
      const ok = await act(() => append(gid, 'channel.create', data))
      if (ok && k === 'text') model.selectChannel(gid, id)
    }
    model.closeModal()
  }
  const del = () => model.openModal('confirm', {
    title: 'Delete channel',
    body: `Delete ${existing.kind === 'text' ? '#' : ''}${existing.name} for everyone?`,
    confirm: 'Delete channel',
    danger: true,
    onConfirm: () => act(() => append(gid, 'channel.delete', { id: chId }))
  })
  return html`
    <${Modal} title=${existing ? 'Edit channel' : 'Create channel'}>
      <div class="modal-body">
        ${!existing && html`
          <div class="kind-pick">
            <button class=${k === 'text' ? 'active' : ''} onClick=${() => setK('text')}><${Icon} name="hash" /><div><b>Text</b><small>Messages, images, files</small></div></button>
            <button class=${k === 'voice' ? 'active' : ''} onClick=${() => setK('voice')}><${Icon} name="speaker" /><div><b>Voice</b><small>Talk, video, screen share</small></div></button>
          </div>`}
        <label>Channel name<input value=${name} maxLength="48" autoFocus placeholder=${k === 'text' ? 'new-channel' : 'Gaming'} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && save()} /></label>
        ${(folders.length > 0 || folder) && html`
          <label>Folder
            <select value=${folder} onChange=${(e) => setFolder(e.target.value)}>
              <option value="">No folder</option>
              ${folders.map(o => html`<option value=${o.id}>${o.label}</option>`)}
            </select>
          </label>`}
      </div>
      <footer>
        ${existing && html`<button class="btn danger-ghost" onClick=${del}>Delete channel</button>`}
        <div class="spacer" />
        <button class="btn primary" disabled=${!clean} onClick=${save}>${existing ? 'Save' : 'Create'}</button>
      </footer>
    <//>`
}

// A folder in the channel list: holds channels and other folders
function FolderModal ({ gid, id = null, parent: presetParent = null }) {
  const g = model.groups.get(gid)
  const f = id ? g?.folders.get(id) : null
  const was = f ? model.folderParent(g, f)?.id || '' : ''
  const [name, setName] = useState(f?.name || '')
  const [parent, setParent] = useState(f ? was : presetParent || '')
  if (!g) return null
  const options = folderOptions(g, { excluding: id }).filter(o => f ? folderFits(g, id, o.f) : model.folderDepth(g, o.f) + 1 < MAX_FOLDER_DEPTH)
  const clean = name.trim()
  const save = async () => {
    if (!clean) return
    if (!f) {
      await act(() => append(gid, 'folder.create', { id: rid(), name: clean, parent: parent || null, order: Date.now() }))
    } else {
      const d = { id }
      if (clean !== f.name) d.name = clean
      if (parent !== was) { d.parent = parent || null; d.order = Date.now() }
      if (Object.keys(d).length > 1) await act(() => append(gid, 'folder.set', d))
    }
    model.closeModal()
  }
  const del = () => {
    const up = model.folderParent(g, f)
    model.openModal('confirm', {
      title: 'Delete folder',
      body: `Delete the folder "${f.name}"? What's inside moves up to ${up ? '"' + up.name + '"' : 'the top level'}. No channel or message is deleted.`,
      confirm: 'Delete folder',
      danger: true,
      onConfirm: () => act(() => append(gid, 'folder.delete', { id }))
    })
  }
  return html`
    <${Modal} title=${f ? 'Edit folder' : 'Create folder'}>
      <div class="modal-body">
        <label>Folder name<input value=${name} maxLength="48" autoFocus placeholder="Gaming" onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && save()} /></label>
        <label>Inside
          <select value=${parent} onChange=${(e) => setParent(e.target.value)}>
            <option value="">Top level</option>
            ${options.map(o => html`<option value=${o.id}>${o.label}</option>`)}
          </select>
        </label>
        <p class="hint">Folders can hold channels and other folders, up to ${MAX_FOLDER_DEPTH} levels. Drag channels and folders in the sidebar to sort them.</p>
      </div>
      <footer>
        ${f && html`<button class="btn danger-ghost" onClick=${del}>Delete folder</button>`}
        <div class="spacer" />
        <button class="btn primary" disabled=${!clean} onClick=${save}>${f ? 'Save' : 'Create'}</button>
      </footer>
    <//>`
}

// Owner/admins: whether @claude works in this group at all
function GroupClaudeModal ({ gid }) {
  const g = model.groups.get(gid)
  if (!g) return null
  const on = model.groupSettings(g).claude !== 'off'
  const set = (v) => act(() => append(gid, 'group.settings', model.settingsWith(g, { claude: v ? 'on' : 'off' })))
  return html`
    <${Modal} title=${'Claude in ' + model.groupName(g)}>
      <div class="modal-body">
        <p>Anyone here can write <b>@claude</b> to get an answer from Claude, an AI made by Anthropic. Whoever asks, their app sends the recent messages of that channel to Anthropic, with <b>their own</b> API key. Nobody else's key is used, and people without a key can't ask.</p>
        <${Toggle} label="Allow @claude in this group" hint="When it's off, nobody's app sends messages from this group to Claude" checked=${on} onChange=${set} />
      </div>
      <footer><button class="btn" onClick=${() => model.closeModal()}>Done</button></footer>
    <//>`
}

function ConfirmModal ({ title, body, confirm = 'OK', danger = false, onConfirm }) {
  return html`
    <${Modal} title=${title}>
      <div class="modal-body"><p>${body}</p></div>
      <footer>
        <div class="spacer" />
        <button class="btn" onClick=${() => model.closeModal()}>Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" autoFocus onClick=${() => { model.closeModal(); onConfirm() }}>${confirm}</button>
      </footer>
    <//>`
}

function GroupIconModal ({ gid }) {
  const g = model.groups.get(gid)
  const [cropping, setCropping] = useState(null)
  const [fileInput, pickImage] = useImagePicker(setCropping)
  if (!g) return null
  const save = async (icon) => {
    const ok = await act(() => append(gid, 'group.icon', { icon }), 'Could not change the picture')
    if (!ok) return
    model.toast(icon ? 'Group picture updated' : 'Group picture removed')
    model.closeModal()
  }
  return html`
    <${Modal} title="Group picture">
      <div class="modal-body">
        ${fileInput}
        ${cropping
          ? html`<${AvatarCropper} image=${cropping} onCancel=${() => setCropping(null)} onDone=${(url) => { setCropping(null); save(url) }} />`
          : html`
            <div class="profile-editor">
              <button class="avatar-pick" title="Upload a picture" onClick=${pickImage}>
                ${g.icon ? html`<img class="group-icon big" src=${g.icon} alt="" />` : html`<div class="group-icon big placeholder">${initials(model.groupName(g))}</div>`}
                <span class="avatar-pick-overlay"><${Icon} name="camera" size=${24} /></span>
              </button>
              <div class="row center avatar-actions">
                <button class="btn sm" onClick=${pickImage}>${g.icon ? 'Change picture' : 'Upload picture'}</button>
                ${g.icon && html`<button class="btn sm" onClick=${() => save(null)}>Remove</button>`}
              </div>
              <p class="hint">Everyone in ${model.groupName(g)} sees it. It syncs with the history, so friends who are offline get it later.</p>
            </div>`}
      </div>
    <//>`
}

function TextFileModal ({ a }) {
  const have = model.blobs.get(a.h)?.state === 'have'
  const text = useBlobText(a, have)
  const ext = extOf(a.n)
  const md = ext === 'md' || ext === 'markdown'
  const [source, setSource] = useState(false)
  return html`
    <${Modal} title=${a.n} wide>
      ${md && html`
        <div class="tabs">
          <button class=${!source ? 'active' : ''} onClick=${() => setSource(false)}>Preview</button>
          <button class=${source ? 'active' : ''} onClick=${() => setSource(true)}>Source</button>
        </div>`}
      <div class="modal-body text-file-body">
        ${text == null ? html`<p class="muted">Loading…</p>` : md && !source ? html`<${MarkdownView} text=${text} />` : html`<${CodeView} text=${text} ext=${md ? 'md' : ext} />`}
      </div>
      <footer>
        <button class="btn" disabled=${text == null} onClick=${() => { api.copy(text); model.toast('Copied to clipboard') }}><${Icon} name="copy" size=${16} /> Copy text</button>
        <div class="spacer" />
        <button class="btn" onClick=${() => act(() => api.saveBlob(a.h, a.n))}><${Icon} name="download" size=${16} /> Save</button>
        <button class="btn primary" onClick=${() => model.closeModal()}>Close</button>
      </footer>
    <//>`
}

function ImageModal ({ a }) {
  return html`
    <div class="lightbox" onClick=${() => model.closeModal()}>
      <img src=${blobUrl(a)} alt=${a.n} onClick=${(e) => e.stopPropagation()} />
      <div class="lightbox-bar" onClick=${(e) => e.stopPropagation()}>
        <span>${a.n}</span>
        <button class="btn" onClick=${() => act(() => api.saveBlob(a.h, a.n))}><${Icon} name="download" size=${16} /> Save</button>
      </div>
    </div>`
}

// ---------------------------------------------------------------- screen share

function ScreenPickerModal () {
  const s = model.settings.screen
  const [sources, setSources] = useState(null)
  const [tab, setTab] = useState('screen')
  const [sel, setSel] = useState(null)
  const [preset, setPreset] = useState(s.preset)
  const [hint, setHint] = useState(s.contentHint)
  const [audio, setAudio] = useState(!!s.audio)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => api.screenSources().then((list) => {
      if (!alive) return
      setSources(list)
      setSel(cur => cur && list.some(x => x.id === cur) ? cur : (list.find(x => x.kind === 'screen') || list[0])?.id || null)
    }).catch(e => model.toast('Could not list screens: ' + e.message, 'error'))
    load()
    const iv = setInterval(load, 4000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  const g = model.currentGroup()
  const viewers = voice.active ? Math.max(1, participantsOf(model.groups.get(voice.active.gid), voice.active.ch).length - 1) : 1
  const p = SCREEN_PRESETS[preset]
  const go = async () => {
    setBusy(true)
    try {
      await voice.startScreen({ sourceId: sel, preset, audio, contentHint: hint })
      saveSettings({ screen: { preset, contentHint: hint, audio } })
      model.closeModal()
    } catch (e) {
      model.toast('Screen share failed: ' + e.message, 'error')
    }
    setBusy(false)
  }
  const list = (sources || []).filter(x => x.kind === tab)
  return html`
    <${Modal} title="Share your screen" wide>
      <div class="tabs">
        <button class=${tab === 'screen' ? 'active' : ''} onClick=${() => setTab('screen')}>Screens</button>
        <button class=${tab === 'window' ? 'active' : ''} onClick=${() => setTab('window')}>Application windows</button>
      </div>
      <div class="modal-body">
        <div class="source-grid">
          ${!sources && html`<p class="muted">Loading…</p>`}
          ${sources && !list.length && html`<p class="muted">Nothing to share here.</p>`}
          ${list.map(x => html`
            <button key=${x.id} class="source ${sel === x.id ? 'active' : ''}" onClick=${() => setSel(x.id)} onDblClick=${go}>
              ${x.thumb ? html`<img src=${x.thumb} />` : html`<div class="thumb-empty" />`}
              <span>${x.icon && html`<img class="app-icon" src=${x.icon} />`}${x.name}</span>
            </button>`)}
        </div>
        <div class="screen-opts">
          <label>Quality
            <select value=${preset} onChange=${(e) => setPreset(e.target.value)}>
              ${Object.entries(SCREEN_PRESETS).map(([k, v]) => html`<option value=${k}>${v.label} (up to ${fmtRate(v.kbps)})</option>`)}
            </select>
          </label>
          <label>Optimise for
            <select value=${hint} onChange=${(e) => setHint(e.target.value)}>
              <option value="motion">Smooth motion (games, video)</option>
              <option value="detail">Sharp text (code, documents)</option>
            </select>
          </label>
          ${model.platform === 'win32' && html`
            <label class="check" title="Captures all system audio. Others in the call may hear their own voice echoed back unless you use headphones and turn their volume down.">
              <input type="checkbox" checked=${audio} onChange=${(e) => setAudio(e.target.checked)} /> Share system audio
            </label>`}
        </div>
        <p class="hint">Your upload needed: about <b>${fmtRate(p.kbps * viewers)}</b> (${fmtRate(p.kbps)} × ${viewers} viewer${viewers > 1 ? 's' : ''}). In a mesh every friend gets their own copy straight from you — no server re-encoding, no quality caps.</p>
      </div>
      <footer><div class="spacer" /><button class="btn" onClick=${() => model.closeModal()}>Cancel</button><button class="btn primary" disabled=${!sel || busy} onClick=${go}><${Icon} name="screenUp" size=${16} /> Go live</button></footer>
    <//>`
}

// ---------------------------------------------------------------- settings

function Toggle ({ checked, onChange, label, hint }) {
  return html`
    <label class="toggle-row">
      <div><b>${label}</b>${hint && html`<small>${hint}</small>`}</div>
      <input type="checkbox" class="switch" checked=${checked} onChange=${(e) => onChange(e.target.checked)} />
    </label>`
}

// Tests the microphone exactly as a call would send it (including the noise filter), and can
// play it back so you can hear what your friends hear.
function MicMeter ({ audio }) {
  const [level, setLevel] = useState(0)
  const [on, setOn] = useState(false)
  const [hear, setHear] = useState(false)
  const [ai, setAi] = useState(null)
  const out = useRef()
  useEffect(() => {
    if (!on) return
    let stream; let ctx; let raf
    let alive = true
    getMic(audio, { onFallback: (e) => model.toast('AI noise suppression could not start: ' + e.message, 'error') }).then((s) => {
      if (!alive) { stopMic(s); return }
      stream = s
      setAi(isDenoised(s))
      ctx = new AudioContext()
      const an = ctx.createAnalyser()
      an.fftSize = 512
      ctx.createMediaStreamSource(s).connect(an)
      const buf = new Float32Array(an.fftSize)
      const tick = () => {
        an.getFloatTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += v * v
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 6))
        raf = requestAnimationFrame(tick)
      }
      tick()
      if (out.current) {
        out.current.srcObject = s
        if (out.current.setSinkId && audio.outputId) out.current.setSinkId(audio.outputId === 'default' ? '' : audio.outputId).catch(() => {})
      }
    }).catch(e => { model.toast('Mic test failed: ' + e.message, 'error'); setOn(false) })
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      stopMic(stream)
      ctx?.close()
      if (out.current) out.current.srcObject = null
    }
  }, [on, audio.inputId, audio.noiseMode, audio.echoCancellation, audio.autoGainControl])
  useEffect(() => {
    const el = out.current
    if (!el) return
    el.muted = !hear
    if (hear) el.play().catch(() => {})
  }, [hear, on])
  return html`
    <div class="mic-test">
      <button class="btn" onClick=${() => setOn(!on)}>${on ? 'Stop test' : 'Test microphone'}</button>
      <div class="meter"><i style=${{ width: (on ? level * 100 : 0) + '%' }} /></div>
      ${on && html`<label class="check" title="Use headphones, or you'll get feedback"><input type="checkbox" checked=${hear} onChange=${(e) => setHear(e.target.checked)} /> Hear yourself</label>`}
      <audio ref=${out} autoplay muted />
    </div>
    ${on && ai !== null && html`<p class="hint">${ai
      ? 'This is your mic after AI noise suppression. Type, or let a fan run: the meter should stay low until you speak. Turn on "Hear yourself" (with headphones) to listen.'
      : 'This is your mic as your friends hear it.'}</p>`}`
}

function SettingsModal ({ tab: initialTab = 'profile' }) {
  const [tab, setTab] = useState(initialTab)
  const tabs = [['profile', 'My profile'], ['appearance', 'Appearance'], ['account', 'Account & backup'], ['voice', 'Voice & audio'], ['screen', 'Screen share'], ['claude', 'Claude'], ['network', 'Network'], ['storage', 'Storage'], ['privacy', 'Privacy & security'], ['updates', 'Updates']]
  return html`
    <${Modal} title="Settings" wide>
      <div class="settings">
        <nav>${tabs.map(([k, label]) => html`<button key=${k} class=${tab === k ? 'active' : ''} onClick=${() => setTab(k)}>${label}</button>`)}</nav>
        <div class="settings-body">
          ${tab === 'profile' && html`<${ProfileSettings} />`}
          ${tab === 'appearance' && html`<${AppearanceSettings} />`}
          ${tab === 'account' && html`<${AccountSettings} />`}
          ${tab === 'voice' && html`<${VoiceSettings} />`}
          ${tab === 'screen' && html`<${ScreenSettings} />`}
          ${tab === 'claude' && html`<${ClaudeSettings} />`}
          ${tab === 'network' && html`<${NetworkSettings} />`}
          ${tab === 'storage' && html`<${StorageSettings} />`}
          ${tab === 'privacy' && html`<${PrivacySettings} />`}
          ${tab === 'updates' && html`<${UpdateSettings} />`}
        </div>
      </div>
    <//>`
}

export function ProfileEditor ({ onSaved, cta = 'Save' }) {
  const [name, setName] = useState(model.me.name || '')
  const [color, setColor] = useState(model.me.color)
  const [avatar, setAvatar] = useState(model.me.avatar || null)
  const [cropping, setCropping] = useState(null)
  const [fileInput, pickImage] = useImagePicker(setCropping)
  const save = async () => {
    const me = await act(() => api.setProfile({ name: name.trim(), color, avatar }))
    if (me) { model.me = me; model.emit(); onSaved?.() }
  }
  if (cropping) {
    return html`<${AvatarCropper} image=${cropping} onCancel=${() => setCropping(null)} onDone=${(url) => { setAvatar(url); setCropping(null) }} />`
  }
  return html`
    <div class="profile-editor">
      ${fileInput}
      <button class="avatar-pick" title="Change profile picture" onClick=${pickImage}>
        <${Avatar} name=${name || '?'} color=${color} src=${avatar} size=${88} />
        <span class="avatar-pick-overlay"><${Icon} name="camera" size=${24} /></span>
      </button>
      <div class="row center avatar-actions">
        <button class="btn sm" onClick=${pickImage}>${avatar ? 'Change picture' : 'Upload picture'}</button>
        ${avatar && html`<button class="btn sm" onClick=${() => setAvatar(null)}>Remove</button>`}
      </div>
      <label>Display name<input value=${name} maxLength="32" autoFocus placeholder="What your friends call you" onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && name.trim() && save()} /></label>
      <div class="swatches">${COLORS.map(c => html`<button key=${c} class=${c === color ? 'active' : ''} style=${{ background: c }} onClick=${() => setColor(c)} title=${c} />`)}</div>
      <button class="btn primary" disabled=${!name.trim()} onClick=${save}>${cta}</button>
    </div>`
}

function ProfileSettings () {
  const autoAway = Number(model.settings.autoAway) || 0
  return html`
    <h4>My profile</h4><${ProfileEditor} onSaved=${() => model.toast('Profile updated')} />
    <h4>Status</h4>
    <label>Turn "Online" into "Away" after
      <select value=${autoAway} onChange=${(e) => saveSettings({ autoAway: Number(e.target.value) })}>
        ${[[0, 'Never'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour']].map(([v, l]) => html`<option value=${v}>${l} without input</option>`)}
      </select>
    </label>
    <p class="hint">Set your status by clicking your picture at the bottom left. "Appear offline" hides you from friends' lists; your app still syncs messages in the background.</p>`
}

// A tiny drawing of the window in each theme: rail, channels, chat and side panel
function ThemePreview ({ id, mode }) {
  return html`
    <div class="theme-preview" data-preview=${id} data-pmode=${mode} aria-hidden="true">
      <div class="thp-bar" />
      <div class="thp-body">
        <i class="thp-rail" /><i class="thp-nav"><b /><b /><b /></i>
        <i class="thp-main"><b /><b class="short" /><b /><u /></i><i class="thp-side" />
      </div>
    </div>`
}

function AppearanceSettings () {
  const cur = normalizeTheme(model.settings.theme)
  const mode = document.documentElement.dataset.mode || 'dark'
  const picked = model.settings.mode || null
  const layout = normalizeLayout(model.settings.layout)
  const custom = !sameOrder(layout.order, DEFAULT_ORDER) || Object.keys(layout.w).length > 0
  return html`
    <h4>Mode</h4>
    <div class="seg" role="group" aria-label="Light or dark">
      ${[['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'Like Windows', 'monitor']].map(([m, label, icon]) => html`
        <button key=${m} data-mode-id=${m} class=${(picked ? picked === m : mode === m) ? 'active' : ''} aria-pressed=${picked === m} onClick=${() => saveSettings({ mode: m })}><${Icon} name=${icon} size=${15} />${m === 'system' && model.platform === 'darwin' ? 'Like macOS' : label}</button>`)}
    </div>
    <p class="hint">${picked ? 'Every theme has a light and a dark version.' : `Every theme has a light and a dark version; ${themeInfo(cur).name} starts out ${themeInfo(cur).mode}.`}</p>
    <h4>Theme</h4>
    <div class="theme-grid">
      ${THEMES.map(t => html`
        <button key=${t.id} class="theme-card ${cur === t.id ? 'active' : ''}" data-theme-id=${t.id} aria-pressed=${cur === t.id} onClick=${() => saveSettings({ theme: t.id })}>
          <${ThemePreview} id=${t.id} mode=${mode} />
          <span class="theme-name">${t.name}${cur === t.id && html`<${Icon} name="check" size=${14} />`}</span>
          <small>${t.hint}</small>
        </button>`)}
    </div>
    ${cur === 'glass' && html`<${Toggle} label="Moving background" hint="The colours drift slowly behind the panels. It pauses while the window is in the background; turn it off to save a little battery." checked=${model.settings.animatedBg !== false} onChange=${(v) => saveSettings({ animatedBg: v })} />`}
    <h4>Panels</h4>
    <p class="hint">Every part of the window is a floating panel. Drag the small grip above a panel onto the left or right half of another one to move it there, and drag the edge of the channel list or the side panel to resize it (it snaps to a few sizes; double-click the edge for the default).</p>
    <div class="layout-summary">
      ${layout.order.map(id => html`<span key=${id} class="ls-${id}">${BLOCK_LABEL[id]}${layout.w[id] ? html` <small>${layout.w[id]} px</small>` : ''}</span>`)}
    </div>
    <div class="row"><button class="btn" disabled=${!custom} onClick=${() => resetLayout()}>Reset panels</button></div>`
}

function VoiceSettings () {
  const a = model.settings.audio
  const [devices, setDevices] = useState([])
  useEffect(() => {
    const load = () => navigator.mediaDevices.enumerateDevices().then(setDevices)
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => navigator.mediaDevices.removeEventListener('devicechange', load)
  }, [])
  const set = async (patch, reloadMic = false) => {
    await saveSettings({ audio: patch })
    if (reloadMic) voice.reloadMic()
    else voice.applyOutputDevice()
  }
  const inputs = devices.filter(d => d.kind === 'audioinput')
  const outputs = devices.filter(d => d.kind === 'audiooutput')
  return html`
    <h4>Voice & audio</h4>
    <div class="grid2">
      <label>Microphone
        <select value=${a.inputId} onChange=${(e) => set({ inputId: e.target.value }, true)}>
          ${inputs.map(d => html`<option value=${d.deviceId}>${d.label || 'Microphone'}</option>`)}
        </select>
      </label>
      <label>Speakers / headphones
        <select value=${a.outputId} onChange=${(e) => set({ outputId: e.target.value })}>
          ${outputs.map(d => html`<option value=${d.deviceId}>${d.label || 'Output'}</option>`)}
        </select>
      </label>
    </div>
    <label>Noise suppression
      <select value=${noiseMode(a)} onChange=${(e) => set({ noiseMode: e.target.value, noiseSuppression: e.target.value !== 'off' }, true)}>
        <option value="ai">AI (RNNoise): removes fans, keyboard clicks, hiss and hum</option>
        <option value="standard">Standard: the browser's built-in filter (lighter)</option>
        <option value="off">Off: send the microphone as it is</option>
      </select>
    </label>
    <${MicMeter} audio=${a} />
    <${Toggle} label="Echo cancellation" hint="Needed if you use speakers instead of headphones" checked=${a.echoCancellation} onChange=${(v) => set({ echoCancellation: v }, true)} />
    <${Toggle} label="Automatic gain control" hint="Evens out your volume" checked=${a.autoGainControl} onChange=${(v) => set({ autoGainControl: v }, true)} />
    <label>Voice quality (Opus bitrate)
      <select value=${a.voiceBitrate} onChange=${(e) => set({ voiceBitrate: +e.target.value })}>
        <option value="32000">32 kbps — low bandwidth</option>
        <option value="64000">64 kbps — standard</option>
        <option value="96000">96 kbps — high (default)</option>
        <option value="128000">128 kbps — very high</option>
        <option value="192000">192 kbps — studio</option>
      </select>
    </label>
    <p class="hint">Applies to calls you join after changing it. Shortcuts while in a call: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F9</kbd> mute, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F10</kbd> deafen (work even when the app is in the background).</p>
    <${SoundSettings} />`
}

function SoundSettings () {
  const s = model.settings.sounds || {}
  const set = (patch) => saveSettings({ sounds: patch })
  return html`
    <h4>Sounds</h4>
    <${Toggle} label="Join and leave sounds" hint="When you or someone else joins or leaves your voice channel, mutes or unmutes" checked=${s.voice !== false} onChange=${(v) => { set({ voice: v }); if (v) playTone('connect') }} />
    <label>Sound volume
      <input type="range" min="0" max="1" step="0.05" value=${s.volume ?? 0.6} onInput=${(e) => { model.settings.sounds = { ...s, volume: +e.target.value } }} onChange=${(e) => { set({ volume: +e.target.value }); playTone('join') }} />
    </label>
    <${Toggle} label="Soundboard" hint="Hear clips people play from the soundboard in your calls (and show the soundboard button)" checked=${s.soundboard !== false} onChange=${(v) => set({ soundboard: v })} />
    ${s.soundboard !== false && html`
      <label>Soundboard volume
        <input type="range" min="0" max="1" step="0.05" value=${s.soundboardVolume ?? 0.7} onChange=${(e) => set({ soundboardVolume: +e.target.value })} />
      </label>`}`
}

function ScreenSettings () {
  const s = model.settings.screen
  const codecs = [...new Set((window.RTCRtpSender?.getCapabilities('video')?.codecs || []).map(c => c.mimeType.split('/')[1]).filter(c => /^(VP8|VP9|H264|AV1|H265)$/i.test(c)))]
  return html`
    <h4>Screen share defaults</h4>
    <div class="grid2">
      <label>Quality
        <select value=${s.preset} onChange=${(e) => saveSettings({ screen: { preset: e.target.value } })}>
          ${Object.entries(SCREEN_PRESETS).map(([k, v]) => html`<option value=${k}>${v.label} · ${fmtRate(v.kbps)}</option>`)}
        </select>
      </label>
      <label>Video codec
        <select value=${s.codec} onChange=${(e) => saveSettings({ screen: { codec: e.target.value } })}>
          <option value="auto">Automatic (${voice.autoCodec} on this PC)</option>
          ${codecs.map(c => html`<option value=${c}>${{
            H264: 'H.264 (GPU-accelerated on most PCs)',
            H265: 'H.265/HEVC (GPU only — every viewer needs HEVC hardware decoding)',
            AV1: 'AV1 (best quality per bit, heavy on CPU without a recent GPU)',
            VP9: 'VP9 (software, CPU heavy at high resolutions)',
            VP8: 'VP8 (software, most compatible)'
          }[c] || c}</option>`)}
        </select>
      </label>
    </div>
    <p class="hint">Automatic picks a codec your graphics card can encode, so high resolutions don't max out your CPU. If the person sharing has a slow upload, pick a lower preset — in a mesh each viewer receives a separate stream.</p>`
}

function NetworkSettings () {
  const st = model.settings
  const [stun, setStun] = useState((st.stunServers || []).join('\n'))
  const peers = []
  for (const g of model.groups.values()) for (const [k, info] of g.online) if (!peers.some(p => p.key === k)) peers.push({ ...info, key: k, name: model.memberName(g, k) })
  return html`
    <h4>Connections</h4>
    <table class="peers">
      <thead><tr><th>Friend</th><th>Path</th><th>Latency</th><th>Version</th></tr></thead>
      <tbody>
        ${!peers.length && html`<tr><td colspan="4" class="muted">No friends online right now.</td></tr>`}
        ${peers.map(p => html`<tr key=${p.key}><td>${p.name}</td><td>${p.lan ? 'Same network (LAN)' : 'Direct over internet'} · ${p.family === 6 ? 'IPv6' : 'IPv4'}</td><td>${p.rtt != null ? p.rtt + ' ms' : '…'}</td><td class=${p.version && model.version && p.version !== model.version ? 'warn-text' : ''}>${p.version || 'older than 0.2'}</td></tr>`)}
      </tbody>
    </table>
    <p class="hint">Every connection is a direct, hole-punched UDP link. There is no relay fallback — that's the point.</p>
    <h4>Connection check</h4>
    <${NetworkHealth} />
    <h4>STUN servers (for calls)</h4>
    <textarea class="mono" rows="3" value=${stun} onInput=${(e) => setStun(e.target.value)} />
    <div class="row"><button class="btn" onClick=${() => saveSettings({ stunServers: stun.split('\n').map(s => s.trim()).filter(s => /^stuns?:/i.test(s)) }).then(() => model.toast('Saved — applies to the next call'))}>Save STUN servers</button></div>
    <p class="hint">STUN servers only answer "what is my public IP:port?" so WebRTC can punch through your router. They never see or carry any audio, video or messages. Leave empty to use only LAN/IPv6 addresses. Relay (TURN) servers are intentionally not supported.</p>
    <h4>Behaviour</h4>
    <label>Automatically keep a copy of files up to
      <select value=${st.autoDownloadMB} onChange=${(e) => saveSettings({ autoDownloadMB: +e.target.value })}>
        ${[0, 10, 25, 100, 500, 2000].map(n => html`<option value=${n}>${n ? n + ' MB' : 'never'}</option>`)}
      </select>
    </label>
    <p class="hint">Keeping copies means friends can still get a file when the original sender is offline.</p>
    <${Toggle} label="Keep running in the tray when closed" hint="Stay online so friends can sync messages and files from you" checked=${st.closeToTray} onChange=${(v) => saveSettings({ closeToTray: v })} />
    <${Toggle} label="Desktop notifications" checked=${st.notifications} onChange=${(v) => saveSettings({ notifications: v })} />`
}

const CLEAN_DAYS = [[0, 'Never'], [7, 'After 7 days'], [30, 'After 30 days'], [90, 'After 90 days']]

function StorageUsage ({ info, onCleaned }) {
  const [busy, setBusy] = useState(false)
  const m = info.messages
  const f = info.files
  const clean = async (days) => {
    setBusy(true)
    const r = await act(() => api.cleanStorage(days))
    setBusy(false)
    if (!r) return
    model.blobs.clear() // forget which files we have; they're checked again when shown
    model.toast(r.n ? `Freed ${fmtBytes(r.bytes)} (${r.n} file${r.n === 1 ? '' : 's'})` : 'Nothing to clean up')
    onCleaned()
  }
  const total = m.disk + f.mine.bytes + f.friends.bytes + f.unused.bytes
  const bar = (bytes) => ({ width: total ? Math.max(bytes ? 1 : 0, bytes / total * 100) + '%' : '0' })
  return html`
    <div class="usage">
      <div class="usage-bar">
        <i class="u-msg" style=${bar(m.disk)} /><i class="u-mine" style=${bar(f.mine.bytes)} /><i class="u-friends" style=${bar(f.friends.bytes)} /><i class="u-unused" style=${bar(f.unused.bytes)} />
      </div>
      <div class="usage-rows">
        <div><span class="u-dot u-msg" /><b>Messages & history</b><span>${fmtBytes(m.disk)}</span>
          <small>${m.ops.toLocaleString()} entries${m.disk && m.raw / m.disk > 1.1 ? `, compressed ${(m.raw / m.disk).toFixed(1)}× (${fmtBytes(m.raw)} uncompressed)` : ''}${m.stubs ? ` · ${m.stubs.toLocaleString()} deleted or outdated entries cleared` : ''}</small></div>
        <div><span class="u-dot u-mine" /><b>Files you sent</b><span>${fmtBytes(f.mine.bytes)}</span><small>${f.mine.n} files · always kept, friends download them from you</small></div>
        <div><span class="u-dot u-friends" /><b>Files from friends</b><span>${fmtBytes(f.friends.bytes)}</span><small>${f.friends.n} files · can be removed and downloaded again later</small></div>
        ${f.unused.n > 0 && html`<div><span class="u-dot u-unused" /><b>Files from deleted messages</b><span>${fmtBytes(f.unused.bytes)}</span><small>${f.unused.n} files · removed automatically</small></div>`}
      </div>
      <div class="row">
        <button class="btn" disabled=${busy || !(f.friends.n + f.unused.n)} onClick=${() => clean(0)}>Remove files from friends</button>
        <label class="inline">Automatically remove friends' files
          <select value=${model.settings.cleanFriendsFilesDays || 0} onChange=${(e) => saveSettings({ cleanFriendsFilesDays: Number(e.target.value) })}>
            ${CLEAN_DAYS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
          </select>
        </label>
      </div>
      <p class="hint">Messages are stored compressed. Deleted messages, older versions of edited messages and old profile pictures are erased for good two days later (time for friends on older versions to update).</p>
    </div>`
}

function StorageSettings () {
  const [info, setInfo] = useState(null)
  const [pending, setPending] = useState(null) // { dir, existing } waiting for confirmation
  const [busy, setBusy] = useState(false)
  const load = () => api.storageInfo().then(setInfo, (e) => model.toast('Could not read the data folder: ' + e.message, 'error'))
  useEffect(() => { load() }, [])
  const choose = async (picked) => {
    const t = await act(() => api.checkStorage(picked))
    if (t) setPending(t)
  }
  const pick = async () => {
    const picked = await act(() => api.pickStorage())
    if (picked) choose(picked)
  }
  const go = async (useExisting) => {
    setBusy(true)
    if (voice.active) voice.leave(true)
    const ok = await act(() => api.moveStorage(pending.dir, useExisting))
    if (!ok) setBusy(false) // otherwise the app restarts
  }
  const isDefault = info && info.dir.toLowerCase() === info.defaultDir.toLowerCase()
  return html`
    <h4>Space used</h4>
    ${info ? html`<${StorageUsage} info=${info} onCleaned=${load} />` : html`<p class="hint">…</p>`}
    <h4>Data folder</h4>
    <p class="hint">Your identity (your key pair), groups, messages and the files you've received live here. Pick a bigger drive if you share lots of large files.</p>
    <div class="invite-box">
      <code class="mono">${info ? info.dir : '…'}</code>
      <button class="btn" onClick=${() => api.openStorage()}><${Icon} name="folder" size=${16} /> Open</button>
    </div>
    <p class="hint">${info ? `${fmtBytes(info.size)} used${isDefault ? ' · default location' : ''}` : ''}</p>
    ${info?.locked
      ? html`<p class="hint warn-text">This folder is set by the OD_DATA_DIR environment variable, so it can't be changed here.</p>`
      : html`
        <div class="row">
          <button class="btn" disabled=${!info || busy} onClick=${pick}>Change folder…</button>
          ${info && !isDefault && html`<button class="btn" disabled=${busy} onClick=${() => choose(null)}>Move back to the default folder</button>`}
        </div>`}
    ${pending && html`
      <div class="callout ${pending.existing ? 'warn' : ''}">
        <${Icon} name="folder" size=${16} />
        <div>
          ${pending.existing
            ? html`
              <p><b>${pending.dir}</b> already holds OpenDiscord data, maybe another identity or an older copy.</p>
              <div class="row">
                <button class="btn primary" disabled=${busy} onClick=${() => go(true)}>Switch to the data that's there</button>
                <button class="btn danger" disabled=${busy} onClick=${() => go(false)}>Replace it with my current data</button>
                <button class="btn" disabled=${busy} onClick=${() => setPending(null)}>Cancel</button>
              </div>
              <p class="hint">Switching leaves your current data where it is. Replacing deletes the data in the new folder first.</p>`
            : html`
              <p>OpenDiscord restarts and moves your data${info ? ` (${fmtBytes(info.size)})` : ''} to <b>${pending.dir}</b>.${voice.active ? ' This ends your call.' : ''}</p>
              <div class="row">
                <button class="btn primary" disabled=${busy} onClick=${() => go(false)}>${busy ? 'Restarting…' : 'Move and restart'}</button>
                <button class="btn" disabled=${busy} onClick=${() => setPending(null)}>Cancel</button>
              </div>`}
        </div>
      </div>`}
    <p class="hint">The move happens on the next start, before anything opens the files. If the folder is on a drive that's missing later, OpenDiscord doesn't start with an empty profile. It asks you to reconnect the drive instead.</p>`
}

function UpdateSettings () {
  const u = model.update
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    await act(() => api.checkForUpdate())
    setChecking(false)
  }
  const busy = checking || u?.status === 'checking' || u?.status === 'downloading' || u?.status === 'installing'
  return html`
    <h4>OpenDiscord ${model.version}</h4>
    <div class="update-status ${u?.status || ''}">
      <${Icon} name=${u?.status === 'ready' || u?.status === 'latest' ? 'check' : u?.status === 'error' ? 'signal' : 'download'} size=${16} />
      <span>${updateStatusText(u)}</span>
    </div>
    ${u?.status === 'downloading' && html`<div class="progress update-progress"><i style=${{ width: (u.percent || 0) + '%' }} /></div>`}
    <div class="row">
      ${u?.status === 'ready'
        ? html`<button class="btn primary" onClick=${restartForUpdate}>Restart to update</button>`
        : html`<button class="btn" disabled=${!u?.supported || busy} onClick=${check}>${busy ? 'Checking…' : 'Check for updates'}</button>`}
      ${u?.releasesUrl && html`<button class="btn" onClick=${() => api.openExternal(u.releasesUrl)}>What's new</button>`}
    </div>
    <${Toggle} label="Install updates automatically" hint="Checks GitHub every few hours, downloads new versions in the background and installs them the next time you restart" checked=${model.settings.autoUpdate !== false} onChange=${(v) => saveSettings({ autoUpdate: v })} />
    <p class="hint">Updates are the releases published from the project's GitHub repository. Each download is checked against its published SHA-512 hash before it's installed. Checking for updates is the only time the app talks to a server other than the P2P network and STUN. Turn it off to avoid that; you can still check by hand.</p>
    ${u?.portable && html`<p class="hint">You're running the portable .exe. The first update installs OpenDiscord on this PC (per user, no admin needed). After that, start it from the Start menu or desktop. Your groups and messages carry over.</p>`}`
}

const CLAUDE_MODELS = [
  ['claude-opus-5-5', 'Opus 5.5', 'smartest, about 2¢ an answer'],
  ['claude-sonnet-5-5', 'Sonnet 5.5', 'balanced, about 1¢ an answer'],
  ['claude-haiku-5-5', 'Haiku 5.5', 'fastest, a fraction of a cent']
]

function ClaudeSettings () {
  const info = model.claude || {}
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const s = model.settings.claude || {}
  useEffect(() => { loadClaudeInfo() }, [])
  const keychain = model.platform === 'win32' ? 'encrypted by Windows' : model.platform === 'darwin' ? 'in the macOS keychain' : 'encrypted by your keyring'
  const save = async () => {
    setBusy(true)
    setErr('')
    try {
      model.claude = await api.claudeSetKey(key.trim())
      setKey('')
      model.toast('API key saved. Write @claude in any chat to ask.')
    } catch (e) { setErr(cleanErr(e)) }
    setBusy(false)
    model.emit()
  }
  const remove = () => model.openModal('confirm', {
    title: 'Remove API key',
    body: 'Remove your Anthropic API key from this PC? @claude stops working for you until you add one again.',
    confirm: 'Remove key',
    danger: true,
    onConfirm: async () => { model.claude = await api.claudeClearKey(); model.emit() }
  })
  const setS = (patch) => saveSettings({ claude: { ...s, ...patch } })
  return html`
    <h4>Ask Claude in your chats</h4>
    <p class="hint">Write <b>@claude</b> in any chat or thread and Claude, an AI made by Anthropic, answers there for everyone to see. Your app sends the recent messages of that chat (and pictures or text files in your message) to Anthropic and posts the answer. It uses <b>your own API key</b>: friends without a key can't ask Claude, and your key is never sent to them.</p>
    <h4>Your API key</h4>
    ${info.hasKey
      ? html`
        <div class="key-row">
          <${Icon} name="lock" size=${16} />
          <span>Key ending in <b class="mono">${info.hint}</b> is saved ${info.encrypted ? keychain : 'in a file only you can read'}.</span>
          <button class="btn sm danger-ghost" onClick=${remove}>Remove</button>
        </div>`
      : html`
        <div class="row">
          <input class="grow mono" type="password" placeholder="sk-ant-…" value=${key} onInput=${(e) => setKey(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && key.trim() && save()} />
          <button class="btn primary" disabled=${!key.trim() || busy} onClick=${save}>${busy ? 'Checking…' : 'Save key'}</button>
        </div>
        ${err && html`<p class="error-text">${err}</p>`}
        <p class="hint">Create a key at <a onClick=${() => api.openExternal('https://console.anthropic.com/settings/keys')}>console.anthropic.com</a>. Anthropic bills you for each answer; the key is checked once and then stays on this PC.</p>`}
    <h4>Model</h4>
    <div class="model-pick">
      ${CLAUDE_MODELS.map(([id, label, hint]) => html`
        <button key=${id} class=${(s.model || 'claude-opus-5-5') === id ? 'active' : ''} onClick=${() => setS({ model: id })}><b>${label}</b><small>${hint}</small></button>`)}
    </div>
    <${Toggle} label="Let Claude search the web" hint="For news, prices, opening hours and the like. Anthropic bills each search on top." checked=${!!s.web} onChange=${(v) => setS({ web: v })} />
    ${info.usage && info.usage.answers > 0 && html`<p class="hint">This month: ${info.usage.answers} answer${info.usage.answers === 1 ? '' : 's'}, about $${info.usage.usd < 0.01 ? '0.01' : info.usage.usd.toFixed(2)}${info.usage.searches ? ` plus ${info.usage.searches} web search${info.usage.searches === 1 ? '' : 'es'}` : ''}.</p>`}`
}

function PrivacySettings () {
  const key = model.me.key
  return html`
    <h4>How your data is protected</h4>
    <ul class="security-list">
      <li><${Icon} name="globe" size=${18} /><div><b>Finding each other</b><small>Each group announces sha256(secret) on the HyperDHT, a public peer-to-peer DHT. DHT nodes see that hash and your IP address — never the secret, names or messages.</small></div></li>
      <li><${Icon} name="lock" size=${18} /><div><b>Messages & files</b><small>Sent over Noise-encrypted Hyperswarm connections (X25519 + ChaCha20-Poly1305). Each friend must prove they know the group secret, bound to the session's handshake hash, before receiving anything.</small></div></li>
      <li><${Icon} name="shield" size=${18} /><div><b>Authenticity</b><small>Every message, edit and reaction is signed with the author's Ed25519 key, so nobody can forge or alter them while relaying.</small></div></li>
      <li><${Icon} name="speaker" size=${18} /><div><b>Calls & screen share</b><small>WebRTC DTLS-SRTP, directly between you. The DTLS fingerprints are exchanged over the authenticated channel, so no one can man-in-the-middle a call.</small></div></li>
      <li><${Icon} name="micOff" size=${18} /><div><b>Nobody listens in</b><small>Your microphone only opens when you join a voice channel. While you're muted it's taken off every connection, so no sound leaves your PC, whatever the other side's app does. Your app only connects to people who are listed in the channel, and your screen only goes to people who appear as watching it.</small></div></li>
      <li><${Icon} name="sparkle" size=${18} /><div><b>Claude</b><small>Only when someone writes @claude (or replies to Claude) does their app send recent messages of that chat to Anthropic, with their own API key: their own messages, Claude's answers to them, and messages of people who allowed it below. Admins can turn Claude off per group.</small></div></li>
      <li><${Icon} name="file" size=${18} /><div><b>On disk</b><small>History is stored unencrypted in your user profile folder, like most desktop apps. Your secret key is encrypted with ${model.platform === 'win32' ? 'Windows' : 'the system'}' keychain${model.me.sealed ? '' : ' (not available on this PC, so it is stored as is)'}. Protect your device with disk encryption (BitLocker/FileVault).</small></div></li>
    </ul>
    <h4>Claude</h4>
    <${Toggle} label="Claude may read my messages" hint="When a friend asks @claude something, your recent messages in that chat are sent to Anthropic with theirs, so Claude has the whole conversation. Off: Claude only sees what the person asking wrote." checked=${!!model.me.claude}
      onChange=${async (v) => { const me = await act(() => api.setProfile({ claude: v })); if (me) { model.me = me; model.emit() } }} />
    <h4>Link previews</h4>
    <${Toggle} label="Show previews for links I send" hint="Your app loads the page once when you send the message and attaches a small preview. Friends' apps never contact the site, so they don't reveal their IP address to it." checked=${model.settings.linkPreviews !== false} onChange=${(v) => saveSettings({ linkPreviews: v })} />
    <h4>Your public key</h4>
    <div class="invite-box"><code class="mono">${key}</code><button class="btn" onClick=${() => api.copy(key)}><${Icon} name="copy" size=${16} /> Copy</button></div>
    <p class="hint">Friends can compare the first characters with what they see for you in the member list tooltip to be sure it's really you.</p>`
}
