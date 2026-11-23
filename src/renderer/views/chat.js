import { html, useState, useEffect, useLayoutEffect, useRef, useMemo } from '../vendor/preact-htm.js'
import {
  api, model, append, act, rid, fmtTime, fmtDay, fmtStamp, fmtBytes, initials, blobUrl, blobState,
  fetchBlob, importFiles, QUICK_EMOJI
} from '../lib/core.js'
import { renderMarkdown, isEmojiOnly } from '../lib/markdown.js'
import { Icon } from '../lib/icons.js'

const drafts = new Map()
const PAGE = 150

export function Avatar ({ name, color, size = 40, speaking = false, dot = null }) {
  return html`
    <div class="avatar ${speaking ? 'speaking' : ''}" style=${{ width: size + 'px', height: size + 'px', '--c': color, fontSize: Math.round(size * 0.38) + 'px' }}>
      <span>${initials(name)}</span>
      ${dot && html`<i class="presence ${dot}" />`}
    </div>`
}

export function ChatView ({ g, ch }) {
  const [dragging, setDragging] = useState(false)
  const composerRef = useRef()
  const onDrop = async (e) => {
    e.preventDefault()
    setDragging(false)
    const paths = [...(e.dataTransfer?.files || [])].map(f => api.pathForFile(f)).filter(Boolean)
    if (paths.length) composerRef.current?.addPaths(paths)
  }
  return html`
    <section class="chat"
      onDragOver=${(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragging(true) } }}
      onDragLeave=${(e) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget)) setDragging(false) }}
      onDrop=${onDrop}>
      <header class="chat-header">
        <${Icon} name="hash" size=${22} class="dim" />
        <h2>${ch.name}</h2>
        <span class="header-note"><${Icon} name="lock" size=${13} /> Stored only on your friends' devices</span>
        <div class="spacer" />
        <button class="icon-btn" title="Invite friends" onClick=${() => model.openModal('invite', { gid: g.id })}><${Icon} name="userPlus" /></button>
      </header>
      <${MessageList} key=${g.id + ch.id} g=${g} ch=${ch} />
      <${Composer} key=${'c' + g.id + ch.id} handle=${composerRef} g=${g} ch=${ch} />
      ${dragging && html`<div class="drop-overlay"><div><${Icon} name="clip" size=${40} /><p>Drop to send to <b>#${ch.name}</b></p><small>Files go straight to your friends — no upload limits</small></div></div>`}
    </section>`
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

  const onScroll = () => {
    const el = ref.current
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    stick.current = bottom
    if (bottom !== atBottom) setAtBottom(bottom)
    if (bottom && model.ui.focused) model.markRead(g.id, ch.id)
    if (el.scrollTop < 300 && limit < list.length) {
      prevHeight.current = el.scrollHeight
      setLimit(limit + PAGE)
    }
  }
  const onMediaLoad = () => { if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight }

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

  return html`
    <div class="messages" ref=${ref} onScroll=${onScroll}>
      ${shown.length === list.length && html`
        <div class="channel-intro">
          <div class="intro-icon"><${Icon} name="hash" size=${36} /></div>
          <h1>Welcome to #${ch.name}</h1>
          <p>This is the start of the channel. Messages are signed by their author and synced directly between your devices — there is no server.</p>
        </div>`}
      ${rows}
      <div class="messages-end" />
    </div>
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

  const react = (e) => {
    const mineOn = m.reactions.get(e)?.get(model.me.key)?.on
    act(() => append(g.id, 'react', { id: m.id, e, on: !mineOn }))
    setPicker(false)
  }
  const del = (ev) => {
    const doIt = () => act(() => append(g.id, 'msg.delete', { id: m.id }))
    if (ev.shiftKey) doIt()
    else model.openModal('confirm', { title: 'Delete message', body: 'Delete this message for everyone? Friends who are offline will remove it when they next sync.', confirm: 'Delete', danger: true, onConfirm: doIt })
  }

  return html`
    <div id=${'msg-' + m.id} class="msg ${grouped ? 'grouped' : ''} ${mention ? 'mention' : ''} ${editing ? 'editing' : ''}">
      ${m.re && html`
        <div class="reply-ref" onClick=${() => document.getElementById('msg-' + m.re)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
          <span class="reply-line" />
          ${parent && !parent.deleted
            ? html`<b style=${{ color: model.memberColor(g, parent.a) }}>${model.memberName(g, parent.a)}</b><span class="reply-snippet">${parent.text.slice(0, 120) || '📎 attachment'}</span>`
            : html`<i>Original message was deleted</i>`}
        </div>`}
      ${grouped
        ? html`<span class="gutter-time">${fmtTime(m.t)}</span>`
        : html`<div class="msg-avatar"><${Avatar} name=${name} color=${color} /></div>`}
      <div class="msg-body">
        ${!grouped && html`<div class="msg-head"><span class="author" style=${{ color }}>${name}</span><time title=${new Date(m.t).toLocaleString()}>${fmtStamp(m.t)}</time></div>`}
        ${editing
          ? html`<${EditBox} g=${g} m=${m} />`
          : m.text && html`<div class="text ${isEmojiOnly(m.text) ? 'jumbo' : ''}">${m._md}${m.edited ? html`<span class="edited" title=${'Edited ' + new Date(m.edited).toLocaleString()}> (edited)</span>` : ''}</div>`}
        ${m.att.length > 0 && html`<div class="attachments">${m.att.map(a => html`<${Attachment} key=${a.h} g=${g} a=${a} onLoad=${onMediaLoad} />`)}</div>`}
        ${m.reactions.size > 0 && html`
          <div class="reactions">
            ${[...m.reactions].map(([e, by]) => {
              const who = [...by].filter(([, v]) => v.on).map(([k]) => k)
              if (!who.length) return null
              return html`<button key=${e} class="reaction ${who.includes(model.me.key) ? 'mine' : ''}" title=${who.map(k => model.memberName(g, k)).join(', ')} onClick=${() => react(e)}>${e} <b>${who.length}</b></button>`
            })}
          </div>`}
      </div>
      ${!editing && html`
        <div class="msg-tools">
          <button title="Add reaction" onClick=${() => setPicker(!picker)}><${Icon} name="smile" size=${18} /></button>
          <button title="Reply" onClick=${() => { model.ui.replyTo = m.id; model.emit(); document.querySelector('.composer textarea')?.focus() }}><${Icon} name="reply" size=${18} /></button>
          ${mine && html`<button title="Edit" onClick=${() => { model.ui.editing = m.id; model.emit() }}><${Icon} name="edit" size=${18} /></button>`}
          ${mine && html`<button title="Delete (shift-click to skip confirmation)" class="danger" onClick=${del}><${Icon} name="trash" size=${18} /></button>`}
        </div>`}
      ${picker && html`<${EmojiPicker} onPick=${react} onClose=${() => setPicker(false)} />`}
    </div>`
}

export function EmojiPicker ({ onPick, onClose }) {
  const ref = useRef()
  useEffect(() => {
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    setTimeout(() => document.addEventListener('mousedown', off), 0)
    return () => document.removeEventListener('mousedown', off)
  }, [])
  return html`<div class="emoji-picker" ref=${ref}>${QUICK_EMOJI.map(e => html`<button key=${e} onClick=${() => onPick(e)}>${e}</button>`)}</div>`
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

function Attachment ({ g, a, onLoad }) {
  const st = blobState(a.h, g.id, a.s)
  const have = st.state === 'have'
  if (have && IMG.test(a.m)) {
    const ratio = a.w && a.hh ? { aspectRatio: `${a.w} / ${a.hh}`, width: Math.min(a.w, 420) + 'px' } : {}
    return html`<img class="att-image" src=${blobUrl(a)} alt=${a.n} style=${ratio} onLoad=${onLoad} onClick=${() => model.openModal('image', { a })} />`
  }
  if (have && VID.test(a.m)) return html`<video class="att-video" src=${blobUrl(a)} controls preload="metadata" onLoadedMetadata=${onLoad} />`
  const pct = st.state === 'fetching' && st.s > 0 ? Math.round((st.r / st.s) * 100) : null
  return html`
    <div class="att-file">
      <${Icon} name="file" size=${30} class="att-icon" />
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

function Composer ({ g, ch, handle }) {
  const key = g.id + ':' + ch.id
  const [text, setText] = useState(drafts.get(key) || '')
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
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
    drafts.delete(key)
    model.ui.replyTo = null
    model.emit()
    requestAnimationFrame(() => ta.current && autosize(ta.current))
  }

  const onKeyDown = (e) => {
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
      ${reply && html`
        <div class="reply-bar">
          Replying to <b style=${{ color: model.memberColor(g, reply.a) }}>${model.memberName(g, reply.a)}</b>
          <button class="icon-btn small" onClick=${() => { model.ui.replyTo = null; model.emit() }}><${Icon} name="x" size=${16} /></button>
        </div>`}
      ${files.length > 0 && html`
        <div class="pending-files">
          ${files.map((f, i) => html`
            <div class="pending-file" key=${f.h + i}>
              ${/^image\//.test(f.m) ? html`<img src=${blobUrl(f)} />` : html`<${Icon} name="file" size=${34} />`}
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
        <textarea ref=${ta} rows="1" value=${text} placeholder=${'Message #' + ch.name}
          onInput=${onInput} onKeyDown=${onKeyDown} onPaste=${onPaste} />
        <button class="icon-btn send ${text.trim() || files.length ? 'ready' : ''}" title="Send (Enter)" onClick=${send}><${Icon} name="send" /></button>
      </div>
      <div class="typing">${typers.length > 0 && html`<span class="dots"><i /><i /><i /></span> <b>${typers.join(', ')}</b> ${typers.length > 1 ? 'are' : 'is'} typing…`}</div>
    </div>`
}
