import { useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Bug, Play, Redo2, Square, X } from 'lucide-react'
import { IconButton } from './ui'

export interface DebugVar { name: string; type: string; value: string; size: string; ok?: boolean }
export interface DebugStop {
  reason: 'breakpoint' | 'step' | 'exception'; detail: string; file: string; line: number
  frame: number; frameFile: string; frameLine: number
  stack: { name: string; file: string; line: number }[]
  locals: DebugVar[]; globals: DebugVar[]; watches: DebugVar[]
}
export interface DebugSession { id: string; state: 'starting' | 'running' | 'paused'; stop: DebugStop | null; evals: { expression: string; value: string; ok: boolean }[] }
export type DebugOp = 'continue' | 'next' | 'step' | 'out' | 'stop'

interface Props {
  session: DebugSession | null
  canDebug: boolean
  why?: string
  breakpointCount: number
  watches: string[]
  onStart: () => void
  onCommand: (op: DebugOp) => void
  onFrame: (index: number) => void
  onEval: (expression: string) => void
  onWatches: (watches: string[]) => void
  onJump: (file: string, line: number) => void
  output: React.ReactNode
}

function Vars({ items, empty }: { items: DebugVar[]; empty: string }) {
  if (!items.length) return <p className="dbg-empty">{empty}</p>
  return <div className="dbg-vars">{items.map(item => <div key={item.name} className={'dbg-var' + (item.ok === false ? ' is-error' : '')} title={item.value}>
    <span className="dbg-name">{item.name}</span>
    <span className="dbg-value">{item.value}</span>
    <span className="dbg-type">{item.type}{item.size ? ' · ' + item.size : ''}</span>
  </div>)}</div>
}

/** The Debug tab: stepping controls, the call stack, variables and watches beside the program's output. */
export function DebugPanel(props: Props) {
  const { session } = props
  const stop = session?.state === 'paused' ? session.stop : null
  const [watch, setWatch] = useState('')
  const [expression, setExpression] = useState('')
  const [globalsOpen, setGlobalsOpen] = useState(false)
  const paused = session?.state === 'paused'
  const status = !session ? (props.canDebug ? (props.breakpointCount ? props.breakpointCount + (props.breakpointCount === 1 ? ' breakpoint set.' : ' breakpoints set.') + ' Press F5 to start.' : 'Click beside a line number to set a breakpoint, then press F5.') : props.why ?? 'Open a Python file to debug it.')
    : session.state === 'starting' ? 'Starting…' : session.state === 'running' ? 'Running… it pauses at the next breakpoint.'
    : stop ? (stop.reason === 'exception' ? 'Stopped on an error: ' + stop.detail : 'Paused at ' + stop.file.split('/').at(-1) + ', line ' + stop.line + (stop.reason === 'breakpoint' ? ' (breakpoint)' : '')) : 'Paused'
  return <div className="dbg">
    <div className="dbg-side">
      <div className="dbg-bar">
        {!session ? <button className="text-btn primary" disabled={!props.canDebug} onClick={props.onStart}><Bug size={13} strokeWidth={1.6} />Debug <kbd>F5</kbd></button> : <>
          <IconButton glyph={Play} label="Continue (F5)" disabled={!paused} onClick={() => props.onCommand('continue')} />
          <IconButton glyph={Redo2} label="Step over (F10)" disabled={!paused} onClick={() => props.onCommand('next')} />
          <IconButton glyph={ArrowDownToLine} label="Step into (F11)" disabled={!paused} onClick={() => props.onCommand('step')} />
          <IconButton glyph={ArrowUpFromLine} label="Step out (Shift+F11)" disabled={!paused} onClick={() => props.onCommand('out')} />
          <IconButton glyph={Square} label="Stop (Shift+F5)" onClick={() => props.onCommand('stop')} />
        </>}
        <span className={'dbg-status' + (stop?.reason === 'exception' ? ' is-error' : '')}>{status}</span>
      </div>
      <div className="dbg-scroll">
        {stop && <section>
          <h3>Call stack</h3>
          {[...stop.stack].reverse().map((frame, reversed) => {
            const index = stop.stack.length - 1 - reversed
            return <button key={index} className={'dbg-frame' + (index === stop.frame ? ' is-active' : '')} onClick={() => { props.onFrame(index); props.onJump(frame.file, frame.line) }}>
              <span>{frame.name}</span><span className="dbg-type">{frame.file.split('/').at(-1)}:{frame.line}</span>
            </button>
          })}
        </section>}
        {stop && <section>
          <h3>Variables</h3>
          <Vars items={stop.locals} empty="No local variables." />
          {stop.globals.length > 0 && <>
            <button className="dbg-toggle" onClick={() => setGlobalsOpen(value => !value)}>{globalsOpen ? 'Hide' : 'Show'} globals ({stop.globals.length})</button>
            {globalsOpen && <Vars items={stop.globals} empty="" />}
          </>}
        </section>}
        <section>
          <h3>Watch</h3>
          {props.watches.map((item, index) => {
            const value = stop?.watches.find(entry => entry.name === item)
            return <div key={item} className={'dbg-var dbg-watch' + (value?.ok === false ? ' is-error' : '')} title={value?.value}>
              <span className="dbg-name">{item}</span><span className="dbg-value">{value ? value.value : paused ? '…' : ''}</span>
              <IconButton glyph={X} size={11} label={'Remove ' + item} className="small" onClick={() => props.onWatches(props.watches.filter((_, position) => position !== index))} />
            </div>
          })}
          <form onSubmit={event => { event.preventDefault(); const value = watch.trim(); if (value && !props.watches.includes(value)) props.onWatches([...props.watches, value]); setWatch('') }}>
            <input className="field dbg-input" value={watch} onChange={event => setWatch(event.target.value)} placeholder="Add an expression to watch" spellCheck={false} />
          </form>
        </section>
      </div>
    </div>
    <div className="dbg-main">
      <div className="dbg-output">{props.output}</div>
      {paused && <>
        {session.evals.length > 0 && <div className="dbg-evals">{session.evals.slice(-6).map((item, index) => <div key={index} className={item.ok ? '' : 'is-error'}><span>› {item.expression}</span>{item.value && <b>{item.value}</b>}</div>)}</div>}
        <form className="dbg-eval" onSubmit={event => { event.preventDefault(); if (expression.trim()) props.onEval(expression.trim()); setExpression('') }}>
          <input className="field dbg-input" value={expression} onChange={event => setExpression(event.target.value)} placeholder="Evaluate in the paused frame, e.g. len(items)" spellCheck={false} />
        </form>
      </>}
    </div>
  </div>
}
