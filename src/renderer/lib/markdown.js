// Tiny, safe markdown → Preact vnodes (never touches innerHTML).
// Supports: ```code blocks```, `inline code`, **bold**, *italic*, __underline__,
// ~~strike~~, ||spoiler||, > quotes, links and @mentions.
import { h } from '../vendor/preact-htm.js'

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*(?!\s)([\s\S]+?)\*|~~([\s\S]+?)~~|\|\|([\s\S]+?)\|\||(https?:\/\/[^\s<>]+[^\s<>.,:;"')\]!?])|(@[\p{L}\p{N}_.\-]+)/gu

function Spoiler ({ children }) {
  return h('span', {
    class: 'spoiler',
    onClick: (e) => e.currentTarget.classList.add('revealed')
  }, children)
}

function inline (text, ctx, keyBase = 0) {
  const out = []
  let last = 0
  let m
  let k = keyBase
  const re = new RegExp(INLINE.source, INLINE.flags) // fresh lastIndex: inline() recurses
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[2] !== undefined) out.push(h('code', { key: k++, class: 'inline' }, m[2]))
    else if (m[3] !== undefined) out.push(h('strong', { key: k++ }, inline(m[3], ctx)))
    else if (m[4] !== undefined) out.push(h('u', { key: k++ }, inline(m[4], ctx)))
    else if (m[5] !== undefined) out.push(h('em', { key: k++ }, inline(m[5], ctx)))
    else if (m[6] !== undefined) out.push(h('s', { key: k++ }, inline(m[6], ctx)))
    else if (m[7] !== undefined) out.push(h(Spoiler, { key: k++ }, inline(m[7], ctx)))
    else if (m[8] !== undefined) {
      const url = m[8]
      out.push(h('a', {
        key: k++,
        href: url,
        title: url,
        onClick: (e) => { e.preventDefault(); ctx.openLink(url) }
      }, url))
    } else if (m[9] !== undefined) {
      const name = m[9].slice(1).toLowerCase()
      const known = ctx.names.has(name) || name === 'everyone' || name === 'here'
      out.push(known
        ? h('span', { key: k++, class: 'mention' + (name === ctx.myName || name === 'everyone' || name === 'here' ? ' me' : '') }, m[9])
        : m[9])
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

export function renderMarkdown (text, ctx) {
  // split with 2 capture groups → [text, lang, code, text, lang, code, ...]
  const parts = text.split(/```(?:([\w+-]{1,20})\n)?([\s\S]*?)```/g)
  const out = []
  for (let i = 0; i < parts.length; i += 3) {
    let t = parts[i]
    if (i > 0) t = t.replace(/^\n/, '')
    if (i + 2 < parts.length) t = t.replace(/\n$/, '')
    if (t) out.push(h('span', { key: 'b' + i }, blocks(t, ctx)))
    if (i + 2 < parts.length) {
      const code = (parts[i + 2] || '').replace(/^\n/, '').replace(/\n$/, '')
      out.push(h('pre', { key: 'c' + i, class: 'codeblock', 'data-lang': parts[i + 1] || '' }, h('code', null, code)))
    }
  }
  return out
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\s|‍|️)+$/u
export function isEmojiOnly (text) {
  if (!text || text.length > 40 || !EMOJI_ONLY.test(text)) return false
  return !/^[\d#*\s]+$/.test(text)
}
