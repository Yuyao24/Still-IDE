// Git in the editor: who last changed the line you're on (at the end of the line, like
// GitLens), optionally for every line in the gutter, and buttons to resolve merge
// conflicts (<<<<<<< … ======= … >>>>>>>) without editing the markers by hand.
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, GutterMarker, ViewPlugin, type ViewUpdate, WidgetType, gutter } from '@codemirror/view'
import type { BlameLine } from './bridge'

export const setBlame = StateEffect.define<{ lines: BlameLine[]; mode: 'off' | 'line' | 'all' } | null>()
const blameField = StateField.define<{ byLine: Map<number, BlameLine>; mode: 'off' | 'line' | 'all' } | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setBlame)) return effect.value ? { byLine: new Map(effect.value.lines.map(line => [line.line, line])), mode: effect.value.mode } : null
    return value
  },
})

const uncommitted = (line: BlameLine) => /^0+$/.test(line.hash)
function ago(seconds: number) {
  const days = Math.floor((Date.now() / 1000 - seconds) / 86400)
  if (days < 1) { const hours = Math.floor((Date.now() / 1000 - seconds) / 3600); return hours < 1 ? 'just now' : hours + (hours === 1 ? ' hour ago' : ' hours ago') }
  if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago')
  const months = Math.floor(days / 30)
  return months < 12 ? months + (months === 1 ? ' month ago' : ' months ago') : Math.floor(months / 12) + (months < 24 ? ' year ago' : ' years ago')
}
export function describeBlame(line: BlameLine) {
  return uncommitted(line) ? 'Not committed yet' : `${line.author}, ${ago(line.time)} · ${line.summary}`
}

// The note for the caret's line is drawn after the text with CSS (not a widget in the line), so it
// never moves the caret or catches a click. It appears once the caret rests on a line with text,
// and stays away from the line being typed in until the caret moves to another line.
const showBlame = StateEffect.define<number | null>()
const currentLineBlame = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none
  shown: number | null = null
  edited: number | null = null
  timer: ReturnType<typeof setTimeout> | undefined
  constructor(readonly view: EditorView) { this.schedule() }
  update(update: ViewUpdate) {
    let changed = false
    for (const transaction of update.transactions) for (const effect of transaction.effects) if (effect.is(showBlame)) { this.shown = effect.value; changed = true }
    if (update.docChanged) { this.edited = update.state.doc.lineAt(update.state.selection.main.head).number; this.shown = null; changed = true }
    if (update.selectionSet && !changed) {
      const line = update.state.doc.lineAt(update.state.selection.main.head).number
      if (line !== this.shown) { this.shown = null; changed = true }
      if (line !== this.edited) this.edited = null
    }
    if (update.selectionSet || update.docChanged) this.schedule()
    if (changed || update.startState.field(blameField, false) !== update.state.field(blameField, false)) this.decorations = this.build(update.state)
  }
  schedule() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const state = this.view.state
      const blame = state.field(blameField, false)
      if (!blame || blame.mode !== 'line' || !state.selection.main.empty) return
      const line = state.doc.lineAt(state.selection.main.head)
      if (line.number === this.edited || !line.text.trim() || !blame.byLine.has(line.number) || this.shown === line.number) return
      this.view.dispatch({ effects: showBlame.of(line.number) })
    }, 650)
  }
  build(state: EditorState) {
    const blame = state.field(blameField, false)
    if (!blame || blame.mode !== 'line' || this.shown === null || this.shown > state.doc.lines) return Decoration.none
    const info = blame.byLine.get(this.shown)
    if (!info) return Decoration.none
    const line = state.doc.line(this.shown)
    return Decoration.set([Decoration.line({ class: 'cm-blame-line', attributes: { 'data-blame': describeBlame(info), title: info.hash.slice(0, 8) } }).range(line.from)])
  }
  destroy() { clearTimeout(this.timer) }
}, { decorations: plugin => plugin.decorations })

class BlameMarker extends GutterMarker {
  constructor(readonly text: string, readonly title: string, readonly fresh: boolean) { super() }
  eq(other: BlameMarker) { return other.text === this.text && other.fresh === this.fresh }
  toDOM() { const node = document.createElement('span'); node.textContent = this.text; node.title = this.title; if (this.fresh) node.className = 'is-fresh'; return node }
}
/** The whole-file blame column; added only while it's switched on, so it takes no room otherwise. */
export const blameGutter = gutter({
  class: 'cm-blame-gutter',
  lineMarker(view, block) {
    const blame = view.state.field(blameField, false)
    if (!blame || blame.mode !== 'all') return null
    const number = view.state.doc.lineAt(block.from).number
    const info = blame.byLine.get(number)
    if (!info) return null
    const previous = blame.byLine.get(number - 1)
    // Show the author once per run of lines from the same commit.
    if (previous && previous.hash === info.hash) return new BlameMarker('', describeBlame(info), false)
    const text = uncommitted(info) ? 'not committed' : (new Date(info.time * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }) + '  ' + info.author.split(' ')[0])
    return new BlameMarker(text, describeBlame(info), Date.now() / 1000 - info.time < 7 * 86400)
  },
  lineMarkerChange: update => update.startState.field(blameField, false) !== update.state.field(blameField, false),
  initialSpacer: () => new BlameMarker('Mar 30, 26  Someone', '', false),
})

