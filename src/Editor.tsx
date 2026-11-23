import { type Extension, Compartment, EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view'
import { HighlightStyle, StreamLanguage, bracketMatching, ensureSyntaxTree, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic as EditorDiagnostic } from '@codemirror/lint'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight'
import { python } from '@codemirror/lang-python'
import { java } from '@codemirror/lang-java'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { go } from '@codemirror/lang-go'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { kotlin, csharp } from '@codemirror/legacy-modes/mode/clike'
import { groovy } from '@codemirror/legacy-modes/mode/groovy'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { type Diagnostic, type Diff, normalize } from './bridge'

const look = EditorView.theme({
  '&': { backgroundColor: 'var(--editor)', color: 'var(--ink)', fontSize: 'var(--editor-font-size)', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: 'var(--editor-line-height)', fontFeatureSettings: 'var(--font-features)', fontVariantLigatures: 'var(--ligatures)', overflow: 'auto' },
  '.cm-content': { padding: '20px 0 32px', caretColor: 'var(--ink)' },
  '.cm-line': { padding: '0 28px 0 14px' },
  '.cm-gutters': { backgroundColor: 'var(--editor)', color: 'var(--muted)', borderRight: '0', fontSize: 'calc(var(--editor-font-size) - 2px)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 22px', minWidth: '46px', opacity: '.75' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 3px', color: 'var(--muted)', cursor: 'pointer' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--current-line)' },
  '.cm-activeLineGutter': { color: 'var(--ink)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': { background: 'var(--selection) !important' },
  '.cm-selectionMatch': { background: 'var(--accent-fill)' },
  '&.cm-focused .cm-matchingBracket': { background: 'var(--accent-fill)', outline: '1px solid var(--accent-border)' },
  '.cm-panels, .cm-tooltip': { background: 'var(--panel)', color: 'var(--ink)', borderColor: 'var(--line)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--selection)', color: 'var(--ink)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)' },
  '.cm-searchMatch': { backgroundColor: 'var(--accent-fill)', outline: '1px solid var(--accent-border)' },
  '.cm-searchMatch-selected': { outline: '1px solid var(--accent)' },
  '.cm-button, .cm-textfield': { background: 'var(--editor)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: '0', backgroundImage: 'none' },
  '.cm-panel.cm-search label': { color: 'var(--secondary)' },
  '.cm-gutter-lint': { minWidth: '9px' },
  '.cm-foldPlaceholder': { background: 'var(--hover)', border: '1px solid var(--line)', color: 'var(--muted)' },
  '.cm-deletedChunk': { background: 'color-mix(in srgb, var(--red) 12%, var(--editor))', color: 'var(--ink)' },
  '.cm-insertedLine, .cm-changedLine': { background: 'color-mix(in srgb, var(--green) 10%, var(--editor))' },
  '.cm-deletedLine': { background: 'color-mix(in srgb, var(--red) 12%, var(--editor))' },
  '.cm-changedText': { background: 'color-mix(in srgb, var(--green) 28%, transparent) !important' },
  '.cm-deletedText': { background: 'color-mix(in srgb, var(--red) 28%, transparent) !important' },
  '.cm-deletedChunk button': { display: 'none' },
})

const syntax = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.moduleKeyword, tags.definitionKeyword, tags.modifier, tags.self], color: 'var(--keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], color: 'var(--string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.constant(tags.variableName)], color: 'var(--number)' },
  { tag: [tags.className, tags.typeName, tags.annotation, tags.meta, tags.processingInstruction, tags.namespace], color: 'var(--type)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.function(tags.definition(tags.variableName)), tags.macroName], color: 'var(--function)' },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: 'var(--variable)' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--property)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--comment)', fontStyle: 'var(--comment-style)' },
  { tag: [tags.heading], color: 'var(--keyword)', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.strong], fontWeight: '650' },
  { tag: [tags.tagName], color: 'var(--tag)' },
  { tag: [tags.attributeName], color: 'var(--attribute)' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: 'var(--operator)' },
  { tag: [tags.invalid], color: 'var(--red)' },
])

