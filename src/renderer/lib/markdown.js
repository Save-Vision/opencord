// Tiny, safe markdown → Preact vnodes (never touches innerHTML).
//
// Chat messages (renderMarkdown): ```code blocks``` (highlighted), `inline code`, **bold**,
// *italic*, __underline__, ~~strike~~, ||spoiler||, > quotes, links, [masked](links), @mentions.
//
// Markdown files (renderMarkdownDoc): the above plus headings, lists, task lists, tables,
// horizontal rules and nested quotes. Remote images are shown as links rather than loaded,
// because loading them would tell that server your IP address.
import { h } from '../vendor/preact-htm.js'
import { highlight } from './highlight.js'

const INLINE = new RegExp([
  /(?<tick>`+)(?<code>[\s\S]*?[^`])\k<tick>(?!`)/.source,
  /!\[(?<imgAlt>[^\]\n]*)\]\((?<imgUrl>https?:\/\/[^\s)]+)\)/.source,
  /\[(?<linkText>[^\]\n]+)\]\((?<linkUrl>https?:\/\/[^\s)]+)\)/.source,
  /\*\*(?<bold>[\s\S]+?)\*\*/.source,
  /__(?<under>[\s\S]+?)__/.source,
  /\*(?!\s)(?<em>[\s\S]+?)\*/.source,
  /~~(?<strike>[\s\S]+?)~~/.source,
  /\|\|(?<spoiler>[\s\S]+?)\|\|/.source,
  /<(?<angle>https?:\/\/[^\s<>]+)>/.source,
  /(?<url>(?:https?|opendiscord):\/\/[^\s<>]+[^\s<>.,:;"')\]!?])/.source,
  /(?<mention>@[\p{L}\p{N}_.-]+)/.source
].join('|'), 'gu')

// URLs in a message that should get a link preview: not inside `code`, not <suppressed>.
export function previewableUrls (text, max = 3) {
  const out = []
  const stripped = String(text || '').replace(/```[\s\S]*?```|`[^`\n]*`|<https?:\/\/[^\s<>]+>/g, ' ')
  for (const m of stripped.matchAll(/https?:\/\/[^\s<>]+[^\s<>.,:;"')\]!?]/g)) {
    if (!out.includes(m[0])) out.push(m[0])
    if (out.length >= max) break
  }
  return out
}

function Spoiler ({ children }) {
  return h('span', {
    class: 'spoiler',
    onClick: (e) => e.currentTarget.classList.add('revealed')
  }, children)
}

const link = (key, url, text, ctx) => h('a', {
  key,
  href: url,
  title: url,
  onClick: (e) => { e.preventDefault(); e.stopPropagation(); ctx.openLink(url) }
}, text)

function inline (text, ctx, keyBase = 0) {
  const out = []
  let last = 0
  let m
  let k = keyBase
  const re = new RegExp(INLINE.source, INLINE.flags) // fresh lastIndex: inline() recurses
  while ((m = re.exec(text))) {
    const g = m.groups
    if (m.index > last) out.push(text.slice(last, m.index))
    if (g.code !== undefined) out.push(h('code', { key: k++, class: 'inline' }, g.code))
    else if (g.imgUrl !== undefined) out.push(link(k++, g.imgUrl, '🖼 ' + (g.imgAlt || 'image'), ctx))
    else if (g.linkUrl !== undefined) out.push(link(k++, g.linkUrl, inline(g.linkText, ctx), ctx))
    else if (g.bold !== undefined) out.push(h('strong', { key: k++ }, inline(g.bold, ctx)))
    else if (g.under !== undefined) out.push(h('u', { key: k++ }, inline(g.under, ctx)))
    else if (g.em !== undefined) out.push(h('em', { key: k++ }, inline(g.em, ctx)))
    else if (g.strike !== undefined) out.push(h('s', { key: k++ }, inline(g.strike, ctx)))
    else if (g.spoiler !== undefined) out.push(h(Spoiler, { key: k++ }, inline(g.spoiler, ctx)))
    else if (g.angle !== undefined) out.push(link(k++, g.angle, g.angle, ctx))
    else if (g.url !== undefined) out.push(link(k++, g.url, g.url, ctx))
    else if (g.mention !== undefined) {
      const name = g.mention.slice(1).toLowerCase()
      const known = ctx.names?.has(name) || name === 'everyone' || name === 'here'
      out.push(known
        ? h('span', { key: k++, class: 'mention' + (name === ctx.myName || name === 'everyone' || name === 'here' ? ' me' : '') }, g.mention)
        : g.mention)
    }
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const QUOTE = /^>\s?/

// Lines starting with "> " become a blockquote; everything else keeps its newlines
// (message text is rendered with white-space: pre-wrap).
function blocks (text, ctx) {
  const out = []
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const group = []
    const isQuote = QUOTE.test(lines[i])
    while (i < lines.length && QUOTE.test(lines[i]) === isQuote) group.push(isQuote ? lines[i++].replace(QUOTE, '') : lines[i++])
    out.push(h(isQuote ? 'blockquote' : 'span', { key: out.length }, inline(group.join('\n'), ctx)))
  }
  return out
}

export function codeBlock (key, code, lang) {
  return h('pre', { key, class: 'codeblock', 'data-lang': lang || '' }, h('code', null, highlight(code, lang)))
}

export function renderMarkdown (text, ctx) {
  // split with 2 capture groups → [text, lang, code, text, lang, code, ...]
  const parts = text.split(/```(?:([\w+#.-]{1,20})\n)?([\s\S]*?)```/g)
  const out = []
  for (let i = 0; i < parts.length; i += 3) {
    let t = parts[i]
    if (i > 0) t = t.replace(/^\n/, '')
    if (i + 2 < parts.length) t = t.replace(/\n$/, '')
    if (t) out.push(h('span', { key: 'b' + i }, blocks(t, ctx)))
    if (i + 2 < parts.length) {
      const code = (parts[i + 2] || '').replace(/^\n/, '').replace(/\n$/, '')
      out.push(codeBlock('c' + i, code, parts[i + 1] || ''))
    }
  }
  return out
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\s|‍|️)+$/u
export function isEmojiOnly (text) {
  if (!text || text.length > 40 || !EMOJI_ONLY.test(text)) return false
  return !/^[\d#*\s]+$/.test(text)
}

// ---------------------------------------------------------------- markdown documents

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/
const isBlank = (l) => /^\s*$/.test(l)
const startsBlock = (l) => FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l.trimStart()) || LIST.test(l)

function cells (line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
}

function list (lines, start, ctx, key, depth) {
  const first = LIST.exec(lines[start])
  const indent = first[1].length
  const ordered = /\d/.test(first[2])
  const items = []
  let i = start
  while (i < lines.length) {
    const m = LIST.exec(lines[i])
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break
    const body = [m[3]]
    i++
    // continuation lines and nested lists: anything indented deeper, or lazily continued text
    while (i < lines.length && !isBlank(lines[i])) {
      const n = LIST.exec(lines[i])
      if (n && n[1].length <= indent) break
      if (!n && /^\s*$/.test(lines[i].slice(0, indent + 1)) === false && startsBlock(lines[i])) break
      body.push(lines[i].replace(new RegExp('^ {0,' + (indent + 4) + '}'), ''))
      i++
    }
    if (i < lines.length && isBlank(lines[i]) && i + 1 < lines.length) {
      const n = LIST.exec(lines[i + 1])
      if (n && n[1].length === indent && /\d/.test(n[2]) === ordered) i++ // loose list: skip the blank line
    }
    let text = body.join('\n')
    let task = null
    const t = /^\[([ xX])\]\s+/.exec(text)
    if (t) { task = t[1] !== ' '; text = text.slice(t[0].length) }
    items.push(h('li', { key: items.length, class: task === null ? '' : 'task' }, [
      task !== null && h('input', { type: 'checkbox', checked: task, disabled: true, key: 'cb' }),
      ...docBlocks(text, ctx, depth + 1, true)
    ]))
  }
  const startNum = ordered ? parseInt(first[2], 10) : undefined
  return { node: h(ordered ? 'ol' : 'ul', { key, start: startNum !== 1 ? startNum : undefined }, items), next: i }
}

function docBlocks (text, ctx, depth = 0, tight = false) {
  if (depth > 12) return [h('p', { key: 'deep' }, text)]
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) { i++; continue }
    let m
    if ((m = FENCE.exec(line))) {
      const fence = m[2]
      const code = []
      i++
      while (i < lines.length && !(lines[i].trimStart().startsWith(fence[0].repeat(fence.length)) && lines[i].trim().replace(new RegExp('^\\' + fence[0] + '+'), '') === '')) code.push(lines[i++])
      i++
      out.push(codeBlock(out.length, code.join('\n'), m[3]))
      continue
    }
    if ((m = HEADING.exec(line))) {
      out.push(h('h' + m[1].length, { key: out.length }, inline(m[2], ctx)))
      i++
      continue
    }
    if (HR.test(line)) { out.push(h('hr', { key: out.length })); i++; continue }
    if (QUOTE.test(line.trimStart())) {
      const q = []
      while (i < lines.length && !isBlank(lines[i]) && (QUOTE.test(lines[i].trimStart()) || !startsBlock(lines[i]))) q.push(lines[i++].trimStart().replace(QUOTE, ''))
      out.push(h('blockquote', { key: out.length }, docBlocks(q.join('\n'), ctx, depth + 1)))
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line)
      const aligns = cells(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) rows.push(cells(lines[i++]))
      const cell = (tag, c, j) => h(tag, { key: j, style: aligns[j] ? { textAlign: aligns[j] } : undefined }, inline(c, ctx))
      out.push(h('div', { key: out.length, class: 'md-table' }, h('table', null, [
        h('thead', { key: 'h' }, h('tr', null, head.map((c, j) => cell('th', c, j)))),
        h('tbody', { key: 'b' }, rows.map((r, ri) => h('tr', { key: ri }, head.map((_, j) => cell('td', r[j] || '', j)))))
      ])))
      continue
    }
    if (LIST.test(line)) {
      const { node, next } = list(lines, i, ctx, out.length, depth)
      out.push(node)
      i = next
      continue
    }
    const para = []
    while (i < lines.length && !isBlank(lines[i]) && !(para.length && startsBlock(lines[i])) &&
      !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) para.push(lines[i++].trim())
    if (!para.length) { para.push(lines[i++].trim()) }
    // A line ending in two spaces or a backslash is a hard break; other newlines are spaces
    const parts = []
    para.forEach((l, j) => {
      if (j) parts.push(ctx.breaks || /\\$/.test(para[j - 1]) ? h('br', { key: 'br' + j }) : ' ')
      parts.push(...inline(l.replace(/\\$/, ''), ctx, j * 1000))
    })
    out.push(tight && out.length === 0 ? h('span', { key: out.length }, parts) : h('p', { key: out.length }, parts))
  }
  return out
}

export function renderMarkdownDoc (text, ctx) {
  return h('div', { class: 'md-doc' }, docBlocks(String(text || ''), { names: new Set(), myName: '', ...ctx }))
}
