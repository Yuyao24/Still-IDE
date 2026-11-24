// Occurrence highlighting that understands scope, like PyCharm: with the caret on a
// variable, only the uses that refer to the same variable are marked (not a different
// `i` in another function); definitions get a slightly stronger mark than reads.
// On a keyword, only that keyword is marked. Works on Lezer trees for Python,
// JavaScript/TypeScript and Java; other languages fall back to plain word matching.
import { RangeSetBuilder, type EditorState } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { language, syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'

interface Rules {
  idents: Set<string>
  scopes: Set<string>
  /** Scope nodes whose own name (a direct child identifier) is bound in the enclosing scope. */
  named: Set<string>
  properties: Set<string>
  classes: Set<string>
  binds: (node: SyntaxNode, text: (node: SyntaxNode) => string) => boolean
}

const python: Rules = {
  idents: new Set(['VariableName']),
  scopes: new Set(['Script', 'FunctionDefinition', 'LambdaExpression', 'ClassDefinition', 'ArrayComprehensionExpression', 'DictionaryComprehensionExpression', 'SetComprehensionExpression', 'ComprehensionExpression']),
  named: new Set(['FunctionDefinition', 'ClassDefinition']),
  properties: new Set(['PropertyName']),
  classes: new Set(['ClassDefinition']),
  binds: node => {
    const parent = node.parent
    if (!parent) return false
    const before = node.prevSibling?.name, after = node.nextSibling?.name
    switch (parent.name) {
      case 'FunctionDefinition': case 'ClassDefinition': return before === 'def' || before === 'class'
      case 'ParamList': return before !== 'AssignOp' && before !== ':'
      case 'AssignStatement': case 'UpdateStatement': {
        if (after === 'TypeDef') return true
        for (let next = node.nextSibling; next; next = next.nextSibling) if (next.name === 'AssignOp' || next.name === 'UpdateOp') return true
        return false
      }
      case 'ForStatement': case 'ArrayComprehensionExpression': case 'DictionaryComprehensionExpression': case 'SetComprehensionExpression': case 'ComprehensionExpression': {
        // Between `for` and `in`.
        let sawFor = false
        for (let previous = node.prevSibling; previous; previous = previous.prevSibling) {
          if (previous.name === 'in') return false
          if (previous.name === 'for') { sawFor = true; break }
        }
        if (!sawFor) return false
        for (let next = node.nextSibling; next; next = next.nextSibling) if (next.name === 'in') return true
        return false
      }
      case 'ImportStatement': {
        if (after === 'as') return false
        if (before === 'as') return true
        for (let previous = node.prevSibling; previous; previous = previous.prevSibling) if (previous.name === 'import') return true
        return false
      }
      case 'WithStatement': case 'TryStatement': case 'NamedExpression': return before === 'as' || parent.name === 'NamedExpression' && !before
      default: return false
    }
  },
}

const script: Rules = {
  idents: new Set(['VariableName', 'VariableDefinition']),
  scopes: new Set(['Script', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunction', 'MethodDeclaration', 'ClassDeclaration', 'ClassExpression', 'Block', 'ForStatement', 'CatchClause']),
  named: new Set(['FunctionDeclaration', 'ClassDeclaration']),
  properties: new Set(['PropertyName', 'PropertyDefinition']),
  classes: new Set(['ClassDeclaration', 'ClassExpression']),
  binds: node => node.name === 'VariableDefinition',
}

const java: Rules = {
  idents: new Set(['Identifier', 'Definition']),
  scopes: new Set(['Program', 'ClassBody', 'InterfaceBody', 'EnumBody', 'MethodDeclaration', 'ConstructorDeclaration', 'Block', 'LambdaExpression', 'ForStatement', 'EnhancedForStatement', 'CatchClause']),
  named: new Set(['MethodDeclaration', 'ConstructorDeclaration', 'ClassDeclaration', 'InterfaceDeclaration', 'EnumDeclaration', 'RecordDeclaration']),
  properties: new Set([]),
  classes: new Set(['ClassBody', 'InterfaceBody', 'EnumBody']),
  binds: node => node.name === 'Definition',
}

function rulesFor(state: EditorState): Rules | null {
  const name = state.facet(language)?.name ?? ''
  if (name === 'python') return python
  if (name === 'java') return java
  if (['javascript', 'typescript', 'jsx', 'tsx'].includes(name)) return script
  return null
}

const read = Decoration.mark({ class: 'cm-occurrence' })
const write = Decoration.mark({ class: 'cm-occurrence cm-occurrence-write' })
const keyword = Decoration.mark({ class: 'cm-occurrence-keyword' })

function build(view: EditorView): DecorationSet {
  const state = view.state
  const range = state.selection.main
  const builder = new RangeSetBuilder<Decoration>()
  if (!range.empty || state.doc.length > 400_000 || state.selection.ranges.length > 1) return builder.finish()
  const rules = rulesFor(state)
  if (!rules) return builder.finish()
  const tree = syntaxTree(state)
  const text = (node: SyntaxNode) => state.doc.sliceString(node.from, node.to)
  const at = (side: -1 | 1) => tree.resolveInner(range.head, side)
  let target: SyntaxNode | null = null
  for (const node of [at(-1), at(1)]) {
    if (rules.idents.has(node.name) || rules.properties.has(node.name)) { target = node; break }
  }
  if (!target) {
    // A keyword: mark just that one.
    for (const node of [at(1), at(-1)]) {
      if (!node.firstChild && /^[a-z]+$/.test(node.name) && node.name === text(node) && node.to > node.from) {
        builder.add(node.from, node.to, keyword)
        break
      }
    }
    return builder.finish()
  }
  const name = text(target)
  if (!name) return builder.finish()
  const scopeOfNode = (node: SyntaxNode) => { for (let parent = node.parent; parent; parent = parent.parent) if (rules.scopes.has(parent.name)) return parent; return null }

  // Property names: mark the same name inside the enclosing class (or the file).
  if (rules.properties.has(target.name)) {
    let container: SyntaxNode = tree.topNode
    for (let node: SyntaxNode | null = target.parent; node; node = node.parent) if (rules.classes.has(node.name)) { container = node; break }
    const found: [number, number][] = []
    container.cursor().iterate(node => {
      if (node.to - node.from !== name.length || state.doc.sliceString(node.from, node.to) !== name) return
      // `self.x` uses, plus `x = …` / `x: int` declared directly in the class body.
      const declared = rules.idents.has(node.name) && rules.binds(node.node, text) && container.name !== 'Script' && scopeOfNode(node.node)?.from === container.from
      if (rules.properties.has(node.name) || declared) found.push([node.from, node.to])
    })
    if (found.length > 1) for (const [from, to] of found) builder.add(from, to, read)
    return builder.finish()
  }

  const isScope = (node: SyntaxNode) => rules.scopes.has(node.name)
  const top = tree.topNode
  // Syntax nodes are fresh objects each time they're fetched, so compare by position and type.
  const same = (a: SyntaxNode, b: SyntaxNode) => a.from === b.from && a.to === b.to && a.type === b.type
  const scopeOf = (node: SyntaxNode): SyntaxNode => {
    for (let parent = node.parent; parent; parent = parent.parent) if (isScope(parent)) return parent
    return top
  }
  // The scope a binding belongs to: a function or class name belongs to the scope around it.
  const owner = (binding: SyntaxNode) => {
    const scope = scopeOf(binding)
    return rules.named.has(scope.name) && binding.parent === scope ? scopeOf(scope) : scope
  }
  const cache = new Map<number, { binds: boolean; outer: 'global' | 'nonlocal' | null }>()
  // Does `scope` itself bind the name (ignoring nested scopes, except for their own names)?
  const lookup = (scope: SyntaxNode) => {
    const key = scope.from * 1e6 + scope.to + scope.type.id / 1000
    const cached = cache.get(key)
    if (cached) return cached
    let binds = false, outer: 'global' | 'nonlocal' | null = null
    const visit = (node: SyntaxNode) => {
      for (let child = node.firstChild; child && !binds; child = child.nextSibling) {
        if (child.name === 'ScopeStatement') {
          const kind = child.firstChild?.name
          for (let item = child.firstChild; item; item = item.nextSibling) if (item.name === 'VariableName' && text(item) === name) outer = kind === 'global' ? 'global' : 'nonlocal'
          continue
        }
        if (isScope(child)) {
          // A nested function or class: only its name is bound out here.
          if (rules.named.has(child.name)) for (let inner = child.firstChild; inner; inner = inner.nextSibling) if (rules.idents.has(inner.name) && rules.binds(inner, text) && text(inner) === name) binds = true
          continue
        }
        if (rules.idents.has(child.name) && text(child) === name && rules.binds(child, text) && !(rules.named.has(scope.name) && child.parent === scope)) binds = true
        else if (child.firstChild) visit(child)
      }
    }
    visit(scope)
    const result = { binds: binds && !outer, outer }
    cache.set(key, result)
    return result
  }
  // Walk outward from a use to the scope that defines the name.
  const resolve = (node: SyntaxNode) => {
    let insideFunction = false
    for (let scope: SyntaxNode | null = scopeOf(node); scope; scope = same(scope, top) || !scope.parent ? null : scopeOf(scope)) {
      // Python: names in a class body aren't visible inside its methods.
      if (rules === python && scope.name === 'ClassDefinition' && insideFunction) continue
      const result = lookup(scope)
      if (result.outer === 'global') return top
      if (result.binds) return scope
      if (scope.name !== 'ClassDefinition') insideFunction = true
    }
    return top
  }
  const home = rules.binds(target, text) ? owner(target) : resolve(target)
  const found: { from: number; to: number; write: boolean }[] = []
  home.cursor().iterate(node => {
    if (!rules.idents.has(node.name) || node.to - node.from !== name.length) return
    const ref = node.node
    if (text(ref) !== name) return
    const binding = rules.binds(ref, text)
    const scope = binding ? owner(ref) : resolve(ref)
    if (same(scope, home)) found.push({ from: ref.from, to: ref.to, write: binding })
  })
  if (found.length < 2 && !found.some(item => item.write)) return builder.finish()
  for (const item of found) builder.add(item.from, item.to, item.write ? write : read)
  return builder.finish()
}

export const scopedOccurrences = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  timer: ReturnType<typeof setTimeout> | undefined
  constructor(readonly view: EditorView) { this.decorations = build(view) }
  update(update: ViewUpdate) {
    if (update.docChanged) this.decorations = this.decorations.map(update.changes)
    if (update.selectionSet || update.docChanged || (syntaxTree(update.startState).length !== syntaxTree(update.state).length)) {
      // Moving the caret is instant; while typing, wait for a pause.
      clearTimeout(this.timer)
      if (update.docChanged) this.timer = setTimeout(() => { this.decorations = build(this.view); this.view.dispatch({}) }, 250)
      else this.decorations = build(update.view)
    }
  }
  destroy() { clearTimeout(this.timer) }
}, { decorations: plugin => plugin.decorations })

/** Grammars this module understands; for others the editor uses plain word matching. */
export function hasScopes(state: EditorState) { return rulesFor(state) !== null }
