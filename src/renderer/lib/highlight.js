// A small syntax highlighter that returns Preact vnodes (never innerHTML). It is a tokenizer,
// not a parser, which is plenty for chat snippets and file previews.
import { h } from '../vendor/preact-htm.js'

const words = (s) => new Set(s.split(/\s+/).filter(Boolean))

const JS_KW = words(`break case catch class const continue debugger default delete do else export extends finally for
  function if import in instanceof let new return super switch this throw try typeof var void while with yield async await
  of static get set interface type enum implements private public protected readonly declare namespace abstract as from
  satisfies keyof infer`)
const JS_LIT = words('true false null undefined NaN Infinity')
const PY_KW = words(`and as assert async await break class continue def del elif else except finally for from global if
  import in is lambda nonlocal not or pass raise return try while with yield match case print`)
const PY_LIT = words('True False None self cls')
const C_KW = words(`auto break case catch char class const constexpr continue default delete do double else enum explicit
  extern final float for friend goto if inline int long mutable namespace new noexcept operator override private protected
  public register return short signed sizeof static struct switch template this throw try typedef typename union unsigned
  using virtual void volatile while bool abstract assert boolean byte extends implements import instanceof interface native
  package super synchronized throws transient var val fun object when is in out internal open data sealed lateinit companion
  base checked decimal delegate event fixed foreach implicit lock params readonly ref sbyte stackalloc string uint ulong
  unchecked unsafe ushort async await yield func go defer chan map range select fallthrough type let mut impl fn pub mod
  crate self Self trait where loop match move dyn use as unsafe extern macro_rules guard protocol extension init deinit
  echo function array foreach endforeach elseif require include`)
const C_LIT = words('true false null nullptr NULL nil None undefined')
const SH_KW = words(`if then else elif fi for while until do done case esac function in return export local readonly
  unset shift exit break continue source alias echo printf cd set declare test`)
const PS_KW = words(`function param if else elseif foreach for while do until return try catch finally throw switch
  begin process end filter break continue exit trap`)
const SQL_KW = words(`select from where and or not insert into values update set delete create table drop alter add
  column primary key foreign references index unique join left right inner outer full on group by order asc desc having
  limit offset as distinct union all exists in is null like between case when then else end default constraint view
  begin commit rollback transaction int integer text varchar char boolean date timestamp real float double`)
const RB_KW = words(`alias and begin break case class def defined do else elsif end ensure false for if in module next nil
  not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor puts`)
const LUA_KW = words('and break do else elseif end false for function goto if in local nil not or repeat return then true until while')

