import { type Extension, Compartment, EditorSelection, EditorState, Prec, RangeSet, RangeSetBuilder, StateEffect, StateField, Text } from '@codemirror/state'
import { cursorDocEnd, defaultKeymap, history, historyKeymap, indentWithTab, redo, selectAll, toggleComment, undo } from '@codemirror/commands'
import {
  Decoration, type DecorationSet, EditorView, GutterMarker, ViewPlugin, type ViewUpdate, crosshairCursor, drawSelection, dropCursor, gutter, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, highlightTrailingWhitespace, highlightWhitespace, keymap, lineNumbers, rectangularSelection, scrollPastEnd,
} from '@codemirror/view'
import { HighlightStyle, Language, LanguageSupport, StreamLanguage, bracketMatching, ensureSyntaxTree, foldAll, foldGutter, foldKeymap, getIndentUnit, indentOnInput, indentUnit, syntaxHighlighting, syntaxTree, unfoldAll } from '@codemirror/language'
import { gotoLine, highlightSelectionMatches, openSearchPanel, searchKeymap, selectNextOccurrence, selectSelectionMatches } from '@codemirror/search'
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, closeCompletion, moveCompletionSelection, startCompletion } from '@codemirror/autocomplete'
import { forceLinting, lintGutter, lintKeymap, linter, type Diagnostic as EditorDiagnostic } from '@codemirror/lint'
import { Chunk, MergeView, unifiedMergeView } from '@codemirror/merge'
import { highlightCode, highlightTree, tagHighlighter, tags } from '@lezer/highlight'
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
import { scopedOccurrences } from './occurrences'
import { smartCompletions, sourceColumn } from './completion'
import { inlineSuggestions, type Suggest } from './ghost'
import { type Diagnostic, type Diff, clipboard, normalize } from './bridge'

