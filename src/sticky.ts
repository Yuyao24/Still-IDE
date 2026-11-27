// Sticky header: while you're inside a function, class or block whose first line has scrolled
// out of view, that line stays pinned at the top of the editor (up to three levels). Click one
// to go to it; right-click to turn the header off. Works from indentation, so it suits every
// language. It counts the lines it covers itself, and the innermost line slides away as its
// block ends.
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
      this.dom.addEventListener('contextmenu', event => {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent('still-sticky-menu', { detail: { x: event.clientX, y: event.clientY } }))
      })
      this.dom.addEventListener('mousedown', event => {
        if (event.button !== 0) return
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-line]')
        if (!row) return
        event.preventDefault()
        const line = view.state.doc.line(Number(row.dataset.line))
        view.dispatch({ selection: { anchor: line.from + (line.text.length - line.text.trimStart().length) }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 4 }) })
        view.focus()
      })
      view.dom.appendChild(this.dom)
      // Every scroll, not only when CodeMirror's viewport moves, so the bar keeps up line by line.
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
      this.measure()
    }
    onScroll = () => this.measure()
    update(update: ViewUpdate) { if (update.viewportChanged || update.docChanged || update.geometryChanged) this.measure() }
    measure() {
      this.view.requestMeasure({
        read: view => {
          const lineHeight = view.defaultLineHeight
          const doc = view.state.doc
          const unit = Math.max(1, getIndentUnit(view.state))
          // Where the visible area starts, in document coordinates (padding above the first line excluded).
          const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop
          const none = { shown: [] as number[], contentLeft: 0, lineHeight, gutter: 0, shift: 0 }
          // At (or within a line of) the top there's nothing scrolled away to show.
          if (top < lineHeight * 0.5) return none
          /** The lines that open the blocks around the line at this height, outermost first. */
          const headersAt = (height: number) => {
            const first = doc.lineAt(view.lineBlockAtHeight(Math.min(height, view.contentHeight - 1)).from)
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
            return headers.slice(-3)
          }
          const blockEnd = (number: number) => {
            const indent = indentOf(doc.line(number).text, unit)
            let end = number + 1
            while (end <= doc.lines && (!doc.line(end).text.trim() || indentOf(doc.line(end).text, unit) > indent)) end++
            return end <= doc.lines ? view.lineBlockAt(doc.line(end).from).top : Infinity
          }
          // Start from the blocks around the first visible line, then add blocks whose first line
          // has gone under the bar itself (the bar covers lines too).
          let shown = headersAt(top + 2)
          for (let round = 0; round < 3; round++) {
            const below = headersAt(top + shown.length * lineHeight + 2)
            if (below.length <= shown.length) break
            shown = below
          }
          // A block that ends above its own row isn't shown; the innermost one slides up and out
          // as its block ends, instead of jumping.
          let shift = 0
          while (shown.length) {
            const rows = shown.length
            const endTop = blockEnd(shown[rows - 1])
            if (endTop <= top + (rows - 1) * lineHeight + 1) { shown = shown.slice(0, -1); continue }
            if (endTop < top + rows * lineHeight) shift = top + rows * lineHeight - endTop
            break
          }
          // Measured without the horizontal scroll, so the bar doesn't slide sideways.
          const contentLeft = view.contentDOM.getBoundingClientRect().left + view.scrollDOM.scrollLeft - view.dom.getBoundingClientRect().left
          return { shown, contentLeft, lineHeight, gutter: view.dom.querySelector('.cm-gutters')?.getBoundingClientRect().width ?? 0, shift }
        },
        write: ({ shown, contentLeft, lineHeight, gutter, shift }) => {
          const key = shown.join(',') + '|' + Math.round(contentLeft)
          if (key !== this.shown) {
            this.shown = key
            this.dom.style.display = shown.length ? '' : 'none'
            this.dom.style.setProperty('--sticky-left', contentLeft + 'px')
            this.dom.style.setProperty('--sticky-gutter', gutter + 'px')
            this.dom.innerHTML = shown.map(number => {
              const text = this.view.state.doc.line(number).text
              return `<div class="cm-sticky-line" data-line="${number}" style="height:${lineHeight}px"><span class="cm-sticky-number">${number}</span><span class="cm-sticky-code">${highlight(text)}</span></div>`
            }).join('')
          }
          // The innermost line slides up under the one above; the bar shrinks with it.
          const last = this.dom.lastElementChild as HTMLElement | null
          if (last) last.style.transform = shift ? `translateY(${-shift}px)` : ''
          this.dom.style.height = shown.length ? shown.length * lineHeight - shift + 'px' : ''
          this.dom.dataset.shift = String(Math.round(shift))
        },
      })
    }
    destroy() { this.view.scrollDOM.removeEventListener('scroll', this.onScroll); this.dom.remove() }
  })
}
