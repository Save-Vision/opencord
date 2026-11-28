// Focus documents: a plain-text / Markdown document the whole group (or both of you in a
// private chat) can write in at the same time, in a full-window editor with nothing else on
// screen. Esc or the arrow at the top left leaves it.
//
// Typing changes the shared text right away on your PC (lib/textcrdt.js) and is sent as a
// signed 'doc.edit' op a moment later (bursts of typing become one op). Friends' edits merge
// in without moving your caret. Who else has the document open travels as ephemeral 'doc'
// messages, like typing indicators.
//
// Live (the default) shows the formatted text next to what you type, block by block, with the
// block you're in highlighted; Preview shows only the result. The buttons on the left format the
// selection for people who don't know Markdown (lib/mdedit.js), and the guide explains each one.

import { html, useState, useEffect, useLayoutEffect, useRef, useMemo } from '../vendor/preact-htm.js'
import { api, model, act, append, rid, useModel } from '../lib/core.js'
import { mergeEdits, chunkEdit } from '../lib/textcrdt.js'
import { Icon } from '../lib/icons.js'
import { Avatar } from './chat.js'
import { renderMarkdownDoc } from '../lib/markdown.js'
import { TOOLS, toolForKey, splitBlocks, blockAt, diffSpan, continueList, toggleTask } from '../lib/mdedit.js'
import { mod, isMac, keyLabel } from '../lib/keys.js'

// A formatting button's shortcut as shown on this computer (none for headings on a Mac)
const toolKeys = (t) => t.keys && !(isMac() && t.id === 'heading') ? keyLabel(t.keys) : null

const FLUSH_IDLE = 350 // ms without typing before the edit is sent
const FLUSH_MAX = 1200 // ...but never later than this after the first unsent key

const ago = (t) => {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + ' min ago'
  if (s < 86400) return Math.floor(s / 3600) + ' h ago'
  return new Date(t).toLocaleDateString()
}

const words = (t) => (t.match(/\S+/g) || []).length

async function sendEdit (gid, docId, ed) {
  for (const part of chunkEdit(ed)) await append(gid, 'doc.edit', { id: docId, ...part })
}

export async function createDoc (g, name, text = '') {
  const id = rid()
  await append(g.id, 'doc.set', { id, name: (name || 'Untitled').slice(0, 80) })
  if (text) {
    const doc = model._doc(g, id)
    const ed = doc.text.localReplace(text, model.me.key)
    if (ed) await sendEdit(g.id, id, ed)
  }
  return id
}

// ---------------------------------------------------------------- the list

