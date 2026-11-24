import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js'
import { model, voice, act, append } from '../lib/core.js'
import { MAX_FOLDER_DEPTH } from '../lib/model.js'
import { APPS } from '../lib/apps.js'
import { Icon } from '../lib/icons.js'
import { Avatar, leaveGroupFlow } from './chat.js'
import { myOpenTasks, eventsToday } from './planner.js'
import { participantsOf, viewersOf, MuteIcons } from './stage.js'
import { openMemberMenu } from './members.js'

// ---------------------------------------------------------------- folded folders (per device)

let folded = new Set()
try { folded = new Set(JSON.parse(localStorage.getItem('od.folded') || '[]')) } catch {}
function toggleFold (key) {
  if (folded.has(key)) folded.delete(key)
  else folded.add(key)
  try { localStorage.setItem('od.folded', JSON.stringify([...folded])) } catch {}
  model.emit()
}

// ---------------------------------------------------------------- moving things around

// What's being dragged: { kind: 'ch' | 'folder', id }
let dragging = null
const STEP = 1000

// How many folder levels sit below f (0 = no sub-folders)
function folderHeight (g, f) {
  let h = 0
  for (const x of model.foldersOf(g)) {
    if (x.id === f.id || !model.inFolder(g, x.id, f)) continue
    let d = 0
    for (let y = x; y && y.id !== f.id; y = model.folderParent(g, y)) d++
    h = Math.max(h, d)
  }
  return h
}

// Can folder `id` go into folder `into` (null = top level)?
function folderFits (g, id, into) {
  if (!into) return true
  const f = g.folders.get(id)
  if (!f || model.inFolder(g, into.id, f)) return false
  return model.folderDepth(g, into) + 1 + folderHeight(g, f) < MAX_FOLDER_DEPTH
}

const siblingsIn = (g, folder, kind) => {
  if (!folder) {
    const tree = model.channelTree(g)
    return kind === 'folder' ? tree.folders.map(n => n.f) : tree[kind]
  }
  const find = (nodes) => {
    for (const n of nodes) {
      if (n.f.id === folder.id) return n
      const sub = find(n.items.filter(i => i.node).map(i => i.node))
      if (sub) return sub
    }
    return null
  }
  const node = find(model.channelTree(g).folders)
  return node ? node.items.map(i => i.ch || i.node.f) : []
}

// Put the dragged channel/folder into `folder` (null = top level), before `before` or at the end
async function moveTo (g, folder, before = null) {
  const d = dragging
  dragging = null
  if (!d) return
  if (d.kind === 'folder' && !folderFits(g, d.id, folder)) {
    model.toast(folder && model.inFolder(g, folder.id, g.folders.get(d.id)) ? "A folder can't go inside itself" : `Folders go at most ${MAX_FOLDER_DEPTH} levels deep`, 'error')
    return
  }
  const item = d.kind === 'ch' ? g.channels.get(d.id) : g.folders.get(d.id)
  if (!item || item === before) return
  const sibs = siblingsIn(g, folder, d.kind === 'ch' && !folder ? item.kind : d.kind === 'folder' && !folder ? 'folder' : null).filter(x => x !== item)
  const key = (x) => model.sortKey(g, x)
  let order
  const i = before ? sibs.indexOf(before) : -1
  if (i < 0) order = sibs.length ? key(sibs[sibs.length - 1]) + STEP : Date.now()
  else order = i === 0 ? key(sibs[0]) - STEP : (key(sibs[i - 1]) + key(sibs[i])) / 2
  if (d.kind === 'ch') await act(() => append(g.id, 'channel.move', { id: d.id, folder: folder ? folder.id : null, order }))
  else await act(() => append(g.id, 'folder.set', { id: d.id, parent: folder ? folder.id : null, order }))
}

// Props for anything that can be dragged
const draggable = (kind, id) => ({
  draggable: true,
  onDragStart: (e) => {
    dragging = { kind, id }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/od-' + kind, id)
    e.stopPropagation()
  },
  onDragEnd: () => { dragging = null; clearMarks() }
})

function clearMarks () {
  for (const el of document.querySelectorAll('.drop-before, .drop-into')) el.classList.remove('drop-before', 'drop-into')
}

// Props for a drop target: `mark` is 'before' (a line above it) or 'into' (highlight)
const dropTarget = (mark, onDrop) => ({
  onDragOver: (e) => {
    if (!dragging) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (!e.currentTarget.classList.contains('drop-' + mark)) { clearMarks(); e.currentTarget.classList.add('drop-' + mark) }
  },
  onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drop-' + mark) },
  onDrop: (e) => { e.preventDefault(); e.stopPropagation(); clearMarks(); onDrop() }
})