const look = EditorView.theme({
  '&': { backgroundColor: 'var(--editor)', color: 'var(--ink)', fontSize: 'var(--editor-font-size)', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: 'var(--editor-line-height)', fontFeatureSettings: 'var(--font-features)', fontVariantLigatures: 'var(--ligatures)', overflow: 'auto' },
  '.cm-content': { padding: '20px 0 32px', caretColor: 'var(--ink)' },
  '.cm-line': { padding: '0 28px 0 14px' },
  '.cm-gutters': { backgroundColor: 'var(--editor)', color: 'var(--muted)', borderRight: '0', fontSize: 'calc(var(--editor-font-size) - 2px)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 22px', minWidth: '46px', opacity: '.75' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 3px', color: 'var(--muted)', cursor: 'pointer' },
  // See-through so a selection on the current line still shows underneath.
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--ink) 3.5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--current-line)', color: 'var(--ink)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--caret, var(--ink))', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { background: 'var(--text-selection) !important' },
  '.cm-selectionLayer .cm-selectionBackground': { opacity: '.75' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { opacity: '1' },
  '.cm-selectionMatch': { background: 'var(--occurrence)', borderRadius: '0' },
  '.cm-selectionMatch-main': { background: 'var(--occurrence)', outline: '1px solid var(--occurrence-border)' },
  '.cm-occurrence': { background: 'var(--occurrence)' },
  '.cm-breakpoints': { width: '14px', cursor: 'pointer' },
  '.cm-breakpoints .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0' },
  '.cm-breakpoints .cm-gutterElement:hover::after': { content: '""', width: '8px', height: '8px', borderRadius: '50%', background: 'color-mix(in srgb, var(--red) 35%, transparent)' },
  '.cm-breakpoint': { width: '8px', height: '8px', borderRadius: '50%', background: 'var(--red)' },
  '.cm-breakpoints .cm-gutterElement:has(.cm-breakpoint):hover::after': { content: 'none' },
  '.cm-debug-line': { background: 'color-mix(in srgb, var(--amber) 18%, transparent) !important', boxShadow: 'inset 2px 0 0 var(--amber)' },
  '.cm-ghost': { color: 'var(--muted)', opacity: '.75', whiteSpace: 'pre', pointerEvents: 'none' },
  '.cm-content[data-suggesting] .cm-cursor-primary, &.cm-focused .cm-content[data-suggesting] ~ .cm-cursorLayer .cm-cursor': { borderLeftColor: 'var(--muted)' },
  '.cm-occurrence-write': { background: 'color-mix(in srgb, var(--occurrence) 55%, var(--occurrence-border))' },
  '.cm-occurrence-keyword': { background: 'var(--occurrence)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--red)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px', textDecorationThickness: '1px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--amber)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px', textDecorationThickness: '1px' },
  '.cm-lintRange-info': { backgroundImage: 'none', textDecoration: 'underline dotted var(--muted)', textUnderlineOffset: '3px' },
  '.cm-tooltip.cm-tooltip-lint': { border: '1px solid var(--line)', boxShadow: '0 6px 20px var(--shadow)', fontFamily: 'var(--font-ui)', fontSize: '12px' },
  '.cm-diagnostic': { padding: '6px 10px', borderLeft: '2px solid var(--line)' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--red)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--amber)' },
  '.cm-diagnosticSource': { color: 'var(--muted)', opacity: '1' },
  '.cm-lint-marker': { width: '7px', height: '7px', borderRadius: '0', content: 'none' },
  '.cm-lint-marker-error': { content: 'none', background: 'var(--red)' },
  '.cm-lint-marker-warning': { content: 'none', background: 'var(--amber)' },
  '.cm-gutter-changes': { width: '3px', marginLeft: '4px' },
  '.cm-gutter-changes .cm-gutterElement': { padding: '0' },
  '.cm-change': { width: '3px', height: '100%' },
  '.cm-change-add': { background: 'var(--green)' },
  '.cm-change-mod': { background: 'var(--amber)' },
  '.cm-change-del': { width: '0', height: '0', borderTop: '4px solid transparent', borderBottom: '4px solid transparent', borderLeft: '5px solid var(--red)', marginTop: '-4px' },
  '.cm-indent-guide': { boxShadow: 'inset 1px 0 0 var(--indent-guide)' },
  '.cm-highlightSpace': { backgroundImage: 'radial-gradient(circle at 50% 55%, var(--muted) 12%, transparent 13%)', opacity: '.5' },
  '.cm-highlightTab': { opacity: '.5' },
  '.cm-trailingSpace': { backgroundColor: 'color-mix(in srgb, var(--red) 18%, transparent)' },
  '&.cm-focused .cm-matchingBracket': { background: 'var(--accent-fill)', outline: '1px solid var(--accent-border)' },
  '.cm-panels, .cm-tooltip': { background: 'var(--panel)', color: 'var(--ink)', borderColor: 'var(--line)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--selection)', color: 'var(--ink)' },
  '.cm-tooltip-autocomplete': { border: '1px solid var(--line)', boxShadow: '0 10px 28px var(--shadow)', background: 'var(--editor)', padding: '4px 0 0' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: 'calc(var(--editor-font-size) - 1px)', minWidth: '320px', maxWidth: 'min(640px, 80vw)', maxHeight: '15em' },
  '.cm-tooltip-autocomplete > ul > li': { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 12px 3px 10px', lineHeight: '1.5' },
  '.cm-tooltip-autocomplete::after': { content: '"Tab to accept · Enter for a new line"', display: 'block', padding: '6px 12px', borderTop: '1px solid var(--line)', marginTop: '4px', color: 'var(--muted)', fontFamily: 'var(--font-sans)', fontSize: '11px' },
  '.cm-completionLabel': { color: 'var(--ink)' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent-strong, var(--keyword))', fontWeight: '600' },
  '.cm-completionDetail': { marginLeft: '0', color: 'var(--muted)', fontStyle: 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1' },
  '.cm-completionSource': { marginLeft: 'auto', paddingLeft: '18px', color: 'var(--muted)', fontFamily: 'var(--font-sans)', fontSize: '11px' },
  '.cm-completionIcon': { width: '16px', height: '16px', padding: '0', marginRight: '2px', display: 'inline-grid', placeItems: 'center', opacity: '1', fontSize: '10px', fontFamily: 'var(--font-sans)', fontWeight: '600', border: '1px solid var(--line)', color: 'var(--muted)' },
  '.cm-completionIcon::after': { content: '"·"' },
  '.cm-completionIcon-function::after, .cm-completionIcon-method::after': { content: '"f"' },
  '.cm-completionIcon-function, .cm-completionIcon-method': { color: 'var(--function)', borderColor: 'color-mix(in srgb, var(--function) 45%, var(--line))' },
  '.cm-completionIcon-class::after, .cm-completionIcon-type::after': { content: '"C"' },
  '.cm-completionIcon-class, .cm-completionIcon-type': { color: 'var(--type)', borderColor: 'color-mix(in srgb, var(--type) 45%, var(--line))' },
  '.cm-completionIcon-variable::after': { content: '"v"' },
  '.cm-completionIcon-variable': { color: 'var(--variable)' },
  '.cm-completionIcon-property::after': { content: '"p"' },
  '.cm-completionIcon-property': { color: 'var(--property)' },
  '.cm-completionIcon-keyword::after': { content: '"k"' },
  '.cm-completionIcon-keyword': { color: 'var(--keyword)', borderColor: 'color-mix(in srgb, var(--keyword) 40%, var(--line))' },
  '.cm-completionIcon-text::after': { content: '"a"' },
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
  { tag: [tags.self, tags.special(tags.variableName)], color: 'var(--keyword)', fontStyle: 'italic' },
  { tag: [tags.standard(tags.variableName), tags.standard(tags.function(tags.variableName))], color: 'var(--function)' },
  { tag: [tags.definition(tags.className), tags.definition(tags.typeName)], color: 'var(--type)', fontWeight: '500' },
  { tag: [tags.function(tags.definition(tags.variableName)), tags.function(tags.definition(tags.propertyName))], color: 'var(--function)', fontWeight: '500' },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: 'var(--variable)' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName), tags.attributeName], color: 'var(--property)' },
  { tag: [tags.escape, tags.special(tags.string)], color: 'var(--number)' },
  { tag: [tags.labelName, tags.macroName], color: 'var(--type)' },
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

