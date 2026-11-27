import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { CircleAlert, CornerDownLeft, TerminalSquare, Trash2, X } from 'lucide-react'
import { type Diagnostic, fileName } from './bridge'
import { Icon, IconButton } from './ui'

export function SplitGrip({ vertical, value, min, max, change, onActive }: {
  vertical?: boolean; value: number; min: number; max: number; change: (value: number) => void; onActive?: (active: boolean) => void
}) {
  function clamp(next: number) { return Math.max(min, Math.min(max, next)) }
  function drag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    start.current = { origin: vertical ? event.clientX : event.clientY, value }
    onActive?.(true)
  }
  const start = useRef<{ origin: number; value: number } | null>(null)
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!start.current) return
    const position = vertical ? event.clientX : event.clientY
    change(clamp(start.current.value + (position - start.current.origin) * (vertical ? 1 : -1)))
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 8
    const delta = vertical
      ? event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      : event.key === 'ArrowDown' ? -step : event.key === 'ArrowUp' ? step : 0
    if (delta) { event.preventDefault(); change(clamp(value + delta)) }
  }
  return <div className={'grip ' + (vertical ? 'vertical' : 'horizontal')} role="separator"
    aria-label={vertical ? 'Resize sidebar' : 'Resize bottom drawer'} aria-orientation={vertical ? 'vertical' : 'horizontal'}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} tabIndex={0} onKeyDown={key}
    onPointerDown={drag} onPointerMove={move} onLostPointerCapture={() => { start.current = null; onActive?.(false) }} />
}

export interface OutputEntry { kind: 'command' | 'stdout' | 'stderr' | 'exit'; text: string; code?: number | null }

export function Output({ entries, sample, onInput }: { entries: OutputEntry[]; sample: boolean; onInput?: (text: string | null) => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const [line, setLine] = useState('')
  useLayoutEffect(() => {
    if (scroller.current && atEnd.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [entries])
  return <div className={'console-wrap' + (onInput ? ' has-input' : '')}>
  <div className="console-scroll" ref={scroller} role="log" aria-label="Process output" aria-live="off"
    onScroll={event => { const node = event.currentTarget; atEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 16 }}>
    {sample && <div className="console-banner"><Icon glyph={TerminalSquare} size={13} />Sample run</div>}
    {entries.length === 0 && <div className="console-banner">Run or build a file to see output.</div>}
    {entries.map((entry, index) => <div key={index} className={'console-line ' + (
      entry.kind === 'stderr' ? 'console-error' : entry.kind === 'command' ? 'console-command' :
      entry.kind === 'exit' ? entry.code === 0 ? 'console-meta' : 'console-error' : ''
    )}>{entry.text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n')}</div>)}
  </div>
  {onInput && <form className="console-input" onSubmit={event => { event.preventDefault(); onInput(line + '\n'); setLine('') }}>
    <Icon glyph={CornerDownLeft} size={13} />
    <input value={line} onChange={event => setLine(event.target.value)} placeholder="Send input to the running program (Enter sends, Ctrl+D ends input)" spellCheck={false}
      aria-label="Program input" onKeyDown={event => { if (event.key === 'd' && event.ctrlKey) { event.preventDefault(); if (line) onInput(line); setLine(''); onInput(null) } }} />
  </form>}
  </div>
}

export function Problems({ items, jump }: { items: Diagnostic[]; jump: (item: Diagnostic) => void }) {
  return <div className="console-scroll" aria-label="Compiler problems">
    {!items.length && <div className="console-banner"><Icon glyph={CircleAlert} size={13} />No compiler problems</div>}
    {items.map((item, index) => <button key={index} className="problem" onClick={() => jump(item)}>
      <Icon glyph={CircleAlert} className={item.severity === 'error' ? 'console-error' : 'text-[var(--amber)]'} />
      <span>{item.message}<br /><span className="help">{fileName(item.path)} [{item.line}, {item.column}]</span></span>
    </button>)}
  </div>
}

export interface DialogState {
  title: string
  description?: string
  input?: string
  placeholder?: string
  inputLabel?: string
  label: string
  danger?: boolean
  action: (value: string) => void
  /** A second choice beside Cancel (e.g. "Just move" next to "Move and update imports"). */
  secondary?: { label: string; action: () => void }
  /** Lines listed under the description (the files a change touches). */
  list?: string[]
}

export function Dialog({ dialog, close }: { dialog: DialogState; close: () => void }) {
  const [value, setValue] = useState(dialog.input ?? '')
  function submit(event: FormEvent) {
    event.preventDefault()
    if (dialog.input !== undefined && !value.trim()) return
    close()
    dialog.action(value.trim())
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <form className="palette" role="dialog" aria-label={dialog.title} aria-modal="true" onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape') close() }}>
      <div className="side-head border-b border-line"><h2 className="font-medium">{dialog.title}</h2><IconButton glyph={X} label="Close dialog" onClick={close} /></div>
      <div className="p-3">
        {dialog.description && <p className="mb-2 text-muted">{dialog.description}</p>}
        {dialog.list && <ul className="dialog-list">{dialog.list.slice(0, 8).map(item => <li key={item}>{item}</li>)}{dialog.list.length > 8 && <li className="text-muted">and {dialog.list.length - 8} more</li>}</ul>}
        {dialog.input !== undefined && <input className="field" aria-label={dialog.inputLabel ?? 'Workspace-relative file path'} value={value} onChange={event => setValue(event.target.value)} autoFocus
          placeholder={dialog.placeholder ?? 'src/example.py'} spellCheck={false} onFocus={event => {
            const dot = event.target.value.lastIndexOf('.')
            const slash = event.target.value.lastIndexOf('/')
            if (dot > slash + 1) event.target.setSelectionRange(slash + 1, dot)
          }} />}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="text-btn" onClick={close} autoFocus={dialog.input === undefined && !dialog.secondary}>Cancel</button>
          {dialog.secondary && <button type="button" className="text-btn" onClick={() => { close(); dialog.secondary!.action() }}>{dialog.secondary.label}</button>}
          <button type="submit" className={'text-btn primary' + (dialog.danger ? ' danger' : '')} disabled={dialog.input !== undefined && !value.trim()}>
            {dialog.danger && <Icon glyph={Trash2} size={13} />}{dialog.label}
          </button>
        </div>
      </div>
    </form>
  </div>
}
