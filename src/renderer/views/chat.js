import { html, useState, useEffect, useLayoutEffect, useRef, useMemo } from '../vendor/preact-htm.js'
import {
  api, model, voice, append, act, rid, fmtTime, fmtDay, fmtStamp, fmtBytes, initials, blobUrl, blobState,
  fetchBlob, importFiles
} from '../lib/core.js'
import { renderMarkdown, renderMarkdownDoc, isEmojiOnly, previewableUrls } from '../lib/markdown.js'
import { highlight, extOf, langFor, langLabel } from '../lib/highlight.js'
import { DM_CALL } from '../lib/model.js'
import { Icon } from '../lib/icons.js'
import { askClaude, mentionsClaude, claudeBlocked, stopClaude, MODEL_LABEL, isClaudeAnswer } from '../lib/claude.js'
import { EmojiPanel, EmojiSuggest, loadEmoji, searchEmoji, rememberEmoji } from './emoji.js'
import { GameCard } from './games.js'
import { PollCard } from './polls.js'
import { openMemberMenu } from './members.js'
import { OutdatedBanner } from './compat.js'
import { PlayInCall, musicCommand } from './music.js'
import { keyLabel } from '../lib/keys.js'

const drafts = new Map()
const PAGE = 150

export function Avatar ({ name, color, src = null, size = 40, speaking = false, dot = null }) {
  return html`
    <div class="avatar ${speaking ? 'speaking' : ''} ${src ? 'has-img' : ''}" style=${{ width: size + 'px', height: size + 'px', '--c': color, fontSize: Math.round(size * 0.38) + 'px' }}>
      ${src ? html`<img src=${src} alt="" draggable="false" />` : html`<span>${initials(name)}</span>`}
      ${dot && html`<i class="presence ${dot}" />`}
    </div>`
}

export function ClaudeAvatar ({ size = 40 }) {
  return html`<div class="avatar claude-avatar" style=${{ width: size + 'px', height: size + 'px' }}><${Icon} name="sparkle" size=${Math.round(size * 0.55)} /></div>`
}

// Names that highlight as @mentions: members, and Claude
const useNames = (g) => useMemo(() => new Set(['claude', ...[...g.members.values()].map(m => (m.name || '').toLowerCase()).filter(Boolean)]), [g.members.size, model.me.name])

// Messages run together under one name when the same person posts again soon after
const groupable = (prev, m) => !!prev && prev.a === m.a && !!prev.bot === !!m.bot && !prev.game && !m.game && m.t - prev.t < 7 * 60 * 1000

export function jumpToMessage (id) {
  // A reply that lives only in a thread: open the thread instead
  const g = model.currentGroup()
  const m = g?.msgById.get(id)
  if (m?.th && !m.also) { model.openThread(g.id, m.th); return }
  model.ui.jumpTo = id
  model.emit()
}

function fmtAgo (t) {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + ' min ago'
  if (s < 86400) return Math.floor(s / 3600) + ' h ago'
  return fmtStamp(t)
}

