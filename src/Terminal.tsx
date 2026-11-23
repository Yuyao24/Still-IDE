import { useEffect, useRef } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

let lifecycle: Promise<unknown> = Promise.resolve()

function colors() {
  const tokens = getComputedStyle(document.documentElement)
  const color = (name: string) => tokens.getPropertyValue('--' + name).trim()
  return {
    background: color('drawer'), foreground: color('ink'), cursor: color('accent'),
    selectionBackground: color('accent-fill'), black: '#37373d', brightBlack: '#85858e',
    red: color('red'), green: color('green'), yellow: color('amber'), blue: color('accent'),
    magenta: '#a99bb1', cyan: '#83a8a9', white: color('ink'),
  }
}

export default function Terminal({ root, visible, theme, onReady }: {
  root: string; visible: boolean; theme: string; onReady: (terminal: Xterm | null) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<Xterm | null>(null)
  const callback = useRef(onReady)
  callback.current = onReady

  useEffect(() => {
    const container = host.current
    if (!container) return
    const id = crypto.randomUUID()
    const terminal = new Xterm({
      fontFamily: '"JetBrains Mono Variable", Consolas, monospace', fontSize: 14, lineHeight: 1.2,
      cursorStyle: 'block', cursorBlink: true, theme: colors(), scrollback: 4000,
      allowProposedApi: false,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    instance.current = terminal
    callback.current(terminal)
    let disposed = false
    let started = false
    let unlisten: UnlistenFn[] = []
    const measure = () => { if (container.clientWidth && container.clientHeight) fit.fit() }
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    void document.fonts.ready.then(() => { if (!disposed) measure() })
    const resize = terminal.onResize(({ cols, rows }) => {
      if (started) void invoke('terminal_resize', { id, cols, rows }).catch(() => {})
    })
    let writes = Promise.resolve()
    const input = terminal.onData(data => {
      if (started) writes = writes.then(() => invoke<void>('terminal_write', { id, data })).catch(() => {})
    })
    lifecycle = lifecycle.catch(() => {}).then(async () => {
      if (disposed) return
      try {
        const output = await listen<{ id: string; bytes: number[] }>('terminal-data', ({ payload }) => {
          if (!disposed && payload.id === id) terminal.write(Uint8Array.from(payload.bytes))
        })
        unlisten.push(output)
        if (disposed) { output(); return }
        const exit = await listen<{ id: string; code: number | null }>('terminal-exit', ({ payload }) => {
          if (!disposed && payload.id === id) {
            started = false
            terminal.writeln('\r\nShell exited. Use New terminal to reconnect.')
          }
        })
        unlisten.push(exit)
        if (disposed) { exit(); return }
        measure()
        started = true
        await invoke('terminal_start', { id, rootPath: root, cols: terminal.cols, rows: terminal.rows })
        if (!disposed && container.clientWidth) terminal.focus()
      } catch (error) {
        started = false
        if (!disposed) terminal.writeln('Could not open the shell.\r\n' + String(error))
      }
    })
    return () => {
      disposed = true
      observer.disconnect()
      resize.dispose()
      input.dispose()
      unlisten.forEach(stop => stop())
      unlisten = []
      terminal.dispose()
      callback.current(null)
      instance.current = null
      lifecycle = lifecycle.then(() => invoke('terminal_stop', { id }).catch(() => {}))
    }
  }, [root])

  useEffect(() => { if (instance.current) instance.current.options.theme = colors() }, [theme])
  return <div ref={host} className="terminal-host" hidden={!visible} />
}
