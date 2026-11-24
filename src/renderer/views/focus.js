// Focus documents: a plain-text / Markdown document the whole group (or both of you in a
// private chat) can write in at the same time, in a full-window editor with nothing else on
// screen. Esc or the arrow at the top left leaves it.
//
// Typing changes the shared text right away on your PC (lib/textcrdt.js) and is sent as a
// signed 'doc.edit' op a moment later (bursts of typing become one op). Friends' edits merge
// in without moving your caret. Who else has the document open travels as ephemeral 'doc'
// messages, like typing indicators.

import { html, useState, useEffect, useLayoutEffect, useRef } from '../vendor/preact-htm.js'
import { api, model, act, append, rid, useModel } from '../lib/core.js'
import { mergeEdits, chunkEdit } from '../lib/textcrdt.js'
import { Icon } from '../lib/icons.js'
import { Avatar, MarkdownView } from './chat.js'

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

// ---------------------------------------------------------------- the editor

export function FocusEditor ({ g, doc }) {
  useModel()
  const area = useRef()
  const pending = useRef(null)
  const timers = useRef({ idle: null, max: null })
  const ids = useRef(doc.text.visible().slice())
  const composing = useRef(false)
  const lastKey = useRef(0)
  const [view, setView] = useState(() => localStorage.getItem('od.focusView') || 'write')
  const [calm, setCalm] = useState(false)
  const [name, setName] = useState(doc.name)
  const text = doc.text.text()

  const flush = () => {
    clearTimeout(timers.current.idle)
    clearTimeout(timers.current.max)
    timers.current.max = null
    const ed = pending.current
    pending.current = null
    if (ed && (ed.r.length || ed.x.length)) act(() => sendEdit(g.id, doc.id, ed))
  }

  const onInput = (e) => {
    const ed = doc.text.localReplace(e.target.value, model.me.key)
    ids.current = doc.text.visible().slice()
    lastKey.current = Date.now()
    if (!ed) return
    pending.current = mergeEdits(pending.current, ed)
    clearTimeout(timers.current.idle)
    timers.current.idle = setTimeout(flush, FLUSH_IDLE)
    if (!timers.current.max) timers.current.max = setTimeout(flush, FLUSH_MAX)
    model.emit()
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
      if (e.ctrlKey && e.key.toLowerCase() === 'e') { e.preventDefault(); pick(view === 'write' ? 'split' : view === 'split' ? 'preview' : 'write') }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const pick = (v) => { setView(v); try { localStorage.setItem('od.focusView', v) } catch {} }
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
        <div class="seg focus-views">
          ${[['write', 'Write'], ['split', 'Split'], ['preview', 'Preview']].map(([v, l]) => html`<button key=${v} class=${view === v ? 'active' : ''} onClick=${() => pick(v)}>${l}</button>`)}
        </div>
        <button class="icon-btn" title="Save as .md file" onClick=${exportMd}><${Icon} name="download" size=${18} /></button>
      </header>
      <div class="focus-body view-${view}">
        <textarea ref=${area} class="focus-text" spellcheck="true" placeholder="Start writing… (Markdown works: # headings, **bold**, - lists)"
          defaultValue=${text} onInput=${onInput}
          onKeyDown=${(e) => { if (!e.ctrlKey && !e.altKey && e.key.length === 1) setCalm(true) }}
          onCompositionStart=${() => { composing.current = true }} onCompositionEnd=${(e) => { composing.current = false; onInput(e) }} />
        ${view !== 'write' && html`<div class="focus-preview">${text.trim() ? html`<${MarkdownView} text=${text} />` : html`<p class="dim">Nothing to preview yet.</p>`}</div>`}
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
