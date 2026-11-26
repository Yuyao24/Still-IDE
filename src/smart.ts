// Small helps while typing, as in other IDEs:
//  - Enter after `class Name:` (Python), `class Name {` (Java, JavaScript, TypeScript, C#) fills in
//    the constructor when the class is still empty.
//  - Enter at the end of `def __init__(self, name, age):` writes `self.name = name` for each parameter.
//  - `(` after `def name` inside a class adds `self` (or `cls` under @classmethod).
//  - `/*` closes itself; Enter inside `/** … */` lays the comment out and later lines start with ` * `.
//    Above a function, `/**` fills in @param and @return from its signature.
//  - Enter between `"""` and `"""` opens the docstring; under a function it lists Args and Returns.
//  - Typing `{name}` inside a plain Python string makes it an f-string.
//  - Renaming an HTML, XML or JSX tag renames its closing tag too.
//  - Optionally, Enter inside a `//` or `#` comment starts the next line as a comment.
import { EditorState, Prec, StateEffect, StateField, type Extension, type Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { clearSnippet, insertBracket, snippet } from '@codemirror/autocomplete'
import { ensureSyntaxTree, getIndentUnit, syntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'

export interface SmartOptions {
  /** Constructors, `self`, and `self.x = x` from `__init__`. */
  constructors: boolean
  /** Docstrings and Javadoc filled in from the signature. */
  docs: boolean
  /** `{name}` in a plain Python string makes it an f-string. */
  fStrings: boolean
  /** Enter inside a line comment continues it. */
  comments: boolean
  /** Brackets close themselves (the `self` help adds the closing one only then). */
  closeBrackets: boolean
}

const clike = new Set(['Java', 'JavaScript', 'JavaScript JSX', 'TypeScript', 'TypeScript JSX', 'C', 'C++', 'C#', 'Go', 'Rust', 'Kotlin', 'CSS', 'Groovy', 'PHP', 'Scala', 'Dart', 'Swift'])
const tagLanguages = new Set(['HTML', 'XML', 'JavaScript JSX', 'TypeScript JSX', 'Vue', 'Svelte'])
const constructors: Record<string, (name: string) => string> = {
  Python: () => 'def __init__(self${}):\n\t${pass}',
  Java: name => `public ${name}(\${}) {\n\t\${}\n}`,
  'C#': name => `public ${name}(\${}) {\n\t\${}\n}`,
  JavaScript: () => 'constructor(${}) {\n\t${}\n}',
  'JavaScript JSX': () => 'constructor(${}) {\n\t${}\n}',
  TypeScript: () => 'constructor(${}) {\n\t${}\n}',
  'TypeScript JSX': () => 'constructor(${}) {\n\t${}\n}',
}

function treeAt(state: EditorState, pos: number): Tree {
  return ensureSyntaxTree(state, pos, 40) ?? syntaxTree(state)
}
function inComment(state: EditorState, pos: number) {
  return /Comment/.test(syntaxTree(state).resolveInner(pos, -1).name)
}
function inString(state: EditorState, pos: number) {
  return /String|Template|Regexp/.test(syntaxTree(state).resolveInner(pos, -1).name)
}
/** Splits on commas that aren't inside brackets, generics or quotes. */
function splitTop(text: string) {
  const parts: string[] = []
  let depth = 0, quote = '', start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) { if (char === quote && text[index - 1] !== '\\') quote = ''; continue }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if ('([{<'.includes(char)) depth++
    else if (')]}>'.includes(char)) depth = Math.max(0, depth - 1)
    else if (char === ',' && depth === 0) { parts.push(text.slice(start, index)); start = index + 1 }
  }
  parts.push(text.slice(start))
  return parts.map(part => part.trim()).filter(Boolean)
}
const escapeSnippet = (text: string) => text.replace(/[$\\{}]/g, char => '\\' + char)