export function DocsView ({ g }) {
  useModel()
  const docs = model.docsOf(g)
  const file = useRef()
  const create = () => act(async () => {
    const id = await createDoc(g, 'Untitled')
    model.openDocs(g.id, id)
  })
  const importMd = async (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.size > 2e6) return model.toast('That file is too big for a focus document (2 MB at most)', 'error')
    const text = (await f.text()).replace(/\r\n/g, '\n')
    act(async () => {
      const id = await createDoc(g, f.name.replace(/\.(md|markdown|txt)$/i, ''), text)
      model.openDocs(g.id, id)
    })
  }
  const remove = (doc) => model.openModal('confirm', {
    title: 'Delete document',
    body: `Delete "${doc.name}" for everyone in ${model.groupName(g)}?`,
    confirm: 'Delete',
    danger: true,
    onConfirm: () => act(() => append(g.id, 'doc.delete', { id: doc.id }))
  })
  return html`
    <div class="docs-view">
      <header class="chat-header"><${Icon} name="focus" size=${20} class="dim" /><h2>Focus docs</h2>
        <span class="header-note">Write together, nothing else on screen</span>
      </header>
      <div class="docs-body">
        <div class="docs-actions">
          <button class="btn primary" onClick=${create}><${Icon} name="plus" size=${16} /> New document</button>
          <button class="btn" onClick=${() => file.current.click()}><${Icon} name="upload" size=${16} /> Open a .md file</button>
          <input ref=${file} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange=${importMd} />
        </div>
        ${docs.length === 0 && html`
          <div class="docs-empty">
            <${Icon} name="doc" size=${40} />
            <p>Notes, plans, a story, a README… Everyone here can open a document and type in it at the same time.</p>
          </div>`}
        <div class="docs-list">
          ${docs.map(doc => {
            const here = model.docPresence(g.id, doc.id)
            const first = doc.text.text().split('\n').find(l => l.trim()) || ''
            const canDelete = doc.createdBy === model.me.key || model.isMod(g, model.me.key)
            return html`
              <div key=${doc.id} class="doc-card" role="button" tabindex="0" onClick=${() => model.openDocs(g.id, doc.id)} onKeyDown=${(e) => e.key === 'Enter' && model.openDocs(g.id, doc.id)}>
                <div class="doc-icon"><${Icon} name="doc" size=${22} /></div>
                <div class="doc-meta">
                  <b>${doc.name}</b>
                  <small>${first ? first.replace(/^#+\s*/, '').slice(0, 90) : 'Empty'}</small>
                  <small class="dim">${words(doc.text.text())} words · ${doc.editedAt ? 'edited ' + ago(doc.editedAt) + ' by ' + model.memberName(g, doc.editedBy) : 'created ' + ago(doc.createdAt)}</small>
                </div>
                ${here.length > 0 && html`<div class="doc-here" title=${here.map(p => model.memberName(g, p.key)).join(', ') + ' writing here'}>${here.slice(0, 3).map(p => html`<${Avatar} key=${p.key} name=${model.memberName(g, p.key)} color=${model.memberColor(g, p.key)} src=${model.memberAvatar(g, p.key)} size=${24} />`)}</div>`}
                ${canDelete && html`<button class="icon-btn" title="Delete document" onClick=${(e) => { e.stopPropagation(); remove(doc) }}><${Icon} name="trash" size=${16} /></button>`}
              </div>`
          })}
        </div>
      </div>
    </div>`
}

// ---------------------------------------------------------------- the live preview

// Every newline is a line break here: people who don't know Markdown expect Enter to start a line
const previewCtx = { openLink: (u) => api.openExternal(u), breaks: true }

// Renders the document block by block; unchanged blocks keep their rendering
function LivePreview ({ text, current, onPick, onTask, refEl }) {
  const cache = useRef(new Map())
  const blocks = splitBlocks(text)
  const next = new Map()
  const items = blocks.map((b, i) => {
    // (a block that appears twice gets its own copy: one rendering can't be in two places)
    let node = next.has(b.text) ? null : cache.current.get(b.text)
    if (!node) node = renderMarkdownDoc(b.text, previewCtx)
    if (!next.has(b.text)) next.set(b.text, node)
    const click = (e) => {
      if (e.target.closest('a')) return
      // a checkbox: tick it in the text
      const li = e.target.closest('li.task')
      if (li) return onTask(b.line, [...e.currentTarget.querySelectorAll('li.task')].indexOf(li))
      onPick(b.line)
    }
    return html`<div key=${i + ':' + b.line} class="fp-block ${i === current ? 'current' : ''}" data-line=${b.line} onClick=${click}>${node}</div>`
  })
  cache.current = next
  return html`
    <div class="focus-preview" ref=${refEl}>
      ${blocks.length
        ? items
        : html`<div class="fp-empty"><b>Your formatted text appears here as you type.</b><span>New to formatting? Use the buttons on the left, or open the guide with <${Icon} name="help" size=${14} />.</span></div>`}
    </div>`
}

// ---------------------------------------------------------------- the formatting guide

function Guide ({ onUse, onClose }) {
  const examples = useMemo(() => TOOLS.filter(t => !t.sep).map(t => ({ ...t, shown: renderMarkdownDoc(t.md, previewCtx) })), [])
  return html`
    <aside class="focus-guide" aria-label="Formatting guide">
      <header><b>How formatting works</b><button class="icon-btn small" title="Close the guide" onClick=${onClose}><${Icon} name="x" size=${14} /></button></header>
      <p>Just type. To format, select some words and press a button on the left. Or type the signs yourself: they turn into formatting in the live view.</p>
      ${examples.map(t => html`
        <div key=${t.id} class="fg-item">
          <div class="fg-head"><${Icon} name=${t.icon} size=${15} /><b>${t.label}</b>${toolKeys(t) && html`<kbd>${toolKeys(t)}</kbd>`}</div>
          <small>${t.hint}</small>
          <div class="fg-example">
            <pre class="fg-src">${t.md}</pre>
            <div class="fg-out">${t.shown}</div>
          </div>
          <button class="btn sm" onClick=${() => onUse(t)}>Use</button>
        </div>`)}
      <p class="dim">This way of writing is called Markdown. The .md files you save open in most notes and code apps.</p>
    </aside>`
}

// ---------------------------------------------------------------- the editor

const VIEWS = [['write', 'Write'], ['live', 'Live'], ['preview', 'Preview']]
const savedView = () => {
  const v = localStorage.getItem('od.focusView')
  return v === 'split' ? 'live' : VIEWS.some(([k]) => k === v) ? v : 'live'
}

export function FocusEditor ({ g, doc }) {
  useModel()
  const area = useRef()
  const preview = useRef()
  const pending = useRef(null)
  const timers = useRef({ idle: null, max: null })
  const ids = useRef(doc.text.visible().slice())
  const composing = useRef(false)
  const lastKey = useRef(0)
  const [view, setView] = useState(savedView)
  const [calm, setCalm] = useState(false)
  const [name, setName] = useState(doc.name)
  const [caretLine, setCaretLine] = useState(0)
  const [guide, setGuide] = useState(() => !doc.text.text().trim() && !localStorage.getItem('od.mdGuideSeen'))
  const text = doc.text.text()

  const flush = () => {
    clearTimeout(timers.current.idle)
    clearTimeout(timers.current.max)
    timers.current.max = null
    const ed = pending.current
    pending.current = null
    if (ed && (ed.r.length || ed.x.length)) act(() => sendEdit(g.id, doc.id, ed))
  }

  const trackCaret = () => {
    const el = area.current
    if (el) setCaretLine(el.value.slice(0, el.selectionStart).split('\n').length - 1)
  }

  const onInput = (e) => {
    const ed = doc.text.localReplace(e.target.value, model.me.key)
    ids.current = doc.text.visible().slice()
    lastKey.current = Date.now()
    trackCaret()
    if (!ed) return
    pending.current = mergeEdits(pending.current, ed)
    clearTimeout(timers.current.idle)
    timers.current.idle = setTimeout(flush, FLUSH_IDLE)
    if (!timers.current.max) timers.current.max = setTimeout(flush, FLUSH_MAX)
    model.emit()
  }

  const pick = (v) => { setView(v); try { localStorage.setItem('od.focusView', v) } catch {} }

  // A button or shortcut: change just the affected span through the editor itself, so Ctrl+Z
  // undoes it like typing, then select what to type next
  const apply = (tool) => {
    const el = area.current
    if (!el) return
    if (view === 'preview') pick('live')
    el.focus()
    applyResult(tool.run({ text: el.value, start: el.selectionStart, end: el.selectionEnd }))
  }
  const applyResult = (res) => {
    const el = area.current
    if (!el) return
    el.focus() // the editing commands only work on the focused field
    if (res.text === el.value) { el.setSelectionRange(res.start, res.end); trackCaret(); return }
    const d = diffSpan(el.value, res.text)
    el.setSelectionRange(d.from, d.to)
    const ok = d.insert ? document.execCommand('insertText', false, d.insert) : document.execCommand('delete')
    if (!ok || el.value !== res.text) {
      el.value = res.text
      onInput({ target: el })
    }
    el.setSelectionRange(res.start, res.end)
    trackCaret()
  }

  // A friend's edit arrived: put the new text in and keep the caret next to the same characters
  useLayoutEffect(() => {
    const el = area.current
    if (!el || composing.current || el.value === text) return
    const old = ids.current
    const vis = doc.text.visible()
    const pos = new Map(vis.map((n, i) => [n, i]))
    const map = (i) => {
      for (let j = Math.min(i, old.length) - 1; j >= 0; j--) if (pos.has(old[j])) return pos.get(old[j]) + 1
      return 0
    }
    const focused = document.activeElement === el
    const [a, b] = [map(el.selectionStart), map(el.selectionEnd)]
    const top = el.scrollTop
    el.value = text
    if (focused) el.setSelectionRange(a, b)
    el.scrollTop = top
    ids.current = vis.slice()
  })

  // Keep the block you're writing in visible in the live view
  const current = blockAt(splitBlocks(text), caretLine)
  useEffect(() => {
    if (view !== 'live') return
    preview.current?.querySelector('.fp-block.current')?.scrollIntoView({ block: 'nearest' })
  }, [current, view])
  // ...and scroll it along with the editor
  const syncScroll = () => {
    const el = area.current
    const pv = preview.current
    if (!el || !pv || view !== 'live') return
    const max = el.scrollHeight - el.clientHeight
    pv.scrollTop = max > 0 ? (el.scrollTop / max) * (pv.scrollHeight - pv.clientHeight) : 0
  }
  // Clicking a block in the preview puts the caret at its start
  const jumpTo = (line) => {
    const el = area.current
    if (!el) return
    const at = line ? el.value.split('\n').slice(0, line).join('\n').length + 1 : 0
    el.focus()
    el.setSelectionRange(at, at)
    trackCaret()
  }

  // Tell friends we're here (and on which line), every few seconds; leave when closing
  useEffect(() => {
    const announce = (here = true) => {
      const el = area.current
      const line = el ? el.value.slice(0, el.selectionStart).split('\n').length : null
      api.sendEph(g.id, null, { type: 'doc', id: doc.id, here, line, typing: Date.now() - lastKey.current < 3000 })
    }
    announce()
    const t = setInterval(announce, 4000)
    const bye = () => { flush(); announce(false) }
    window.addEventListener('beforeunload', bye)
    return () => { clearInterval(t); window.removeEventListener('beforeunload', bye); bye() }
  }, [doc.id])

  useEffect(() => { if (view !== 'preview') area.current?.focus() }, [view])
  useEffect(() => { setName(doc.name) }, [doc.name])

  const leave = () => { flush(); model.ui.docs = { gid: g.id, id: null }; model.emit() }
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape' && !model.ui.modal) { e.preventDefault(); leave() }
      if (mod(e) && !e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); pick(view === 'write' ? 'live' : view === 'live' ? 'preview' : 'write') }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const closeGuide = () => { setGuide(false); try { localStorage.setItem('od.mdGuideSeen', '1') } catch {} }
  const rename = () => {
    const n = name.trim()
    if (n && n !== doc.name) act(() => append(g.id, 'doc.set', { id: doc.id, name: n.slice(0, 80) }))
    else setName(doc.name)
  }
  const exportMd = () => act(async () => {
    flush()
    const file = (doc.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document') + '.md'
    const info = await api.importData(file, 'text/markdown', new TextEncoder().encode(doc.text.text()))
    await api.saveBlob(info.h, file)
  })
  const onKeyDown = (e) => {
    const id = toolForKey(e)
    if (id) { e.preventDefault(); apply(TOOLS.find(t => t.id === id)); return }
    // Tab / Shift+Tab indent and outdent, like in a word processor (Esc still leaves the editor)
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !composing.current) {
      e.preventDefault()
      apply(TOOLS.find(t => t.id === (e.shiftKey ? 'outdent' : 'indent')))
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !composing.current) {
      const el = e.currentTarget
      const res = continueList({ text: el.value, start: el.selectionStart, end: el.selectionEnd })
      if (res) { e.preventDefault(); applyResult(res); return }
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) setCalm(true)
  }

  const here = model.docPresence(g.id, doc.id)
  const typing = here.filter(p => p.typing)
  const unsent = !!pending.current
  return html`
    <div class="focus-mode ${calm ? 'calm' : ''} platform-${model.platform}" onMouseMove=${() => calm && setCalm(false)}>
      <header class="focus-bar">
        <button class="icon-btn" title="Leave focus (Esc)" onClick=${leave}><${Icon} name="chevronLeft" size=${20} /></button>
        <input class="focus-title" value=${name} maxLength="80" aria-label="Document name"
          onInput=${(e) => setName(e.target.value)} onBlur=${rename} onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.stopPropagation(); setName(doc.name); e.target.blur() } }} />
        <div class="spacer" />
        <div class="focus-people" title=${here.length ? here.map(p => model.memberName(g, p.key) + (p.line ? ' · line ' + p.line : '')).join('\n') : 'Only you are here'}>
          ${here.slice(0, 5).map(p => html`<${Avatar} key=${p.key} name=${model.memberName(g, p.key)} color=${model.memberColor(g, p.key)} src=${model.memberAvatar(g, p.key)} size=${26} speaking=${p.typing} />`)}
        </div>
        <div class="seg focus-views" title=${keyLabel('Ctrl+E') + ' switches'}>
          ${VIEWS.map(([v, l]) => html`<button key=${v} class=${view === v ? 'active' : ''} onClick=${() => pick(v)}>${l}</button>`)}
        </div>
        <button class="icon-btn" title="Save as .md file" onClick=${exportMd}><${Icon} name="download" size=${18} /></button>
      </header>
      <div class="focus-body view-${view}">
        <nav class="focus-tools" aria-label="Formatting">
          ${TOOLS.map((t, i) => t.sep
            ? html`<i key=${'s' + i} class="ft-sep" />`
            : html`<button key=${t.id} class="ft-btn" data-tool=${t.id} aria-label=${t.label} title=${`${t.label}${toolKeys(t) ? ' (' + toolKeys(t) + ')' : ''}\n${t.hint}`}
                onMouseDown=${(e) => e.preventDefault()} onClick=${() => apply(t)}><${Icon} name=${t.icon} size=${18} /></button>`)}
          <span class="spacer" />
          <button class="ft-btn ${guide ? 'on' : ''}" aria-label="Formatting guide" title="How formatting works" onClick=${() => guide ? closeGuide() : setGuide(true)}><${Icon} name="help" size=${18} /></button>
        </nav>
        ${guide && html`<${Guide} onUse=${apply} onClose=${closeGuide} />`}
        <textarea ref=${area} class="focus-text" spellcheck="true" placeholder="Start writing…"
          defaultValue=${text} onInput=${onInput} onKeyDown=${onKeyDown} onKeyUp=${trackCaret} onClick=${trackCaret} onScroll=${syncScroll}
          onCompositionStart=${() => { composing.current = true }} onCompositionEnd=${(e) => { composing.current = false; onInput(e) }} />
        ${view !== 'write' && html`<${LivePreview} text=${text} current=${view === 'live' ? current : -1} onPick=${(line) => { if (view === 'preview') pick('live'); setTimeout(() => jumpTo(line), 0) }}
          onTask=${(line, n) => { const el = area.current; const at = [el.selectionStart, el.selectionEnd]; applyResult({ text: toggleTask(el.value, line, n), start: at[0], end: at[1] }) }} refEl=${preview} />`}
      </div>
      <footer class="focus-foot">
        <span>${words(text)} words</span>
        <span>${text.length} characters</span>
        ${typing.length > 0 && html`<span class="focus-typing">${typing.map(p => model.memberName(g, p.key)).join(', ')} ${typing.length > 1 ? 'are' : 'is'} writing…</span>`}
        <span class="spacer" />
        <span class=${unsent ? 'dim' : 'focus-synced'}>${unsent ? 'Sending…' : here.length ? 'In sync with ' + here.length + (here.length > 1 ? ' others' : ' other') : 'Saved'}</span>
      </footer>
    </div>`
}