// "3 replies · Last reply 5 min ago" under a message that has a thread
// One line of a message without markdown symbols, for "replied to …" previews
const snippet = (text) => text
  .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
  .replace(/\*\*|__|~~|\|\||`/g, '')
  .replace(/(^|\s)[*_](?=\S)([^*_\n]+?)[*_](?=\s|$|[.,!?])/g, '$1$2')
  .replace(/^\s*(#{1,3}|>)\s+/gm, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120)

function ThreadSummary ({ g, m }) {
  const info = model.threadInfo(g, m.id)
  if (!info) return null
  const unread = model.threadUnread(g, m.id)
  const open = model.ui.thread?.id === m.id
  return html`
    <button class="thread-summary ${open ? 'open' : ''} ${unread ? 'unread' : ''}" onClick=${() => model.openThread(g.id, m.id)}>
      <span class="ts-people">${info.people.map(k => html`<${Avatar} key=${k} name=${model.memberName(g, k)} color=${model.memberColor(g, k)} src=${model.memberAvatar(g, k)} size=${20} />`)}</span>
      <b>${info.count} ${info.count === 1 ? 'reply' : 'replies'}</b>
      ${unread > 0 && html`<span class="ts-new">${unread} new</span>`}
      <small>Last reply ${fmtAgo(info.last)}</small>
      <span class="ts-view">View thread <${Icon} name="chevronRight" size=${14} /></span>
    </button>`
}

// The side panel with one thread: the message it started from, the replies, a composer
export function ThreadPanel ({ g }) {
  const id = model.ui.thread.id
  const root = g.msgById.get(id)
  const replies = model.threadOf(g, id)
  const ch = g.channels.get(root?.ch || replies[0]?.ch) || model.currentChannel(g)
  const ref = useRef()
  const stick = useRef(true)
  useLayoutEffect(() => { if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight })
  useEffect(() => { if (model.ui.focused) model.markThreadRead(g.id, id) })
  useEffect(() => { stick.current = true }, [id])
  const names = useNames(g)
  const ctx = { names, myName: (model.me.name || '').toLowerCase(), openLink: (u) => openLink(u) }
  const drafts = [...g.claudeDrafts.values()].filter(x => x.th === id)
  const onScroll = () => {
    const el = ref.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }
  const onMediaLoad = () => { if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight }
  let prev = null
  return html`
    <aside class="thread-panel">
      <header>
        <${Icon} name="thread" size=${20} class="dim" />
        <div class="tp-title"><b>Thread</b><small>${g.dm ? model.groupName(g) : '#' + (ch?.name || 'channel')}</small></div>
        <div class="spacer" />
        <button class="icon-btn" title="Close thread" onClick=${() => model.closeThread()}><${Icon} name="x" /></button>
      </header>
      <div class="thread-body" ref=${ref} onScroll=${onScroll}>
        ${root && !root.deleted
          ? html`<${Message} g=${g} m=${root} grouped=${false} ctx=${ctx} onMediaLoad=${onMediaLoad} inThread=${true} />`
          : html`<div class="thread-missing"><${Icon} name="trash" size=${16} /> The message this thread started from was deleted.</div>`}
        <div class="thread-divider"><span>${replies.length ? `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : 'No replies yet'}</span></div>
        ${replies.map((m) => {
          const grouped = groupable(prev, m)
          prev = m
          return html`<${Message} key=${m.id} g=${g} m=${m} grouped=${grouped} ctx=${ctx} onMediaLoad=${onMediaLoad} inThread=${true} />`
        })}
        ${drafts.map(d => html`<${ClaudeDraft} key=${d.id} g=${g} d=${d} ctx=${ctx} />`)}
      </div>
      ${ch && html`<${Composer} key=${'t' + g.id + id} g=${g} ch=${ch} thread=${id} />`}
    </aside>`
}

// opendiscord:// links open in the app; web links in the browser
export function openLink (url) {
  if (/^opendiscord:\/\//i.test(url)) model.openModal('openLink', { url })
  else api.openExternal(url)
}

export function startDmCall (g) {
  model.ui.stage = { gid: g.id, ch: DM_CALL }
  model.emit()
  if (!voice.inChannel(g.id, DM_CALL)) act(() => voice.join(g.id, DM_CALL))
}

export function ChatView ({ g, ch }) {
  const [dragging, setDragging] = useState(false)
  const composerRef = useRef()
  const onDrop = async (e) => {
    e.preventDefault()
    setDragging(false)
    if (g.kickedMe) return
    const paths = [...(e.dataTransfer?.files || [])].map(f => api.pathForFile(f)).filter(Boolean)
    if (paths.length) composerRef.current?.addPaths(paths)
  }
  const dm = g.dm
  const friendName = dm ? model.groupName(g) : ''
  const pending = dm && !model.isFriend(dm)
  return html`
    <section class="chat"
      onDragOver=${(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragging(true) } }}
      onDragLeave=${(e) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget)) setDragging(false) }}
      onDrop=${onDrop}>
      <header class="chat-header">
        ${dm
          ? html`<${Avatar} name=${friendName} color=${model.memberColor(g, dm)} src=${model.memberAvatar(g, dm)} size=${26} dot=${model.presence(g, dm)} /><h2>${friendName}</h2>`
          : html`<${Icon} name="hash" size=${22} class="dim" /><h2>${ch.name}</h2>`}
        <span class="header-note"><${Icon} name="lock" size=${13} /> ${dm ? 'Private: only the two of you have the key' : "Stored only on your friends' devices"}</span>
        <div class="spacer" />
        ${dm && html`<button class="icon-btn" title=${voice.inChannel(g.id, DM_CALL) ? 'Open call' : 'Start a call'} onClick=${() => startDmCall(g)}><${Icon} name="phone" /></button>`}
        ${dm && html`<button class="icon-btn" title="Shared calendar" onClick=${() => model.openPlanner(g.id, 'calendar')}><${Icon} name="calendar" /></button>`}
        ${dm && html`<button class="icon-btn" title="Shared tasks" onClick=${() => model.openPlanner(g.id, 'tasks')}><${Icon} name="tasks" /></button>`}
        ${dm && html`<button class="icon-btn" title="Focus docs: write together" onClick=${() => model.openDocs(g.id)}><${Icon} name="focus" /></button>`}
        ${dm
          ? html`<button class="icon-btn" title="Games" onClick=${() => model.openGames(g.id)}><${Icon} name="chess" /></button>`
          : !g.kickedMe && model.appOn(g, 'games') && html`<button class="icon-btn" title="Play a game in this channel" onClick=${() => model.openModal('newGame', { gid: g.id, ch: ch.id })}><${Icon} name="chess" /></button>`}
        ${!g.kickedMe && !g.restoring && html`<button class="icon-btn" title="Create a poll" onClick=${() => model.openModal('poll', { gid: g.id, ch: ch.id })}><${Icon} name="poll" /></button>`}
        <${PinsButton} g=${g} ch=${ch} />
        <button class="icon-btn ${model.ui.search?.gid === g.id ? 'on' : ''}" title=${'Search (' + keyLabel('Ctrl+F') + ')'} onClick=${() => model.openSearch('')}><${Icon} name="search" /></button>
        ${!dm && model.canInvite(g) && html`<button class="icon-btn" title="Invite friends" onClick=${() => model.openModal('invite', { gid: g.id })}><${Icon} name="userPlus" /></button>`}
      </header>
      ${g.kickedMe && html`
        <div class="banner bad removed-banner">
          <span>You were removed from this group. You won't receive new messages.</span>
          <button class="btn sm" onClick=${() => leaveGroupFlow(g)}>Leave group</button>
        </div>`}
      <${OutdatedBanner} g=${g} />
      ${pending && html`
        <div class="banner info">
          <${Icon} name="userPlus" size=${16} />
          <span>Waiting for <b>${friendName}</b> to accept your friend request. Messages you send now arrive once they do.</span>
        </div>`}
      <${MessageList} key=${g.id + ch.id} g=${g} ch=${ch} />
      <${Composer} key=${'c' + g.id + ch.id} handle=${composerRef} g=${g} ch=${ch} />
      ${dragging && html`<div class="drop-overlay"><div><${Icon} name="clip" size=${40} /><p>Drop to send to <b>${dm ? friendName : '#' + ch.name}</b></p><small>Files go straight to your friends — no upload limits</small></div></div>`}
    </section>`
}

export function leaveGroupFlow (g) {
  model.openModal('confirm', {
    title: `Leave ${model.groupName(g)}?`,
    body: 'This deletes the group and its history from this device. You can rejoin later with an invite code, and history will sync back from your friends.',
    confirm: 'Leave group',
    danger: true,
    onConfirm: async () => {
      if (voice.active?.gid === g.id) voice.leave()
      await act(() => api.leaveGroup(g.id))
      model.removeGroup(g.id)
    }
  })
}

function PinsButton ({ g, ch }) {
  const [open, setOpen] = useState(false)
  const ref = useRef()
  const pins = model.pinnedIn(g, ch.id)
  useEffect(() => {
    if (!open) return
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    setTimeout(() => document.addEventListener('mousedown', off), 0)
    return () => document.removeEventListener('mousedown', off)
  }, [open])
  const ctx = { names: new Set(), myName: '', openLink: (u) => openLink(u) }
  return html`
    <div class="pins-wrap" ref=${ref}>
      <button class="icon-btn ${open ? 'on' : ''}" title="Pinned messages" onClick=${() => setOpen(!open)}>
        <${Icon} name="pin" />${pins.length > 0 && html`<span class="count-badge">${pins.length}</span>`}
      </button>
      ${open && html`
        <div class="pins-panel">
          <header><b>Pinned messages</b><small>${pins.length ? pins.length + ' pinned' : ''}</small></header>
          <div class="pins-list">
            ${!pins.length && html`<div class="pins-empty"><${Icon} name="pin" size=${28} /><p>Nothing pinned yet. Hover a message and click the pin to keep it here for everyone.</p></div>`}
            ${pins.map(({ m, by }) => html`
              <div key=${m.id} class="pin-item">
                <${Avatar} name=${model.memberName(g, m.a)} color=${model.memberColor(g, m.a)} src=${model.memberAvatar(g, m.a)} size=${32} />
                <div class="pin-body">
                  <div class="msg-head"><span class="author" style=${{ color: model.memberColor(g, m.a) }}>${model.memberName(g, m.a)}</span><time>${fmtStamp(m.t)}</time></div>
                  <div class="text">${m.text ? renderMarkdown(m.text.slice(0, 600), ctx) : html`<i class="muted">📎 ${m.att.map(a => a.n).join(', ')}</i>`}</div>
                  <small class="muted">Pinned by ${model.memberName(g, by)}</small>
                </div>
                <div class="pin-actions">
                  <button class="btn sm" onClick=${() => { setOpen(false); jumpToMessage(m.id) }}>Jump</button>
                  <button class="icon-btn small" title="Unpin" onClick=${() => act(() => append(g.id, 'msg.pin', { id: m.id, on: false }))}><${Icon} name="x" size=${14} /></button>
                </div>
              </div>`)}
          </div>
        </div>`}
    </div>`
}

function MessageList ({ g, ch }) {
  const list = g.messages.get(ch.id) || []
  const [limit, setLimit] = useState(PAGE)
  const ref = useRef()
  const stick = useRef(true)
  const prevHeight = useRef(0)
  const [atBottom, setAtBottom] = useState(true)
  const [unreadAfter] = useState(() => model.lastRead[g.id + ':' + ch.id] || g.joinedAt)
  const shown = list.slice(Math.max(0, list.length - limit))

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (prevHeight.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current
      prevHeight.current = 0
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight
    }
  })

  useEffect(() => {
    if (model.ui.focused && stick.current) model.markRead(g.id, ch.id)
  })

  // Jump to a message (pins, replies): load enough history, then scroll to it and flash it
  useEffect(() => {
    const id = model.ui.jumpTo
    if (!id) return
    const idx = list.findIndex(m => m.id === id)
    if (idx < 0) { model.ui.jumpTo = null; return }
    stick.current = false
    if (idx < list.length - limit) { setLimit(list.length - idx + 20); return }
    model.ui.jumpTo = null
    requestAnimationFrame(() => {
      const el = document.getElementById('msg-' + id)
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('flash')
      setTimeout(() => el.classList.remove('flash'), 1800)
    })
  })

  const lastTop = useRef(0)
  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    // Only an upward scroll means "the user left the bottom". Our own scroll-to-bottom can land
    // a frame after content grew (a file preview loaded), and must not unpin the view.
    if (bottom) stick.current = true
    else if (el.scrollTop < lastTop.current - 2) stick.current = false
    lastTop.current = el.scrollTop
    if (stick.current !== atBottom) setAtBottom(stick.current)
    if (bottom && model.ui.focused) model.markRead(g.id, ch.id)
    if (el.scrollTop < 300 && limit < list.length) {
      prevHeight.current = el.scrollHeight
      setLimit(limit + PAGE)
    }
  }
  const onMediaLoad = () => { if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight }
  // Content that grows after rendering (file previews, link previews, late images) keeps the
  // view pinned to the newest message while you're at the bottom
  const inner = useRef(null)
  useEffect(() => {
    if (!inner.current || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(onMediaLoad)
    ro.observe(inner.current)
    return () => ro.disconnect()
  }, [])

  const names = useNames(g)
  const ctx = { names, myName: (model.me.name || '').toLowerCase(), openLink: (u) => openLink(u) }
  const drafts = model.claudeDraftsIn(g, ch.id)

  const rows = []
  let prev = shown.length < list.length ? null : undefined
  let shownNew = false
  for (const m of shown) {
    if (!prev || fmtDay(prev.t) !== fmtDay(m.t)) rows.push(html`<div class="day-divider" key=${'d' + m.id}><span>${fmtDay(m.t)}</span></div>`)
    if (!shownNew && m.t > unreadAfter && m.a !== model.me.key) {
      shownNew = true
      rows.push(html`<div class="new-divider" key="new"><span>NEW</span></div>`)
    }
    const grouped = groupable(prev, m) && fmtDay(prev.t) === fmtDay(m.t) && !m.re && !m.also && !m.deleted && !prev.deleted && !model.threadInfo(g, prev.id)
    rows.push(html`<${Message} key=${m.id} g=${g} m=${m} grouped=${grouped} ctx=${ctx} onMediaLoad=${onMediaLoad} />`)
    prev = m
  }

  const friend = g.dm ? model.groupName(g) : ''
  return html`
    <div class="messages" ref=${ref} onScroll=${onScroll}><div ref=${inner}>
      ${shown.length === list.length && (g.dm
        ? html`
          <div class="channel-intro">
            <${Avatar} name=${friend} color=${model.memberColor(g, g.dm)} src=${model.memberAvatar(g, g.dm)} size=${80} />
            <h1>${friend}</h1>
            <p>This is the beginning of your private chat with <b>${friend}</b>. Its key comes from a key exchange between your two identities, so nobody else can ever join or read it.</p>
          </div>`
        : html`
          <div class="channel-intro">
            <div class="intro-icon"><${Icon} name="hash" size=${36} /></div>
            <h1>Welcome to #${ch.name}</h1>
            <p>This is the start of the channel. Messages are signed by their author and synced directly between your devices — there is no server.</p>
          </div>`)}
      ${rows}
      ${drafts.map(d => html`<${ClaudeDraft} key=${d.id} g=${g} d=${d} ctx=${ctx} />`)}
      <div class="messages-end" />
    </div></div>
    ${!atBottom && html`<button class="jump" onClick=${() => { stick.current = true; ref.current.scrollTop = ref.current.scrollHeight }}>Jump to present ↓</button>`}`
}

