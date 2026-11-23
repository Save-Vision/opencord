import { html, useState, useEffect, useLayoutEffect, useRef, useMemo } from '../vendor/preact-htm.js'
import {
  api, model, voice, append, act, rid, fmtTime, fmtDay, fmtStamp, fmtBytes, initials, blobUrl, blobState,
  fetchBlob, importFiles
} from '../lib/core.js'
import { renderMarkdown, renderMarkdownDoc, isEmojiOnly, previewableUrls } from '../lib/markdown.js'
import { highlight, extOf, langFor, langLabel } from '../lib/highlight.js'
import { DM_CALL } from '../lib/model.js'
import { Icon } from '../lib/icons.js'
import { EmojiPanel, EmojiSuggest, loadEmoji, searchEmoji, rememberEmoji } from './emoji.js'

const drafts = new Map()
const PAGE = 150

export function Avatar ({ name, color, src = null, size = 40, speaking = false, dot = null }) {
  return html`
    <div class="avatar ${speaking ? 'speaking' : ''} ${src ? 'has-img' : ''}" style=${{ width: size + 'px', height: size + 'px', '--c': color, fontSize: Math.round(size * 0.38) + 'px' }}>
      ${src ? html`<img src=${src} alt="" draggable="false" />` : html`<span>${initials(name)}</span>`}
      ${dot && html`<i class="presence ${dot}" />`}
    </div>`
}

