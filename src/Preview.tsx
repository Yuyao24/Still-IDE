import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export type DocKind = 'markdown' | 'text'

export function docKind(path: string): DocKind | null {
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (extension === 'md' || extension === 'markdown' || extension === 'mdx') return 'markdown'
  if (extension === 'txt' || extension === 'text') return 'text'
  return null
}

function renderMarkdown(source: string) {
  const html = DOMPurify.sanitize(marked.parse(source, { gfm: true, breaks: false, async: false }) as string)
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
  return template.innerHTML
}

/** Rendered view of a Markdown or plain text file. Links never navigate the app window. */
export function Preview({ text, kind, onLink }: { text: string; kind: DocKind; onLink: (href: string) => void }) {
  const html = useMemo(() => kind === 'markdown' ? renderMarkdown(text) : '', [text, kind])
  const words = useMemo(() => (text.match(/\S+/g) ?? []).length, [text])
  return <div className="doc-preview" onClick={event => {
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