// An answer Claude is still writing, streamed live from the asker's app
function ClaudeDraft ({ g, d, ctx }) {
  const md = useMemo(() => (d.text ? renderMarkdownDoc(d.text, ctx) : null), [d.text])
  return html`
    <div class="msg bot draft">
      <div class="msg-avatar"><${ClaudeAvatar} /></div>
      <div class="msg-body">
        <div class="msg-head"><span class="author claude-name">Claude</span><span class="bot-tag">AI</span><small class="asked-by">for ${model.memberName(g, d.by)}</small></div>
        ${md
          ? html`<div class="text">${md}</div>`
          : html`<div class="text thinking"><span class="dots"><i /><i /><i /></span> ${d.status || 'Thinking…'}</div>`}
        ${md && d.status && html`<small class="muted">${d.status}</small>`}
        ${d.by === model.me.key && html`<button class="btn sm stop-btn" onClick=${() => stopClaude(d.id)}><${Icon} name="stop" size=${11} /> Stop</button>`}
      </div>
    </div>`
}

function Message ({ g, m, grouped, ctx, onMediaLoad, inThread = false }) {
  const mine = m.a === model.me.key
  const bot = !!m.bot
  const editing = model.ui.editing === m.id
  const [picker, setPicker] = useState(false)
  const name = bot ? 'Claude' : model.memberName(g, m.a)
  const color = bot ? null : model.memberColor(g, m.a)
  // deleted, but replies in its thread keep it in the channel
  if (m.deleted) {
    if (inThread || !model.threadInfo(g, m.id)) return null
    return html`
      <div id=${'msg-' + m.id} class="msg deleted">
        <div class="msg-avatar"><div class="deleted-mark"><${Icon} name="trash" size=${16} /></div></div>
        <div class="msg-body">
          <div class="text"><i class="muted">This message was deleted.</i></div>
          <${ThreadSummary} g=${g} m=${m} />
        </div>
      </div>`
  }
  if (!m._md || m._mdText !== m.text) { m._md = bot ? renderMarkdownDoc(m.text, ctx) : renderMarkdown(m.text, ctx); m._mdText = m.text }
  const threadRoot = m.also ? g.msgById.get(m.th) : null
  const mention = !mine && model.mentionsMe(m.text)
  const parent = m.re ? g.msgById.get(m.re) : null
  const pinned = model.isPinned(g, m.id)
  const embeds = model.embedsOf(g, m)

  const react = (e) => {
    const mineOn = m.reactions.get(e)?.get(model.me.key)?.on
    act(() => append(g.id, 'react', { id: m.id, e, on: !mineOn }))
  }
  const del = (ev) => {
    // ch/at keep the spot of a deleted message that has a thread (see model msg.delete)
    const doIt = () => act(() => append(g.id, 'msg.delete', { id: m.id, ch: m.ch, at: m.t }))
    if (ev.shiftKey) doIt()
    else model.openModal('confirm', { title: 'Delete message', body: 'Delete this message for everyone? Friends who are offline will remove it when they next sync.', confirm: 'Delete', danger: true, onConfirm: doIt })
  }
  const pin = () => act(() => append(g.id, 'msg.pin', { id: m.id, on: !pinned }))

  return html`
    <div id=${'msg-' + m.id} class="msg ${grouped ? 'grouped' : ''} ${mention ? 'mention' : ''} ${editing ? 'editing' : ''} ${pinned ? 'pinned' : ''} ${bot ? 'bot' : ''} ${m.game ? 'has-game' : ''} ${m.poll ? 'has-poll' : ''}">
      ${m.also && !inThread && html`
        <div class="reply-ref thread-ref" onClick=${() => model.openThread(g.id, m.th)}>
          <${Icon} name="thread" size=${13} />
          <span>replied to a thread:</span>
          ${threadRoot && !threadRoot.deleted ? html`<span class="reply-snippet">${snippet(threadRoot.text) || '📎 attachment'}</span>` : html`<i>deleted message</i>`}
        </div>`}
      ${m.re && html`
        <div class="reply-ref" onClick=${() => jumpToMessage(m.re)}>
          <span class="reply-line" />
          ${parent && !parent.deleted
            ? html`<b class=${parent.bot ? 'claude-name' : ''} style=${parent.bot ? null : { color: model.memberColor(g, parent.a) }}>${parent.bot ? 'Claude' : model.memberName(g, parent.a)}</b><span class="reply-snippet">${parent.game ? (g.games.get(parent.id)?.info?.kind === 'poker' ? '🃏 poker table' : '♟ chess game') : parent.poll ? '📊 ' + parent.poll.q : snippet(parent.text) || '📎 attachment'}</span>`
            : html`<i>Original message was deleted</i>`}
        </div>`}
      ${grouped
        ? html`<span class="gutter-time">${fmtTime(m.t)}</span>`
        : html`<div class="msg-avatar">${bot ? html`<${ClaudeAvatar} />` : html`<button class="avatar-btn" title=${'Profile of ' + name} onClick=${(e) => openMemberMenu(e, g, m.a)} onContextMenu=${(e) => openMemberMenu(e, g, m.a)}><${Avatar} name=${name} color=${color} src=${model.memberAvatar(g, m.a)} /></button>`}</div>`}
      <div class="msg-body">
        ${!grouped && html`
          <div class="msg-head">
            ${bot
              ? html`<span class="author claude-name">${name}</span>`
              : html`<span class="author clickable" style=${color ? { color } : null} onClick=${(e) => openMemberMenu(e, g, m.a)} onContextMenu=${(e) => openMemberMenu(e, g, m.a)}>${name}</span>`}
            ${bot && html`<span class="bot-tag">AI</span><small class="asked-by" title="Asked with their own API key">for <a onClick=${(e) => openMemberMenu(e, g, m.a)}>${model.memberName(g, m.a)}</a> · ${MODEL_LABEL[m.bot.model] || m.bot.model || 'Claude'}</small>`}
            <time title=${new Date(m.t).toLocaleString()}>${fmtStamp(m.t)}</time>${pinned && html`<span class="pin-mark" title="Pinned"><${Icon} name="pin" size=${12} /></span>`}
          </div>`}
        ${editing
          ? html`<${EditBox} g=${g} m=${m} />`
          : m.game
            ? html`<${GameCard} g=${g} m=${m} />`
            : m.poll
              ? html`<${PollCard} g=${g} m=${m} />`
              : m.text && html`<div class="text ${isEmojiOnly(m.text) ? 'jumbo' : ''}">${m._md}${m.edited ? html`<span class="edited" title=${'Edited ' + new Date(m.edited).toLocaleString()}> (edited)</span>` : ''}${grouped && pinned ? html`<span class="pin-mark" title="Pinned"><${Icon} name="pin" size=${12} /></span>` : ''}</div>`}
        ${m.att.length > 0 && html`<div class="attachments">${m.att.map(a => html`<${Attachment} key=${a.h} g=${g} a=${a} onLoad=${onMediaLoad} />`)}</div>`}
        ${embeds.length > 0 && html`<div class="embeds">${embeds.map(e => html`<${Embed} key=${e.url} e=${e} onLoad=${onMediaLoad} />`)}</div>`}
        ${m.reactions.size > 0 && html`
          <div class="reactions">
            ${[...m.reactions].map(([e, by]) => {
              const who = [...by].filter(([, v]) => v.on).map(([k]) => k)
              if (!who.length) return null
              return html`<button key=${e} class="reaction ${who.includes(model.me.key) ? 'mine' : ''}" title=${who.map(k => model.memberName(g, k)).join(', ')} onClick=${() => react(e)}>${e} <b>${who.length}</b></button>`
            })}
          </div>`}
        ${!inThread && !m.th && html`<${ThreadSummary} g=${g} m=${m} />`}
      </div>
      ${!editing && !g.kickedMe && html`
        <div class="msg-tools">
          <button title="Add reaction" data-emoji-toggle onClick=${() => setPicker(!picker)}><${Icon} name="smile" size=${18} /></button>
          ${!inThread && html`<button title="Reply" onClick=${() => { model.ui.replyTo = m.id; model.emit(); document.querySelector('.chat .composer textarea')?.focus() }}><${Icon} name="reply" size=${18} /></button>`}
          ${!inThread && !m.th && html`<button title="Reply in thread" class="thread-btn" onClick=${() => model.openThread(g.id, m.id)}><${Icon} name="thread" size=${18} /></button>`}
          <button title=${pinned ? 'Unpin' : 'Pin message'} class=${pinned ? 'on' : ''} onClick=${pin}><${Icon} name="pin" size=${18} /></button>
          ${mine && !bot && !m.game && !m.poll && html`<button title="Edit" onClick=${() => { model.ui.editing = m.id; model.emit() }}><${Icon} name="edit" size=${18} /></button>`}
          ${mine && html`<button title="Delete (shift-click to skip confirmation)" class="danger" onClick=${del}><${Icon} name="trash" size=${18} /></button>`}
        </div>`}
      ${picker && html`<${EmojiPanel} class="for-message" onPick=${react} onClose=${() => setPicker(false)} />`}
    </div>`
}