const modes: { name: string; extensions: string[]; files?: string[]; indent?: number; load: () => Extension }[] = [
  { name: 'Python', extensions: ['py', 'pyi', 'pyw'], indent: 4, load: () => python() },
  { name: 'Java', extensions: ['java'], indent: 4, load: () => java() },
  { name: 'JavaScript', extensions: ['js', 'mjs', 'cjs'], load: () => javascript() },
  { name: 'JavaScript JSX', extensions: ['jsx'], load: () => javascript({ jsx: true }) },
  { name: 'TypeScript', extensions: ['ts', 'mts', 'cts'], load: () => javascript({ typescript: true }) },
  { name: 'TypeScript JSX', extensions: ['tsx'], load: () => javascript({ typescript: true, jsx: true }) },
  { name: 'JSON', extensions: ['json', 'jsonc', 'ipynb'], load: () => json() },
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdx'], load: () => markdown() },
  { name: 'HTML', extensions: ['html', 'htm', 'vue', 'svelte'], load: () => html() },
  { name: 'CSS', extensions: ['css', 'scss', 'less'], load: () => css() },
  { name: 'Rust', extensions: ['rs'], indent: 4, load: () => rust() },
  { name: 'C++', extensions: ['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh'], indent: 4, load: () => cpp() },
  { name: 'Go', extensions: ['go'], indent: 4, load: () => go() },
  { name: 'XML', extensions: ['xml', 'svg', 'plist', 'xsd', 'csproj'], files: ['pom.xml'], load: () => xml() },
  { name: 'YAML', extensions: ['yml', 'yaml'], load: () => yaml() },
  { name: 'SQL', extensions: ['sql'], load: () => sql() },
  { name: 'TOML', extensions: ['toml'], files: ['Cargo.lock', 'poetry.lock'], load: () => StreamLanguage.define(toml) },
  { name: 'Shell', extensions: ['sh', 'bash', 'zsh', 'fish'], files: ['.bashrc', '.zshrc', '.profile', 'gradlew', 'mvnw'], load: () => StreamLanguage.define(shell) },
  { name: 'PowerShell', extensions: ['ps1', 'psm1'], indent: 4, load: () => StreamLanguage.define(powerShell) },
  { name: 'Ruby', extensions: ['rb'], load: () => StreamLanguage.define(ruby) },
  { name: 'Kotlin', extensions: ['kt', 'kts'], indent: 4, load: () => StreamLanguage.define(kotlin) },
  { name: 'C#', extensions: ['cs'], indent: 4, load: () => StreamLanguage.define(csharp) },
  { name: 'Groovy', extensions: ['gradle', 'groovy'], indent: 4, load: () => StreamLanguage.define(groovy) },
  { name: 'Dockerfile', extensions: ['dockerfile'], files: ['Dockerfile'], load: () => StreamLanguage.define(dockerFile) },
  { name: 'Properties', extensions: ['properties', 'ini', 'cfg', 'conf', 'env'], files: ['.gitignore', '.env', '.editorconfig'], load: () => StreamLanguage.define(properties) },
]

function mode(path: string) {
  const name = path.split('/').at(-1) ?? path
  const extension = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : ''
  return modes.find(item => item.files?.includes(name)) ?? modes.find(item => item.extensions.includes(extension))
}

export const language = (path: string) => mode(path)?.name ?? 'Plain Text'
export const defaultIndent = (path: string) => mode(path)?.indent ?? 2

export interface EditorOptions { wrap: boolean; lineNumbers: boolean; highlightLine: boolean; tabSize: number; layout: 'inline' | 'split' }

const configuration = new Compartment()
function configure(options: EditorOptions, path: string): Extension {
  return [
    options.wrap ? EditorView.lineWrapping : [],
    options.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [],
    options.highlightLine ? highlightActiveLine() : [],
    EditorState.tabSize.of(options.tabSize),
    indentUnit.of(' '.repeat(options.tabSize)),
    mode(path)?.load() ?? [],
  ]
}