// ---- Python ----
const pythonDef = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\((.*)\)\s*(?:->\s*(.+?))?\s*:\s*(#.*)?$/
function pythonParams(inside: string, dropFirst: boolean) {
  const names = splitTop(inside)
    .filter(part => part !== '/' && part !== '*' && !part.startsWith('*'))
    .map(part => part.split(/[:=]/)[0].trim())
    .filter(name => /^[A-Za-z_]\w*$/.test(name))
  return dropFirst && (names[0] === 'self' || names[0] === 'cls') ? names.slice(1) : names
}
/** Whether a line sits in a class (by indentation), and the decorators right above it. */
function pythonContext(state: EditorState, lineNumber: number, indent: number) {
  const decorators: string[] = []
  for (let number = lineNumber - 1; number >= 1; number--) {
    const text = state.doc.line(number).text
    if (/^\s*@/.test(text)) { decorators.push(text.trim()); continue }
    break
  }
  for (let number = lineNumber - 1; number >= 1; number--) {
    const text = state.doc.line(number).text
    if (!text.trim() || /^\s*(#|@)/.test(text)) continue
    const own = /^\s*/.exec(text)![0].length
    if (own < indent) return { inClass: /^\s*class\b/.test(text), decorators }
  }
  return { inClass: false, decorators }
}

function pythonEnter(view: EditorView, options: SmartOptions): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty || state.selection.ranges.length > 1) return false
  const line = state.doc.lineAt(range.head)
  const before = state.sliceDoc(line.from, range.head)
  const after = state.sliceDoc(range.head, line.to)
  const indent = /^\s*/.exec(line.text)![0]
  const unit = ' '.repeat(getIndentUnit(state))

  // """|"""  →  opened onto its own lines; under a function, with its Args and Returns.
  const quotes = /("""|''')$/.exec(before)
  if (quotes && after.startsWith(quotes[1])) {
    const previous = line.number > 1 ? state.doc.line(line.number - 1).text : ''
    const signature = pythonDef.exec(previous)
    const only = before.trim() === quotes[1] && after.trim() === quotes[1]
    if (options.docs && signature && only && signature[1].length < indent.length) {
      const { inClass } = pythonContext(state, line.number - 1, signature[1].length)
      const params = pythonParams(signature[3], inClass)
      const returns = signature[4] && signature[4].trim() !== 'None' ? signature[4].trim() : ''
      if (params.length || returns) {
        const q = quotes[1]
        let template = q + '\n${}\n'
        if (params.length) template += '\nArgs:\n' + params.map(name => '\t' + escapeSnippet(name) + ': ${}').join('\n') + '\n'
        if (returns) template += '\nReturns:\n\t${}\n'
        template += q
        snippet(template)(view, null, line.from + indent.length, line.to)
        // The snippet indents its blank lines too; leave them empty (no trailing whitespace).
        const doc = view.state.doc
        const blanks = template.split('\n').flatMap((text, index) => {
          if (text || line.number + index > doc.lines) return []
          const row = doc.line(line.number + index)
          return /^\s+$/.test(row.text) ? [{ from: row.from, to: row.to }] : []
        })
        if (blanks.length) view.dispatch({ changes: blanks, userEvent: 'input' })
        return true
      }
    }
    const body = '\n' + indent, close = '\n' + indent
    view.dispatch({ changes: { from: range.head, insert: body + close }, selection: { anchor: range.head + body.length }, userEvent: 'input' })
    return true
  }

  // def __init__(self, name, age):|  →  self.name = name, self.age = age
  const init = pythonDef.exec(line.text)
  const atEnd = !after.trim() || /^\s*\)\s*(->\s*[^:]*)?:\s*(#.*)?$/.test(after)
  if (options.constructors && init && init[2] === '__init__' && atEnd) {
    const params = pythonParams(init[3], true)
    const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null
    const nextIndent = next ? /^\s*/.exec(next.text)![0] : ''
    const deeper = Boolean(next && next.text.trim() && nextIndent.length > indent.length)
    // The constructor snippet leaves `pass` as the body; that counts as empty.
    let onlyPass = false
    if (deeper && next!.text.trim() === 'pass') {
      const following = next!.number < state.doc.lines ? state.doc.line(next!.number + 1).text : ''
      onlyPass = !following.trim() || /^\s*/.exec(following)![0].length <= indent.length
    }
    if (params.length && (!deeper || onlyPass)) {
      const bodyIndent = onlyPass ? nextIndent : indent + unit
      const text = params.map(name => bodyIndent + 'self.' + name + ' = ' + name).join('\n')
      const changes = onlyPass ? { from: next!.from, to: next!.to, insert: text } : { from: line.to, insert: '\n' + text }
      const end = onlyPass ? next!.from + text.length : line.to + 1 + text.length
      clearSnippet(view)
      view.dispatch({ changes, selection: { anchor: end }, scrollIntoView: true, userEvent: 'input' })
      return true
    }
  }

  // class Name:|  (with nothing in the class yet)
  if (options.constructors && /^\s*class\s+\w+\s*(\([^)]*\))?\s*:\s*$/.test(before) && !after.trim()) {
    const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : ''
    const nextIndent = /^\s*/.exec(next)![0]
    if (!next.trim() || nextIndent.length <= indent.length) {
      view.dispatch({ changes: { from: range.head, insert: '\n' + indent + unit }, selection: { anchor: range.head + 1 + indent.length + unit.length }, userEvent: 'input' })
      snippet(constructors.Python(''))(view, null, view.state.selection.main.head, view.state.selection.main.head)
      return true
    }
  }

  // # a comment|  →  the next line is a comment too (optional).
  if (options.comments) return continueLineComment(view, /^(\s*)(#+)(\s?)/)
  return false
}

/** `(` after `def name` in a class: `(self` (or `(cls`), closed when brackets close themselves. */
function pythonSelf(options: SmartOptions) {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== '(' || from !== to || view.state.selection.ranges.length > 1) return false
    const line = view.state.doc.lineAt(from)
    const before = view.state.sliceDoc(line.from, from)
    if (!/^(\s+)(?:async\s+)?def\s+[A-Za-z_]\w*$/.test(before) || view.state.sliceDoc(from, line.to).trim()) return false
    const { inClass, decorators } = pythonContext(view.state, line.number, /^\s*/.exec(before)![0].length)
    if (!inClass || decorators.includes('@staticmethod')) return false
    const name = decorators.includes('@classmethod') ? 'cls' : 'self'
    const bracket = options.closeBrackets ? insertBracket(view.state, '(') : null
    if (bracket) view.dispatch(bracket)
    else view.dispatch({ changes: { from, insert: '(' }, selection: { anchor: from + 1 }, userEvent: 'input.type' })
    const at = view.state.selection.main.head
    view.dispatch({ changes: { from: at, insert: name }, selection: { anchor: at + name.length }, userEvent: 'input.type' })
    return true
  })
}

/** Typing the `}` of `{name}` in a plain string turns it into an f-string. */
const fStrings = EditorState.transactionFilter.of((tr): Transaction | readonly TransactionSpec[] => {
  if (!tr.isUserEvent('input.type') || tr.state.selection.ranges.length > 1) return tr
  const state = tr.state
  const head = state.selection.main.head
  if (!state.selection.main.empty || state.sliceDoc(head - 1, head) !== '}') return tr
  // Either this transaction typed the brace, or stepped over one that closed itself.
  let typed = false
  tr.changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => { if (toB === head && inserted.toString().endsWith('}')) typed = true })
  if (!typed && !(tr.changes.empty && tr.startState.selection.main.head === head - 1)) return tr
  const line = state.doc.lineAt(head)
  const before = state.sliceDoc(line.from, head - 1)
  const open = before.lastIndexOf('{')
  if (open < 0 || before[open - 1] === '{') return tr
  // A name, attribute, index or call, optionally with !r and a format spec: what an f-string takes.
  if (!/^[A-Za-z_][\w.]*(\[[^\]]*\]|\(\))*(![rsa])?(:[^{}]*)?$/.test(before.slice(open + 1))) return tr
  let node: SyntaxNode | null = treeAt(state, head).resolveInner(line.from + open, 1)
  while (node && node.name !== 'String' && node.name !== 'FormatString') node = node.parent
  if (!node || node.name !== 'String' || node.from < line.from) return tr
  const start = state.sliceDoc(node.from, Math.min(node.to, node.from + 5))
  const prefix = /^[A-Za-z]*/.exec(start)![0]
  if (/[fbu]/i.test(prefix) || /^('''|""")/.test(start.slice(prefix.length))) return tr
  return [tr, { changes: { from: node.from, insert: 'f' }, sequential: true }]
})