const R = {
  slashComment: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
  hashComment: /#[^\n]*/,
  dq: /"(?:[^"\\\n]|\\.)*"/,
  sq: /'(?:[^'\\\n]|\\.)*'/,
  tpl: /`(?:[^`\\]|\\.)*`/,
  triple: /"""[\s\S]*?"""|'''[\s\S]*?'''/,
  num: /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*\b/,
  word: /[A-Za-z_$][\w$]*/,
  meta: /@[A-Za-z_][\w.]*/
}

// Each language: ordered [class, regex] rules; 'word' tokens are classified with kw/lit sets.
const LANGS = {
  js: { rules: [['com', R.slashComment], ['str', R.tpl], ['str', R.dq], ['str', R.sq], ['re', /\/(?![/*\s])(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[dgimsuyv]*(?=\s*[,;)\]}.]|\s*$)/], ['num', R.num], ['meta', R.meta], ['word', R.word]], kw: JS_KW, lit: JS_LIT },
  py: { rules: [['com', R.hashComment], ['str', R.triple], ['str', /[rbfuRBFU]{0,2}"(?:[^"\\\n]|\\.)*"/], ['str', /[rbfuRBFU]{0,2}'(?:[^'\\\n]|\\.)*'/], ['num', R.num], ['meta', R.meta], ['word', R.word]], kw: PY_KW, lit: PY_LIT },
  c: { rules: [['com', R.slashComment], ['meta', /^\s*#\s*\w+/m], ['str', /@?"(?:[^"\\\n]|\\.)*"/], ['str', /'(?:[^'\\\n]|\\.){1,4}'/], ['str', R.tpl], ['num', R.num], ['meta', R.meta], ['word', R.word]], kw: C_KW, lit: C_LIT },
  sh: { rules: [['com', /(?:^|\s)#[^\n]*/], ['str', R.dq], ['str', /'[^']*'/], ['var', /\$\{[^}\n]*\}|\$[A-Za-z_]\w*|\$[0-9@#?*!$-]/], ['num', R.num], ['word', /[A-Za-z_][\w-]*/]], kw: SH_KW, lit: words('true false') },
  ps: { rules: [['com', /<#[\s\S]*?#>|#[^\n]*/], ['str', R.dq], ['str', /'[^']*'/], ['var', /\$[\w:]+/], ['attr', /-[A-Za-z]\w*/], ['num', R.num], ['word', /[A-Za-z_][\w-]*/]], kw: PS_KW, lit: words('$true $false $null'), ci: true },
  sql: { rules: [['com', /--[^\n]*|\/\*[\s\S]*?\*\//], ['str', /'(?:[^']|'')*'/], ['str', R.dq], ['num', R.num], ['word', R.word]], kw: SQL_KW, lit: words('true false null'), ci: true },
  rb: { rules: [['com', R.hashComment], ['str', R.dq], ['str', R.sq], ['var', /[@$:][A-Za-z_]\w*/], ['num', R.num], ['word', R.word]], kw: RB_KW, lit: words('true false nil') },
  lua: { rules: [['com', /--\[\[[\s\S]*?\]\]|--[^\n]*/], ['str', /\[\[[\s\S]*?\]\]/], ['str', R.dq], ['str', R.sq], ['num', R.num], ['word', R.word]], kw: LUA_KW, lit: words('true false nil') },
  json: { rules: [['attr', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/], ['str', R.dq], ['num', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/], ['word', R.word]], kw: new Set(), lit: words('true false null') },
  css: { rules: [['com', /\/\*[\s\S]*?\*\//], ['str', R.dq], ['str', R.sq], ['kw', /@[\w-]+/], ['num', /#[\da-fA-F]{3,8}\b/], ['attr', /--?[A-Za-z][\w-]*(?=\s*:(?!:))|\b[a-z-]+(?=\s*:\s*[^;{}\n]*[;}])/], ['num', /-?\b\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex)?\b/], ['fn', /[\w-]+(?=\()/], ['type', /[.#][A-Za-z_][\w-]*/]], kw: new Set(), lit: words('important') },
  html: { rules: [['com', /<!--[\s\S]*?-->/], ['tag', /<\/?[A-Za-z][\w:.-]*|\/?>/], ['attr', /[A-Za-z_:@][\w:.@-]*(?==)/], ['str', R.dq], ['str', R.sq], ['meta', /&[#\w]+;/]], kw: new Set(), lit: new Set() },
  yaml: { rules: [['com', /(?:^|\s)#[^\n]*/], ['attr', /[\w.\/-]+(?=\s*:(?:\s|$))/], ['str', R.dq], ['str', R.sq], ['meta', /^---$|[&*][\w-]+|!![\w]+/m], ['num', R.num], ['word', R.word]], kw: new Set(), lit: words('true false null yes no on off ~') },
  ini: { rules: [['com', /^\s*[#;][^\n]*/m], ['kw', /^\s*\[[^\]\n]+\]/m], ['attr', /^\s*[\w.-]+(?=\s*[=:])/m], ['str', R.dq], ['str', R.sq], ['num', R.num], ['word', R.word]], kw: new Set(), lit: words('true false yes no on off') },
  diff: { rules: [['add', /^\+[^\n]*/m], ['del', /^-[^\n]*/m], ['meta', /^@@[^\n]*|^(?:diff|index) [^\n]*/m]], kw: new Set(), lit: new Set() },
  md: { rules: [['kw', /^#{1,6} [^\n]*/m], ['str', /`[^`\n]+`/], ['attr', /\*\*[^*\n]+\*\*|__[^_\n]+__/], ['meta', /^\s*(?:[-*+]|\d+\.)\s/m], ['fn', /\[[^\]\n]+\]\([^)\n]+\)/]], kw: new Set(), lit: new Set() }
}

