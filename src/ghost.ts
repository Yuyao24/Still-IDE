// AI inline suggestions, like GitHub Copilot: after a short pause in typing, grey "ghost"
// text appears after the caret (from the rest of a line to a whole function). Tab accepts
// it, Ctrl+→ accepts the next word, Esc dismisses it, and typing what it shows keeps the rest.
import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type ViewUpdate } from '@codemirror/view'
import { completionStatus } from '@codemirror/autocomplete'

export type Suggest = (prefix: string, suffix: string, signal: AbortSignal) => Promise<string>
interface Ghost { pos: number; text: string }

const setGhost = StateEffect.define<Ghost | null>()
const pending = StateEffect.define<boolean>()

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super() }
  eq(other: GhostWidget) { return other.text === this.text }
  toDOM() {
    const node = document.createElement('span')
    node.className = 'cm-ghost'
    node.textContent = this.text
    node.setAttribute('aria-hidden', 'true')
    return node
  }
  ignoreEvent() { return false }
}

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setGhost)) return effect.value
    if (!value) return null
    if (transaction.docChanged) {
      // Typing exactly what the suggestion shows uses it up; anything else drops it.
      let next: Ghost | null = null, count = 0
      transaction.changes.iterChanges((fromA, toA, _fromB, toB, inserted) => {
        count++
        const typed = inserted.toString()
        if (fromA === value.pos && toA === fromA && typed && value.text.startsWith(typed) && typed.length < value.text.length) next = { pos: toB, text: value.text.slice(typed.length) }
      })
      return count === 1 ? next : null
    }
    if (transaction.selection && transaction.state.selection.main.head !== value.pos) return null
    return value
  },
  provide: field => EditorView.decorations.from(field, value => value
    ? Decoration.set([Decoration.widget({ widget: new GhostWidget(value.text), side: 1 }).range(value.pos)])
    : Decoration.none),
})

const waiting = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(pending)) return effect.value
    return transaction.docChanged ? false : value
  },
  provide: field => EditorView.contentAttributes.from(field, (on): Record<string, string> => on ? { 'data-suggesting': 'true' } : {}),
})

function accept(view: EditorView, part?: 'word') {
  const ghost = view.state.field(ghostField, false)
  if (!ghost || completionStatus(view.state) === 'active') return false
  let text = ghost.text
  if (part === 'word') text = /^\s*[\w$]+|^\s*[^\w\s]+|^\s+/.exec(text)?.[0] ?? text
  view.dispatch({
    changes: { from: ghost.pos, insert: text },
    selection: { anchor: ghost.pos + text.length },
    effects: text === ghost.text ? setGhost.of(null) : setGhost.of({ pos: ghost.pos + text.length, text: ghost.text.slice(text.length) }),
    userEvent: 'input.complete',
    scrollIntoView: true,
  })
  return true
}

/** Inline suggestions from `source()`; when it returns null the feature is off. */
export function inlineSuggestions(source: () => Suggest | null | undefined): Extension {
  const fetcher = ViewPlugin.fromClass(class {
    timer: ReturnType<typeof setTimeout> | undefined
    controller: AbortController | null = null
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      const typed = update.transactions.some(transaction => (transaction.isUserEvent('input') && !transaction.isUserEvent('input.paste')) || transaction.isUserEvent('delete.backward'))
      if (update.docChanged && typed) this.schedule()
      else if (update.docChanged || (update.selectionSet && !update.state.field(ghostField, false))) this.cancel()
    }
    cancel() {
      clearTimeout(this.timer)
      this.controller?.abort()
      this.controller = null
    }
    schedule() {
      this.cancel()
      if (!source()) return
      this.timer = setTimeout(() => { void this.request() }, 450)
    }
    async request() {
      const suggest = source()
      const view = this.view
      const state = view.state
      const range = state.selection.main
      if (!suggest || !range.empty || state.selection.ranges.length > 1 || state.field(ghostField, false)) return
      const head = range.head
      const line = state.doc.lineAt(head)
      // Only at the end of what's typed on the line (closing brackets and spaces may follow).
      if (/[\w$]/.test(line.text.slice(head - line.from))) return
      const prefix = state.sliceDoc(Math.max(0, head - 6000), head)
      if (!prefix.trim()) return
      const suffix = state.sliceDoc(head, Math.min(state.doc.length, head + 2000))
      const controller = new AbortController()
      this.controller = controller
      const doc = state.doc
      view.dispatch({ effects: pending.of(true) })
      try {
        const text = await suggest(prefix, suffix, controller.signal)
        if (controller.signal.aborted || view.state.doc !== doc || view.state.selection.main.head !== head) return
        view.dispatch({ effects: [pending.of(false), setGhost.of(text.trim() ? { pos: head, text } : null)] })
      } catch {
        if (!controller.signal.aborted && view.state.doc === doc) view.dispatch({ effects: pending.of(false) })
      } finally {
        if (this.controller === controller) this.controller = null
      }
    }
    destroy() { this.cancel() }
  })
  return [
    ghostField, waiting, fetcher,
    Prec.highest(keymap.of([
      { key: 'Tab', run: view => accept(view) },
      { key: 'Mod-ArrowRight', run: view => accept(view, 'word') },
      { key: 'Escape', run: view => { if (!view.state.field(ghostField, false)) return false; view.dispatch({ effects: setGhost.of(null) }); return true } },
    ])),
  ]
}
