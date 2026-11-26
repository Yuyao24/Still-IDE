// Small helps while typing, as in other IDEs:
//  - Enter after `class Name:` (Python), `class Name {` (Java, JavaScript, TypeScript, C#) fills in
//    the constructor when the class is still empty.
//  - `/*` closes itself; Enter inside `/** … */` lays the comment out and later lines start with ` * `.
//  - Enter between `"""` and `"""` opens the docstring onto its own lines.
import { EditorSelection, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { snippet } from '@codemirror/autocomplete'
import { getIndentUnit, syntaxTree } from '@codemirror/language'

const clike = new Set(['Java', 'JavaScript', 'JavaScript JSX', 'TypeScript', 'TypeScript JSX', 'C', 'C++', 'C#', 'Go', 'Rust', 'Kotlin', 'CSS', 'Groovy', 'PHP', 'Scala', 'Dart', 'Swift'])
const constructors: Record<string, (name: string) => string> = {
  Python: () => 'def __init__(self${}):\n\t${pass}',
  Java: name => `public ${name}(\${}) {\n\t\${}\n}`,
  'C#': name => `public ${name}(\${}) {\n\t\${}\n}`,
  JavaScript: () => 'constructor(${}) {\n\t${}\n}',
  'JavaScript JSX': () => 'constructor(${}) {\n\t${}\n}',
  TypeScript: () => 'constructor(${}) {\n\t${}\n}',
  'TypeScript JSX': () => 'constructor(${}) {\n\t${}\n}',
}

function inComment(view: EditorView, pos: number) {
  const node = syntaxTree(view.state).resolveInner(pos, -1)
  return /Comment/.test(node.name)
}
function inString(view: EditorView, pos: number) {
  const node = syntaxTree(view.state).resolveInner(pos, -1)
  return /String|Template|Regexp/.test(node.name)
}

export function smartTyping(languageName: string, fillConstructors: boolean): Extension {
  const python = languageName === 'Python'
  const cstyle = clike.has(languageName)
  if (!python && !cstyle) return []

  const enter = (view: EditorView) => {
    const { state } = view
    const range = state.selection.main
    if (!range.empty || state.selection.ranges.length > 1) return false
    const line = state.doc.lineAt(range.head)
    const before = state.sliceDoc(line.from, range.head)
    const after = state.sliceDoc(range.head, line.to)
    const indent = /^\s*/.exec(line.text)![0]
    const unit = ' '.repeat(getIndentUnit(state))

    if (python) {
      // """|"""  →  """\n|\n"""
      const quotes = /("""|''')$/.exec(before)
      if (quotes && after.startsWith(quotes[1])) {
        const body = '\n' + indent, close = '\n' + indent
        view.dispatch({ changes: { from: range.head, insert: body + close }, selection: { anchor: range.head + body.length }, userEvent: 'input' })
        return true
      }
      // class Name:|  (with nothing in the class yet)
      if (fillConstructors && /^\s*class\s+\w+\s*(\([^)]*\))?\s*:\s*$/.test(before) && !after.trim()) {
        const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : ''
        const nextIndent = /^\s*/.exec(next)![0]
        if (!next.trim() || nextIndent.length <= indent.length) {
          view.dispatch({ changes: { from: range.head, insert: '\n' + indent + unit }, selection: { anchor: range.head + 1 + indent.length + unit.length }, userEvent: 'input' })
          snippet(constructors.Python(''))(view, null, view.state.selection.main.head, view.state.selection.main.head)
          return true
        }
      }
      return false
    }

    // /**|*/ or /* | */  →  laid out over three lines
    const opening = /\/\*(\*?)\s*$/.exec(before)
    if (opening && /^\s*\*\//.test(after)) {
      const close = /^\s*\*\//.exec(after)![0]
      const middle = '\n' + indent + ' * ', end = '\n' + indent + ' */'
      view.dispatch({ changes: { from: range.head, to: range.head + close.length, insert: middle + end }, selection: { anchor: range.head + middle.length }, userEvent: 'input' })
      return true
    }
    // Inside a block comment: the next line starts with " * " too.
    if (inComment(view, range.head) && !/\*\/\s*$/.test(before)) {
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
    if (fillConstructors && klass && make && /^\s*\}/.test(after)) {
      const close = /^\s*/.exec(after)![0]
      const inner = '\n' + indent + unit, outer = '\n' + indent
      view.dispatch({ changes: { from: range.head, to: range.head + close.length, insert: inner + outer }, selection: { anchor: range.head + inner.length }, userEvent: 'input' })
      snippet(make(klass[1]))(view, null, view.state.selection.main.head, view.state.selection.main.head)
      return true
    }
    return false
  }

  // `/*` closes itself (not inside strings or comments).
  const closeComment = EditorView.inputHandler.of((view, from, to, text) => {
    if (!cstyle || text !== '*' || from !== to || view.state.sliceDoc(from - 1, from) !== '/' || view.state.selection.ranges.length > 1) return false
    if (inString(view, from) || inComment(view, from - 1)) return false
    if (/^\s*\*\//.test(view.state.sliceDoc(from, from + 4))) return false
    view.dispatch({ changes: { from, to, insert: '* */' }, selection: EditorSelection.cursor(from + 1), userEvent: 'input.type' })
    return true
  })
  // A second `*` right after `/*` (making `/**`) goes in before the closing.
  return [Prec.high(keymap.of([{ key: 'Enter', run: enter }])), closeComment]
}