function setup(): Extension {
  return [
    highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
    indentOnInput(), syntaxHighlighting(syntax), bracketMatching(), closeBrackets(), autocompletion(), rectangularSelection(),
    crosshairCursor(), highlightSelectionMatches(), look,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
  ]
}

const onCursor = (view: EditorView) => {
  const position = view.state.selection.main.head
  const line = view.state.doc.lineAt(position)
  return { line: line.number, column: position - line.from + 1, selected: Math.abs(view.state.selection.main.to - view.state.selection.main.from) }
}

export interface Cursor { line: number; column: number; selected?: number }
export type TokenKind = 'keyword' | 'string' | 'number' | 'type' | 'function' | 'variable' | 'property' | 'comment' | 'tag' | 'attribute' | 'operator' | 'plain'
export interface CodeToken { text: string; kind: TokenKind }
export interface CodeCapture { path: string; startLine: number; lines: CodeToken[][] }

// Same groups as the on-screen highlighter, but as names, so the code image can colour them itself.
const tokenNames = tagHighlighter([
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.moduleKeyword, tags.definitionKeyword, tags.modifier, tags.self], class: 'keyword' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], class: 'string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.constant(tags.variableName)], class: 'number' },
  { tag: [tags.className, tags.typeName, tags.annotation, tags.meta, tags.processingInstruction, tags.namespace], class: 'type' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.function(tags.definition(tags.variableName)), tags.macroName], class: 'function' },
  { tag: [tags.variableName, tags.definition(tags.variableName)], class: 'variable' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], class: 'property' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], class: 'comment' },
  { tag: [tags.tagName], class: 'tag' },
  { tag: [tags.attributeName], class: 'attribute' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], class: 'operator' },
])

/** The selected lines (whole lines) split into coloured tokens, or null when nothing is selected. */
export function captureSelection(state: EditorState, path: string): CodeCapture | null {
  const selection = state.selection.main
  if (selection.empty) return null
  const first = state.doc.lineAt(selection.from)
  let last = state.doc.lineAt(selection.to)
  if (selection.to === last.from && last.number > first.number) last = state.doc.line(last.number - 1)
  const from = first.from, to = last.to
  if (to - from > 60000) return null
  const kinds: TokenKind[] = new Array(to - from).fill('plain')
  const tree = ensureSyntaxTree(state, to, 400) ?? syntaxTree(state)
  highlightTree(tree, tokenNames, (start, end, name) => {
    for (let index = Math.max(start, from); index < Math.min(end, to); index++) kinds[index - from] = name.split(' ')[0] as TokenKind
  }, from, to)
  const lines: CodeToken[][] = []
  for (let number = first.number; number <= last.number; number++) {
    const line = state.doc.line(number)
    const tokens: CodeToken[] = []
    for (let index = line.from; index < line.to; index++) {
      const char = state.doc.sliceString(index, index + 1)
      const kind = kinds[index - from]
      const previous = tokens.at(-1)
      if (previous && previous.kind === kind) previous.text += char
      else tokens.push({ text: char, kind })
    }
    lines.push(tokens)
  }
  return { path, startLine: first.number, lines }
}

export interface EditorHandle { focus: () => void; jump: (line: number, column?: number, length?: number) => void; capture: () => CodeCapture | null }
export interface EditorMemory { state?: EditorState; top?: number; left?: number }
interface Props {
  path: string
  text: string
  memory?: EditorMemory
  diff?: Diff
  initialLine?: number
  readOnly?: boolean
  options: EditorOptions
  diagnostics: Diagnostic[]
  onEdit: (text: string) => void
  onCursor: (cursor: Cursor) => void
  onBlur?: () => void
  handle: (value: EditorHandle | null) => void
}

function handleFor(editor: EditorView, path: string): EditorHandle {
  return {
    capture: () => captureSelection(editor.state, path),
    focus: () => editor.focus(),
    jump: (line, column = 1, length = 0) => {
      const row = editor.state.doc.line(Math.max(1, Math.min(line, editor.state.doc.lines)))
      const anchor = Math.min(row.to, row.from + Math.max(0, column - 1))
      editor.dispatch({ selection: { anchor, head: Math.min(row.to, anchor + length) }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) })
      editor.focus()
    },
  }
}

