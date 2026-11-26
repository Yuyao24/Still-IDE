import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { highlightToHtml } from './Editor'

export type DocKind = 'markdown' | 'text' | 'tex' | 'svg' | 'notebook'

export function docKind(path: string): DocKind | null {
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (extension === 'md' || extension === 'markdown' || extension === 'mdx') return 'markdown'
  if (extension === 'txt' || extension === 'text') return 'text'
  if (extension === 'tex' || extension === 'latex' || extension === 'ltx') return 'tex'
  if (extension === 'svg') return 'svg'
  if (extension === 'ipynb') return 'notebook'
  return null
}

/** Markdown as HTML. With `lines`, each top-level block carries the source line it starts on
 *  (data-line), so a side-by-side preview can follow the editor. */
export function renderMarkdown(source: string, lines = false) {
  let raw: string
  if (lines) {
    const tokens = marked.lexer(source, { gfm: true, breaks: false })
    let line = 1
    raw = tokens.map(token => {
      const start = line
      line += (token.raw.match(/\n/g) ?? []).length
      if (token.type === 'space') return ''
      const one = Object.assign([token], { links: tokens.links }) as unknown as Parameters<typeof marked.parser>[0]
      return `<div data-line="${start}">${marked.parser(one, { gfm: true, breaks: false, async: false })}</div>`
    }).join('')
  } else raw = marked.parse(source, { gfm: true, breaks: false, async: false }) as string
  const html = DOMPurify.sanitize(raw, { ADD_ATTR: ['data-line'] })
  const template = document.createElement('template')
  template.innerHTML = html
  // Local images can't be shown in the preview (the app only loads its own files); show the alt text instead.
  template.content.querySelectorAll('img').forEach(image => {
    if ((image.getAttribute('src') ?? '').startsWith('data:image/')) return
    const note = document.createElement('span')
    note.className = 'doc-image'
    note.textContent = 'Image: ' + (image.getAttribute('alt') || image.getAttribute('src') || 'untitled')
    image.replaceWith(note)
  })
  template.content.querySelectorAll('input[type="checkbox"]').forEach(box => box.setAttribute('disabled', ''))
  // Mermaid diagrams are drawn after the page shows them (the library loads only when needed).
  template.content.querySelectorAll('pre code.language-mermaid').forEach(block => {
    const holder = document.createElement('div')
    holder.className = 'doc-mermaid'
    holder.setAttribute('data-mermaid', block.textContent ?? '')
    holder.textContent = 'Drawing diagram…'
    block.parentElement!.replaceWith(holder)
  })
  // Fenced code blocks get the same colours as the editor.
  template.content.querySelectorAll('pre code[class*="language-"]').forEach(block => {
    const language = [...block.classList].find(name => name.startsWith('language-'))?.slice(9) ?? ''
    block.innerHTML = highlightToHtml(block.textContent ?? '', language)
  })
  return template.innerHTML
}

let mermaidCount = 0
/** Draws the Mermaid diagrams in a rendered document. */
async function drawDiagrams(root: HTMLElement) {
  const pending = [...root.querySelectorAll<HTMLElement>('.doc-mermaid[data-mermaid]')]
  if (!pending.length) return
  const { default: mermaid } = await import('mermaid')
  const dark = document.documentElement.classList.contains('theme-dark')
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', fontFamily: 'inherit', htmlLabels: false, flowchart: { htmlLabels: false } })
  for (const holder of pending) {
    const source = holder.getAttribute('data-mermaid') ?? ''
    holder.removeAttribute('data-mermaid')
    try {
      const { svg } = await mermaid.render('still-mermaid-' + ++mermaidCount, source)
      holder.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
    } catch (error) {
      holder.classList.add('is-error')
      holder.textContent = 'This diagram has a mistake: ' + String((error as Error)?.message ?? error).split('\n')[0]
    }
  }
}

/** Rendered view of a Markdown or plain text file. Links never navigate the app window. Beside the
 *  editor, it follows the editor's top line (`syncLine`); double-clicking a block jumps there. */
export function Preview({ text, kind, onLink, syncLine, onJumpLine }: { text: string; kind: DocKind; onLink: (href: string) => void; syncLine?: number; onJumpLine?: (line: number) => void }) {
  const follows = syncLine !== undefined
  const html = useMemo(() => kind === 'markdown' ? renderMarkdown(text, follows) : '', [text, kind, follows])
  const words = useMemo(() => (text.match(/\S+/g) ?? []).length, [text])
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { if (box.current) void drawDiagrams(box.current) }, [html])
  useEffect(() => {
    const scroller = box.current
    if (!scroller || syncLine === undefined) return
    const blocks = [...scroller.querySelectorAll<HTMLElement>('[data-line]')]
    if (!blocks.length) return
    // The block the editor's top line is in, and how far into it.
    let index = blocks.findIndex(block => Number(block.dataset.line) > syncLine) - 1
    if (index === -2) index = blocks.length - 1
    if (index < 0) { scroller.scrollTo({ top: 0 }); return }
    const block = blocks[index], next = blocks[index + 1]
    const from = Number(block.dataset.line), to = next ? Number(next.dataset.line) : from + 1
    const share = Math.min(1, Math.max(0, (syncLine - from) / Math.max(1, to - from)))
    const top = block.offsetTop + share * ((next?.offsetTop ?? block.offsetTop + block.offsetHeight) - block.offsetTop) - 16
    scroller.scrollTo({ top: Math.max(0, top) })
  }, [syncLine, html])
  return <div ref={box} className="doc-preview" onDoubleClick={event => {
    const block = (event.target as Element).closest<HTMLElement>('[data-line]')
    if (block && onJumpLine) onJumpLine(Number(block.dataset.line))
  }} onClick={event => {
    const link = (event.target as Element).closest('a')
    if (!link) return
    event.preventDefault()
    const href = link.getAttribute('href')
    if (href) onLink(href)
  }}>
    {kind === 'markdown'
      ? <article className="doc-body doc-markdown" dangerouslySetInnerHTML={{ __html: html }} />
      : <article className="doc-body doc-text">{text}</article>}
    <p className="doc-count">{words.toLocaleString()} {words === 1 ? 'word' : 'words'} · {Math.max(1, Math.round(words / 230))} min read</p>
  </div>
}
