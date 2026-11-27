// Spell check for prose: comments, docstrings and written strings in code, and the text of
// Markdown, LaTeX and plain text files. Misspelled words get a dotted underline; hovering one
// offers suggestions and Add to dictionary. The English dictionary (Hunspell, from SCOWL) loads
// only when a file needs it.
import { RangeSetBuilder, StateEffect, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, hoverTooltip, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

interface Checker { correct(word: string): boolean; suggest(word: string): string[]; add(word: string): unknown }
let loading: Promise<Checker> | null = null
let checker: Checker | null = null
const known = new Map<string, boolean>()
let added = new Set<string>()

function load(): Promise<Checker> {
  loading ??= Promise.all([import('nspell'), import('./spell/en.aff?raw'), import('./spell/en.dic?raw')]).then(([module, aff, dic]) => {
    checker = module.default({ aff: aff.default, dic: dic.default })
    for (const word of added) checker.add(word)
    return checker
  })
  return loading
}

/** Words you added (Settings keeps them); they count as correct everywhere. */
export function setSpellWords(words: string[]) {
  added = new Set(words.map(word => word.toLowerCase()))
  known.clear()
  if (checker) for (const word of added) checker.add(word)
}

function isCorrect(word: string) {
  if (!checker) return true
  const lower = word.toLowerCase()
  if (added.has(lower)) return true
  let result = known.get(word)
  if (result === undefined) {
    result = checker.correct(word) || checker.correct(lower)
    known.set(word, result)
  }
  return result
}

type Kind = 'code' | 'markdown' | 'latex' | 'text'
function kindOf(language: string): Kind | null {
  if (language === 'Markdown') return 'markdown'
  if (language === 'LaTeX') return 'latex'
  if (language === 'Plain Text') return 'text'
  if (['Python', 'Java', 'JavaScript', 'JavaScript JSX', 'TypeScript', 'TypeScript JSX', 'Rust', 'Go', 'C++', 'C#', 'Kotlin', 'Ruby', 'Shell', 'CSS', 'HTML', 'SQL', 'YAML', 'TOML', 'Groovy', 'PowerShell'].includes(language)) return 'code'
  return null
}

/** Ranges of prose to check in the visible part of the document. */
function proseRanges(view: EditorView, kind: Kind): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = []
  const tree = syntaxTree(view.state)
  for (const visible of view.visibleRanges) {
    if (kind === 'code') {
      tree.iterate({
        from: visible.from, to: visible.to,
        enter: node => {
          if (/Comment/.test(node.name)) { ranges.push({ from: node.from, to: node.to }); return false }
          // Strings that read like sentences (a space and letters), not keys, paths or formats.
          if (/^(String|TemplateString|Docstring)$/.test(node.name)) {
            const text = view.state.sliceDoc(node.from, Math.min(node.to, node.from + 400))
            if (/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(text) && !/^[^\s]*(\/|\\|\.[a-z]{2,4}\b)/.test(text.replace(/^[a-zA-Z]*["'`]+/, ''))) ranges.push({ from: node.from, to: node.to })
            return false
          }
          return undefined
        },
      })
    } else {
      // Markdown, LaTeX and text: everything except code, links and markup.
      const skip: { from: number; to: number }[] = []
      if (kind === 'markdown') tree.iterate({ from: visible.from, to: visible.to, enter: node => {
        if (/^(InlineCode|FencedCode|CodeBlock|URL|Autolink|HTMLTag|HTMLBlock|LinkLabel|CodeText|Comment)$/.test(node.name)) { skip.push({ from: node.from, to: node.to }); return false }
        return undefined
      } })
      let start = visible.from
      for (const gap of skip.sort((a, b) => a.from - b.from)) {
        if (gap.from > start) ranges.push({ from: start, to: gap.from })
        start = Math.max(start, gap.to)
      }
      if (start < visible.to) ranges.push({ from: start, to: visible.to })
    }
  }
  return ranges
}

/** Names used in the code itself (comments and strings left out), so a comment mentioning
 *  `total_price` or `getUser` isn't flagged. */
function codeWords(view: EditorView): Set<string> {
  const words = new Set<string>()
  const doc: Text = view.state.doc
  const end = Math.min(doc.length, 400_000)
  const prose: { from: number; to: number }[] = []
  syntaxTree(view.state).iterate({ from: 0, to: end, enter: node => {
    if (/Comment|String|Docstring/.test(node.name)) { prose.push({ from: node.from, to: node.to }); return false }
    return undefined
  } })
  let start = 0
  const add = (text: string) => { for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) words.add(match[0].toLowerCase()) }
  for (const range of prose) { if (range.from > start) add(doc.sliceString(start, range.from)); start = Math.max(start, range.to) }
  if (start < end) add(doc.sliceString(start, end))
  return words
}

const wordPattern = /[A-Za-z][A-Za-z']*[A-Za-z]/g
function misspellings(view: EditorView, kind: Kind, names: Set<string> | null): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const marks: { from: number; to: number }[] = []
  for (const range of proseRanges(view, kind)) {
    const text = view.state.sliceDoc(range.from, range.to)
    for (const match of text.matchAll(wordPattern)) {
      let word = match[0].replace(/'s$/i, '')
      const at = range.from + (match.index ?? 0)
      const before = text[(match.index ?? 0) - 1] ?? ''
      // Leave out short words, identifiers (camelCase, ALLCAPS), words joined to code or paths, LaTeX commands.
      if (word.length < 3 || word.length > 30 || /[A-Z]/.test(word.slice(1)) || /[\\@#$/._-]/.test(before) || /[0-9_]/.test(text[(match.index ?? 0) + match[0].length] ?? '')) continue
      if (kind === 'latex' && before === '\\') continue
      if (names?.has(word.toLowerCase())) continue
      word = word.replace(/'+$/, '')
      if (!isCorrect(word)) marks.push({ from: at, to: at + word.length })
    }
  }
  marks.sort((a, b) => a.from - b.from)
  let last = -1
  for (const mark of marks) { if (mark.from >= last) { builder.add(mark.from, mark.to, misspelled); last = mark.to } }
  return builder.finish()
}

const misspelled = Decoration.mark({ class: 'cm-misspelled' })
const refresh = StateEffect.define<null>()
// Repaints the marks just computed (CodeMirror skips a transaction with nothing in it).
const redraw = StateEffect.define<null>()

/** Spell checking for a file of this language; `onAdd` keeps a word for good. */
export function spellCheck(language: string, onAdd: (word: string) => void): Extension {
  const kind = kindOf(language)
  if (!kind) return []
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none
    timer = 0
    names: Set<string> | null = null
    constructor(readonly view: EditorView) {
      void load().then(() => this.schedule(0))
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.names = null
      if (update.docChanged || update.viewportChanged || update.transactions.some(tr => tr.effects.some(effect => effect.is(refresh)))) {
        // Keep marks in place while typing; check again once typing pauses.
        this.decorations = this.decorations.map(update.changes)
        this.schedule(update.docChanged ? 400 : 60)
      }
    }
    schedule(delay: number) {
      clearTimeout(this.timer)
      this.timer = window.setTimeout(() => {
        if (!checker) return
        if (kind === 'code' && !this.names) this.names = codeWords(this.view)
        this.decorations = misspellings(this.view, kind, kind === 'code' ? this.names : null)
        this.view.dispatch({ effects: redraw.of(null) })
      }, delay)
    }
    destroy() { clearTimeout(this.timer) }
  }, { decorations: plugin => plugin.decorations })

  const tooltip = hoverTooltip((view, pos) => {
    const found = view.plugin(plugin)
    if (!found || !checker) return null
    let hit: { from: number; to: number } | null = null
    found.decorations.between(pos, pos, (from, to) => { hit = { from, to } })
    if (!hit) return null
    const { from, to } = hit as { from: number; to: number }
    const word = view.state.sliceDoc(from, to)
    return {
      pos: from, end: to, above: true,
      create: () => {
        const dom = document.createElement('div')
        dom.className = 'cm-spell-tip'
        const title = document.createElement('div')
        title.className = 'cm-spell-title'
        title.textContent = 'Not in the dictionary: ' + word
        dom.appendChild(title)
        const list = document.createElement('div')
        list.className = 'cm-spell-options'
        const suggestions = checker!.suggest(word).slice(0, 6)
        // Keep the word's capitalisation when replacing.
        const shaped = (option: string) => word[0] === word[0].toUpperCase() ? option[0].toUpperCase() + option.slice(1) : option
        for (const option of suggestions) {
          const button = document.createElement('button')
          button.textContent = shaped(option)
          button.onmousedown = event => { event.preventDefault(); view.dispatch({ changes: { from, to, insert: shaped(option) }, userEvent: 'input.spell' }) }
          list.appendChild(button)
        }
        if (!suggestions.length) { const none = document.createElement('span'); none.textContent = 'No suggestions'; list.appendChild(none) }
        dom.appendChild(list)
        const add = document.createElement('button')
        add.className = 'cm-spell-add'
        add.textContent = 'Add to dictionary'
        add.onmousedown = event => {
          event.preventDefault()
          added.add(word.toLowerCase()); known.clear(); checker?.add(word)
          onAdd(word)
          view.dispatch({ effects: refresh.of(null) })
        }
        dom.appendChild(add)
        return { dom }
      },
    }
  }, { hoverTime: 350 })
  return [plugin, tooltip]
}

/** Where Add to dictionary saves words (Settings sets it). */
export const spellHook: { add: (word: string) => void } = { add: () => {} }