export interface EditorOptions {
  wrap: boolean; lineNumbers: boolean; highlightLine: boolean; tabSize: number; layout: 'inline' | 'split'; autocomplete: boolean
  occurrences?: boolean; whitespace?: 'none' | 'trailing' | 'all'; indentGuides?: boolean; closeBrackets?: boolean; scrollPastEnd?: boolean
  errors?: boolean; changes?: boolean; cursorBlink?: boolean; folding?: boolean
}

// Suggestions are accepted with Tab, never Enter, so Enter always makes a new line.
const completionKeys = Prec.highest(keymap.of([
  { key: 'Tab', run: acceptCompletion },
  { key: 'Ctrl-Space', run: startCompletion },
  { key: 'Escape', run: closeCompletion },
  { key: 'ArrowDown', run: moveCompletionSelection(true) },
  { key: 'ArrowUp', run: moveCompletionSelection(false) },
  { key: 'PageDown', run: moveCompletionSelection(true, 'page') },
  { key: 'PageUp', run: moveCompletionSelection(false, 'page') },
]))

/** Ranked word suggestions for code; markup and data languages keep CodeMirror's own (tags, properties). */
function completionFor(path: string, whileTyping: boolean) {
  const name = mode(path)?.name ?? 'Plain Text'
  const smart = ({ Python: 'python', Java: 'java', JavaScript: 'javascript', 'JavaScript JSX': 'javascript', TypeScript: 'javascript', 'TypeScript JSX': 'javascript' } as Record<string, string>)[name]
  const own = smart !== undefined || ['Plain Text', 'Markdown', 'Rust', 'Go', 'C++', 'Kotlin', 'C#', 'Ruby', 'Shell', 'Groovy', 'PowerShell'].includes(name)
  return autocompletion({
    activateOnTyping: whileTyping, defaultKeymap: false, icons: true, maxRenderedOptions: 40,
    addToOptions: [sourceColumn], optionClass: () => 'cm-completion-row',
    ...(own ? { override: [smartCompletions(smart ?? '')] } : {}),
  })
}

const configuration = new Compartment()
function configure(options: EditorOptions, path: string): Extension {
  return [
    options.wrap ? EditorView.lineWrapping : [],
    options.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [],
    options.highlightLine ? highlightActiveLine() : [],
    // Off: suggestions only appear with Ctrl+Space. On: they appear while typing.
    completionFor(path, options.autocomplete),
    EditorState.tabSize.of(options.tabSize),
    indentUnit.of(' '.repeat(options.tabSize)),
    // Other uses of the word under the caret (or of the selected text) are marked.
    // Other uses of the selected text are always marked. With nothing selected, the variable under the caret
    // is marked where it's in scope (Python, JavaScript, Java), or the plain word elsewhere.
    options.occurrences !== false && !['Python', 'Java', 'JavaScript', 'JavaScript JSX', 'TypeScript', 'TypeScript JSX'].includes(mode(path)?.name ?? '')
      ? highlightSelectionMatches({ highlightWordAroundCursor: true, minSelectionLength: 2 }) : highlightSelectionMatches({ minSelectionLength: 2 }),
    options.occurrences !== false ? scopedOccurrences : [],
    options.whitespace === 'all' ? highlightWhitespace() : options.whitespace === 'trailing' ? highlightTrailingWhitespace() : [],
    options.indentGuides !== false ? indentGuides : [],
    options.closeBrackets !== false ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : [],
    options.scrollPastEnd ? scrollPastEnd() : [],
    options.folding !== false ? foldGutter({ markerDOM: open => { const marker = document.createElement('span'); marker.className = 'cm-fold-marker' + (open ? ' open' : ''); return marker } }) : [],
    drawSelection({ cursorBlinkRate: options.cursorBlink === false ? 0 : 1100 }),
    mode(path)?.load() ?? [],
  ]
}

