// Viewers for files that aren't edited as code: PDFs (drawn with pdf.js, so they look the same
// on every platform), images, and LaTeX — compiled to PDF with the TeX installed on the machine,
// or, without one, a quick reading view with the maths typeset.
import { useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import DOMPurify from 'dompurify'
import { Minus, Plus, Scan } from 'lucide-react'
import { IconButton } from './ui'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type BinaryKind = 'pdf' | 'image'
export function binaryKind(path: string): BinaryKind | null {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  if (extension === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'].includes(extension)) return 'image'
  return null
}

export function fromBase64(text: string) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

// ---- PDF ----
interface PageBox { width: number; height: number }

export function PdfView({ data, label }: { data: Uint8Array | null; label?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [boxes, setBoxes] = useState<PageBox[]>([])
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [width, setWidth] = useState(800)
  const [page, setPage] = useState(1)
  const keep = useRef<{ top: number; height: number } | null>(null)
  const shown = useRef<pdfjs.PDFDocumentLoadingTask | null>(null)

  useEffect(() => {
    if (!data) return
    let cancelled = false
    setError(null)
    // pdf.js takes ownership of the buffer it is given, so hand it a copy.
    const task = pdfjs.getDocument({ data: data.slice() })
    task.promise.then(async loaded => {
      const sizes: PageBox[] = []
      for (let number = 1; number <= loaded.numPages && !cancelled; number++) {
        const viewport = (await loaded.getPage(number)).getViewport({ scale: 1 })
        sizes.push({ width: viewport.width, height: viewport.height })
      }
      if (cancelled) return
      // A recompiled document keeps its place.
      const scroller = host.current
      if (scroller && scroller.scrollHeight > scroller.clientHeight) keep.current = { top: scroller.scrollTop, height: scroller.scrollHeight }
      const previous = shown.current
      shown.current = task
      setDoc(loaded)
      setBoxes(sizes)
      if (previous) setTimeout(() => { void previous.destroy().catch(() => {}) }, 500)
    }).catch(problem => { if (!cancelled) setError(String((problem as Error)?.message ?? problem)) })
    return () => { cancelled = true; if (shown.current !== task) void task.destroy().catch(() => {}) }
  }, [data])
  useEffect(() => () => { void shown.current?.destroy().catch(() => {}) }, [])

  useEffect(() => {
    const element = host.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const scroller = host.current
    if (scroller && keep.current) {
      scroller.scrollTop = keep.current.top * (scroller.scrollHeight / Math.max(1, keep.current.height))
      keep.current = null
    }
  }, [boxes])

  const widest = Math.max(1, ...boxes.map(box => box.width))
  const scale = zoom === 'fit' ? Math.max(0.2, (width - 48) / widest) : zoom
  function onScroll() {
    const scroller = host.current
    if (!scroller) return
    const pages = [...scroller.querySelectorAll<HTMLElement>('.pdf-page')]
    const middle = scroller.scrollTop + scroller.clientHeight / 3
    const current = pages.findIndex(node => node.offsetTop + node.offsetHeight > middle)
    setPage(current < 0 ? pages.length : current + 1)
  }

  return <div className="pdf-view">
    <div className="pdf-scroll" ref={host} onScroll={onScroll}>
      {error ? <p className="doc-message">This PDF couldn't be shown: {error}</p>
        : !doc ? <p className="doc-message">Opening {label ?? 'the PDF'}…</p>
          : boxes.map((box, index) => <PdfPage key={index} doc={doc} number={index + 1} box={box} scale={scale} />)}
    </div>
    {doc && <div className="pdf-tools">
      <span className="pdf-page-count">{page} / {boxes.length}</span>
      <IconButton glyph={Minus} label="Zoom out" onClick={() => setZoom(Math.max(0.25, Math.round((scale - 0.15) * 20) / 20))} />
      <button className="pdf-zoom" onClick={() => setZoom(1)} title="Actual size">{Math.round(scale * 100)}%</button>
      <IconButton glyph={Plus} label="Zoom in" onClick={() => setZoom(Math.min(5, Math.round((scale + 0.15) * 20) / 20))} />
      <IconButton glyph={Scan} label="Fit width" className={zoom === 'fit' ? 'is-on' : ''} onClick={() => setZoom('fit')} />
    </div>}
  </div>
}

function PdfPage({ doc, number, box, scale }: { doc: pdfjs.PDFDocumentProxy; number: number; box: PageBox; scale: number }) {
  const holder = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(number <= 2)
  useEffect(() => {
    const element = holder.current
    if (!element) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setVisible(true) }, { rootMargin: '600px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible || !canvas.current) return
    let cancelled = false
    let task: ReturnType<pdfjs.PDFPageProxy['render']> | null = null
    void doc.getPage(number).then(pdfPage => {
      if (cancelled || !canvas.current) return
      const ratio = window.devicePixelRatio || 1
      const viewport = pdfPage.getViewport({ scale: scale * ratio })
      const target = canvas.current
      target.width = Math.floor(viewport.width)
      target.height = Math.floor(viewport.height)
      task = pdfPage.render({ canvas: target, viewport })
      task.promise.catch(() => {})
    })
    return () => { cancelled = true; task?.cancel() }
  }, [doc, number, scale, visible])
  return <div className="pdf-page" ref={holder} style={{ width: box.width * scale, height: box.height * scale }}>
    <canvas ref={canvas} style={{ width: '100%', height: '100%' }} aria-label={'Page ' + number} />
  </div>
}

// ---- Images ----
export function ImageView({ data, path }: { data: Uint8Array | null; path: string }) {
  const [fit, setFit] = useState(true)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const url = useMemo(() => {
    if (!data) return null
    const extension = path.split('.').at(-1)?.toLowerCase() ?? 'png'
    const type = extension === 'jpg' ? 'jpeg' : extension === 'ico' ? 'x-icon' : extension
    let binary = ''
    for (let index = 0; index < data.length; index += 0x8000) binary += String.fromCharCode(...data.subarray(index, index + 0x8000))
    return `data:image/${type};base64,${btoa(binary)}`
  }, [data, path])
  return <div className={'image-view' + (fit ? ' is-fit' : '')} onClick={() => setFit(value => !value)} title={fit ? 'Click for actual size' : 'Click to fit'}>
    {url ? <img src={url} alt={path} onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} /> : <p className="doc-message">Opening the image…</p>}
    {size && <span className="image-size">{size.width} × {size.height}{data ? ' · ' + (data.length / 1024).toFixed(data.length > 10240 ? 0 : 1) + ' KB' : ''}</span>}
  </div>
}

/** SVG files are edited as text; the preview draws them (scripts and event handlers removed). */
export function SvgView({ text }: { text: string }) {
  const clean = useMemo(() => DOMPurify.sanitize(text, { USE_PROFILES: { svg: true, svgFilters: true } }), [text])
  return <div className="image-view is-fit svg-view" dangerouslySetInnerHTML={{ __html: clean }} />
}

// ---- LaTeX ----
export interface TexResult { pdf: string | null; engine: string | null; seconds: number; errors: { line: number; message: string }[]; log: string; notes?: string[] }

export function TexPreview({ text, result, compiling, onJump }: { text: string; result: TexResult | null; compiling: boolean; onJump: (line: number) => void }) {
  const pdf = useMemo(() => result?.pdf ? fromBase64(result.pdf) : null, [result?.pdf])
  const rough = useMemo(() => result && !result.engine ? texToHtml(text) : '', [text, result])
  const failed = Boolean(result && result.engine && !pdf)
  return <div className="tex-view">
    <div className={'tex-status' + (result?.errors.length || failed ? ' is-error' : '')}>
      {compiling ? 'Compiling…'
        : !result ? 'Save to compile.'
          : !result.engine ? 'No TeX found: showing a quick reading view. Install MiKTeX, TeX Live or Tectonic for the real PDF (if you just installed one, save again).'
            : result.errors.length ? `${result.errors.length} ${result.errors.length === 1 ? 'error' : 'errors'} · ${result.engine}`
              : !pdf ? `${result.engine} stopped without making a PDF`
                : `Compiled with ${result.engine} in ${result.seconds.toFixed(1)} s`}
    </div>
    {result?.notes?.length ? <div className="tex-notes">{result.notes.map((note, index) => <p key={index}>{note}</p>)}</div> : null}
    {result?.errors.length ? <div className="tex-errors">{result.errors.slice(0, 20).map((item, index) => <button key={index} onClick={() => onJump(item.line)}><b>{item.line ? 'Line ' + item.line : 'TeX'}</b> {item.message}</button>)}</div> : null}
    {result && !result.engine
      ? <div className="doc-preview"><article className="doc-body doc-markdown tex-rough" dangerouslySetInnerHTML={{ __html: rough }} /></div>
      : pdf ? <PdfView data={pdf} label="the compiled PDF" />
        : compiling || !result ? <p className="doc-message">Compiling…</p>
          : result.errors.length ? <p className="doc-message">No PDF yet. Fix the errors above and save.</p>
            // No errors Still could read: show what TeX said, so the reason is visible.
            : <div className="tex-log"><p className="doc-message">Here is the end of what {result.engine} printed:</p><pre>{result.log || '(nothing)'}</pre></div>}
  </div>
}

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function math(source: string, display: boolean) {
  try { return katex.renderToString(source, { displayMode: display, throwOnError: false, output: 'html' }) } catch { return escape(source) }
}

/** A rough HTML reading of a LaTeX document: structure, emphasis, lists and typeset maths. */
export function texToHtml(source: string): string {
  let text = source.replace(/(^|[^\\])%.*$/gm, '$1')
  const title = /\\title\{([^}]*)\}/.exec(text)?.[1]
  const author = /\\author\{([^}]*)\}/.exec(text)?.[1]
  const body = /\\begin\{document\}([\s\S]*?)(\\end\{document\}|$)/.exec(text)
  text = body ? body[1] : text
  const stash: string[] = []
  const keep = (html: string) => { stash.push(html); return `\u0000${stash.length - 1}\u0000` }
  // Verbatim and maths first, so nothing inside them is touched.
  text = text.replace(/\\begin\{(verbatim|lstlisting|minted)\}(?:\[[^\]]*\])?(?:\{[^}]*\})?([\s\S]*?)\\end\{\1\}/g, (_m, _k, code: string) => keep(`<pre><code>${escape(code.replace(/^\n/, ''))}</code></pre>`))
  text = text.replace(/\\begin\{(equation|align|gather|multline|displaymath|eqnarray)(\*?)\}([\s\S]*?)\\end\{\1\2\}/g, (_m, kind: string, _s, body: string) => keep(math(kind === 'align' || kind === 'eqnarray' ? `\\begin{aligned}${body.replace(/\\label\{[^}]*\}/g, '')}\\end{aligned}` : body.replace(/\\label\{[^}]*\}/g, ''), true)))
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) => keep(math(body, true)))
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => keep(math(body, true)))
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => keep(math(body, false)))
  text = text.replace(/(^|[^\\])\$([^$]+?)\$/g, (_m, before: string, body: string) => before + keep(math(body, false)))
  text = escape(text)
  const heading = (level: number) => (_m: string, title: string) => keep(`<h${level}>${title}</h${level}>`)
  text = text.replace(/\\section\*?\{([^}]*)\}/g, heading(2)).replace(/\\subsection\*?\{([^}]*)\}/g, heading(3)).replace(/\\subsubsection\*?\{([^}]*)\}/g, heading(4))
    .replace(/\\paragraph\*?\{([^}]*)\}/g, (_m, title: string) => `<b>${title}</b> `)
  for (let pass = 0; pass < 3; pass++) {
    text = text.replace(/\\(?:textbf|bf)\{([^{}]*)\}/g, '<b>$1</b>').replace(/\\(?:textit|emph|it)\{([^{}]*)\}/g, '<i>$1</i>')
      .replace(/\\texttt\{([^{}]*)\}/g, '<code>$1</code>').replace(/\\underline\{([^{}]*)\}/g, '<u>$1</u>')
      .replace(/\\href\{([^}]*)\}\{([^{}]*)\}/g, '<a href="$1">$2</a>').replace(/\\url\{([^}]*)\}/g, '<a href="$1">$1</a>')
  }
  text = text.replace(/\\begin\{(itemize|enumerate|description)\}/g, (_m, kind: string) => kind === 'enumerate' ? '<ol>' : '<ul>')
    .replace(/\\end\{(itemize|enumerate|description)\}/g, (_m, kind: string) => kind === 'enumerate' ? '</ol>' : '</ul>')
    .replace(/\\item(?:\[([^\]]*)\])?\s*/g, (_m, label?: string) => '<li>' + (label ? `<b>${label}</b> ` : ''))
  text = text.replace(/\\begin\{(figure|table)\*?\}[\s\S]*?(?:\\caption\{([^}]*)\})?[\s\S]*?\\end\{\1\*?\}/g, (_m, kind: string, caption?: string) => keep(`<p class="tex-float">[${kind}${caption ? ': ' + caption : ''}]</p>`))
    .replace(/\\begin\{(abstract|quote|quotation|center)\}/g, '<blockquote>').replace(/\\end\{(abstract|quote|quotation|center)\}/g, '</blockquote>')
  text = text.replace(/\\maketitle/g, () => keep((title ? `<h1>${escape(title)}</h1>` : '') + (author ? `<p class="tex-author">${escape(author)}</p>` : '')))
  text = text.replace(/---/g, '—').replace(/--/g, '–').replace(/``/g, '“').replace(/''/g, '”').replace(/~/g, '&nbsp;').replace(/\\\\(\[[^\]]*\])?/g, '<br>')
    .replace(/\\(label|ref|cite|eqref|pageref)\{([^}]*)\}/g, (_m, kind: string, key: string) => kind === 'label' ? '' : `<span class="tex-ref">[${key}]</span>`)
    .replace(/\\(?:begin|end)\{[^}]*\}/g, '').replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?\{([^{}]*)\}/g, '$2').replace(/\\[a-zA-Z]+\*?/g, '').replace(/\\([%$&#_{}])/g, '$1').replace(/[{}]/g, '')
  const html = text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean).map(part => /^\u0000\d+\u0000$/.test(part) || /^<(h\d|ul|ol|pre|blockquote)/.test(part) ? part : `<p>${part}</p>`).join('\n')
  return html.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => stash[Number(index)])
}