function Embed ({ e, onLoad }) {
  const open = () => api.openExternal(e.url)
  const ratio = e.w && e.h ? { aspectRatio: `${e.w} / ${e.h}` } : {}
  if (e.kind === 'image') {
    return html`<img class="embed-image" src=${e.image} title=${e.url} style=${{ ...ratio, width: Math.min(e.w || 400, 400) + 'px' }} onLoad=${onLoad} onClick=${open} />`
  }
  return html`
    <div class="embed ${e.large ? 'large' : ''}" style=${{ '--c': e.color || 'var(--border-strong)' }}>
      <div class="embed-text">
        ${e.site && html`<div class="embed-site">${e.site}</div>`}
        ${e.title && html`<a class="embed-title" title=${e.url} onClick=${open}>${e.title}</a>`}
        ${e.description && html`<div class="embed-desc">${e.description}</div>`}
      </div>
      ${e.image && (e.large
        ? html`<button class="embed-media" title=${e.url} onClick=${open}><img src=${e.image} style=${ratio} onLoad=${onLoad} />${e.video && html`<span class="embed-play"><${Icon} name="play" size=${22} /></span>`}</button>`
        : html`<img class="embed-thumb" src=${e.image} onClick=${open} onLoad=${onLoad} />`)}
    </div>`
}