/** Thin vertical lines at each indentation level, like other editors. */
const indentGuides = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = this.build(view) }
  update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view) }
  build(view: EditorView) {
    const builder = new RangeSetBuilder<Decoration>()
    const unit = Math.max(1, getIndentUnit(view.state))
    const guide = Decoration.mark({ class: 'cm-indent-guide' })
    for (const { from, to } of view.visibleRanges) {
      for (let position = from; position <= to;) {
        const line = view.state.doc.lineAt(position)
        let column = 0
        for (let index = 0; index < line.length; index++) {
          const char = line.text.charCodeAt(index)
          if (char === 9) { if (column > 0) builder.add(line.from + index, line.from + index + 1, guide); column += unit - (column % unit) }
          else if (char === 32) { if (column > 0 && column % unit === 0) builder.add(line.from + index, line.from + index + 1, guide); column++ }
          else break
        }
        position = line.to + 1
      }
    }
    return builder.finish()
  }
}, { decorations: plugin => plugin.decorations })

// ---- Change markers: lines added, changed or removed since the last commit ----
const setBase = StateEffect.define<string | null>()
const setChanges = StateEffect.define<RangeSet<GutterMarker>>()
class ChangeMarker extends GutterMarker {
  constructor(readonly kind: 'add' | 'mod' | 'del') { super() }
  eq(other: ChangeMarker) { return other.kind === this.kind }
  toDOM() { const node = document.createElement('div'); node.className = 'cm-change cm-change-' + this.kind; node.title = this.kind === 'add' ? 'Added since the last commit' : this.kind === 'mod' ? 'Changed since the last commit' : 'Lines removed here since the last commit'; return node }
}
const changeMarker = { add: new ChangeMarker('add'), mod: new ChangeMarker('mod'), del: new ChangeMarker('del') }
const baseText = StateField.define<Text | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setBase)) return effect.value === null ? null : Text.of(effect.value.split('\n'))
    return value
  },
})
const changeMarks = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setChanges)) return effect.value
    if (transaction.effects.some(effect => effect.is(setBase)) && !transaction.state.field(baseText)) return RangeSet.empty
    return transaction.docChanged ? value.map(transaction.changes) : value
  },
})
function computeChanges(doc: Text, base: Text): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>()
  if (doc.length > 2_000_000 || base.length > 2_000_000) return builder.finish()
  for (const chunk of Chunk.build(base, doc, { scanLimit: 2000, timeout: 120 })) {
    if (chunk.fromB === chunk.toB) {
      const line = doc.lineAt(Math.min(chunk.fromB, doc.length))
      builder.add(line.from, line.from, changeMarker.del)
      continue
    }
    // Ranges in this document that were typed in (insertions) or otherwise changed.
    const inserted = chunk.changes.filter(change => change.fromA === change.toA).map(change => [chunk.fromB + change.fromB, chunk.fromB + change.toB] as const)
    const changed = chunk.changes.map(change => [chunk.fromB + change.fromB, chunk.fromB + change.toB] as const)
    const within = (position: number) => inserted.some(([from, to]) => position >= from && position < to)
    const first = doc.lineAt(chunk.fromB).number, last = doc.lineAt(Math.max(chunk.fromB, Math.min(doc.length, chunk.toB - 1))).number
    for (let number = first; number <= last; number++) {
      const line = doc.line(number)
      // A whole new line: its text and the line break before it were all inserted.
      const added = line.from > 0 && within(line.from - 1) && (line.length === 0 || (within(line.from) && within(line.to - 1)))
      const touched = changed.some(([from, to]) => from === to
        ? from >= line.from && from <= line.to
        : (from < line.to && to > line.from) || (from === line.to && doc.sliceString(from, from + 1) !== '\n') || (line.length === 0 && from === line.from && doc.sliceString(from, from + 1) !== '\n'))
      if (added) builder.add(line.from, line.from, changeMarker.add)
      else if (touched) builder.add(line.from, line.from, changeMarker.mod)
    }
  }
  return builder.finish()
}
const changeTracker = ViewPlugin.fromClass(class {
  timer: ReturnType<typeof setTimeout> | undefined
  constructor(readonly view: EditorView) { this.schedule(0) }
  update(update: ViewUpdate) {
    if (update.docChanged || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setBase)))) this.schedule(220)
  }
  schedule(delay: number) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const base = this.view.state.field(baseText, false)
      if (!base) return
      this.view.dispatch({ effects: setChanges.of(computeChanges(this.view.state.doc, base)) })
    }, delay)
  }
  destroy() { clearTimeout(this.timer) }
})
const changeGutter = [baseText, changeMarks, changeTracker, gutter({ class: 'cm-gutter-changes', markers: view => view.state.field(changeMarks, false) ?? RangeSet.empty })]