// ---- Merge conflicts ----
interface Conflict { start: number; mid: number; end: number; base: number | null }
function findConflicts(state: EditorState): Conflict[] {
  const doc = state.doc
  if (doc.length > 3_000_000) return []
  const text = doc.toString()
  if (!text.includes('<<<<<<<')) return []
  const found: Conflict[] = []
  let open: Partial<Conflict> | null = null
  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number).text
    if (line.startsWith('<<<<<<<')) open = { start: number, base: null }
    else if (open && line.startsWith('|||||||')) open.base = number
    else if (open && line.startsWith('=======')) open.mid = number
    else if (open && open.mid && line.startsWith('>>>>>>>')) { found.push({ start: open.start!, mid: open.mid, end: number, base: open.base ?? null }); open = null }
  }
  return found
}
function lines(state: EditorState, from: number, to: number) {
  const out: string[] = []
  for (let number = from; number <= to; number++) out.push(state.doc.line(number).text)
  return out
}
function resolve(view: EditorView, conflict: Conflict, keep: 'current' | 'incoming' | 'both') {
  const state = view.state
  const current = lines(state, conflict.start + 1, (conflict.base ?? conflict.mid) - 1)
  const incoming = lines(state, conflict.mid + 1, conflict.end - 1)
  const chosen = keep === 'current' ? current : keep === 'incoming' ? incoming : [...current, ...incoming]
  const from = state.doc.line(conflict.start).from
  const endLine = state.doc.line(conflict.end)
  const to = endLine.number < state.doc.lines ? endLine.to + 1 : endLine.to
  view.dispatch({ changes: { from, to, insert: chosen.length ? chosen.join('\n') + (endLine.number < state.doc.lines ? '\n' : '') : '' }, userEvent: 'input.resolve' })
  view.focus()
}
class ConflictBar extends WidgetType {
  constructor(readonly conflict: Conflict, readonly current: string, readonly incoming: string) { super() }
  eq(other: ConflictBar) { return other.conflict.start === this.conflict.start && other.conflict.end === this.conflict.end }
  toDOM(view: EditorView) {
    const bar = document.createElement('div')
    bar.className = 'cm-conflict-bar'
    const add = (label: string, keep: 'current' | 'incoming' | 'both') => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.onmousedown = event => { event.preventDefault(); resolve(view, this.conflict, keep) }
      bar.appendChild(button)
    }
    add('Accept current' + (this.current ? ' (' + this.current + ')' : ''), 'current')
    add('Accept incoming' + (this.incoming ? ' (' + this.incoming + ')' : ''), 'incoming')
    add('Accept both', 'both')
    return bar
  }
  ignoreEvent() { return true }
}
// Block widgets (the button bar above each conflict) have to come from state, not a view plugin.
function conflictDecorationsFor(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const conflict of findConflicts(state)) {
    const head = state.doc.line(conflict.start)
    const tail = state.doc.line(conflict.end)
    builder.add(head.from, head.from, Decoration.widget({ widget: new ConflictBar(conflict, head.text.slice(7).trim(), tail.text.slice(7).trim()), side: -1, block: true }))
    for (let number = conflict.start; number <= conflict.end; number++) {
      const line = state.doc.line(number)
      const marker = number === conflict.start || number === conflict.mid || number === conflict.end || number === conflict.base
      const cls = marker ? 'cm-conflict-marker' : number < (conflict.base ?? conflict.mid) ? 'cm-conflict-current' : number > conflict.mid ? 'cm-conflict-incoming' : 'cm-conflict-base'
      builder.add(line.from, line.from, Decoration.line({ class: cls }))
    }
  }
  return builder.finish()
}
const conflictDecorations = StateField.define<DecorationSet>({
  create: state => conflictDecorationsFor(state),
  update: (value, transaction) => transaction.docChanged ? conflictDecorationsFor(transaction.state) : value,
  provide: field => EditorView.decorations.from(field),
})

export function conflictCount(state: EditorState) { return findConflicts(state).length }

export const gitLines: Extension = [blameField, currentLineBlame, conflictDecorations]