// ---- C-like languages ----
const modifiers = /^(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|default|override|virtual|async|export|declare|readonly|inline|extern|unsafe|open|suspend|operator|const|constexpr)\s+)+/
/** Parameter names and whether something is returned, from the line after a doc comment. */
function signatureOf(text: string, language: string): { params: string[]; returns: boolean } | null {
  const line = text.trim().replace(/^(@\w+(\([^)]*\))?\s*)+/, '')
  if (/^(class|interface|enum|record|struct|trait|type|namespace|module|import|package|return|if|for|while|switch)\b/.test(line)) return null
  const arrow = /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:\s*[^=]+)?\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=]+?))?\s*=>/.exec(line)
  const call = arrow ? null : /^(.*?)\b([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^{;=]+?))?\s*(?:throws\s+[^{;]+)?\s*(?:\{.*)?;?\s*$/.exec(line)
  if (!arrow && !call) return null
  const inside = arrow ? arrow[1] : call![3]
  const script = language.startsWith('TypeScript') || language.startsWith('JavaScript')
  const params = splitTop(inside).map(part => {
    if (script) return part.replace(/^\.\.\./, '').replace(/^(public|private|protected|readonly)\s+/, '').split(/[?:=]/)[0].trim()
    // Java, C#, C++…: the last word, without annotations, `final`, arrays or varargs.
    const cleaned = part.replace(/@\w+(\([^)]*\))?\s*/g, '').replace(/=.*$/, '').replace(/\[\s*\]/g, '').replace(/\.\.\./g, ' ').trim()
    return /([A-Za-z_$][\w$]*)\s*$/.exec(cleaned)?.[1] ?? ''
  }).filter(name => /^[A-Za-z_$][\w$]*$/.test(name))
  let returns = false
  if (script) {
    const type = (arrow ? arrow[2] : call![4])?.trim()
    returns = Boolean(type) && !/^(void|Promise<void>|never|undefined)$/.test(type!)
  } else if (call) {
    const head = call[1].replace(modifiers, '').trim()
    returns = Boolean(head) && !/^(void|new|return|else)$/.test(head) && !head.endsWith('=')
  }
  return { params, returns }
}