const ALIASES = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', typescript: 'js', tsx: 'js', mts: 'js', node: 'js',
  py: 'py', python: 'py', pyw: 'py', c: 'c', h: 'c', cpp: 'c', cc: 'c', cxx: 'c', hpp: 'c', 'c++': 'c', cs: 'c', csharp: 'c',
  java: 'c', kt: 'c', kts: 'c', kotlin: 'c', go: 'c', golang: 'c', rs: 'c', rust: 'c', swift: 'c', php: 'c', dart: 'c',
  scala: 'c', groovy: 'c', gradle: 'c', zig: 'c', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', dockerfile: 'sh',
  makefile: 'sh', mk: 'sh', bat: 'ps', cmd: 'ps', ps1: 'ps', psm1: 'ps', powershell: 'ps', pwsh: 'ps', sql: 'sql',
  rb: 'rb', ruby: 'rb', lua: 'lua', json: 'json', jsonc: 'json', json5: 'json', css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html', xaml: 'html', csproj: 'html',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini',
  gitignore: 'sh', diff: 'diff', patch: 'diff', md: 'md', markdown: 'md'
}

const LABELS = { js: 'JavaScript', py: 'Python', c: 'Code', sh: 'Shell', ps: 'PowerShell', sql: 'SQL', rb: 'Ruby', lua: 'Lua', json: 'JSON', css: 'CSS', html: 'HTML/XML', yaml: 'YAML', ini: 'Config', diff: 'Diff', md: 'Markdown' }

export function langFor (name) {
  const n = String(name || '').toLowerCase()
  return ALIASES[n] || null
}

// "src/app.test.ts" -> "ts"; "Dockerfile" -> "dockerfile"; ".gitignore" -> "gitignore"
export function extOf (filename) {
  const base = String(filename || '').split(/[\\/]/).pop().toLowerCase()
  const i = base.lastIndexOf('.')
  return i <= 0 ? base.replace(/^\./, '') : base.slice(i + 1)
}

export const langLabel = (ext) => {
  const l = langFor(ext)
  if (l === 'c') return ({ c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', cs: 'C#', java: 'Java', kt: 'Kotlin', go: 'Go', rs: 'Rust', swift: 'Swift', php: 'PHP', dart: 'Dart' })[ext] || 'Code'
  if (l === 'js' && /^(ts|tsx|mts)$/.test(ext)) return 'TypeScript'
  return LABELS[l] || 'Text'
}

const compiled = new Map()
function compile (lang) {
  if (compiled.has(lang)) return compiled.get(lang)
  const def = LANGS[lang]
  const re = new RegExp(def.rules.map(([, r]) => '(' + r.source + ')').join('|'), 'g' + (def.rules.some(([, r]) => r.multiline) ? 'm' : '') + (def.ci ? 'i' : ''))
  const out = { re, def }
  compiled.set(lang, out)
  return out
}

export function highlight (code, langName) {
  const lang = langFor(langName)
  if (!lang || code.length > 400000) return code
  const { re, def } = compile(lang)
  re.lastIndex = 0
  const out = []
  let last = 0
  let m
  let k = 0
  while ((m = re.exec(code))) {
    if (m[0] === '') { re.lastIndex++; continue }
    let gi = 1
    while (m[gi] === undefined) gi++
    let cls = def.rules[gi - 1][0]
    const text = m[0]
    if (cls === 'word') {
      const w = def.ci ? text.toLowerCase() : text
      if (def.kw.has(w)) cls = 'kw'
      else if (def.lit.has(w)) cls = 'lit'
      else if (/^\s*\(/.test(code.slice(re.lastIndex, re.lastIndex + 40))) cls = 'fn'
      else if (/^[A-Z][a-z]\w*$/.test(text) && lang !== 'sql') cls = 'type'
      else cls = null
    }
    if (m.index > last) out.push(code.slice(last, m.index))
    out.push(cls ? h('span', { key: k++, class: 'tk-' + cls }, text) : text)
    last = re.lastIndex
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}