function EditBox ({ g, m }) {
  const [text, setText] = useState(m.text)
  const ref = useRef()
  useEffect(() => { const el = ref.current; el.focus(); el.setSelectionRange(el.value.length, el.value.length); autosize(el) }, [])
  const close = () => { model.ui.editing = null; model.emit() }
  const save = () => {
    const t = text.trim()
    if (!t && !m.att.length) return
    if (t !== m.text) act(() => append(g.id, 'msg.edit', { id: m.id, text: t }))
    close()
  }
  return html`
    <div class="edit-box">
      <textarea ref=${ref} value=${text} onInput=${(e) => { setText(e.target.value); autosize(e.target) }}
        onKeyDown=${(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() }
          if (e.key === 'Escape') close()
        }} />
      <small>Escape to <a onClick=${close}>cancel</a> · Enter to <a onClick=${save}>save</a></small>
    </div>`
}

const IMG = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/
const VID = /^video\/(mp4|webm)$/
const AUD = /^audio\/(mpeg|ogg|wav|mp4|flac|webm)$/
const PLAIN_TEXT = new Set(['txt', 'log', 'csv', 'tsv', 'text', 'nfo', 'srt', 'license', 'readme', 'cfg'])
const MAX_TEXT_PREVIEW = 1024 * 1024

export function isTextFile (a) {
  if (a.s > MAX_TEXT_PREVIEW) return false
  const ext = extOf(a.n)
  return PLAIN_TEXT.has(ext) || !!langFor(ext) || /^text\//.test(a.m) || a.m === 'application/json'
}

const textCache = new Map() // hash -> Promise<string>
export function useBlobText (a, have) {
  const [text, setText] = useState(null)
  useEffect(() => {
    if (!have) return
    let p = textCache.get(a.h)
    if (!p) {
      p = fetch(blobUrl(a)).then(r => r.arrayBuffer()).then(b => new TextDecoder('utf-8').decode(b))
      textCache.set(a.h, p)
      p.catch(() => textCache.delete(a.h))
    }
    let alive = true
    p.then(v => { if (alive) setText(v) }, () => { if (alive) setText('') })
    return () => { alive = false }
  }, [have, a.h])
  return text
}