function clikeEnter(view: EditorView, languageName: string, options: SmartOptions): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty || state.selection.ranges.length > 1) return false
  const line = state.doc.lineAt(range.head)
  const before = state.sliceDoc(line.from, range.head)
  const after = state.sliceDoc(range.head, line.to)
  const indent = /^\s*/.exec(line.text)![0]
  const unit = ' '.repeat(getIndentUnit(state))

  // /**|*/ or /* | */  →  laid out over three lines; above a function, with its @param and @return.
  const opening = /\/\*(\*?)\s*$/.exec(before)
  if (opening && /^\s*\*\//.test(after)) {
    const close = /^\s*\*\//.exec(after)![0]
    const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : ''
    const signature = options.docs && opening[1] && before.trim() === '/**' ? signatureOf(next, languageName) : null
    if (signature && (signature.params.length || signature.returns)) {
      const javadoc = languageName === 'Java' || languageName === 'Kotlin' || languageName === 'C#' || languageName === 'Groovy' || languageName === 'Scala'
      let template = '\n * ${}\n *'
      for (const name of signature.params) template += '\n * @param ' + escapeSnippet(name) + ' ${}'
      if (signature.returns) template += '\n * ' + (javadoc ? '@return' : '@returns') + ' ${}'
      template += '\n */'
      snippet(template)(view, null, range.head, range.head + close.length)
      return true
    }
    const middle = '\n' + indent + ' * ', end = '\n' + indent + ' */'
    view.dispatch({ changes: { from: range.head, to: range.head + close.length, insert: middle + end }, selection: { anchor: range.head + middle.length }, userEvent: 'input' })
    return true
  }
  // Inside a block comment: the next line starts with " * " too.
  if (inComment(state, range.head) && !/\*\/\s*$/.test(before)) {
    const star = /^(\s*)(\/\*\*?|\*)(?!\/)/.exec(line.text)
    if (star) {
      const lead = star[2] === '*' ? star[1] : star[1] + ' '
      const insert = '\n' + lead + '* '
      view.dispatch({ changes: { from: range.head, insert }, selection: { anchor: range.head + insert.length }, scrollIntoView: true, userEvent: 'input' })
      return true
    }
  }
  // class Name {|}  (empty)  →  a constructor inside
  const klass = /\bclass\s+([A-Za-z_$][\w$]*)[^{]*\{\s*$/.exec(before)
  const make = constructors[languageName]
  if (options.constructors && klass && make && /^\s*\}/.test(after)) {
    const close = /^\s*/.exec(after)![0]
    const inner = '\n' + indent + unit, outer = '\n' + indent
    view.dispatch({ changes: { from: range.head, to: range.head + close.length, insert: inner + outer }, selection: { anchor: range.head + inner.length }, userEvent: 'input' })
    snippet(make(klass[1]))(view, null, view.state.selection.main.head, view.state.selection.main.head)
    return true
  }
  // // a comment|  →  the next line is a comment too (optional).
  if (options.comments && languageName !== 'CSS') return continueLineComment(view, /^(\s*)(\/\/[/!]?)(\s?)/)
  return false
}