// ---- Breakpoints and the paused line (debugger) ----
const setBreakpoints = StateEffect.define<number[]>()
const setDebugLine = StateEffect.define<number | null>()
class BreakpointMarker extends GutterMarker {
  toDOM() { const node = document.createElement('div'); node.className = 'cm-breakpoint'; return node }
}
const breakpointMarker = new BreakpointMarker()
const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, transaction) {
    value = value.map(transaction.changes)
    for (const effect of transaction.effects) if (effect.is(setBreakpoints)) {
      const doc = transaction.state.doc
      const builder = new RangeSetBuilder<GutterMarker>()
      for (const line of [...new Set(effect.value)].filter(line => line >= 1 && line <= doc.lines).sort((a, b) => a - b)) builder.add(doc.line(line).from, doc.line(line).from, breakpointMarker)
      value = builder.finish()
    }
    return value
  },
})
export function breakpointLines(state: EditorState) {
  const lines: number[] = []
  state.field(breakpointField, false)?.between(0, state.doc.length, from => { lines.push(state.doc.lineAt(from).number) })
  return lines
}
const debugLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes)
    for (const effect of transaction.effects) if (effect.is(setDebugLine)) {
      const line = effect.value
      value = line && line <= transaction.state.doc.lines ? Decoration.set([Decoration.line({ class: 'cm-debug-line' }).range(transaction.state.doc.line(line).from)]) : Decoration.none
    }
    return value
  },
  provide: field => EditorView.decorations.from(field),
})
function breakpointGutter(toggle: (line: number) => void) {
  return [breakpointField, debugLine, gutter({
    class: 'cm-breakpoints', renderEmptyElements: true,
    markers: view => view.state.field(breakpointField, false) ?? RangeSet.empty,
    initialSpacer: () => breakpointMarker,
    domEventHandlers: { mousedown: (view, line) => { toggle(view.state.doc.lineAt(line.from).number); return true } },
  })]
}

/** Lezer marks code it can't parse with error nodes; show them as syntax errors. */
function syntaxErrors(state: EditorState): EditorDiagnostic[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 300) ?? syntaxTree(state)
  const found: EditorDiagnostic[] = []
  tree.iterate({
    enter: node => {
      if (found.length >= 60) return false
      if (!node.type.isError) return
      const from = node.from, to = Math.min(state.doc.length, Math.max(node.to, from + 1))
      const previous = found.at(-1)
      if (previous && from <= previous.to + 1) { previous.to = Math.max(previous.to, to); return }
      found.push({ from, to: Math.min(to, state.doc.lineAt(from).to) > from ? Math.min(to, state.doc.lineAt(from).to) : to, severity: 'error', message: 'Syntax error', source: 'parser' })
    },
  })
  return found
}

function setup(): Extension {
  return [
    highlightSpecialChars(), history(), dropCursor(), EditorState.allowMultipleSelections.of(true),
    indentOnInput(), syntaxHighlighting(syntax), bracketMatching(), completionKeys, rectangularSelection(),
    crosshairCursor(), look,
    keymap.of([
      { key: 'F2', run: renameOccurrences },
      { key: 'F12', run: view => { const handler = definitionHandlers.get(view); if (!handler) return false; handler(); return true } },
      ...defaultKeymap.filter(binding => binding.key !== 'Mod-Shift-k' && binding.key !== 'Mod-Enter'),
      { key: 'Mod-Shift-d', run: duplicateLine },
      ...searchKeymap, ...historyKeymap, ...foldKeymap, ...lintKeymap, indentWithTab,
    ]),
  ]
}