export function CodeView ({ text, ext }) {
  const body = useMemo(() => highlight(text, ext), [text, ext])
  const count = text.split('\n').length
  const nums = useMemo(() => Array.from({ length: count }, (_, i) => i + 1).join('\n'), [count])
  return html`<pre class="codeblock numbered"><span class="ln" aria-hidden="true">${nums}</span><code>${body}</code></pre>`
}

const docCtx = { openLink: (u) => api.openExternal(u) }
export const MarkdownView = ({ text }) => useMemo(() => renderMarkdownDoc(text, docCtx), [text])

const PREVIEW_LINES = 14
function TextPreview ({ g, a, text, onLoad }) {
  const ext = extOf(a.n)
  const md = ext === 'md' || ext === 'markdown'
  const [expanded, setExpanded] = useState(false)
  const lines = text.split('\n')
  const long = md ? text.length > 1200 || lines.length > 30 : lines.length > PREVIEW_LINES
  const shown = md || expanded || !long ? text : lines.slice(0, PREVIEW_LINES).join('\n')
  useEffect(() => { onLoad?.() }, [expanded, text])
  return html`
    <div class="text-preview ${md ? 'md' : 'code'} ${expanded ? 'expanded' : ''} ${long ? 'long' : ''}">
      <div class="tp-head">
        <${Icon} name=${md ? 'file' : 'code'} size=${16} />
        <span class="tp-name" title=${a.n}>${a.n}</span>
        <small>${md ? 'Markdown' : langLabel(ext)} · ${lines.length} line${lines.length === 1 ? '' : 's'} · ${fmtBytes(a.s)}</small>
        <div class="spacer" />
        <button class="icon-btn small" title="Open" onClick=${() => model.openModal('textFile', { a, gid: g.id })}><${Icon} name="maximize" size=${16} /></button>
        <button class="icon-btn small" title="Save to disk" onClick=${() => act(() => api.saveBlob(a.h, a.n))}><${Icon} name="download" size=${16} /></button>
      </div>
      <div class="tp-body">${md ? html`<${MarkdownView} text=${text} />` : html`<${CodeView} text=${shown} ext=${ext} />`}</div>
      ${long && html`<button class="tp-more" onClick=${() => setExpanded(!expanded)}>${expanded ? 'Show less' : md ? 'Show more' : `Show all ${lines.length} lines`}</button>`}
    </div>`
}

function Attachment ({ g, a, onLoad }) {
  const st = blobState(a.h, g.id, a.s)
  const have = st.state === 'have'
  const textual = isTextFile(a)
  const text = useBlobText(a, have && textual)
  if (have && IMG.test(a.m)) {
    const ratio = a.w && a.hh ? { aspectRatio: `${a.w} / ${a.hh}`, width: Math.min(a.w, 420) + 'px' } : {}
    return html`<img class="att-image" src=${blobUrl(a)} alt=${a.n} style=${ratio} onLoad=${onLoad} onClick=${() => model.openModal('image', { a })} />`
  }
  if (have && VID.test(a.m)) return html`<video class="att-video" src=${blobUrl(a)} controls preload="metadata" onLoadedMetadata=${onLoad} />`
  if (have && textual && text != null && !text.includes('\u0000')) return html`<${TextPreview} g=${g} a=${a} text=${text} onLoad=${onLoad} />`
  const pct = st.state === 'fetching' && st.s > 0 ? Math.round((st.r / st.s) * 100) : null
  return html`
    <div class="att-file">
      <${Icon} name=${textual ? 'code' : 'file'} size=${30} class="att-icon" />
      <div class="att-meta">
        <span class="att-name" title=${a.n}>${a.n}</span>
        <small>${fmtBytes(a.s)}${st.state === 'fetching' ? ` · receiving ${pct != null ? pct + '%' : '…'}` : ''}${st.state === 'error' ? ' · ' + st.err : ''}</small>
        ${st.state === 'fetching' && html`<div class="progress"><i style=${{ width: (pct || 2) + '%' }} /></div>`}
        ${have && AUD.test(a.m) && html`<audio src=${blobUrl(a)} controls preload="metadata" />`}
      </div>
      ${have && AUD.test(a.m) && html`<${PlayInCall} g=${g} a=${a} />`}
      ${have
        ? html`<button class="icon-btn" title="Save to disk" onClick=${() => act(() => api.saveBlob(a.h, a.n))}><${Icon} name="download" /></button>`
        : st.state !== 'fetching' && html`<button class="icon-btn" title="Download from friends" onClick=${() => fetchBlob(a.h, g.id)}><${Icon} name="download" /></button>`}
    </div>`
}

function autosize (el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 320) + 'px'
}

// The sender's app makes link previews (see main/linkpreview.js) and attaches them to the
// message as signed ops, so friends never contact the linked site themselves.
async function attachPreviews (gid, id, text) {
  if (model.settings.linkPreviews === false) return
  await Promise.all(previewableUrls(text).map(async (url) => {
    try {
      const e = await api.linkPreview(url)
      if (e && model.groups.has(gid)) await append(gid, 'msg.embed', { id, ...e })
    } catch (err) { console.warn('[preview]', url, err) }
  }))
}

