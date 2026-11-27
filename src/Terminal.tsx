import { useEffect, useRef } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { type Theme, resolve } from './themes'
import { clipboard } from './bridge'

function colors(theme: Theme) {
  const { colors: c, terminal: t } = resolve(theme)
  return {
    background: c.drawer, foreground: c.ink, cursor: c.accent, cursorAccent: c.drawer,
    selectionBackground: c.selection, ...t,
  }
}

export interface TerminalSession { id: string; label: string; ssh?: string; remotePath?: string; exited?: boolean; /** A shell in the project's dev container. */ container?: boolean }

interface Props {
  session: TerminalSession
  root: string | null
  visible: boolean
  theme: Theme
  fontSize: number
  fontFamily: string
  cursor: 'block' | 'bar' | 'underline'
  shell: string
  scrollback?: number
  copyOnSelect?: boolean
  onReady: (terminal: Xterm | null) => void
  onExit: (id: string) => void
}

export default function Terminal({ session, root, visible, theme, fontSize, fontFamily, cursor, shell, scrollback = 5000, copyOnSelect = false, onReady, onExit }: Props) {
  const host = useRef<HTMLDivElement>(null)
  // xterm sizes itself from its parent's height and width; the padding lives on the outer box
  // so that measurement is the real space (otherwise the last line hides and text runs under the scrollbar).
  const mount = useRef<HTMLDivElement>(null)
  const instance = useRef<Xterm | null>(null)
  const fitter = useRef<FitAddon | null>(null)
  const callbacks = useRef({ onReady, onExit })
  callbacks.current = { onReady, onExit }
  const initial = useRef({ theme, fontSize, fontFamily, cursor, shell, scrollback })
  const copying = useRef(copyOnSelect)
  copying.current = copyOnSelect

  useEffect(() => {
    const container = mount.current
    if (!container) return
    const id = session.id
    const settings = initial.current
    const terminal = new Xterm({
      fontFamily: settings.fontFamily + ', "JetBrains Mono Variable", Consolas, monospace', fontSize: settings.fontSize, lineHeight: 1.2,
      cursorStyle: settings.cursor, cursorBlink: true, theme: colors(settings.theme), scrollback: settings.scrollback, allowProposedApi: false,
      macOptionIsMeta: true,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminal.onSelectionChange(() => { if (copying.current && terminal.hasSelection()) void clipboard.write(terminal.getSelection()).catch(() => {}) })
    instance.current = terminal
    fitter.current = fit
    callbacks.current.onReady(terminal)
    let disposed = false
    let started = false
    const unlisten: UnlistenFn[] = []
    const measure = () => { if (container.clientWidth && container.clientHeight) { try { fit.fit() } catch { /* not attached yet */ } } }
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
    const startup = (async () => {
      try {
        unlisten.push(await listen<{ id: string; bytes: number[] }>('terminal-data', ({ payload }) => {
          if (!disposed && payload.id === id) terminal.write(Uint8Array.from(payload.bytes))
        }))
        unlisten.push(await listen<{ id: string; code: number | null }>('terminal-exit', ({ payload }) => {
          if (!disposed && payload.id === id) {
            started = false
            terminal.writeln('\r\n\x1b[2m' + (session.ssh ? 'Connection closed.' : session.container ? 'The container shell exited.' : 'Shell exited.') + ' Open a new terminal to continue.\x1b[0m')
            callbacks.current.onExit(id)
          }
        }))
        if (disposed) return
        measure()
        started = true
        await invoke('terminal_start', {
          id, rootPath: root, cols: terminal.cols, rows: terminal.rows, shell: settings.shell || null,
          sshHost: session.ssh ?? null, remotePath: session.remotePath ?? null, container: session.container ?? null,
        })
        if (!disposed && container.clientWidth) terminal.focus()
      } catch (error) {
        started = false
        if (!disposed) terminal.writeln('\x1b[31mCould not open the ' + (session.ssh ? 'SSH session' : 'shell') + '.\x1b[0m\r\n' + String(error))
        callbacks.current.onExit(id)
      }
    })()
    return () => {
      disposed = true
      observer.disconnect()
      resize.dispose()
      input.dispose()
      void startup.finally(() => {
        unlisten.forEach(stop => stop())
        void invoke('terminal_stop', { id }).catch(() => {})
      })
      terminal.dispose()
      callbacks.current.onReady(null)
      instance.current = null
      fitter.current = null
    }
  }, [session.id])

  useEffect(() => {
    const terminal = instance.current
    if (!terminal) return
    terminal.options.theme = colors(theme)
    terminal.options.fontSize = fontSize
    terminal.options.fontFamily = fontFamily + ', "JetBrains Mono Variable", Consolas, monospace'
    terminal.options.cursorStyle = cursor
    terminal.options.scrollback = scrollback
    try { fitter.current?.fit() } catch { /* hidden */ }
  }, [theme, fontSize, fontFamily, cursor, scrollback])

  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      try { fitter.current?.fit() } catch { /* hidden */ }
      if (instance.current) callbacks.current.onReady(instance.current)
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])

  return <div ref={host} className="terminal-host" hidden={!visible}><div ref={mount} className="terminal-mount" /></div>
}
