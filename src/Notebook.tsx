// Jupyter notebooks (.ipynb): code and Markdown cells, run one at a time in a Python kernel that
// keeps its variables between cells. Outputs (text, tables, images, errors) are saved back into
// the notebook, so it opens the same in Jupyter, VS Code or Colab.
import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import DOMPurify from 'dompurify'
import { ChevronDown, ChevronUp, CirclePlay, Code2, Eraser, Play, Plus, RotateCcw, Square, Trash2, Type } from 'lucide-react'
import { cellExtensions } from './Editor'
import { renderMarkdown } from './Preview'
import { desktop } from './bridge'
import { Icon, IconButton } from './ui'

type Output =
  | { output_type: 'stream'; name: string; text: string | string[] }
  | { output_type: 'execute_result' | 'display_data'; data: Record<string, string | string[]>; execution_count?: number | null; metadata?: object }
  | { output_type: 'error'; ename: string; evalue: string; traceback: string[] }
interface Cell { id: string; cell_type: 'code' | 'markdown' | 'raw'; source: string; outputs: Output[]; execution_count: number | null; metadata: object }
interface Book { cells: Cell[]; metadata: Record<string, unknown>; nbformat: number; nbformat_minor: number }

const joined = (value: string | string[] | undefined) => Array.isArray(value) ? value.join('') : value ?? ''
const newId = () => Math.random().toString(36).slice(2, 10)

function parse(text: string): Book | string {
  if (!text.trim()) return { cells: [{ id: newId(), cell_type: 'code', source: '', outputs: [], execution_count: null, metadata: {} }], metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 }
  try {
    const raw = JSON.parse(text)
    if (!Array.isArray(raw.cells)) return "This file doesn't look like a Jupyter notebook."
    return {
      cells: raw.cells.map((cell: Record<string, unknown>) => ({
        id: typeof cell.id === 'string' ? cell.id : newId(), cell_type: cell.cell_type === 'markdown' || cell.cell_type === 'raw' ? cell.cell_type : 'code',
        source: joined(cell.source as string | string[]), outputs: Array.isArray(cell.outputs) ? cell.outputs as Output[] : [],
        execution_count: typeof cell.execution_count === 'number' ? cell.execution_count : null, metadata: (cell.metadata as object) ?? {},
      })),
      metadata: raw.metadata ?? {}, nbformat: raw.nbformat ?? 4, nbformat_minor: raw.nbformat_minor ?? 5,
    }
  } catch (error) { return 'The notebook could not be read: ' + String((error as Error).message ?? error) }
}

/** Back to nbformat 4: sources and text as lists of lines, as Jupyter writes them. */
function serialize(book: Book) {
  const lines = (text: string) => text.split(/(?<=\n)/)
  return JSON.stringify({
    cells: book.cells.map(cell => cell.cell_type === 'code'
      ? { cell_type: 'code', execution_count: cell.execution_count, id: cell.id, metadata: cell.metadata, outputs: cell.outputs.map(output => output.output_type === 'stream' ? { ...output, text: lines(joined(output.text)) } : output), source: lines(cell.source) }
      : { cell_type: cell.cell_type, id: cell.id, metadata: cell.metadata, source: lines(cell.source) }),
    metadata: book.metadata, nbformat: book.nbformat, nbformat_minor: Math.max(5, book.nbformat_minor),
  }, null, 1) + '\n'
}

function CellEditor({ value, onChange, keys, onFocus, autoFocus }: { value: string; onChange: (text: string) => void; keys: { key: string; run: () => boolean }[]; onFocus: () => void; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef({ onChange, keys, onFocus })
  latest.current = { onChange, keys, onFocus }
  useEffect(() => {
    if (!host.current) return
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions: cellExtensions('cell.py', text => latest.current.onChange(text), ['Shift-Enter', 'Mod-Enter', 'Alt-Enter', 'Escape'].map(key => ({ key, run: () => latest.current.keys.find(item => item.key === key)?.run() ?? false })), () => latest.current.onFocus()) }),
    })
    view.current = editor
    if (autoFocus) editor.focus()
    return () => { editor.destroy(); view.current = null }
  }, [])
  // Text changed from outside (cleared, undone elsewhere): follow it.
  useEffect(() => {
    const editor = view.current
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
  }, [value])
  return <div className="nb-editor" ref={host} />
}