const SHORTCODE = /(^|[\s(])(:[\w+-]{2,32})$/
const MENTION = /(^|[\s(])@([\p{L}\p{N}_.-]{0,32})$/u

// "@cl…": people in the chat, and Claude
function mentionItems (g, query) {
  const q = query.toLowerCase()
  const out = []
  if ('claude'.startsWith(q)) out.push({ kind: 'claude', label: 'Claude', insert: '@claude', hint: model.claude?.hasKey ? 'Ask Claude (your API key)' : 'Needs your API key' })
  for (const m of model.membersOf(g)) {
    const name = model.memberName(g, m.key)
    if (m.key === model.me.key || !name || !name.toLowerCase().startsWith(q)) continue
    out.push({ kind: 'member', key: m.key, label: name, insert: '@' + name })
    if (out.length >= 8) break
  }
  return out
}

function MentionSuggest ({ g, items, index, onPick }) {
  if (!items.length) return null
  return html`
    <div class="emoji-suggest mention-suggest">
      <div class="es-head">Mention</div>
      ${items.map((x, i) => html`
        <button key=${x.insert} class=${i === index ? 'active' : ''} onMouseDown=${(e) => { e.preventDefault(); onPick(x) }}>
          ${x.kind === 'claude' ? html`<${ClaudeAvatar} size=${22} />` : html`<${Avatar} name=${x.label} color=${model.memberColor(g, x.key)} src=${model.memberAvatar(g, x.key)} size=${22} />`}
          <span class="ms-name">${x.label}</span>
          ${x.hint && html`<small>${x.hint}</small>`}
        </button>`)}
    </div>`
}

// Shown above the composer while the message mentions @claude (or replies to Claude)
function ClaudeHint ({ g, again = false }) {
  const why = claudeBlocked(g)
  const model_ = MODEL_LABEL[model.settings.claude?.model] || 'Claude'
  if (why === 'nokey') {
    return html`<div class="claude-hint warn"><${Icon} name="sparkle" size=${14} /><span>Claude answers with your own Anthropic API key, and you haven't added one.</span><a onClick=${() => model.openModal('settings', { tab: 'claude' })}>Add a key</a></div>`
  }
  if (why === 'off') return html`<div class="claude-hint warn"><${Icon} name="sparkle" size=${14} /><span>An admin turned Claude off in this group.</span></div>`
  return html`<div class="claude-hint"><${Icon} name="sparkle" size=${14} /><span>${again ? 'Replying to Claude asks it again: ' : ''}Claude (${model_}) reads your recent messages here and its answers to you (not other people's, unless they allowed it in Settings › Privacy), and answers with your API key.</span></div>`
}

function Composer ({ g, ch, handle, thread = null }) {
  const key = g.id + ':' + ch.id + (thread ? ':t:' + thread : '')
  const typingCh = thread ? ch.id + '/' + thread : ch.id
  const [text, setText] = useState(drafts.get(key) || '')
  const [alsoSend, setAlsoSend] = useState(false)
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [sugg, setSugg] = useState({ items: [], index: 0 })
  const ta = useRef()
  const lastTyping = useRef(0)
  const reply = !thread && model.ui.replyTo ? g.msgById.get(model.ui.replyTo) : null

  const addPaths = async (paths) => {
    setBusy(true)
    const out = await act(() => importFiles({ paths }), 'Could not attach')
    setBusy(false)
    if (out) setFiles(f => [...f, ...out].slice(0, 10))
  }
  const addFiles = async (list) => {
    setBusy(true)
    const out = await act(() => importFiles({ files: list }), 'Could not attach')
    setBusy(false)
    if (out) setFiles(f => [...f, ...out].slice(0, 10))
  }
  if (handle) handle.current = { addPaths }
  useEffect(() => { ta.current?.focus(); if (ta.current) autosize(ta.current) }, [])
  useEffect(() => { drafts.set(key, text) }, [text])

  if (g.kickedMe) return html`<div class="composer-wrap"><div class="composer disabled">You can't send messages here because you were removed from this group.</div><div class="typing" /></div>`
  if (g.restoring) return html`<div class="composer-wrap"><div class="composer disabled"><span class="spinner" /> Getting your messages back from your backup… You can write here once someone from this chat has been online.</div><div class="typing" /></div>`

  const placeholder = thread ? 'Reply in thread…' : g.dm ? 'Message @' + model.groupName(g) : 'Message #' + ch.name

  const send = async () => {
    const t = text.trim()
    if ((!t && !files.length) || busy) return
    if (/^\/(chess|poker)\b/i.test(t) && !files.length && !model.appOn(g, 'games')) {
      model.toast(model.isMod(g, model.me.key) ? 'Add the Games app to this group first: group menu → Apps.' : "This group doesn't have the Games app. The owner or an admin can add it (group menu → Apps).", 'error')
      return
    }
    if (/^\/chess\b/i.test(t) && !files.length) {
      setText('')
      model.openModal('newGame', { gid: g.id, ch: ch.id })
      return
    }
    if (/^\/poker\b/i.test(t) && !files.length) {
      setText('')
      model.openModal('newGame', { gid: g.id, ch: ch.id, kind: 'poker' })
      return
    }
    if (/^\/(play|skip)\b/i.test(t) && !files.length) {
      setText('')
      musicCommand(g, t)
      return
    }
    if (/^\/poll\b/i.test(t) && !files.length && !thread) {
      setText('')
      model.openModal('poll', { gid: g.id, ch: ch.id, q: t.replace(/^\/poll\s*/i, '') })
      return
    }
    if (/^\/search\b/i.test(t) && !files.length) {
      setText('')
      model.openSearch(t.replace(/^\/search\s*/i, ''))
      return
    }
    const askAgain = !!reply && isClaudeAnswer(reply) && !claudeBlocked(g)
    const data = { id: rid(), ch: ch.id, text: t }
    if (files.length) data.att = files.map(({ h, s, n, m, w, hh }) => ({ h, s, n, m, w, hh }))
    if (reply) data.re = reply.id
    if (thread) {
      data.th = thread
      if (alsoSend) data.also = true
    }
    const ok = await act(() => append(g.id, 'msg', data), 'Could not send')
    if (!ok) return
    setText('')
    setFiles([])
    setSugg({ items: [], index: 0 })
    drafts.delete(key)
    if (!thread) model.ui.replyTo = null
    model.emit()
    requestAnimationFrame(() => ta.current && autosize(ta.current))
    if (t) attachPreviews(g.id, data.id, t)
    if (t && (mentionsClaude(t) || askAgain)) {
      const m = g.msgById.get(data.id)
      if (m) askClaude(g, m)
    }
  }

  const setTextAndCaret = (next, caret) => {
    setText(next)
    requestAnimationFrame(() => {
      const el = ta.current
      if (!el) return
      el.focus()
      el.setSelectionRange(caret, caret)
      autosize(el)
    })
  }
  const insert = (str) => {
    const el = ta.current
    const start = el ? el.selectionStart : text.length
    const end = el ? el.selectionEnd : text.length
    setTextAndCaret(text.slice(0, start) + str + text.slice(end), start + str.length)
  }
  const applySuggest = (x) => {
    const caret = ta.current ? ta.current.selectionStart : text.length
    let before
    if (sugg.mode === 'mention') before = text.slice(0, caret).replace(MENTION, (_, pre) => pre + x.insert + ' ')
    else {
      before = text.slice(0, caret).replace(SHORTCODE, (_, pre) => pre + x.e + ' ')
      rememberEmoji(x.e)
    }
    setSugg({ items: [], index: 0 })
    setTextAndCaret(before + text.slice(caret), before.length)
  }
  const updateSuggest = (value, caret) => {
    const before = value.slice(0, caret)
    const at = MENTION.exec(before)
    if (at) {
      const items = mentionItems(g, at[2])
      setSugg(items.length ? { items, index: 0, mode: 'mention' } : { items: [], index: 0 })
      return
    }
    // ":thumbs_up:" typed out in full becomes the emoji right away
    const full = /:([\w+-]{2,40}):$/.exec(before)
    if (full) {
      loadEmoji().then(() => {
        const hit = searchEmoji(full[1], 1)[0]
        if (hit && hit.s === full[1].toLowerCase()) {
          const b = before.slice(0, -full[0].length) + hit.e
          rememberEmoji(hit.e)
          setTextAndCaret(b + value.slice(caret), b.length)
        }
      })
      if (sugg.items.length) setSugg({ items: [], index: 0 })
      return
    }
    const m = SHORTCODE.exec(before)
    if (!m) { if (sugg.items.length) setSugg({ items: [], index: 0 }); return }
    loadEmoji().then(() => {
      const items = searchEmoji(m[2].slice(1))
      items.query = m[2].slice(1)
      setSugg({ items, index: 0 })
    })
  }

  const onKeyDown = (e) => {
    if (sugg.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = sugg.items.length
        setSugg({ ...sugg, index: (sugg.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n })
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) { e.preventDefault(); applySuggest(sugg.items[sugg.index]); return }
      if (e.key === 'Escape') { e.preventDefault(); setSugg({ items: [], index: 0 }); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return }
    if (e.key === 'Escape' && !thread && model.ui.replyTo) { model.ui.replyTo = null; model.emit() }
    if (e.key === 'ArrowUp' && !text) {
      const list = thread ? model.threadOf(g, thread) : g.messages.get(ch.id) || []
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].a === model.me.key && !list[i].bot && !list[i].game && !list[i].deleted) { e.preventDefault(); model.ui.editing = list[i].id; model.emit(); break }
      }
    }
  }
  const onInput = (e) => {
    setText(e.target.value)
    autosize(e.target)
    updateSuggest(e.target.value, e.target.selectionStart)
    const now = Date.now()
    if (e.target.value && now - lastTyping.current > 3000) {
      lastTyping.current = now
      api.sendEph(g.id, null, { type: 'typing', ch: typingCh })
    }
  }
  const onPaste = (e) => {
    const list = [...(e.clipboardData?.files || [])]
    if (list.length) { e.preventDefault(); addFiles(list) }
  }

  const typers = [...(g.typing.get(typingCh)?.keys() || [])].filter(k => k !== model.me.key).map(k => model.memberName(g, k))

  return html`
    <div class="composer-wrap ${thread ? 'in-thread' : ''}">
      ${sugg.mode === 'mention'
        ? html`<${MentionSuggest} g=${g} items=${sugg.items} index=${sugg.index} onPick=${applySuggest} />`
        : html`<${EmojiSuggest} items=${sugg.items} index=${sugg.index} onPick=${applySuggest} />`}
      ${mentionsClaude(text) ? html`<${ClaudeHint} g=${g} />` : isClaudeAnswer(reply) && !claudeBlocked(g) && html`<${ClaudeHint} g=${g} again />`}
      ${emojiOpen && html`<${EmojiPanel} class="for-composer" onPick=${insert} onClose=${() => setEmojiOpen(false)} />`}
      ${reply && html`
        <div class="reply-bar">
          Replying to <b class=${reply.bot ? 'claude-name' : ''} style=${reply.bot ? null : { color: model.memberColor(g, reply.a) }}>${reply.bot ? 'Claude' : model.memberName(g, reply.a)}</b>
          <button class="icon-btn small" onClick=${() => { model.ui.replyTo = null; model.emit() }}><${Icon} name="x" size=${16} /></button>
        </div>`}
      ${files.length > 0 && html`
        <div class="pending-files">
          ${files.map((f, i) => html`
            <div class="pending-file" key=${f.h + i}>
              ${/^image\//.test(f.m) ? html`<img src=${blobUrl(f)} />` : html`<${Icon} name=${isTextFile(f) ? 'code' : 'file'} size=${34} />`}
              <span title=${f.n}>${f.n}</span>
              <small>${fmtBytes(f.s)}</small>
              <button class="remove" title="Remove" onClick=${() => setFiles(files.filter((_, j) => j !== i))}><${Icon} name="x" size=${14} /></button>
            </div>`)}
        </div>`}
      <div class="composer ${reply ? 'has-reply' : ''}">
        <button class="icon-btn" title="Attach files (any size — sent peer-to-peer)" disabled=${busy}
          onClick=${async () => { const p = await api.pickFiles(); if (p.length) addPaths(p) }}>
          <${Icon} name=${busy ? 'zap' : 'clip'} />
        </button>
        <textarea ref=${ta} rows="1" value=${text} placeholder=${placeholder}
          onInput=${onInput} onKeyDown=${onKeyDown} onPaste=${onPaste}
          onBlur=${() => setTimeout(() => setSugg(s => s.items.length ? { items: [], index: 0 } : s), 150)} />
        <button class="icon-btn emoji-btn ${emojiOpen ? 'on' : ''}" title="Emoji (or type :name)" data-emoji-toggle onClick=${() => setEmojiOpen(!emojiOpen)}><${Icon} name="smile" /></button>
        <button class="icon-btn send ${text.trim() || files.length ? 'ready' : ''}" title="Send (Enter)" onClick=${send}><${Icon} name="send" /></button>
      </div>
      ${thread && html`
        <label class="also-send">
          <input type="checkbox" checked=${alsoSend} onChange=${(e) => setAlsoSend(e.target.checked)} />
          Also send to ${g.dm ? 'the chat' : '#' + ch.name}
        </label>`}
      <div class="typing">${typers.length > 0 && html`<span class="dots"><i /><i /><i /></span> <b>${typers.join(', ')}</b> ${typers.length > 1 ? 'are' : 'is'} typing…`}</div>
    </div>`
}