const definitionHandlers = new WeakMap<EditorView, () => void>()

/** Selects every use of the word under the caret, so typing renames them all in this file. */
export function renameOccurrences(view: EditorView) {
  const range = view.state.selection.main
  if (range.empty) {
    const word = view.state.wordAt(range.head)
    if (!word) return false
    view.dispatch({ selection: EditorSelection.single(word.from, word.to) })
  }
  return selectSelectionMatches(view)
}

function duplicateLine(view: EditorView) {
  const changes = view.state.selection.ranges.map(range => {
    const line = view.state.doc.lineAt(range.head)
    return { from: line.to, insert: '\n' + line.text }
  })
  view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.copyline' })
  return true
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
  let selection = state.selection.main
  if (selection.empty) {
    // Nothing selected: the whole file, if it fits on one image.
    if (state.doc.lines > 150) return null
    selection = EditorSelection.range(0, state.doc.length)
  }
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

export type EditorCommand = 'undo' | 'redo' | 'selectAll' | 'comment' | 'foldAll' | 'unfoldAll' | 'rename' | 'gotoLine' | 'selectNext' | 'find' | 'cut' | 'copy' | 'end'
export interface CodeIssue { line: number; column: number; endLine?: number | null; endColumn?: number | null; severity: 'error' | 'warning' | 'info'; message: string }
export interface LiveIssue { line: number; column: number; severity: 'error' | 'warning' | 'info'; message: string; source: string }
export interface EditorHandle {
  focus: () => void; find: () => void; reveal: () => void; selection: () => string; jump: (line: number, column?: number, length?: number) => void; capture: () => CodeCapture | null
  command: (name: EditorCommand) => boolean; insert: (text: string) => void; word: () => { text: string; line: number } | null
  /** Trims trailing spaces and/or ensures a final newline, in the editor (undoable); returns the new text. */
  tidy: (options: { trim: boolean; finalNewline: boolean }) => string | null
}
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
  /** The file as of the last commit; lines changed since then get a marker. */
  base?: string | null
  /** Checks the whole file (Python); when absent, the parser's syntax errors are shown. */
  check?: (text: string) => Promise<CodeIssue[]>
  onIssues?: (issues: LiveIssue[]) => void
  onContextMenu?: (event: React.MouseEvent) => void
  onDefinition?: () => void
  /** AI inline suggestions (ghost text); absent when the feature is off. */
  suggest?: Suggest
  breakpoints?: number[]
  /** Called with the new list when a breakpoint is toggled or edits move breakpoints. */
  onBreakpoints?: (lines: number[]) => void
  /** The line the debugger is paused on in this file. */
  debugLine?: number | null
}