/** Continues a whole-line comment onto the next line; Enter on an empty one ends it. */
function continueLineComment(view: EditorView, marker: RegExp) {
  const { state } = view
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const found = marker.exec(line.text)
  if (!found || head - line.from < found[1].length + found[2].length || line.text.startsWith('#!') || !inComment(state, head)) return false
  if (!line.text.slice(found[0].length).trim()) {
    // An empty comment line: drop the marker and stop.
    view.dispatch({ changes: { from: line.from, to: line.to, insert: found[1] }, selection: { anchor: line.from + found[1].length }, userEvent: 'input' })
    return true
  }
  const insert = '\n' + found[1] + found[2] + ' '
  view.dispatch({ changes: { from: head, insert }, selection: { anchor: head + insert.length }, scrollIntoView: true, userEvent: 'input' })
  return true
}

/** `/*` closes itself (not inside strings or comments). */
const closeComment = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '*' || from !== to || view.state.sliceDoc(from - 1, from) !== '/' || view.state.selection.ranges.length > 1) return false
  if (inString(view.state, from) || inComment(view.state, from - 1)) return false
  if (/^\s*\*\//.test(view.state.sliceDoc(from, from + 4))) return false
  view.dispatch({ changes: { from, to, insert: '* */' }, selection: { anchor: from + 1 }, userEvent: 'input.type' })
  return true
})