export default function Editor(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props
  const split = Boolean(props.diff) && props.options.layout === 'split'

  useLayoutEffect(() => {
    const current = callbacks.current
    if (!host.current) return
    const source = normalize(current.diff?.after ?? current.text)
    const listener = EditorView.updateListener.of(update => {
      if (update.docChanged && !current.diff) callbacks.current.onEdit(update.state.doc.toString())
      if (update.selectionSet || update.docChanged) callbacks.current.onCursor(onCursor(update.view))
      if (update.focusChanged && !update.view.hasFocus) callbacks.current.onBlur?.()
    })
    const base = [setup(), configuration.of(configure(current.options, current.path)), lintGutter(),
      EditorView.contentAttributes.of({ 'aria-label': current.diff ? 'File diff' : current.path, spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' })]
    const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)]

    if (current.diff && split) {
      const merge = new MergeView({
        parent: host.current, collapseUnchanged: { margin: 4, minSize: 6 }, gutter: true, highlightChanges: true,
        a: { doc: normalize(current.diff.before), extensions: [...base, ...readOnly] },
        b: { doc: source, extensions: [...base, ...readOnly, listener] },
      })
      view.current = merge.b
      current.onCursor(onCursor(merge.b))
      current.handle(handleFor(merge.b, current.path))
      return () => { merge.destroy(); view.current = null; callbacks.current.handle(null) }
    }

    const extensions: Extension[] = [...base, listener]
    if (current.diff) extensions.push(...readOnly, unifiedMergeView({ original: normalize(current.diff.before), mergeControls: false, gutter: true }))
    else if (current.readOnly) extensions.push(...readOnly)
    const line = current.initialLine ?? 1
    const initialPosition = source.split('\n').slice(0, line - 1).reduce((sum, item) => sum + item.length + 1, 0)
    const editor = new EditorView({
      parent: host.current,
      state: current.memory?.state ?? EditorState.create({ doc: source, extensions, selection: { anchor: Math.min(initialPosition, source.length) } }),
    })
    if (current.memory?.state) {
      // Restored states keep their old configuration; bring it up to date.
      editor.dispatch({ effects: configuration.reconfigure(configure(current.options, current.path)) })
      editor.scrollDOM.scrollTop = current.memory.top ?? 0
      editor.scrollDOM.scrollLeft = current.memory.left ?? 0
    } else if (line > 1) {
      editor.dispatch({ effects: EditorView.scrollIntoView(initialPosition, { y: 'center' }) })
    }
    view.current = editor
    current.onCursor(onCursor(editor))
    current.handle(handleFor(editor, current.path))
    return () => {
      if (current.memory) {
        current.memory.state = editor.state
        current.memory.top = editor.scrollDOM.scrollTop
        current.memory.left = editor.scrollDOM.scrollLeft
      }
      editor.destroy()
      view.current = null
      callbacks.current.handle(null)
    }
  }, [props.path, props.diff, props.memory, split])

  const { wrap, lineNumbers: numbers, highlightLine, tabSize } = props.options
  useEffect(() => {
    view.current?.dispatch({ effects: configuration.reconfigure(configure(props.options, props.path)) })
  }, [wrap, numbers, highlightLine, tabSize])

  useEffect(() => {
    const editor = view.current
    if (!editor || props.diff) return
    const diagnostics: EditorDiagnostic[] = props.diagnostics.filter(item => item.path === props.path).map(item => {
      const row = editor.state.doc.line(Math.max(1, Math.min(item.line, editor.state.doc.lines)))
      const from = Math.min(row.to, row.from + Math.max(0, item.column - 1))
      return { from, to: Math.min(row.to, from + 1), severity: item.severity, message: item.message, source: 'javac' }
    })
    editor.dispatch(setDiagnostics(editor.state, diagnostics))
  }, [props.diagnostics, props.diff, props.path])

  return <div className={'editor-host' + (split ? ' split-diff' : '')} ref={host} />
}