// ---------------------------------------------------------------- group menu

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
      ${model.canInvite(g) && item('userPlus', 'Invite people', () => model.openModal('invite', { gid: g.id }), 'accent')}
      ${model.appOn(g, 'calendar') && item('calendar', 'Calendar', () => model.openPlanner(g.id, 'calendar'))}
      ${model.appOn(g, 'tasks') && item('tasks', 'Tasks', () => model.openPlanner(g.id, 'tasks'))}
      ${model.appOn(g, 'games') && item('chess', 'Play a game', () => model.openModal('newGame', { gid: g.id }))}
      ${model.appOn(g, 'docs') && item('focus', 'Focus docs', () => model.openDocs(g.id))}
      ${model.isMod(g, model.me.key) && !g.kickedMe && item('apps', 'Apps', () => model.openModal('apps', { gid: g.id }))}
      ${item('hash', 'Create text channel', () => model.openModal('channel', { gid: g.id, kind: 'text' }))}
      ${item('speaker', 'Create voice channel', () => model.openModal('channel', { gid: g.id, kind: 'voice' }))}
      ${item('folderPlus', 'Create folder', () => model.openModal('folder', { gid: g.id }))}
      ${item('edit', 'Rename group', () => model.openModal('renameGroup', { gid: g.id }))}
      ${item('image', 'Change group picture', () => model.openModal('groupIcon', { gid: g.id }))}
      ${model.isMod(g, model.me.key) && item('sparkle', 'Claude settings', () => model.openModal('groupClaude', { gid: g.id }))}
      <hr />
      ${item('leave', 'Leave group', () => leaveGroupFlow(g), 'danger')}
    </div>`
}

// ---------------------------------------------------------------- sidebar

// Documents someone else has open right now
const docsLive = (g) => model.docsOf(g).filter(d => model.docPresence(g.id, d.id).length > 0).length

export function Sidebar ({ g, ch, stage, footer }) {
  const [menu, setMenu] = useState(false)
  const tree = model.channelTree(g)
  const planner = !stage && model.ui.planner?.gid === g.id ? model.ui.planner.tab : null
  const games = !stage && model.ui.games?.gid === g.id
  const today = eventsToday(g)
  const mine = myOpenTasks(g)
  const turns = model.myGameTurns(g)
  const view = { g, ch: !stage && !planner && !games ? ch : null, stage }
  const on = (id) => model.appOn(g, id)
  const missing = APPS.filter(a => !on(a.id))
  const canAddApps = missing.length > 0 && model.isMod(g, model.me.key) && !g.kickedMe
  return html`
    <aside class="sidebar">
      <header class="group-header" onClick=${() => setMenu(!menu)}>
        ${g.icon && html`<img class="gh-icon" src=${g.icon} alt="" />`}
        <h1>${model.groupName(g)}</h1>
        <${Icon} name=${menu ? 'x' : 'chevronDown'} size=${18} />
      </header>
      ${menu && html`<${GroupMenu} g=${g} onClose=${() => setMenu(false)} />`}
      <div class="channels" onDragEnd=${clearMarks}>
        ${model.canInvite(g) && html`<button class="invite-cta" onClick=${() => model.openModal('invite', { gid: g.id })}><${Icon} name="userPlus" size=${16} /> Invite friends</button>`}
        ${on('calendar') && html`
        <button class="channel planner-link ${planner === 'calendar' ? 'active' : ''}" onClick=${() => model.openPlanner(g.id, 'calendar')}>
          <${Icon} name="calendar" size=${18} class="dim" /><span class="ch-name">Calendar</span>
          ${today > 0 && html`<span class="soft-badge" title="Events today">${today} today</span>`}
        </button>`}
        ${on('tasks') && html`
        <button class="channel planner-link ${planner === 'tasks' ? 'active' : ''}" onClick=${() => model.openPlanner(g.id, 'tasks')}>
          <${Icon} name="tasks" size=${18} class="dim" /><span class="ch-name">Tasks</span>
          ${mine > 0 && html`<span class="soft-badge" title="Open tasks assigned to you">${mine}</span>`}
        </button>`}
        ${on('games') && html`
        <button class="channel planner-link games-link ${games ? 'active' : ''}" onClick=${() => model.openGames(g.id)}>
          <${Icon} name="chess" size=${18} class="dim" /><span class="ch-name">Games</span>
          ${turns > 0 && html`<span class="soft-badge" title="Games waiting for you">${turns} your move</span>`}
        </button>`}
        ${on('docs') && html`
        <button class="channel planner-link docs-link ${model.ui.docs?.gid === g.id ? 'active' : ''}" onClick=${() => model.openDocs(g.id)}>
          <${Icon} name="focus" size=${18} class="dim" /><span class="ch-name">Focus docs</span>
          ${docsLive(g) > 0 && html`<span class="soft-badge" title="Documents someone is writing in right now">${docsLive(g)} live</span>`}
        </button>`}
        ${canAddApps && html`
          <button class="add-folder-hint add-app-hint" title=${'Add ' + missing.map(a => a.name).join(', ')} onClick=${() => model.openModal('apps', { gid: g.id })}><${Icon} name="apps" size=${15} /> Add apps</button>`}
        <${SectionHead} g=${g} kind="text" label="Text channels" />
        ${tree.text.map(c => html`<${TextRow} key=${c.id} view=${view} c=${c} />`)}
        <${SectionHead} g=${g} kind="voice" label="Voice channels" />
        ${tree.voice.map(c => html`<${VoiceRow} key=${c.id} view=${view} c=${c} />`)}
        ${tree.folders.map(node => html`<${FolderBlock} key=${node.f.id} view=${view} node=${node} depth=${0} />`)}
        ${!g.kickedMe && html`
          <button class="add-folder-hint" onClick=${() => model.openModal('folder', { gid: g.id })}><${Icon} name="folderPlus" size=${15} /> ${tree.folders.length ? 'New folder' : 'Create a folder'}</button>`}
      </div>
      ${footer}
    </aside>`
}

// "Text channels" / "Voice channels": also where channels are dropped to leave a folder
function SectionHead ({ g, kind, label }) {
  return html`
    <div class="section-head" ...${dropTarget('into', () => moveTo(g, null))}>
      <span>${label}</span>
      <button class="icon-btn small" title=${kind === 'text' ? 'Create text channel' : 'Create voice channel'} onClick=${() => model.openModal('channel', { gid: g.id, kind })}><${Icon} name="plus" size=${16} /></button>
    </div>`
}

function FolderBlock ({ view, node, depth }) {
  const { g } = view
  const f = node.f
  const key = g.id + ':' + f.id
  const closed = folded.has(key)
  // Folded: still show the open channel, and voice channels with people in them
  const visible = closed
    ? node.items.filter(it => it.ch && (it.ch.id === view.ch?.id || it.ch.id === view.stage?.id || (it.ch.kind === 'voice' && participantsOf(g, it.ch.id).length)))
    : node.items
  const unread = closed && hasUnread(g, node)
  return html`
    <div class="folder" style=${{ '--depth': depth }}>
      <div class="folder-head ${unread ? 'unread' : ''}" ...${draggable('folder', f.id)} ...${dropTarget('into', () => moveTo(g, f))}
        onClick=${() => toggleFold(key)} title=${closed ? 'Open folder' : 'Fold folder'}>
        <${Icon} name="chevronDown" size=${12} class=${'fold ' + (closed ? 'closed' : '')} />
        <span class="folder-name">${f.name}</span>
        <span class="folder-tools" onClick=${(e) => e.stopPropagation()}>
          <button class="icon-btn small" title="Create channel in this folder" onClick=${() => model.openModal('channel', { gid: g.id, kind: 'text', folder: f.id })}><${Icon} name="plus" size=${15} /></button>
          ${depth + 1 < MAX_FOLDER_DEPTH && html`<button class="icon-btn small" title="Create a folder inside" onClick=${() => model.openModal('folder', { gid: g.id, parent: f.id })}><${Icon} name="folderPlus" size=${14} /></button>`}
          <button class="icon-btn small" title="Edit folder" onClick=${() => model.openModal('folder', { gid: g.id, id: f.id })}><${Icon} name="settings" size=${13} /></button>
        </span>
      </div>
      <div class="folder-items">
        ${visible.map(it => it.ch
          ? it.ch.kind === 'voice'
            ? html`<${VoiceRow} key=${it.ch.id} view=${view} c=${it.ch} folder=${f} />`
            : html`<${TextRow} key=${it.ch.id} view=${view} c=${it.ch} folder=${f} />`
          : html`<${FolderBlock} key=${it.node.f.id} view=${view} node=${it.node} depth=${depth + 1} />`)}
        ${!closed && !node.items.length && html`<div class="folder-empty" ...${dropTarget('into', () => moveTo(g, f))}>Empty. Drag channels here.</div>`}
      </div>
    </div>`
}

function hasUnread (g, node) {
  return node.items.some(it => it.ch ? it.ch.kind === 'text' && model.unread(g, it.ch.id).count > 0 : hasUnread(g, it.node))
}

function TextRow ({ view, c, folder = null }) {
  const { g } = view
  const u = model.unread(g, c.id)
  const active = view.ch?.id === c.id
  const open = () => { model.ui.stage = null; model.selectChannel(g.id, c.id) }
  return html`
    <button class="channel ${active ? 'active' : ''} ${u.count ? 'unread' : ''}" onClick=${open}
      ...${draggable('ch', c.id)} ...${dropTarget('before', () => moveTo(g, folder, c))}>
      <${Icon} name="hash" size=${18} class="dim" /><span class="ch-name">${c.name}</span>
      ${u.mentions > 0 && html`<span class="badge">${u.mentions}</span>`}
      <span class="ch-edit" title="Edit channel" onClick=${(e) => { e.stopPropagation(); model.openModal('channel', { gid: g.id, chId: c.id }) }}><${Icon} name="settings" size=${14} /></span>
    </button>`
}

function VoiceRow ({ view, c, folder = null }) {
  const { g } = view
  const keys = participantsOf(g, c.id)
  const openVoice = () => {
    model.ui.stage = { gid: g.id, ch: c.id }
    model.emit()
    if (!voice.inChannel(g.id, c.id) && !g.kickedMe) act(() => voice.join(g.id, c.id))
  }
  return html`
    <div>
      <button class="channel ${view.stage?.id === c.id ? 'active' : ''} ${voice.inChannel(g.id, c.id) ? 'connected' : ''}" onClick=${openVoice}
        ...${draggable('ch', c.id)} ...${dropTarget('before', () => moveTo(g, folder, c))}>
        <${Icon} name="speaker" size=${18} class="dim" /><span class="ch-name">${c.name}</span>
        <span class="ch-edit" title="Edit channel" onClick=${(e) => { e.stopPropagation(); model.openModal('channel', { gid: g.id, chId: c.id }) }}><${Icon} name="settings" size=${14} /></span>
      </button>
      ${keys.map((k) => {
        const me = k === model.me.key
        const st = me ? voice.statePayload() : g.voice.get(k) || {}
        const watches = (st.watch || []).filter(w => keys.includes(w))
        const viewers = st.screen ? viewersOf(g, c.id, k).length : 0
        return html`
          <div key=${k} class="voice-user ${voice.speaking.has(k) ? 'speaking' : ''}" onClick=${(e) => clickVoiceUser(e, g, c, k, st)} onContextMenu=${(e) => openMemberMenu(e, g, k)}
            title=${st.screen ? (me ? 'Show your stream' : `Watch ${model.memberName(g, k)}'s stream`) : 'Profile · right-click for options'}>
            <${Avatar} name=${model.memberName(g, k)} color=${model.memberColor(g, k)} src=${model.memberAvatar(g, k)} size=${22} speaking=${voice.speaking.has(k)} />
            <span class="vu-name">${model.memberName(g, k)}</span>
            ${watches.length > 0 && html`<span class="vu-watch" title=${'Watching ' + watches.map(w => w === model.me.key ? 'your' : model.memberName(g, w) + "'s").join(', ') + ' stream'}><${Icon} name="eye" size=${13} /></span>`}
            ${st.screen && html`<span class="live" title=${viewers ? viewers + ' watching' : 'Nobody watching'}>LIVE${viewers ? ' · ' + viewers : ''}</span>`}
            ${st.cam && html`<${Icon} name="camera" size=${14} class="dim" />`}
            <${MuteIcons} g=${g} k=${k} st=${st} />
          </div>`
      })}
    </div>`
}

// Clicking someone in a voice channel: their stream if they share their screen (joining the
// channel first if needed), otherwise their profile card
async function clickVoiceUser (e, g, c, k, st) {
  if (!st.screen) return openMemberMenu(e, g, k)
  model.ui.stage = { gid: g.id, ch: c.id, focus: { id: k + ':screen', n: Date.now() } }
  model.emit()
  if (k === model.me.key) return
  if (!voice.inChannel(g.id, c.id)) {
    if (g.kickedMe) return
    await act(() => voice.join(g.id, c.id))
    if (!voice.inChannel(g.id, c.id)) return
  }
  voice.watchScreen(k)
  model.emit()
}

// For the channel / folder modals: every folder with its path, for a "Folder" picker
export function folderOptions (g, { excluding = null } = {}) {
  const out = []
  const walk = (nodes, prefix) => {
    for (const n of nodes) {
      if (excluding && (n.f.id === excluding || model.inFolder(g, n.f.id, g.folders.get(excluding)))) continue
      out.push({ id: n.f.id, label: prefix + n.f.name, f: n.f })
      walk(n.items.filter(i => i.node).map(i => i.node), prefix + n.f.name + ' / ')
    }
  }
  walk(model.channelTree(g).folders, '')
  return out
}

export { folderFits }