function handleFor(editor: EditorView, path: string): EditorHandle {
  const copy = () => {
    const text = editor.state.selection.ranges.map(range => editor.state.sliceDoc(range.from, range.to)).join('\n')
    if (text) void clipboard.write(text).catch(() => {})
    return text
  }
  return {
    command: name => {
      switch (name) {
        case 'undo': return undo(editor)
        case 'redo': return redo(editor)
        case 'selectAll': return selectAll(editor)
        case 'comment': return toggleComment(editor)
        case 'foldAll': return foldAll(editor)
        case 'unfoldAll': return unfoldAll(editor)
        case 'rename': return renameOccurrences(editor)
        case 'gotoLine': return gotoLine(editor)
        case 'selectNext': return selectNextOccurrence(editor)
        case 'find': return openSearchPanel(editor)
        case 'end': return cursorDocEnd(editor)
        case 'copy': return Boolean(copy())
        case 'cut': {
          if (!copy() || editor.state.readOnly) return false
          editor.dispatch(editor.state.replaceSelection(''), { userEvent: 'delete.cut' })
          return true
        }
      }
    },
    tidy: ({ trim, finalNewline }) => {
      if (editor.state.readOnly) return null
      const changes: { from: number; to?: number; insert?: string }[] = []
      const doc = editor.state.doc
      const heads = new Set(editor.state.selection.ranges.map(range => doc.lineAt(range.head).number))
      if (trim) for (let number = 1; number <= doc.lines; number++) {
        const line = doc.line(number)
        const match = /[ \t]+$/.exec(line.text)
        // Leave the line being typed on alone, so the caret doesn't jump back.
        if (match && !(heads.has(number) && editor.hasFocus && line.text.trim())) changes.push({ from: line.from + match.index, to: line.to })
      }
      if (finalNewline && doc.length && doc.sliceString(doc.length - 1) !== '\n') changes.push({ from: doc.length, insert: '\n' })
      if (changes.length) editor.dispatch({ changes, userEvent: 'input.tidy' })
      return editor.state.doc.toString()
    },
    insert: text => { if (!editor.state.readOnly) editor.dispatch(editor.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true }) },
    word: () => {
      const range = editor.state.selection.main
      const word = range.empty ? editor.state.wordAt(range.head) : range
      if (!word || word.from === word.to) return null
      return { text: editor.state.sliceDoc(word.from, word.to), line: editor.state.doc.lineAt(word.from).number }
    },
    capture: () => captureSelection(editor.state, path),
    focus: () => editor.focus(),
    find: () => { editor.focus(); openSearchPanel(editor) },
    selection: () => { const range = editor.state.selection.main; return range.empty ? '' : editor.state.sliceDoc(range.from, range.to) },
    reveal: () => editor.dispatch({ effects: EditorView.scrollIntoView(editor.state.selection.main.head, { y: 'center' }) }),
    jump: (line, column = 1, length = 0) => {
      const row = editor.state.doc.line(Math.max(1, Math.min(line, editor.state.doc.lines)))
      const anchor = Math.min(row.to, row.from + Math.max(0, column - 1))
      editor.dispatch({ selection: { anchor, head: Math.min(row.to, anchor + length) }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) })
      editor.focus()
    },
  }
}

