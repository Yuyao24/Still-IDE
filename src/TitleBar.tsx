import type { ReactNode } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Minus, Square, X } from 'lucide-react'
import { desktop } from './bridge'
import { IconButton } from './ui'

/** The slim 36px window chrome. Empty areas drag the window; double-click maximizes. */
export function TitleBar({ left, center, right, onError, onClose, autoHide }: {
  left: ReactNode; center?: ReactNode; right?: ReactNode; onError: (error: unknown) => void; onClose?: () => void; autoHide?: boolean
}) {
  const bar = <header className="chrome" onMouseDown={event => {
    if (desktop && event.button === 0 && !(event.target as Element).closest('button, input, a, [role="menu"]')) {
      const current = getCurrentWindow()
      void (event.detail === 2 ? current.toggleMaximize() : current.startDragging()).catch(onError)
    }
  }}>
    <div className="chrome-left">{left}</div>
    <div className="chrome-center">{center}</div>
    <div className="chrome-actions">
      {right}
      {desktop && <div className="window-controls">
        <IconButton glyph={Minus} size={13} label="Minimize" onClick={() => { void getCurrentWindow().minimize().catch(onError) }} />
        <IconButton glyph={Square} size={11} label="Toggle maximize" onClick={() => { void getCurrentWindow().toggleMaximize().catch(onError) }} />
        <IconButton glyph={X} size={14} label="Close window" className="window-close" onClick={() => { if (onClose) onClose(); else void getCurrentWindow().close().catch(onError) }} />
      </div>}
    </div>
  </header>
  // Hidden until the pointer reaches the top edge of the window (Settings → Appearance).
  return autoHide ? <div className="chrome-zone">{bar}</div> : bar
}
