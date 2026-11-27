// Refactorings Still does itself, without a language server: Extract variable (Python, JavaScript,
// TypeScript, Java, Kotlin, Rust, Go, C#, C++) and Extract method for Python, which works out
// the new function's parameters and return values from how names are used around the selection.
// Language servers add their own (Extract method in Java and TypeScript, for example).
import { ensureSyntaxTree, getIndentUnit, indentString, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { type EditorView, showDialog } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'

export interface Refactor { id: string; title: string; run: () => void }

const blocks = /^(Body|Block|Script|Program|SourceFile|SwitchBody|StatementList|ClassBody|Document)$/

function treeOf(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, 400) ?? syntaxTree(state)
}

/** The trimmed selection, or null when nothing is selected. */
function trimmed(state: EditorState) {
  const range = state.selection.main
  if (range.empty) return null
  const text = state.sliceDoc(range.from, range.to)
  const from = range.from + (text.length - text.trimStart().length)
  const to = range.to - (text.length - text.trimEnd().length)
  return from < to ? { from, to, text: state.sliceDoc(from, to) } : null
}

/** The syntax node that covers exactly this range, if there is one. */
function exactNode(tree: Tree, from: number, to: number): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(from, 1)
  while (node && !(node.from === from && node.to === to)) {
    if (node.from < from || node.to > to) { node = null; break }
    node = node.parent
  }
  // Prefer the outermost node with the same span (a call over the name inside it).
  while (node?.parent && node.parent.from === from && node.parent.to === to && !blocks.test(node.parent.name)) node = node.parent
  return node
}

const statementLike = /Statement$|Declaration$|Definition$|^(Block|Body|Script|Program)$/
function isExpression(node: SyntaxNode | null) {
  return Boolean(node && !statementLike.test(node.name) && !/Comment|Keyword|^[a-z]+$/.test(node.name) && node.name !== '⚠')
}

/** The statement that holds a position: the node right under a block. */
function statementAt(tree: Tree, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(pos, 1)
  while (node?.parent && !blocks.test(node.parent.name)) node = node.parent
  return node?.parent ? node : null
}

const snake = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
const camel = (text: string) => text.replace(/_+([a-z0-9])/g, (_, char: string) => char.toUpperCase())

