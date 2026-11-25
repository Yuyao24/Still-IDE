// CodeMirror's forceLinting only speeds up a lint pass that is already scheduled; once a pass has
// finished it does nothing. New results from outside the editor (compiler output, a language
// server) need a fresh pass, so this asks for one and then runs it straight away.
import { StateEffect } from '@codemirror/state'
import type { EditorView, ViewUpdate } from '@codemirror/view'
import { forceLinting } from '@codemirror/lint'

const relintEffect = StateEffect.define<null>()
export const needsRefresh = (update: ViewUpdate) => update.transactions.some(transaction => transaction.effects.some(effect => effect.is(relintEffect)))
export function relint(view: EditorView) {
  view.dispatch({ effects: relintEffect.of(null) })
  forceLinting(view)
}
