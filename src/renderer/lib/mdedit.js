// Markdown formatting for people who never write Markdown: what the buttons on the left of a
// focus document do (views/focus.js). Each function takes the text and the selection and
// returns the new text and selection; pressing a button again undoes it (toggle).
//
//   { text, start, end }  start/end: the selection, like textarea.selectionStart/End

// ---------------------------------------------------------------- inline: **bold**, *italic*…

import { mod, isMac } from './keys.js'

export function wrap ({ text, start, end }, before, after = before, placeholder = 'text') {
  const sel = text.slice(start, end)
  // already wrapped around the selection: unwrap
  if (text.slice(start - before.length, start) === before && text.slice(end, end + after.length) === after) {
    return { text: text.slice(0, start - before.length) + sel + text.slice(end + after.length), start: start - before.length, end: end - before.length }
  }
  // the selection includes the markers: unwrap
  if (sel.length >= before.length + after.length && sel.startsWith(before) && sel.endsWith(after)) {
    const inner = sel.slice(before.length, sel.length - after.length)
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length }
  }
  // keep spaces outside the markers (**word** not ** word**)
  const lead = sel.length - sel.trimStart().length
  const trail = sel.length - sel.trimEnd().length
  const core = sel.trim() || placeholder
  const s = start + lead
  const out = text.slice(0, s) + before + core + after + text.slice(end - trail)
  return { text: out, start: s + before.length, end: s + before.length + core.length }
}

export function link (state) {
  const { text, start, end } = state
  const sel = text.slice(start, end).trim()
  const isUrl = /^https?:\/\/\S+$/.test(sel)
  const label = isUrl ? 'link text' : sel || 'link text'
  const url = isUrl ? sel : 'https://'
  const ins = `[${label}](${url})`
  const out = text.slice(0, start) + ins + text.slice(end)
  // select what to type next: the address, or the words if the address was selected
  return isUrl || !sel
    ? { text: out, start: start + 1, end: start + 1 + label.length }
    : { text: out, start: start + label.length + 3, end: start + label.length + 3 + url.length }
}

// ---------------------------------------------------------------- lines: # heading, - list…

function lineRange (text, start, end) {
  const a = text.lastIndexOf('\n', start - 1) + 1
  let b = text.indexOf('\n', end > start && text[end - 1] === '\n' ? end - 1 : end)
  if (b < 0) b = text.length
  return [a, b]
}

