// Sticky scroll: while you're inside a function, class or block whose first line has scrolled
// out of view, that line stays pinned at the top of the editor (up to three levels). Click one
// to go to it. Works from indentation, so it suits every language.
import { type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { getIndentUnit } from '@codemirror/language'

const header = /^\s*(async\s+def|def|class|function|async\s+function|public|private|protected|internal|static|abstract|final|override|fn|pub|func|impl|struct|enum|trait|interface|module|namespace|export|if|elif|else|for|while|with|try|catch|except|finally|switch|case|match|do|unless|begin|describe|it|test)\b|[{:]\s*(#.*|\/\/.*)?$/

function indentOf(text: string, unit: number) {
  let column = 0
  for (const char of text) { if (char === ' ') column++; else if (char === '\t') column += unit - (column % unit); else break }
  return column
}

export function stickyScroll(highlight: (line: string) => string, enabled: boolean): Extension {
  if (!enabled) return []
  return ViewPlugin.fromClass(class {
    dom: HTMLDivElement
    shown = ''
    constructor(readonly view: EditorView) {
      this.dom = document.createElement('div')
      this.dom.className = 'cm-sticky'
      this.dom.setAttribute('aria-hidden', 'true')
      this.dom.addEventListener('mousedown', event => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-line]')
        if (!row) return
        event.preventDefault()
        const line = view.state.doc.line(Number(row.dataset.line))
        view.dispatch({ selection: { anchor: line.from + (line.text.length - line.text.trimStart().length) }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 4 }) })
        view.focus()
      })
      view.dom.appendChild(this.dom)
      this.measure()
    }
    update(update: ViewUpdate) { if (update.viewportChanged || update.docChanged || update.geometryChanged) this.measure() }
    measure() {
      this.view.requestMeasure({
        read: view => {
          // Where the visible area starts, in document coordinates (padding above the first line excluded).
          const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop
          if (top <= 0) return { shown: [] as number[], contentLeft: 0, lineHeight: view.defaultLineHeight, gutter: 0 }
          const block = view.lineBlockAtHeight(top + 2)
          const doc = view.state.doc
          const first = doc.lineAt(block.from)
          const unit = Math.max(1, getIndentUnit(view.state))
          // The first visible line with text sets the depth; walk up for the lines that open its blocks.
          let probe = first.number
          while (probe < doc.lines && !doc.line(probe).text.trim()) probe++
          let limit = indentOf(doc.line(probe).text, unit)
          const headers: number[] = []
          for (let number = first.number - 1; number >= 1 && limit > 0 && headers.length < 6; number--) {
            const text = doc.line(number).text
            if (!text.trim()) continue
            const indent = indentOf(text, unit)
            if (indent < limit) {
              if (header.test(text)) headers.unshift(number)
              limit = indent
            }
          }
          const shown = headers.slice(-3)
          const contentLeft = view.contentDOM.getBoundingClientRect().left - view.dom.getBoundingClientRect().left
          return { shown, contentLeft, lineHeight: view.defaultLineHeight, gutter: view.dom.querySelector('.cm-gutters')?.getBoundingClientRect().width ?? 0 }
        },
        write: ({ shown, contentLeft, lineHeight, gutter }) => {
          const key = shown.join(',') + '|' + Math.round(contentLeft)
          if (key === this.shown) return
          this.shown = key
          this.dom.style.display = shown.length ? '' : 'none'
          this.dom.style.setProperty('--sticky-left', contentLeft + 'px')
          this.dom.style.setProperty('--sticky-gutter', gutter + 'px')
          this.dom.innerHTML = shown.map(number => {
            const text = this.view.state.doc.line(number).text
            return `<div class="cm-sticky-line" data-line="${number}" style="height:${lineHeight}px"><span class="cm-sticky-number">${number}</span><span class="cm-sticky-code">${highlight(text)}</span></div>`
          }).join('')
        },
      })
    }
    destroy() { this.dom.remove() }
  })
}