// ---- Tags: the opening and closing names stay the same ----
const tagNames = new Set(['TagName', 'JSXIdentifier', 'JSXBuiltin'])
const openTags = new Set(['OpenTag', 'JSXOpenTag'])
const closeTags = new Set(['CloseTag', 'JSXCloseTag'])
function nameNode(tree: Tree, from: number, to: number): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(from, side)
    // A builtin JSX name (a lowercase tag) wraps the identifier; use the outer one.
    if (node.name === 'JSXIdentifier' && node.parent?.name === 'JSXBuiltin') node = node.parent
    if (tagNames.has(node.name) && node.from <= from && to <= node.to && node.parent && (openTags.has(node.parent.name) || closeTags.has(node.parent.name))) return node
  }
  return null
}
function partner(name: SyntaxNode): SyntaxNode | null {
  const tag = name.parent!, element = tag.parent
  if (!element) return null
  const opening = openTags.has(tag.name)
  const other = opening ? element.lastChild : element.firstChild
  if (!other || other === tag || !(opening ? closeTags : openTags).has(other.name)) return null
  for (let child = other.firstChild; child; child = child.nextSibling) if (tagNames.has(child.name)) return child
  return null
}
// When a whole name is deleted, both tags are left empty (`<>` and `</>`) and there's no name in the
// tree to follow; remember where the two names were so the next letters go into both.
const setEmptyPair = StateEffect.define<{ a: number; b: number } | null>()
const emptyPair = StateField.define<{ a: number; b: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setEmptyPair)) return effect.value
    return value && tr.docChanged ? { a: tr.changes.mapPos(value.a, -1), b: tr.changes.mapPos(value.b, -1) } : value
  },
})
const tagSync = EditorState.transactionFilter.of((tr): Transaction | readonly TransactionSpec[] => {
  if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('delete')) || tr.startState.selection.ranges.length > 1) return tr
  let count = 0, fromA = 0, toA = 0, inserted = ''
  tr.changes.iterChanges((from, to, _fromB, _toB, text) => { count++; fromA = from; toA = to; inserted = text.toString() })
  if (count !== 1) return tr
  const start = tr.startState
  // Typing into a pair of emptied names.
  const pair = start.field(emptyPair, false)
  if (pair && fromA === toA && (fromA === pair.a || fromA === pair.b) && /^[\w:.-]+$/.test(inserted)) {
    const other = fromA === pair.a ? pair.b : pair.a
    return [tr, { changes: { from: tr.changes.mapPos(other, other > fromA ? 1 : -1), insert: inserted }, effects: setEmptyPair.of(null), sequential: true }]
  }
  const name = nameNode(treeAt(start, toA), fromA, toA)
  if (!name) return tr
  const other = partner(name)
  if (!other) return tr
  const old = start.sliceDoc(name.from, name.to)
  if (start.sliceDoc(other.from, other.to) !== old) return tr
  const typed = tr.state.sliceDoc(tr.changes.mapPos(name.from, -1), tr.changes.mapPos(name.to, 1))
  const next = /^[\w:.-]*/.exec(typed)![0]
  if (next === old || (!next && typed)) return tr
  const from = tr.changes.mapPos(other.from, -1), to = tr.changes.mapPos(other.to, 1)
  if (next) return [tr, { changes: { from, to, insert: next }, sequential: true }]
  // Both names emptied: remember where they are, in the document after this change.
  let here = tr.changes.mapPos(name.from, -1)
  if (here > from) here -= to - from
  return [tr, { changes: { from, to }, effects: setEmptyPair.of({ a: here, b: from }), sequential: true }]
})

export function smartTyping(languageName: string, options: SmartOptions): Extension {
  const extensions: Extension[] = []
  if (tagLanguages.has(languageName)) extensions.push(emptyPair, tagSync)
  if (languageName === 'Python') {
    extensions.push(Prec.high(keymap.of([{ key: 'Enter', run: view => pythonEnter(view, options) }])))
    if (options.constructors) extensions.push(pythonSelf(options))
    if (options.fStrings) extensions.push(fStrings)
  }
  if (clike.has(languageName)) extensions.push(Prec.high(keymap.of([{ key: 'Enter', run: view => clikeEnter(view, languageName, options) }])), closeComment)
  return extensions
}