async function runChecks(view: EditorView, props: Props): Promise<EditorDiagnostic[]> {
  const state = view.state
  const doc = state.doc
  const position = (line: number, column: number) => {
    const row = doc.line(Math.max(1, Math.min(line, doc.lines)))
    return Math.min(row.to, row.from + Math.max(0, column - 1))
  }
  const found: EditorDiagnostic[] = props.diagnostics.filter(item => item.path === props.path).map(item => {
    const from = position(item.line, item.column)
    const word = state.wordAt(from)
    return { from, to: word && word.from === from ? word.to : Math.min(doc.lineAt(from).to, from + 1), severity: item.severity, message: item.message, source: 'compiler' }
  })
  if (props.options.errors !== false) {
    if (props.check) {
      try {
        const issues = await props.check(doc.toString())
        for (const issue of issues) {
          const from = position(issue.line, issue.column)
          let to = issue.endLine && issue.endColumn ? position(issue.endLine, issue.endColumn) : from
          if (to <= from) { const word = state.wordAt(from); to = word && word.from <= from && word.to > from ? word.to : Math.min(doc.lineAt(from).to, from + 1) }
          if (to <= from) to = Math.min(doc.length, from + 1)
          found.push({ from, to, severity: issue.severity, message: issue.message, source: 'python' })
        }
      } catch { /* the checker is optional */ }
    } else found.push(...syntaxErrors(state))
  }
  if (view.state.doc === doc) props.onIssues?.(found.map(item => {
    const line = doc.lineAt(item.from)
    return { line: line.number, column: item.from - line.from + 1, severity: item.severity === 'hint' ? 'info' : item.severity, message: item.message, source: item.source ?? '' }
  }))
  return found
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
      // Edits above a breakpoint move it; tell the owner where it went.
      if (update.docChanged && update.startState.field(breakpointField, false)?.size) {
        const before = breakpointLines(update.startState).join(), after = breakpointLines(update.state)
        if (before !== after.join()) callbacks.current.onBreakpoints?.(after)
      }
      if (update.selectionSet || update.docChanged) callbacks.current.onCursor(onCursor(update.view))
      if (update.focusChanged && !update.view.hasFocus) callbacks.current.onBlur?.()
    })
    const base = [setup(), configuration.of(configure(current.options, current.path)), lintGutter(),
      EditorView.contentAttributes.of({ 'aria-label': current.diff ? 'File diff' : current.path, spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' })]
    const live = current.diff ? [] : [
      breakpointGutter(line => {
        const lines = view.current ? breakpointLines(view.current.state) : []
        callbacks.current.onBreakpoints?.(lines.includes(line) ? lines.filter(item => item !== line) : [...lines, line])
      }),
      changeGutter,
      inlineSuggestions(() => callbacks.current.suggest),
      linter(view => runChecks(view, callbacks.current), { delay: 650 }),
      // Alt+click adds a cursor; Ctrl/Cmd+click goes to the definition, as in other editors.
      EditorView.clickAddsSelectionRange.of(event => event.altKey),
      EditorView.domEventHandlers({
        mousedown: (event, view) => {
          if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (position === null) return false
          event.preventDefault()
          view.dispatch({ selection: { anchor: position } })
          callbacks.current.onDefinition?.()
          return true
        },
      }),
    ]
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

    const extensions: Extension[] = [...base, ...live, listener]
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
    definitionHandlers.set(editor, () => callbacks.current.onDefinition?.())
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

  const options = props.options
  useEffect(() => {
    view.current?.dispatch({ effects: configuration.reconfigure(configure(props.options, props.path)) })
  }, [options.wrap, options.lineNumbers, options.highlightLine, options.tabSize, options.autocomplete, options.occurrences, options.whitespace,
    options.indentGuides, options.closeBrackets, options.scrollPastEnd, options.cursorBlink, options.folding])

  useEffect(() => {
    const editor = view.current
    if (!editor || props.diff) return
    editor.dispatch({ effects: setBase.of(props.options.changes === false ? null : props.base ?? null) })
  }, [props.base, props.diff, props.path, options.changes])

  const breakKey = (props.breakpoints ?? []).join(',')
  useEffect(() => {
    const editor = view.current
    if (!editor || props.diff) return
    if (breakpointLines(editor.state).join(',') !== breakKey) editor.dispatch({ effects: setBreakpoints.of(props.breakpoints ?? []) })
  }, [breakKey, props.diff, props.path])
  useEffect(() => {
    const editor = view.current
    if (!editor || props.diff) return
    const line = props.debugLine ?? null
    editor.dispatch({ effects: [setDebugLine.of(line), ...(line && line <= editor.state.doc.lines ? [EditorView.scrollIntoView(editor.state.doc.line(line).from, { y: 'center' })] : [])] })
  }, [props.debugLine, props.diff, props.path])

  // Compiler results and the error setting feed the same checker; re-run it when they change.
  useEffect(() => { if (view.current && !props.diff) forceLinting(view.current) }, [props.diagnostics, props.diff, props.path, options.errors])

  return <div className={'editor-host' + (split ? ' split-diff' : '')} ref={host} onContextMenu={event => {
    const editor = view.current
    if (!editor || !props.onContextMenu || !(event.target as Element).closest('.cm-content, .cm-gutters')) return
    event.preventDefault()
    // Right-clicking outside the selection moves the caret there first.
    const position = editor.posAtCoords({ x: event.clientX, y: event.clientY })
    if (position !== null && !editor.state.selection.ranges.some(range => position >= range.from && position <= range.to)) editor.dispatch({ selection: { anchor: position } })
    editor.focus()
    props.onContextMenu(event)
  }} />
}

/** Highlighted HTML for a code block (used by the Markdown preview). Unknown languages come back escaped and plain. */
export function highlightToHtml(code: string, languageName: string) {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const alias: Record<string, string> = { python: 'py', py: 'py', js: 'js', javascript: 'js', ts: 'ts', typescript: 'ts', tsx: 'tsx', jsx: 'jsx', java: 'java', json: 'json', html: 'html', css: 'css', rust: 'rs', rs: 'rs', go: 'go', c: 'c', cpp: 'cpp', 'c++': 'cpp', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', yaml: 'yml', yml: 'yml', toml: 'toml', sql: 'sql', xml: 'xml', kotlin: 'kt', ruby: 'rb', powershell: 'ps1', md: 'md', markdown: 'md' }
  const found = mode('x.' + (alias[languageName.toLowerCase()] ?? languageName.toLowerCase()))
  if (!found) return escape(code)
  const loaded = found.load()
  const parser = loaded instanceof LanguageSupport ? loaded.language.parser : loaded instanceof Language ? loaded.parser : null
  if (!parser) return escape(code)
  let html = ''
  highlightCode(code, parser.parse(code), tokenNames, (text, classes) => {
    html += classes ? `<span class="tok-${classes.split(' ')[0]}">${escape(text)}</span>` : escape(text)
  }, () => { html += '\n' })
  return html
}