export function jumpToMessage (id) {
  model.ui.jumpTo = id
  model.emit()
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
          ? html`<${Avatar} name=${friendName} color=${model.memberColor(g, dm)} src=${model.memberAvatar(g, dm)} size=${26} dot=${g.online.has(dm) ? 'online' : 'offline'} /><h2>${friendName}</h2>`
          : html`<${Icon} name="hash" size=${22} class="dim" /><h2>${ch.name}</h2>`}
        <span class="header-note"><${Icon} name="lock" size=${13} /> ${dm ? 'Private: only the two of you have the key' : "Stored only on your friends' devices"}</span>
        <div class="spacer" />
        ${dm && html`<button class="icon-btn" title=${voice.inChannel(g.id, DM_CALL) ? 'Open call' : 'Start a call'} onClick=${() => startDmCall(g)}><${Icon} name="phone" /></button>`}
        <${PinsButton} g=${g} ch=${ch} />
        ${!dm && html`<button class="icon-btn" title="Invite friends" onClick=${() => model.openModal('invite', { gid: g.id })}><${Icon} name="userPlus" /></button>`}
      </header>
      ${g.kickedMe && html`
        <div class="banner bad removed-banner">
          <span>You were removed from this group. You won't receive new messages.</span>
          <button class="btn sm" onClick=${() => leaveGroupFlow(g)}>Leave group</button>
        </div>`}
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
  const ctx = { names: new Set(), myName: '', openLink: (u) => api.openExternal(u) }
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

  const names = useMemo(() => new Set([...g.members.values()].map(m => (m.name || '').toLowerCase()).filter(Boolean)), [g.members.size, model.me.name])
  const ctx = { names, myName: (model.me.name || '').toLowerCase(), openLink: (u) => api.openExternal(u) }

  const rows = []
  let prev = shown.length < list.length ? null : undefined
  let shownNew = false
  for (const m of shown) {
    if (!prev || fmtDay(prev.t) !== fmtDay(m.t)) rows.push(html`<div class="day-divider" key=${'d' + m.id}><span>${fmtDay(m.t)}</span></div>`)
    if (!shownNew && m.t > unreadAfter && m.a !== model.me.key) {
      shownNew = true
      rows.push(html`<div class="new-divider" key="new"><span>NEW</span></div>`)
    }
    const grouped = prev && prev.a === m.a && m.t - prev.t < 7 * 60 * 1000 && fmtDay(prev.t) === fmtDay(m.t) && !m.re
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
      <div class="messages-end" />
    </div></div>
    ${!atBottom && html`<button class="jump" onClick=${() => { stick.current = true; ref.current.scrollTop = ref.current.scrollHeight }}>Jump to present ↓</button>`}`
}

function Message ({ g, m, grouped, ctx, onMediaLoad }) {
  const mine = m.a === model.me.key
  const editing = model.ui.editing === m.id
  const [picker, setPicker] = useState(false)
  const name = model.memberName(g, m.a)
  const color = model.memberColor(g, m.a)
  if (!m._md || m._mdText !== m.text) { m._md = renderMarkdown(m.text, ctx); m._mdText = m.text }
  const mention = !mine && model.mentionsMe(m.text)
  const parent = m.re ? g.msgById.get(m.re) : null
  const pinned = model.isPinned(g, m.id)
  const embeds = model.embedsOf(g, m)

  const react = (e) => {
    const mineOn = m.reactions.get(e)?.get(model.me.key)?.on
    act(() => append(g.id, 'react', { id: m.id, e, on: !mineOn }))
  }
  const del = (ev) => {
    const doIt = () => act(() => append(g.id, 'msg.delete', { id: m.id }))
    if (ev.shiftKey) doIt()
    else model.openModal('confirm', { title: 'Delete message', body: 'Delete this message for everyone? Friends who are offline will remove it when they next sync.', confirm: 'Delete', danger: true, onConfirm: doIt })
  }
  const pin = () => act(() => append(g.id, 'msg.pin', { id: m.id, on: !pinned }))

  return html`
    <div id=${'msg-' + m.id} class="msg ${grouped ? 'grouped' : ''} ${mention ? 'mention' : ''} ${editing ? 'editing' : ''} ${pinned ? 'pinned' : ''}">
      ${m.re && html`
        <div class="reply-ref" onClick=${() => jumpToMessage(m.re)}>
          <span class="reply-line" />
          ${parent && !parent.deleted
            ? html`<b style=${{ color: model.memberColor(g, parent.a) }}>${model.memberName(g, parent.a)}</b><span class="reply-snippet">${parent.text.slice(0, 120) || '📎 attachment'}</span>`
            : html`<i>Original message was deleted</i>`}
        </div>`}
      ${grouped
        ? html`<span class="gutter-time">${fmtTime(m.t)}</span>`
        : html`<div class="msg-avatar"><${Avatar} name=${name} color=${color} src=${model.memberAvatar(g, m.a)} /></div>`}
      <div class="msg-body">
        ${!grouped && html`<div class="msg-head"><span class="author" style=${{ color }}>${name}</span><time title=${new Date(m.t).toLocaleString()}>${fmtStamp(m.t)}</time>${pinned && html`<span class="pin-mark" title="Pinned"><${Icon} name="pin" size=${12} /></span>`}</div>`}
        ${editing
          ? html`<${EditBox} g=${g} m=${m} />`
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
      </div>
      ${!editing && !g.kickedMe && html`
        <div class="msg-tools">
          <button title="Add reaction" data-emoji-toggle onClick=${() => setPicker(!picker)}><${Icon} name="smile" size=${18} /></button>
          <button title="Reply" onClick=${() => { model.ui.replyTo = m.id; model.emit(); document.querySelector('.composer textarea')?.focus() }}><${Icon} name="reply" size=${18} /></button>
          <button title=${pinned ? 'Unpin' : 'Pin message'} class=${pinned ? 'on' : ''} onClick=${pin}><${Icon} name="pin" size=${18} /></button>
          ${mine && html`<button title="Edit" onClick=${() => { model.ui.editing = m.id; model.emit() }}><${Icon} name="edit" size=${18} /></button>`}
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

function Composer ({ g, ch, handle }) {
  const key = g.id + ':' + ch.id
  const [text, setText] = useState(drafts.get(key) || '')
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [sugg, setSugg] = useState({ items: [], index: 0 })
  const ta = useRef()
  const lastTyping = useRef(0)
  const reply = model.ui.replyTo ? g.msgById.get(model.ui.replyTo) : null

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

  const placeholder = g.dm ? 'Message @' + model.groupName(g) : 'Message #' + ch.name

  const send = async () => {
    const t = text.trim()
    if ((!t && !files.length) || busy) return
    const data = { id: rid(), ch: ch.id, text: t }
    if (files.length) data.att = files.map(({ h, s, n, m, w, hh }) => ({ h, s, n, m, w, hh }))
    if (reply) data.re = reply.id
    const ok = await act(() => append(g.id, 'msg', data), 'Could not send')
    if (!ok) return
    setText('')
    setFiles([])
    setSugg({ items: [], index: 0 })
    drafts.delete(key)
    model.ui.replyTo = null
    model.emit()
    requestAnimationFrame(() => ta.current && autosize(ta.current))
    if (t) attachPreviews(g.id, data.id, t)
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
    const before = text.slice(0, caret).replace(SHORTCODE, (_, pre) => pre + x.e + ' ')
    rememberEmoji(x.e)
    setSugg({ items: [], index: 0 })
    setTextAndCaret(before + text.slice(caret), before.length)
  }
  const updateSuggest = (value, caret) => {
    const before = value.slice(0, caret)
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
    if (e.key === 'Escape' && model.ui.replyTo) { model.ui.replyTo = null; model.emit() }
    if (e.key === 'ArrowUp' && !text) {
      const list = g.messages.get(ch.id) || []
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].a === model.me.key) { e.preventDefault(); model.ui.editing = list[i].id; model.emit(); break }
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
      api.sendEph(g.id, null, { type: 'typing', ch: ch.id })
    }
  }
  const onPaste = (e) => {
    const list = [...(e.clipboardData?.files || [])]
    if (list.length) { e.preventDefault(); addFiles(list) }
  }

  const typers = [...(g.typing.get(ch.id)?.keys() || [])].filter(k => k !== model.me.key).map(k => model.memberName(g, k))

  return html`
    <div class="composer-wrap">
      <${EmojiSuggest} items=${sugg.items} index=${sugg.index} onPick=${applySuggest} />
      ${emojiOpen && html`<${EmojiPanel} class="for-composer" onPick=${insert} onClose=${() => setEmojiOpen(false)} />`}
      ${reply && html`
        <div class="reply-bar">
          Replying to <b style=${{ color: model.memberColor(g, reply.a) }}>${model.memberName(g, reply.a)}</b>
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
      <div class="typing">${typers.length > 0 && html`<span class="dots"><i /><i /><i /></span> <b>${typers.join(', ')}</b> ${typers.length > 1 ? 'are' : 'is'} typing…`}</div>
    </div>`
}