const PREFIX = {
  quote: /^> ?/,
  bullet: /^[-*+] (?!\[[ xX]\] )/,
  number: /^\d{1,9}[.)] /,
  task: /^[-*+] \[[ xX]\] /,
  heading: /^#{1,6} /
}
const ANY_PREFIX = /^(?:#{1,6} |> ?|[-*+] \[[ xX]\] |[-*+] |\d{1,9}[.)] )/

// Turns every selected line into a heading / list item / quote, or back to plain text if they
// all already are. Headings go # → ## → ### → plain. Indented lines (sub-points) keep their
// indentation; headings never have any.
const lead = (l) => /^[ \t]*/.exec(l)[0]
export function lines (state, kind) {
  const { text, start, end } = state
  const [a, b] = lineRange(text, start, end)
  const ls = text.slice(a, b).split('\n')
  const filled = ls.filter(l => l.trim())
  const all = filled.length > 0 && filled.every(l => PREFIX[kind].test(l.slice(lead(l).length)))
  const nums = new Map() // indentation -> last number, so sub-points count from 1
  const out = ls.map((line) => {
    if (!line.trim() && ls.length > 1) return line
    const ind = kind === 'heading' ? '' : lead(line)
    const l = line.slice(lead(line).length)
    if (kind === 'heading') {
      const m = /^(#{1,6}) /.exec(l)
      if (!m) return '# ' + l.replace(ANY_PREFIX, '')
      return m[1].length >= 3 ? l.slice(m[0].length) : '#' + l
    }
    if (all) return ind + l.replace(PREFIX[kind], '')
    const body = l.replace(ANY_PREFIX, '')
    if (kind === 'quote') return ind + '> ' + body
    if (kind === 'bullet') return ind + '- ' + body
    if (kind === 'task') return ind + '- [ ] ' + body
    for (const k of nums.keys()) if (k.length > ind.length) nums.delete(k)
    const n = (nums.get(ind) || 0) + 1
    nums.set(ind, n)
    return ind + n + '. ' + body
  })
  const joined = out.join('\n')
  const res = text.slice(0, a) + joined + text.slice(b)
  // a single empty line: put the caret after the new prefix; otherwise select the lines
  if (ls.length === 1 && start === end) {
    const delta = joined.length - ls[0].length
    const caret = Math.max(a, start + delta)
    return { text: res, start: caret, end: caret }
  }
  return { text: res, start: a, end: a + joined.length }
}

// ---------------------------------------------------------------- indenting (Tab / Shift+Tab)

// Indent and outdent the selected lines, like Tab and Shift+Tab in a word processor. In a list,
// Tab makes the item a sub-point of the one above (it lines up under that item's text, which is
// what Markdown needs: 2 spaces under "- ", 3 under "1. "); Shift+Tab moves it back out to the
// level of its parent. Other lines move by 4 spaces. All selected lines move together.
const ITEM_AT = /^( *)([-*+]|\d{1,9}[.)])( +)/
const PARA_STEP = 4
const width = (l) => l.length - l.trimStart().length
const fence = (l) => /^\s{0,3}(`{3,}|~{3,})/.test(l)

// The column where an item's text starts: its sub-points line up there
const textColumn = (m) => m[1].length + m[2].length + Math.min(m[3].length, 4)

export function indent (state, dir) {
  const { text, start, end } = state
  const [a, b] = lineRange(text, start, end)
  const all = text.split('\n')
  const first = text.slice(0, a).split('\n').length - 1
  const last = first + text.slice(a, b).split('\n').length - 1
  // tabs at the start of a line count as 4 spaces
  const norm = (l) => l.replace(/^[ \t]+/, (s) => s.replace(/\t/g, '    '))
  const ls = all.map(norm)
  // inside a ``` code block, Tab is for the code: leave those lines alone
  const inCode = []
  let open = false
  ls.forEach((l, i) => { if (fence(l)) { inCode[i] = true; open = !open } else inCode[i] = open })
  const lead = ls.slice(first, last + 1).findIndex((l, j) => l.trim() && !inCode[first + j])
  if (lead < 0) return state
  const i0 = first + lead
  const cur = width(ls[i0])
  const m0 = ITEM_AT.exec(ls[i0])
  let target
  if (m0) {
    // the item this one would belong to: the closest one above at its level (Tab) or above it (Shift+Tab)
    let parent = null
    for (let i = i0 - 1; i >= 0; i--) {
      if (!ls[i].trim() || inCode[i]) { if (!ls[i].trim() && !ITEM_AT.test(ls[i + 1] || '')) break; continue }
      const m = ITEM_AT.exec(ls[i])
      if (!m) { if (width(ls[i]) < cur) break; continue }
      const w = m[1].length
      if (dir > 0 && w === cur) { parent = m; break }
      if (dir < 0 && w < cur) { parent = m; break }
      if (w < cur) break
    }
    if (dir > 0) target = parent ? textColumn(parent) : cur + (m0[2].length + 1)
    else target = parent ? parent[1].length : Math.max(0, cur - PARA_STEP)
  } else {
    target = dir > 0 ? cur + PARA_STEP : Math.max(0, cur - PARA_STEP)
  }
  const delta = target - cur
  if (!delta) return state
  const out = ls.slice()
  for (let i = first; i <= last; i++) {
    if (!ls[i].trim() || inCode[i]) continue
    const w = width(ls[i])
    out[i] = ' '.repeat(Math.max(0, w + delta)) + ls[i].slice(w)
  }
  // numbered items count again at their new level: 1 for the first sub-point, then on
  for (let i = first; i <= last; i++) {
    const m = ITEM_AT.exec(out[i])
    if (!m || inCode[i] || !/\d/.test(m[2])) continue
    const w = m[1].length
    let n = 1
    for (let j = i - 1; j >= 0; j--) {
      const p = ITEM_AT.exec(out[j])
      if (!out[j].trim()) break
      if (!p) { if (width(out[j]) < w) break; continue }
      if (p[1].length < w) break
      if (p[1].length === w) { if (/\d/.test(p[2])) n = parseInt(p[2], 10) + 1; break }
    }
    out[i] = m[1] + n + m[2].replace(/^\d+/, '') + out[i].slice(m[1].length + m[2].length)
  }
  const changed = out.slice(first, last + 1).join('\n')
  const res = text.slice(0, a) + changed + text.slice(b)
  if (start === end && first === last) {
    // keep the caret next to the same character
    const shift = changed.length - (b - a)
    const caret = Math.max(a + width(out[first]), Math.min(a + changed.length, start + shift))
    return { text: res, start: caret, end: caret }
  }
  return { text: res, start: a, end: a + changed.length }
}

// ---------------------------------------------------------------- blocks: tables, code…

// Puts a block on lines of its own, with a blank line before and after
function block (state, body, selectFrom = 0, selectLen = 0) {
  const { text, start, end } = state
  const before = text.slice(0, start)
  const after = text.slice(end)
  const pre = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const post = !after ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
  const out = before + pre + body + post + after
  const s = before.length + pre.length + selectFrom
  return { text: out, start: s, end: s + selectLen }
}

export function code (state) {
  const sel = state.text.slice(state.start, state.end)
  // a few words on one line: `inline code`; otherwise a code block
  if (sel && !sel.includes('\n')) return wrap(state, '`', '`', 'code')
  const body = sel || 'your code here'
  return block(state, '```\n' + body + '\n```', 4, body.length)
}

export function table (state) {
  const body = '| Column 1 | Column 2 |\n| --- | --- |\n| text | text |'
  return block(state, body, 2, 'Column 1'.length)
}

export function divider (state) {
  return block({ ...state, start: state.end }, '---')
}

// The buttons, in order. `run` takes and returns { text, start, end }.
export const TOOLS = [
  { id: 'heading', icon: 'heading', label: 'Heading', keys: 'Ctrl+H', hint: 'A title for a section. Press again for a smaller one.', md: '# Title', run: (s) => lines(s, 'heading') },
  { id: 'bold', icon: 'bold', label: 'Bold', keys: 'Ctrl+B', hint: 'Makes words stand out.', md: '**bold**', run: (s) => wrap(s, '**', '**', 'bold text') },
  { id: 'italic', icon: 'italic', label: 'Italic', keys: 'Ctrl+I', hint: 'Slanted, for emphasis.', md: '*italic*', run: (s) => wrap(s, '*', '*', 'italic text') },
  { id: 'underline', icon: 'underline', label: 'Underline', keys: 'Ctrl+U', hint: 'A line under the words. (Other Markdown apps may show it in bold.)', md: '__underlined__', run: (s) => wrap(s, '__', '__', 'underlined text') },
  { id: 'strike', icon: 'strike', label: 'Strikethrough', keys: 'Ctrl+Shift+X', hint: 'Crossed out, for things that are done or wrong.', md: '~~crossed out~~', run: (s) => wrap(s, '~~', '~~', 'crossed out') },
  { sep: true },
  { id: 'bullet', icon: 'list', label: 'Bullet list', keys: 'Ctrl+Shift+8', hint: 'A list with dots. Each line is one item.', md: '- first\n- second', run: (s) => lines(s, 'bullet') },
  { id: 'number', icon: 'listOrdered', label: 'Numbered list', keys: 'Ctrl+Shift+7', hint: 'Steps in order: 1, 2, 3…', md: '1. first\n2. second', run: (s) => lines(s, 'number') },
  { id: 'task', icon: 'tasks', label: 'Checklist', keys: 'Ctrl+Shift+9', hint: 'Things to do. Change [ ] to [x] when one is done.', md: '- [ ] to do\n- [x] done', run: (s) => lines(s, 'task') },
  { id: 'indent', icon: 'indent', label: 'Indent', keys: 'Tab', hint: 'Moves the lines to the right. In a list, the item becomes a sub-point of the one above.', md: '- Fruit\n  - Apples\n  - Pears\n- Bread', run: (s) => indent(s, 1) },
  { id: 'outdent', icon: 'outdent', label: 'Outdent', keys: 'Shift+Tab', hint: 'Moves the lines back to the left. A sub-point goes back to the level above.', md: '1. Plan\n   1. Dates\n   2. Places\n2. Book', run: (s) => indent(s, -1) },
  { sep: true },
  { id: 'quote', icon: 'quote', label: 'Quote', hint: 'Someone else\'s words, or a note that stands apart.', md: '> a quote', run: (s) => lines(s, 'quote') },
  { id: 'code', icon: 'code', label: 'Code', hint: 'Code or commands, in a fixed-width font.', md: '`code`', run: code },
  { id: 'link', icon: 'link', label: 'Link', keys: 'Ctrl+K', hint: 'Words that open a web page.', md: '[OpenDiscord](https://github.com)', run: link },
  { id: 'table', icon: 'table', label: 'Table', hint: 'Rows and columns. | separates the columns.', md: '| Name | Brings |\n| --- | --- |\n| Ana | tent |', run: table },
  { id: 'divider', icon: 'minus', label: 'Divider', hint: 'A line across the page between parts.', md: 'above\n\n---\n\nbelow', run: divider }
]

// Ctrl+… shortcuts for the editor (⌘ on a Mac, where ⌘H hides the app, so no heading key there)
export function toolForKey (e) {
  if (!mod(e) || e.altKey) return null
  const k = e.key.toLowerCase()
  if (!e.shiftKey) return { b: 'bold', i: 'italic', u: 'underline', k: 'link', h: isMac() ? null : 'heading' }[k] || null
  // the physical keys, so Ctrl+Shift+8 works on every keyboard layout
  return { Digit8: 'bullet', Digit7: 'number', Digit9: 'task', KeyX: 'strike' }[e.code] || null
}

// ---------------------------------------------------------------- the live preview

// Splits a document into its top-level blocks (separated by blank lines, but never inside a
// ``` code block), each with the line it starts on. The preview renders them one by one, so it
// can show which block the caret is in, and only re-renders the blocks that changed.
export function splitBlocks (text) {
  const ls = String(text || '').split('\n')
  const out = []
  let cur = null
  let fence = null
  ls.forEach((l, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l)
    if (fence) {
      cur.text += '\n' + l
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !l.trim().replace(/^[`~]+/, '')) fence = null
      return
    }
    if (!l.trim()) { cur = null; return }
    if (!cur) { cur = { line: i, text: l }; out.push(cur) } else cur.text += '\n' + l
    if (f) fence = f[1]
  })
  return out
}

// Which block holds a line (the last one starting at or before it)
export function blockAt (blocks, line) {
  let found = -1
  for (let i = 0; i < blocks.length && blocks[i].line <= line; i++) found = i
  return found
}

// The smallest change between two texts, so a button press can go through the editor's own
// undo (document.execCommand('insertText') on just that span)
export function diffSpan (a, b) {
  let p = 0
  const max = Math.min(a.length, b.length)
  while (p < max && a[p] === b[p]) p++
  let s = 0
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) }
}

// ---------------------------------------------------------------- Enter in a list

// Enter at the end of a list item starts the next one (- , 1. → 2. , - [ ] , > ); Enter on an
// empty sub-point moves it back one level, and on an empty top-level item ends the list.
// Returns null when Enter should just be Enter.
const ITEM = /^(\s*)(> |[-*+] \[[ xX]\] |[-*+] |(\d{1,9})([.)]) )/
export function continueList ({ text, start, end }) {
  if (start !== end) return null
  const a = text.lastIndexOf('\n', start - 1) + 1
  let b = text.indexOf('\n', start)
  if (b < 0) b = text.length
  const m = ITEM.exec(text.slice(a, b))
  if (!m || start < a + m[0].length) return null
  if (!text.slice(a + m[0].length, b).trim()) {
    // an empty sub-point: back to the level above
    if (m[1].length && !m[2].startsWith('>')) {
      const res = indent({ text, start, end }, -1)
      if (res.text !== text) {
        const la = res.text.lastIndexOf('\n', res.start - 1) + 1
        let lb = res.text.indexOf('\n', la)
        if (lb < 0) lb = res.text.length
        return { text: res.text, start: lb, end: lb }
      }
    }
    // an empty item: take its marker away and stop the list
    const out = text.slice(0, a) + m[1] + text.slice(a + m[0].length)
    return { text: out, start: a + m[1].length, end: a + m[1].length }
  }
  let marker = m[2]
  if (m[3]) marker = (parseInt(m[3], 10) + 1) + m[4] + ' '
  else if (/\[[ xX]\]/.test(marker)) marker = marker[0] + ' [ ] '
  const ins = '\n' + m[1] + marker
  return { text: text.slice(0, start) + ins + text.slice(end), start: start + ins.length, end: start + ins.length }
}

// ---------------------------------------------------------------- ticking a checkbox

// Ticks or unticks the nth checkbox of the block that starts on `line`
const TASK = /^(\s*[-*+] \[)([ xX])(\] )/
export function toggleTask (text, line, n) {
  const ls = text.split('\n')
  let k = 0
  let fence = false
  for (let i = line; i < ls.length; i++) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(ls[i])) fence = !fence
    if (!fence && i > line && !ls[i].trim()) break
    const m = !fence && TASK.exec(ls[i])
    if (m && k++ === n) {
      ls[i] = m[1] + (m[2] === ' ' ? 'x' : ' ') + m[3] + ls[i].slice(m[0].length)
      return ls.join('\n')
    }
  }
  return text
}