/** A name for an extracted expression: `order.total_price()` → total_price, `getUser(id)` → user. */
function suggestName(expression: string, language: string): string {
  const python = language === 'Python'
  let base = 'value'
  const call = /([A-Za-z_][\w]*)\s*\([^()]*\)\s*$/.exec(expression)
  const member = /([A-Za-z_][\w]*)\s*$/.exec(expression)
  if (/^\s*(['"`]|f['"])/.test(expression)) base = 'text'
  else if (/^\s*[\d.]+\s*$/.test(expression)) base = 'number'
  else if (/^\s*\[/.test(expression)) base = 'items'
  else if (/^\s*\{/.test(expression)) base = python ? 'values' : 'options'
  // Arithmetic and other operators: a plain name, not one taken from an operand.
  else if (/[-+*/%<>=!&|^?]/.test(expression.replace(/\([^()]*\)|\[[^\]]*\]|(['"`]).*?\1/g, '').replace(/=>|->/g, ''))) base = 'value'
  else if (call) base = call[1]
  else if (member) base = member[1]
  base = base.replace(/^(get|calc|calculate|compute|make|build|fetch|load|read|find)_?(?=[A-Za-z])/, '')
  if (base === 'len' || base === 'length' || base === 'size' || base === 'count') base = 'count'
  if (!base || base.length < 2 || /^(self|this|str|int|float|list|dict|set|tuple|bool|new)$/.test(base)) base = 'value'
  base = python ? snake(base) : camel(base)
  return base[0].toLowerCase() + base.slice(1)
}

function uniqueName(state: EditorState, base: string) {
  const text = state.doc.toString()
  let name = base, count = 2
  // Attributes (order.total) don't clash with a new local name.
  while (new RegExp('(?<![\\w.$])' + name + '(?![\\w$])').test(text)) name = base + count++
  return name
}

function declaration(language: string, name: string, expression: string, semicolons: boolean) {
  switch (language) {
    case 'Python': case 'Ruby': return `${name} = ${expression}`
    case 'Java': case 'C#': return `var ${name} = ${expression};`
    case 'Kotlin': case 'Scala': return `val ${name} = ${expression}`
    case 'Rust': return `let ${name} = ${expression};`
    case 'Go': return `${name} := ${expression}`
    case 'C++': return `auto ${name} = ${expression};`
    case 'JavaScript': case 'JavaScript JSX': case 'TypeScript': case 'TypeScript JSX': return `const ${name} = ${expression}${semicolons ? ';' : ''}`
    default: return null
  }
}

/** A small dialog under the editor asking for a name, with an optional checkbox. */
function askName(view: EditorView, label: string, value: string, check?: string, checked = true): Promise<{ name: string; checked: boolean } | null> {
  const { close, result } = showDialog(view, {
    content: () => {
      const form = document.createElement('form')
      form.className = 'cm-refactor-form'
      const caption = document.createElement('label')
      caption.textContent = label
      const input = document.createElement('input')
      input.name = 'name'; input.value = value; input.spellcheck = false
      input.setAttribute('aria-label', label)
      caption.appendChild(input)
      form.appendChild(caption)
      if (check) {
        const box = document.createElement('label')
        box.className = 'cm-refactor-check'
        const input = document.createElement('input')
        input.type = 'checkbox'; input.name = 'all'; input.checked = checked
        box.append(input, document.createTextNode(' ' + check))
        form.appendChild(box)
      }
      const submit = document.createElement('button')
      submit.type = 'submit'; submit.textContent = 'Extract'; submit.className = 'cm-button'
      form.appendChild(submit)
      return form
    },
    focus: true,
    class: 'cm-lsp-rename-panel cm-refactor-panel',
  })
  return result.then(form => {
    view.dispatch({ effects: close })
    const name = (form?.elements.namedItem('name') as HTMLInputElement | null)?.value.trim() ?? ''
    const checked = Boolean((form?.elements.namedItem('all') as HTMLInputElement | null)?.checked)
    view.focus()
    return form && name ? { name, checked } : null
  })
}

const identifier = /^[A-Za-z_$][\w$]*$/

// ---- Extract variable ----
function extractVariableCheck(state: EditorState, language: string): string | null {
  const range = trimmed(state)
  if (!range) return 'Select an expression to extract it into a variable.'
  if (!declaration(language, 'x', 'y', false)) return 'Extract variable isn’t available for this kind of file.'
  const tree = treeOf(state)
  if (tree.length && !isExpression(exactNode(tree, range.from, range.to))) return 'Select a whole expression (not part of one, or a statement) to extract it.'
  return null
}

function extractVariable(view: EditorView, language: string, notify: (message: string) => void) {
  const state = view.state
  const problem = extractVariableCheck(state, language)
  if (problem) { notify(problem); return }
  const range = trimmed(state)!
  const tree = treeOf(state)
  const statement = statementAt(tree, range.from)
  const anchorLine = state.doc.lineAt(statement ? statement.from : range.from)
  const indent = /^\s*/.exec(anchorLine.text)![0]
  // Other uses of the same expression further on in the same block, outside strings and comments.
  const block = statement?.parent
  const scopeEnd = block ? block.to : state.doc.length
  const others: { from: number; to: number }[] = []
  const body = state.sliceDoc(anchorLine.from, scopeEnd)
  for (let at = body.indexOf(range.text); at >= 0; at = body.indexOf(range.text, at + range.text.length)) {
    const from = anchorLine.from + at, to = from + range.text.length
    if (from === range.from) continue
    const inside = tree.resolveInner(from, 1)
    if (/String|Comment/.test(inside.name) && !/String/.test(exactNode(tree, range.from, range.to)?.name ?? '')) continue
    if (tree.length && !exactNode(tree, from, to)) continue
    others.push({ from, to })
  }
  // Calls may do something each time, so replacing every use starts unticked for them.
  const pure = !/\(|\+\+|--|await |yield /.test(range.text)
  const sample = state.doc.toString().slice(0, 20000).split('\n').filter(line => line.trim() && !/^\s*(\/\/|\*|\/\*)/.test(line))
  const semicolons = sample.filter(line => /;\s*$/.test(line)).length > sample.length * 0.2
  void askName(view, 'Extract to a variable named', uniqueName(state, suggestName(range.text, language)),
    others.length ? `Replace all ${others.length + 1} uses` : undefined, pure).then(answer => {
    if (!answer) return
    if (!identifier.test(answer.name)) { notify(answer.name + ' isn’t a valid name.'); return }
    const now = view.state
    if (now.doc !== state.doc) { notify('The file changed; select the expression again.'); return }
    const replaced = [range, ...(answer.checked ? others : [])]
    const text = declaration(language, answer.name, range.text, semicolons)!
    view.dispatch({
      changes: [{ from: anchorLine.from, insert: indent + text + '\n' }, ...replaced.map(item => ({ from: item.from, to: item.to, insert: answer.name }))],
      selection: { anchor: anchorLine.from + indent.length + text.indexOf(answer.name), head: anchorLine.from + indent.length + text.indexOf(answer.name) + answer.name.length },
      userEvent: 'input.refactor', scrollIntoView: true,
    })
    notify('Extracted ' + answer.name + (replaced.length > 1 ? ', used in ' + replaced.length + ' places.' : '.'))
  })
}

// ---- Extract method (Python) ----
interface Use { name: string; pos: number; read: boolean; write: boolean }
const nested = /^(FunctionDefinition|ClassDefinition|LambdaExpression)$/
const comprehension = /ComprehensionExpression$/

function child(node: SyntaxNode, name: string) { for (let item = node.firstChild; item; item = item.nextSibling) if (item.name === name) return item; return null }
function lastChild(node: SyntaxNode, name: string) { let found: SyntaxNode | null = null; for (let item = node.firstChild; item; item = item.nextSibling) if (item.name === name) found = item; return found }

/** How each name is used in a Python scope: read, assigned, or both. Nested functions and classes
 *  count only by their own name; comprehension variables stay inside the comprehension. */
function pythonUses(state: EditorState, scope: SyntaxNode): Use[] {
  const uses: Use[] = []
  const locals: Set<string>[] = []
  const visit = (node: SyntaxNode): void => {
    if (node !== scope && nested.test(node.name)) {
      const name = child(node, 'VariableName')
      if (name && node.name !== 'LambdaExpression') uses.push({ name: state.sliceDoc(name.from, name.to), pos: name.from, read: false, write: true })
      // Reads inside a nested function of names from this scope still matter (closures, default values).
      for (let item = node.firstChild; item; item = item.nextSibling) if (item.name !== 'VariableName' && item.name !== 'ParamList') visitNested(item)
      return
    }
    if (comprehension.test(node.name)) {
      const names = new Set<string>()
      for (let item = node.firstChild, between = false; item; item = item.nextSibling) {
        if (item.name === 'for') between = true
        else if (item.name === 'in') between = false
        else if (between) collectNames(item, names)
      }
      locals.push(names)
      for (let item = node.firstChild; item; item = item.nextSibling) visit(item)
      locals.pop()
      return
    }
    if (node.name === 'VariableName') { classify(node); return }
    for (let item = node.firstChild; item; item = item.nextSibling) visit(item)
  }
  const visitNested = (node: SyntaxNode): void => {
    if (node.name === 'VariableName') {
      const name = state.sliceDoc(node.from, node.to)
      uses.push({ name, pos: node.from, read: true, write: false })
      return
    }
    for (let item = node.firstChild; item; item = item.nextSibling) visitNested(item)
  }
  const collectNames = (node: SyntaxNode, into: Set<string>) => {
    if (node.name === 'VariableName') into.add(state.sliceDoc(node.from, node.to))
    for (let item = node.firstChild; item; item = item.nextSibling) collectNames(item, into)
  }
  const classify = (node: SyntaxNode) => {
    const name = state.sliceDoc(node.from, node.to)
    if (locals.some(set => set.has(name))) return
    const parent = node.parent
    if (!parent) return
    const previous = node.prevSibling?.name, next = node.nextSibling?.name
    let write = false, read = true
    if (parent.name === 'ArgList' && next === 'AssignOp') return // a keyword argument's name
    if (parent.name === 'ImportStatement') {
      if (next !== 'as' && (previous === 'import' || previous === ',' || previous === 'as') && child(parent, 'import')!.from < node.from) uses.push({ name, pos: node.from, read: false, write: true })
      else if (previous === 'as') uses.push({ name, pos: node.from, read: false, write: true })
      return
    }
    if (previous === 'as') { write = true; read = false }
    else if (parent.name === 'ParamList') { if (previous !== 'AssignOp') { write = true; read = false } }
    else if (/^(FunctionDefinition|ClassDefinition)$/.test(parent.name) && parent === scope) return
    else {
      // Walk up through tuples and brackets to the statement that might assign this name.
      let holder: SyntaxNode = parent
      while (/^(TupleExpression|ParenthesizedExpression|ArrayExpression)$/.test(holder.name) && holder.parent) holder = holder.parent
      if (holder.name === 'AssignStatement' || holder.name === 'NamedExpression') {
        const op = lastChild(holder, 'AssignOp')
        if (op && node.from < op.from && (holder === parent || parent.name !== 'MemberExpression')) { write = true; read = false }
      } else if (holder.name === 'UpdateStatement' && holder === parent && node.from < (child(holder, 'UpdateOp')?.from ?? 0)) { write = true; read = true }
      else if (holder.name === 'ForStatement') {
        const keyword = child(holder, 'in')
        if (keyword && node.from < keyword.from && node.from > (child(holder, 'for')?.from ?? Infinity)) { write = true; read = false }
      }
    }
    uses.push({ name, pos: node.from, read, write })
  }
  visit(scope)
  return uses.sort((a, b) => a.pos - b.pos)
}

function descendants(node: SyntaxNode, test: (node: SyntaxNode) => boolean, stop = nested): SyntaxNode[] {
  const found: SyntaxNode[] = []
  const walk = (current: SyntaxNode) => {
    for (let item = current.firstChild; item; item = item.nextSibling) {
      if (test(item)) found.push(item)
      if (!stop.test(item.name)) walk(item)
    }
  }
  walk(node)
  return found
}

interface MethodPlan { from: number; to: number; make: (name: string) => { changes: { from: number; to?: number; insert: string }[]; callAt: number } }

function planPythonMethod(state: EditorState): MethodPlan | { problem: string } {
  const range = state.selection.main
  if (range.empty) return { problem: 'Select the lines to extract into a function.' }
  const doc = state.doc
  const tree = treeOf(state)
  const firstLine = doc.lineAt(range.from)
  const lastLine = doc.lineAt(range.to > range.from && range.to === doc.lineAt(range.to).from ? range.to - 1 : range.to)
  const startAt = firstLine.from + /^\s*/.exec(firstLine.text)![0].length
  const endAt = lastLine.from + lastLine.text.trimEnd().length
  if (startAt >= endAt) return { problem: 'Select the lines to extract into a function.' }
  const up = (pos: number, side: -1 | 1) => {
    let node: SyntaxNode | null = tree.resolveInner(pos, side)
    while (node?.parent && node.parent.name !== 'Body' && node.parent.name !== 'Script') node = node.parent
    return node?.parent ? node : null
  }
  const first = up(startAt, 1), last = up(endAt, -1)
  if (!first || !last || !first.parent || !last.parent || first.parent.from !== last.parent.from || first.parent.to !== last.parent.to) return { problem: 'Select whole statements in one block to extract them into a function.' }
  const block = first.parent
  const from = doc.lineAt(first.from).from
  const to = doc.lineAt(doc.sliceString(last.to - 1, last.to) === '\n' ? last.to - 1 : last.to).to
  if (first.from < firstLine.from || to > lastLine.to) return { problem: 'Select whole statements to extract them into a function.' }
  // The scope: the function the lines are in, or the module.
  let scope: SyntaxNode = block
  while (scope.parent && scope.name !== 'FunctionDefinition') scope = scope.parent
  const inFunction = scope.name === 'FunctionDefinition'
  if (!inFunction) scope = tree.topNode
  const selected = (node: SyntaxNode) => node.from >= from && node.to <= to + 1
  const inside = descendants(scope, node => selected(node))
  if (inside.some(node => /^(YieldExpression|yield)$/.test(node.name))) return { problem: 'The lines use yield, so they can’t move into a separate function.' }
  const isAsync = inside.some(node => node.name === 'await')
  // break and continue must stay with their loop.
  for (const node of inside.filter(item => /^(BreakStatement|ContinueStatement)$/.test(item.name))) {
    let loop: SyntaxNode | null = node.parent
    while (loop && !/^(ForStatement|WhileStatement)$/.test(loop.name) && loop !== block) loop = loop.parent
    if (!loop || loop === block || !selected(loop)) return { problem: 'The lines use break or continue for a loop outside them.' }
  }
  const returns = inside.filter(item => item.name === 'ReturnStatement')
  const endsWithReturn = last.name === 'ReturnStatement'
  if (returns.length && !endsWithReturn) return { problem: 'The lines return from the middle of the function, so they can’t be extracted as they are.' }

  const uses = pythonUses(state, scope)
  const before = new Set(uses.filter(use => use.pos < from && use.write).map(use => use.name))
  if (inFunction) for (const param of descendants(child(scope, 'ParamList') ?? scope, node => node.name === 'VariableName', /$^/)) before.add(state.sliceDoc(param.from, param.to))
  const within = uses.filter(use => use.pos >= from && use.pos <= to)
  const firstUse = new Map<string, Use>()
  for (const use of within) if (!firstUse.has(use.name)) firstUse.set(use.name, use)
  const isMethod = inFunction && scope.parent?.name === 'Body' && scope.parent.parent?.name === 'ClassDefinition'
  const paramNodes = inFunction ? descendants(child(scope, 'ParamList')!, node => node.name === 'VariableName' && node.prevSibling?.name !== 'AssignOp', /$^/) : []
  const selfName = isMethod && paramNodes.length ? state.sliceDoc(paramNodes[0].from, paramNodes[0].to) : null
  const asMethod = Boolean(selfName && /^(self|cls)$/.test(selfName))
  const params = [...firstUse.values()].filter(use => use.read && before.has(use.name) && !(asMethod && use.name === selfName)).map(use => use.name)
  const writtenInside = new Set(within.filter(use => use.write).map(use => use.name))
  // A name the lines set and the code after them reads (or that a loop around them reads again).
  let loop: SyntaxNode | null = block
  while (loop && loop !== scope && !/^(ForStatement|WhileStatement)$/.test(loop.name)) loop = loop.parent
  const loopFrom = loop && loop !== scope ? loop.from : to
  const outputs = [...writtenInside].filter(name => uses.some(use => use.read && ((use.pos > to) || (use.pos >= loopFrom && use.pos < from)) && use.name === name))
  if (outputs.length && endsWithReturn) return { problem: 'The lines both return and set names used later, so they can’t be extracted as they are.' }

  return {
    from, to,
    make: (name: string) => {
      const unit = getIndentUnit(state)
      const lines = doc.sliceString(from, to).split('\n')
      const indents = lines.filter(line => line.trim()).map(line => /^\s*/.exec(line)![0].length)
      const common = Math.min(...indents)
      const callIndent = /^\s*/.exec(lines.find(line => line.trim()) ?? '')![0]
      // Where the new function goes: after this method in the class, or after the top-level statement.
      let holder: SyntaxNode = scope
      if (holder.parent?.name === 'DecoratedStatement') holder = holder.parent
      let defIndent = ''
      let insertAt: number, before = false
      if (asMethod) {
        defIndent = /^\s*/.exec(doc.lineAt(holder.from).text)![0]
        insertAt = doc.lineAt(holder.to - (doc.sliceString(holder.to - 1, holder.to) === '\n' ? 1 : 0)).to
      } else {
        let top: SyntaxNode = inFunction ? holder : first
        while (top.parent && top.parent.name !== 'Script') top = top.parent
        if (inFunction) insertAt = doc.lineAt(top.to - (doc.sliceString(top.to - 1, top.to) === '\n' ? 1 : 0)).to
        else { insertAt = doc.lineAt(top.from).from; before = true }
      }
      const bodyIndent = defIndent + indentString(state, unit)
      const body = lines.map(line => line.trim() ? bodyIndent + line.slice(common) : '').join('\n')
      const header = `${defIndent}${isAsync ? 'async ' : ''}def ${name}(${[...(asMethod ? [selfName!] : []), ...params].join(', ')}):`
      const tail = outputs.length ? '\n' + bodyIndent + 'return ' + outputs.join(', ') : ''
      const fn = header + '\n' + body + tail
      const gap = asMethod ? '\n\n' : '\n\n\n'
      const call = `${callIndent}${outputs.length ? outputs.join(', ') + ' = ' : ''}${endsWithReturn ? 'return ' : ''}${isAsync ? 'await ' : ''}${asMethod ? selfName + '.' : ''}${name}(${params.join(', ')})`
      return {
        changes: [{ from, to, insert: call }, before ? { from: insertAt, insert: fn + gap } : { from: insertAt, insert: gap + fn }],
        callAt: from + call.indexOf(name + '('),
      }
    },
  }
}

function extractMethod(view: EditorView, notify: (message: string) => void) {
  const state = view.state
  const plan = planPythonMethod(state)
  if (!('make' in plan)) { notify(plan.problem); return }
  const ready = plan
  void askName(view, 'Extract to a function named', uniqueName(state, 'extracted')).then(answer => {
    if (!answer) return
    if (!/^[A-Za-z_]\w*$/.test(answer.name)) { notify(answer.name + ' isn’t a valid name.'); return }
    if (view.state.doc !== state.doc) { notify('The file changed; select the lines again.'); return }
    if (new RegExp('^\\s*(async\\s+)?def\\s+' + answer.name + '\\b', 'm').test(state.doc.toString())) { notify('There’s already a function called ' + answer.name + '.'); return }
    const { changes, callAt } = ready.make(answer.name)
    const set = state.changes(changes)
    const at = set.mapPos(callAt, 1)
    view.dispatch({ changes: set, selection: { anchor: at, head: at + answer.name.length }, userEvent: 'input.refactor', scrollIntoView: true })
    notify('Extracted ' + answer.name + '().')
  })
}

/** The refactorings Still offers here for this language. */
export function builtInRefactors(view: EditorView, language: string, notify: (message: string) => void): Refactor[] {
  const state = view.state
  const items: Refactor[] = []
  if (declaration(language, 'x', 'y', false) && trimmed(state) && !extractVariableCheck(state, language)) items.push({ id: 'extract-variable', title: 'Extract variable…', run: () => extractVariable(view, language, notify) })
  if (language === 'Python' && !state.selection.main.empty && 'make' in planPythonMethod(state)) items.push({ id: 'extract-method', title: 'Extract function…', run: () => extractMethod(view, notify) })
  return items
}

/** Runs one refactoring by id (for its shortcut), explaining why when it can't. */
export function runRefactor(view: EditorView, language: string, id: 'extract-variable' | 'extract-method', notify: (message: string) => void) {
  if (id === 'extract-variable') extractVariable(view, language, notify)
  else if (language === 'Python') extractMethod(view, notify)
  else notify('Extract method comes from the language server for this kind of file; try Refactor… (' + language + ').')
}