function OutputView({ output }: { output: Output }) {
  if (output.output_type === 'stream') return <pre className={'nb-out nb-stream' + (output.name === 'stderr' ? ' is-err' : '')}>{joined(output.text)}</pre>
  if (output.output_type === 'error') return <pre className="nb-out nb-error"><b>{output.ename}</b>{output.evalue ? ': ' + output.evalue : ''}{output.traceback.length ? '\n' + output.traceback.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n') : ''}</pre>
  const data = output.data
  if (data['image/png']) return <img className="nb-out nb-image" alt="Output" src={'data:image/png;base64,' + joined(data['image/png']).replace(/\s/g, '')} />
  if (data['image/svg+xml']) return <div className="nb-out nb-html" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(joined(data['image/svg+xml']), { USE_PROFILES: { svg: true } }) }} />
  if (data['text/html']) return <div className="nb-out nb-html" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(joined(data['text/html'])) }} />
  if (data['text/markdown']) return <div className="nb-out nb-html doc-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(joined(data['text/markdown'])) }} />
  return <pre className="nb-out nb-result">{joined(data['text/plain'])}</pre>
}

export function Notebook({ text, path, rootPath, canRun, why, onChange }: { text: string; path: string; rootPath: string; canRun: boolean; why?: string; onChange: (text: string) => void }) {
  const parsed = useMemo(() => parse(text), [])
  const [book, setBook] = useState<Book | null>(typeof parsed === 'string' ? null : parsed)
  const [current, setCurrent] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const [kernel, setKernel] = useState<'off' | 'starting' | 'idle' | 'busy' | 'dead'>('off')
  const [version, setVersion] = useState('')
  const [queue, setQueue] = useState<string[]>([])
  const [focusId, setFocusId] = useState<string | null>(null)
  const id = useMemo(() => 'nb-' + Math.random().toString(36).slice(2), [])
  const counter = useRef(Math.max(0, ...(book?.cells.map(cell => cell.execution_count ?? 0) ?? [0])))
  const bookRef = useRef(book)
  bookRef.current = book
  // The queue is read from kernel events, which can arrive before React re-renders, so the ref is
  // updated together with the state (never from a render).
  const queueRef = useRef<string[]>([])
  const setQueueNow = (next: string[]) => { queueRef.current = next; setQueue(next) }

  // Edits are written back to the tab (as notebook JSON) a moment after they stop.
  const changed = useRef(false)
  useEffect(() => {
    if (!book || !changed.current) return
    const timer = setTimeout(() => onChange(serialize(book)), 250)
    return () => clearTimeout(timer)
  }, [book])
  function update(next: (book: Book) => Book) { changed.current = true; setBook(previous => previous ? next(previous) : previous) }
  const setCell = (cellId: string, change: (cell: Cell) => Cell) => update(value => ({ ...value, cells: value.cells.map(cell => cell.id === cellId ? change(cell) : cell) }))

  useEffect(() => {
    if (!desktop) return
    const stop = listen<{ id: string; cell?: string; kind: string; name?: string; text?: string; mime?: string; data?: string; message?: string; traceback?: string[]; ok?: boolean }>('notebook-event', ({ payload }) => {
      if (payload.id !== id) return
      const cellId = payload.cell ?? ''
      if (payload.kind === 'exit') { setKernel('dead'); setQueueNow([]); return }
      if (payload.kind === 'stream') setCell(cellId, cell => {
        const last = cell.outputs.at(-1)
        if (last?.output_type === 'stream' && last.name === payload.name) return { ...cell, outputs: [...cell.outputs.slice(0, -1), { ...last, text: joined(last.text) + payload.text }] }
        return { ...cell, outputs: [...cell.outputs, { output_type: 'stream', name: payload.name ?? 'stdout', text: payload.text ?? '' }] }
      })
      if (payload.kind === 'result' || payload.kind === 'display') setCell(cellId, cell => ({ ...cell, outputs: [...cell.outputs, {
        output_type: payload.kind === 'result' ? 'execute_result' : 'display_data', metadata: {},
        data: { [payload.mime ?? 'text/plain']: payload.data ?? '', ...(payload.text && payload.mime !== 'text/plain' ? { 'text/plain': payload.text } : {}) },
        ...(payload.kind === 'result' ? { execution_count: cell.execution_count } : {}),
      } as Output] }))
      if (payload.kind === 'error') setCell(cellId, cell => ({ ...cell, outputs: [...cell.outputs, { output_type: 'error', ename: payload.name ?? 'Error', evalue: payload.message ?? '', traceback: payload.traceback ?? [] }] }))
      if (payload.kind === 'done') {
        const rest = queueRef.current.filter(item => item !== cellId)
        // An error stops the cells queued after it, as in Jupyter.
        setQueueNow(payload.ok ? rest : [])
        if (payload.ok && rest.length) send(rest[0]); else setKernel('idle')
      }
    })
    return () => { void stop.then(unlisten => unlisten()); void invoke('notebook_stop', { id }).catch(() => {}) }
  }, [])

  async function ensureKernel() {
    if (kernel === 'idle' || kernel === 'busy') return true
    setKernel('starting')
    try { setVersion(await invoke<string>('notebook_start', { rootPath, path, id })); setKernel('idle'); return true }
    catch (error) { setKernel('dead'); setVersion(String(error)); return false }
  }
  function send(cellId: string) {
    const cell = bookRef.current?.cells.find(item => item.id === cellId)
    if (!cell) return
    counter.current += 1
    const count = counter.current
    setCell(cellId, value => ({ ...value, outputs: [], execution_count: count }))
    setKernel('busy')
    void invoke('notebook_run', { id, cell: cellId, code: cell.source }).catch(() => setKernel('dead'))
  }
  async function run(cellIds: string[]) {
    const code = cellIds.filter(cellId => bookRef.current?.cells.find(cell => cell.id === cellId)?.cell_type === 'code')
    if (!code.length || !canRun) return
    if (!await ensureKernel()) return
    const busy = queueRef.current.length > 0
    setQueueNow([...queueRef.current, ...code.filter(item => !queueRef.current.includes(item))])
    if (!busy) send(code[0])
  }
  async function restart() {
    await invoke('notebook_stop', { id }).catch(() => {})
    setQueueNow([]); setKernel('off'); counter.current = 0
    await ensureKernel()
  }
  async function interrupt() {
    const ok = await invoke<boolean>('notebook_interrupt', { id }).catch(() => false)
    if (!ok) await restart()
  }
  function insert(at: number, type: Cell['cell_type']) {
    const cell: Cell = { id: newId(), cell_type: type, source: '', outputs: [], execution_count: null, metadata: {} }
    update(value => ({ ...value, cells: [...value.cells.slice(0, at), cell, ...value.cells.slice(at)] }))
    setCurrent(at)
    setFocusId(cell.id)
    if (type === 'markdown') setEditing(cell.id)
  }
  function move(index: number, by: number) {
    update(value => {
      const cells = value.cells.slice()
      const target = index + by
      if (target < 0 || target >= cells.length) return value
      ;[cells[index], cells[target]] = [cells[target], cells[index]]
      return { ...value, cells }
    })
    setCurrent(index + by)
  }

  if (!book) return <div className="nb"><p className="doc-message">{typeof parsed === 'string' ? parsed : ''} Use the Edit view to see the raw file.</p></div>
  const status = !canRun ? why : kernel === 'off' ? 'Kernel starts when you run a cell' : kernel === 'starting' ? 'Starting Python…' : kernel === 'dead' ? (version.includes('not found') ? version : 'Kernel stopped. Run a cell to start it again.') : (kernel === 'busy' ? 'Running… · ' : 'Idle · ') + version

  return <div className="nb">
    <div className="nb-bar">
      <button className="text-btn primary" disabled={!canRun || kernel === 'starting'} onClick={() => { void run(book.cells.map(cell => cell.id)) }}><Icon glyph={CirclePlay} size={13} />Run all</button>
      <IconButton glyph={Square} label="Interrupt" disabled={kernel !== 'busy'} onClick={() => { void interrupt() }} />
      <IconButton glyph={RotateCcw} label="Restart the kernel (clears variables)" disabled={!canRun} onClick={() => { void restart() }} />
      <IconButton glyph={Eraser} label="Clear all outputs" onClick={() => update(value => ({ ...value, cells: value.cells.map(cell => ({ ...cell, outputs: [], execution_count: null })) }))} />
      <span className={'nb-status is-' + kernel}><i />{status}</span>
    </div>
    <div className="nb-cells">
      {book.cells.map((cell, index) => {
        const queued = queue.includes(cell.id)
        const running = queue[0] === cell.id && kernel === 'busy'
        return <section key={cell.id} className={'nb-cell is-' + cell.cell_type + (index === current ? ' is-current' : '') + (running ? ' is-running' : '')} onMouseDown={() => setCurrent(index)}>
          <div className="nb-gutter">
            {cell.cell_type === 'code' && <>
              <button className="nb-run" title="Run this cell (Shift+Enter)" disabled={!canRun} onClick={() => { void run([cell.id]) }}><Icon glyph={running ? Square : Play} size={11} /></button>
              <span className="nb-count">{running ? '[*]' : queued ? '[…]' : cell.execution_count ? `[${cell.execution_count}]` : '[ ]'}</span>
            </>}
          </div>
          <div className="nb-body">
            {cell.cell_type === 'markdown' && editing !== cell.id
              ? <div className="nb-markdown doc-markdown" onDoubleClick={() => { setEditing(cell.id); setFocusId(cell.id) }} title="Double-click to edit"
                  dangerouslySetInnerHTML={{ __html: cell.source.trim() ? renderMarkdown(cell.source) : '<p class="nb-empty">Empty Markdown cell. Double-click to write.</p>' }} />
              : <CellEditor value={cell.source} autoFocus={focusId === cell.id} onFocus={() => setCurrent(index)} onChange={source => setCell(cell.id, value => ({ ...value, source }))} keys={[
                  { key: 'Shift-Enter', run: () => { if (cell.cell_type === 'markdown') setEditing(null); else void run([cell.id]); if (index === book.cells.length - 1) insert(index + 1, 'code'); else { setCurrent(index + 1); setFocusId(book.cells[index + 1].id) } return true } },
                  { key: 'Mod-Enter', run: () => { if (cell.cell_type === 'markdown') setEditing(null); else void run([cell.id]); return true } },
                  { key: 'Alt-Enter', run: () => { if (cell.cell_type === 'markdown') setEditing(null); else void run([cell.id]); insert(index + 1, 'code'); return true } },
                  { key: 'Escape', run: () => { if (cell.cell_type === 'markdown') { setEditing(null); return true } return false } },
                ]} />}
            {cell.cell_type === 'code' && cell.outputs.length > 0 && <div className="nb-outputs">{cell.outputs.map((output, number) => <OutputView key={number} output={output} />)}</div>}
          </div>
          <div className="nb-tools">
            <IconButton glyph={cell.cell_type === 'code' ? Type : Code2} label={cell.cell_type === 'code' ? 'Make this a Markdown cell' : 'Make this a code cell'} onClick={() => setCell(cell.id, value => ({ ...value, cell_type: value.cell_type === 'code' ? 'markdown' : 'code', outputs: [] }))} />
            <IconButton glyph={ChevronUp} label="Move up" disabled={index === 0} onClick={() => move(index, -1)} />
            <IconButton glyph={ChevronDown} label="Move down" disabled={index === book.cells.length - 1} onClick={() => move(index, 1)} />
            <IconButton glyph={Trash2} label="Delete cell" onClick={() => update(value => ({ ...value, cells: value.cells.length > 1 ? value.cells.filter(item => item.id !== cell.id) : value.cells }))} />
          </div>
          <div className="nb-add">
            <button onClick={() => insert(index + 1, 'code')}><Icon glyph={Plus} size={11} />Code</button>
            <button onClick={() => insert(index + 1, 'markdown')}><Icon glyph={Plus} size={11} />Markdown</button>
          </div>
        </section>
      })}
    </div>
  </div>
}
