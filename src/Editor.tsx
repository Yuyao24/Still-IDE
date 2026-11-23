import { type Extension, Compartment, EditorState } from '@codemirror/state'
import { indentWithTab } from '@codemirror/commands'
import { EditorView, keymap } from '@codemirror/view'
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { lintGutter, setDiagnostics, type Diagnostic as EditorDiagnostic } from '@codemirror/lint'
import { unifiedMergeView } from '@codemirror/merge'
import { tags } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import { python } from '@codemirror/lang-python'
import { java } from '@codemirror/lang-java'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { type Diagnostic, type Diff, normalize } from './bridge'

const look = EditorView.theme({
  '&': { backgroundColor: 'var(--editor)', color: 'var(--ink)', fontSize: '14px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '22px', fontFeatureSettings: '"liga" 1, "calt" 1', fontVariantLigatures: 'contextual common-ligatures', overflow: 'auto' },
  '.cm-content': { padding: '13px 0 24px', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 17px 0 11px' },
  '.cm-gutters': { backgroundColor: 'var(--editor)', color: 'var(--muted)', borderRight: '0', fontSize: '12px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 7px 0 15px', minWidth: '37px' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 3px', color: 'var(--muted)', cursor: 'pointer' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--current-line)' },
  '.cm-activeLineGutter': { color: 'var(--ink)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: 'var(--accent-fill)' },
  '.cm-selectionMatch, .cm-matchingBracket': { background: 'var(--accent-fill)' },
  '.cm-panels, .cm-tooltip': { background: 'var(--panel)', color: 'var(--ink)', borderColor: 'var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--accent-fill)', outline: '1px solid var(--accent-border)' },
  '.cm-searchMatch-selected': { outline: '1px solid var(--accent)' },
  '.cm-button, .cm-textfield': { background: 'var(--bar)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: '3px' },
  '.cm-gutter-lint': { minWidth: '9px' },
  '.cm-deletedChunk': { background: 'color-mix(in srgb, var(--red) 12%, var(--editor))', color: 'var(--ink)' },
  '.cm-insertedLine': { background: 'color-mix(in srgb, var(--green) 10%, var(--editor))' },
  '.cm-deletedChunk button': { display: 'none' },
})

const syntax = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.moduleKeyword], color: 'var(--keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--number)' },
  { tag: [tags.className, tags.typeName, tags.annotation, tags.meta, tags.processingInstruction], color: 'var(--type)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.propertyName)], color: 'var(--function)' },
  { tag: [tags.comment, tags.lineComment], color: 'var(--comment)', fontStyle: 'italic' },
  { tag: [tags.heading, tags.link], color: 'var(--keyword)', fontWeight: '600' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--secondary)' },
])

export function language(path: string) {
  switch (path.split('.').at(-1)?.toLowerCase()) {
    case 'py': return 'Python'
    case 'java': return 'Java'
    case 'md': return 'Markdown'
    case 'json': return 'JSON'
    default: return 'Plain Text'
  }
}

function support(path: string): Extension {
  switch (language(path)) {
    case 'Python': return python()
    case 'Java': return java()
    case 'Markdown': return markdown()
    case 'JSON': return json()
    default: return []
  }
}

const diagnosticsCompartment = new Compartment()
const onCursor = (view: EditorView) => {
  const position = view.state.selection.main.head
  const line = view.state.doc.lineAt(position)
  return { line: line.number, column: position - line.from + 1 }
}

export interface EditorHandle { focus: () => void; jump: (line: number, column?: number) => void }
export interface EditorMemory { state?: EditorState; top?: number; left?: number }
interface Props {
  path: string
  text: string
  memory?: EditorMemory
  diff?: Diff
  sample?: boolean
  diagnostics: Diagnostic[]
  onEdit: (text: string) => void
  onCursor: (cursor: { line: number; column: number }) => void
  handle: (value: EditorHandle | null) => void
}

export default function Editor(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props

  useLayoutEffect(() => {
    const current = callbacks.current
    if (!host.current) return
    const source = normalize(current.diff?.after ?? current.text)
    const extensions: Extension[] = [
      basicSetup, EditorView.lineWrapping, look, syntaxHighlighting(syntax), support(current.path), keymap.of([indentWithTab]),
      EditorState.tabSize.of(4), indentUnit.of(['Python', 'Java'].includes(language(current.path)) ? '    ' : '  '), diagnosticsCompartment.of(lintGutter()),
      EditorView.contentAttributes.of({ 'aria-label': current.diff ? 'File diff' : current.path, spellcheck: 'false' }),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !current.diff) callbacks.current.onEdit(update.state.doc.toString())
        if (update.selectionSet || update.docChanged) callbacks.current.onCursor(onCursor(update.view))
      }),
    ]
    if (current.diff) {
      extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false), unifiedMergeView({
        original: normalize(current.diff.before), mergeControls: false, gutter: true,
      }))
    }
    const initialLine = current.sample && current.path === 'src/app.py' ? 11 : 1
    const initialPosition = source.split('\n').slice(0, initialLine - 1).reduce((sum, line) => sum + line.length + 1, 0)
    const editor = new EditorView({
      parent: host.current,
      state: current.memory?.state ?? EditorState.create({ doc: source, extensions, selection: { anchor: Math.min(initialPosition, source.length) } }),
    })
    if (current.memory) {
      editor.scrollDOM.scrollTop = current.memory.top ?? 0
      editor.scrollDOM.scrollLeft = current.memory.left ?? 0
    }
    view.current = editor
    current.onCursor(onCursor(editor))
    current.handle({
      focus: () => editor.focus(),
      jump: (line, column = 1) => {
        const row = editor.state.doc.line(Math.max(1, Math.min(line, editor.state.doc.lines)))
        const anchor = Math.min(row.to, row.from + Math.max(0, column - 1))
        editor.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) })
        editor.focus()
      },
    })
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
  }, [props.path, props.diff, props.memory, props.sample])

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

  return <div className="editor-host" ref={host} />
}

