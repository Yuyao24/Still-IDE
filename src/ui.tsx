import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Braces, Coffee, FileCode2, FileCog, FileImage, FileJson, FileTerminal, FileText, Globe, Hash, X, type LucideIcon } from 'lucide-react'

export const IconContext = createContext(1.5)
export function Icon({ glyph: Glyph, size = 15, className }: { glyph: LucideIcon; size?: number; className?: string }) {
  const strokeWidth = useContext(IconContext)
  return <Glyph size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
}

export function IconButton({ glyph, label, className = '', size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { glyph: LucideIcon; label: string; size?: number }) {
  return <button type="button" className={'icon-btn ' + className} title={label} aria-label={label} {...props}><Icon glyph={glyph} size={size} /></button>
}

const fileGlyphs: Record<string, [LucideIcon, string]> = {
  py: [FileCode2, 'file-python'], java: [Coffee, 'file-java'], kt: [Coffee, 'file-java'],
  js: [FileCode2, 'file-script'], mjs: [FileCode2, 'file-script'], cjs: [FileCode2, 'file-script'], jsx: [FileCode2, 'file-script'],
  ts: [FileCode2, 'file-script'], tsx: [FileCode2, 'file-script'], rs: [FileCode2, 'file-script'], go: [FileCode2, 'file-script'],
  c: [FileCode2, 'file-script'], h: [FileCode2, 'file-script'], cpp: [FileCode2, 'file-script'], cs: [FileCode2, 'file-script'],
  json: [FileJson, 'file-muted'], toml: [Braces, 'file-muted'], yaml: [FileCog, 'file-muted'], yml: [FileCog, 'file-muted'],
  xml: [Braces, 'file-muted'], gradle: [FileCog, 'file-muted'], html: [Globe, 'file-muted'], css: [Hash, 'file-muted'],
  sh: [FileTerminal, 'file-muted'], bash: [FileTerminal, 'file-muted'], ps1: [FileTerminal, 'file-muted'],
  png: [FileImage, 'file-muted'], jpg: [FileImage, 'file-muted'], svg: [FileImage, 'file-muted'], md: [FileText, 'file-doc'],
}

export function FileIcon({ path, size }: { path: string; size?: number }) {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  const [glyph, className] = fileGlyphs[extension] ?? [FileText, 'file-muted']
  return <Icon glyph={glyph} size={size} className={className} />
}

export interface MenuItem {
  label: string
  icon?: LucideIcon
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  /** A submenu, shown to the side on hover or with the right arrow key. */
  items?: MenuEntry[]
  action?: () => void
}
export type MenuEntry = MenuItem | 'separator'

/** A small popup menu anchored at a point. Arrow keys move, Enter chooses, → opens a submenu, ← and Escape go back. */
export function Menu({ x, y, items, onClose, nested, onBack, minWidth, autoFocus = true }: { x: number; y: number; items: MenuEntry[]; onClose: () => void; nested?: boolean; onBack?: () => void; minWidth?: number; autoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  const [open, setOpen] = useState<{ index: number; x: number; y: number; focus: boolean } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const { width, height } = node.getBoundingClientRect()
    // A submenu that doesn't fit on the right opens to the left of its parent instead.
    const left = nested && x + width > innerWidth - 6 ? Math.max(6, x - width - (minWidth ?? 0)) : Math.max(6, Math.min(x, innerWidth - width - 6))
    setPosition({ left, top: Math.max(6, Math.min(y, innerHeight - height - 6)) })
    if (autoFocus) node.querySelector<HTMLButtonElement>(':scope > button:not(:disabled)')?.focus({ preventScroll: true })
  }, [x, y])
  useEffect(() => {
    if (nested) return
    const close = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    addEventListener('mousedown', close, true)
    addEventListener('blur', onClose)
    addEventListener('resize', onClose)
    return () => { removeEventListener('mousedown', close, true); removeEventListener('blur', onClose); removeEventListener('resize', onClose) }
  }, [onClose, nested])
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  const withIcons = items.some(item => item !== 'separator' && (item.icon || item.checked !== undefined))
  function openSub(index: number, element: HTMLElement, focus: boolean) {
    const box = element.getBoundingClientRect()
    setOpen({ index, x: box.right + 2, y: box.top - 5, focus })
  }
  return <div ref={ref} className={'menu' + (nested ? ' menu-nested' : '')} role="menu" style={position} onKeyDown={event => {
    if ((event.target as Element).closest('.menu') !== ref.current) return
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)') ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(null)
      buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
    } else if (event.key === 'ArrowRight') {
      const button = buttons[index]
      const item = button && items[Number(button.dataset.index)]
      if (item && item !== 'separator' && item.items) { event.preventDefault(); openSub(Number(button.dataset.index), button, true) }
    } else if (event.key === 'ArrowLeft' && nested) { event.preventDefault(); event.stopPropagation(); onBack?.() }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); (event.key === 'Home' ? buttons[0] : buttons.at(-1))?.focus() }
    else if (event.key === 'Tab') event.preventDefault()
  }}>
    {items.map((item, index) => item === 'separator' ? <div key={index} className="menu-separator" role="separator" /> :
      <button key={index} type="button" role="menuitem" data-index={index} aria-haspopup={item.items ? 'menu' : undefined} aria-expanded={item.items ? open?.index === index : undefined}
        className={'menu-item' + (item.danger ? ' danger' : '') + (open?.index === index ? ' is-open' : '')} disabled={item.disabled}
        onMouseEnter={event => {
          clearTimeout(hoverTimer.current)
          const element = event.currentTarget
          if (item.items) hoverTimer.current = setTimeout(() => openSub(index, element, false), open ? 0 : 120)
          else if (open) hoverTimer.current = setTimeout(() => setOpen(null), 160)
        }}
        onClick={event => {
          if (item.items) { openSub(index, event.currentTarget, true); return }
          onClose(); item.action?.()
        }}>
        {withIcons && (item.checked !== undefined ? <span className="menu-check">{item.checked ? '✓' : ''}</span> : item.icon ? <Icon glyph={item.icon} size={13} /> : <span className="menu-check" />)}
        <span className="menu-label">{item.label}</span>
        {item.shortcut && <kbd>{item.shortcut}</kbd>}
        {item.items && <span className="menu-arrow" aria-hidden="true" />}
      </button>)}
    {open && (() => {
      const item = items[open.index]
      if (item === 'separator' || !item.items) return null
      return <Menu key={open.index} nested autoFocus={open.focus} x={open.x} y={open.y} items={item.items} minWidth={ref.current?.offsetWidth} onClose={onClose}
        onBack={() => { setOpen(null); ref.current?.querySelector<HTMLButtonElement>(`:scope > button[data-index="${open.index}"]`)?.focus() }} />
    })()}
  </div>
}

export interface MenuState { x: number; y: number; items: MenuEntry[] }

/** Centered modal sheet with a header and close button. */
export function Modal({ title, onClose, children, wide, className = '' }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const node = ref.current
    const first = node?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button:not(.modal-close)')
    first?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={ref} className={'sheet ' + (wide ? 'sheet-wide ' : '') + className} role="dialog" aria-modal="true" aria-label={title}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <header className="sheet-head"><h2>{title}</h2><IconButton glyph={X} label="Close" className="modal-close" onClick={onClose} /></header>
      {children}
    </section>
  </div>
}

export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: string }) {
  return <label className="setting-row">
    <span className="setting-text"><span>{label}</span>{description && <small>{description}</small>}</span>
    <button type="button" role="switch" aria-checked={checked} className={'switch' + (checked ? ' on' : '')} onClick={() => onChange(!checked)}><span /></button>
  </label>
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return <div className="segmented" role="radiogroup" aria-label={label}>
    {options.map(option => <button key={String(option.value)} type="button" role="radio" aria-checked={value === option.value}
      className={value === option.value ? 'is-active' : ''} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>
}

export function relativeTime(time: number | null | undefined) {
  if (!time) return 'Never opened'
  const seconds = Math.round((Date.now() - time) / 1000)
  if (seconds < 60) return 'Just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes + 'm ago'
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours + 'h ago'
  const days = Math.round(hours / 24)
  if (days < 7) return days === 1 ? 'Yesterday' : days + ' days ago'
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined })
}

/** A single underline that slides to whichever child has `data-slide`. Re-measures when `key` changes or the container resizes. */
export function useSlider(key: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => {
      const target = node.querySelector<HTMLElement>(':scope > [data-slide]')
      setBox(previous => {
        if (!target) return null
        const next = { left: target.offsetLeft, width: target.offsetWidth }
        return previous && previous.left === next.left && previous.width === next.width ? previous : next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    node.querySelectorAll(':scope > *').forEach(child => observer.observe(child))
    return () => observer.disconnect()
  }, [key])
  const first = useRef(true)
  useEffect(() => { if (box) first.current = false }, [box])
  const bar = box ? <span className={'slider' + (first.current ? ' no-motion' : '')} aria-hidden="true" style={{ width: box.width, transform: `translateX(${box.left}px)` }} /> : null
  return { ref, bar }
}

/** VS Code-style layout icons: a window outline with the part it toggles filled in when shown. */
export function LayoutIcon({ part, on }: { part: 'left' | 'bottom' | 'right' | 'canvas' | 'focus' | 'overview'; on: boolean }) {
  const fill = on ? 'currentColor' : 'none'
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    {part === 'overview' ? <>
      <rect x="1.6" y="2.6" width="5.6" height="4.6" /><rect x="8.8" y="2.6" width="5.6" height="4.6" />
      <rect x="1.6" y="8.8" width="5.6" height="4.6" /><rect x="8.8" y="8.8" width="5.6" height="4.6" />
    </> : part === 'focus' ? <>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" />
      <path d="M4.5 6h7M4.5 8h5M4.5 10h6" strokeWidth="1" />
    </> : <>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" />
      {part === 'left' && <rect x="1.6" y="2.6" width="4.4" height="10.8" fill={fill} />}
      {part === 'bottom' && <rect x="1.6" y="9.4" width="12.8" height="4" fill={fill} />}
      {part === 'right' && <rect x="10" y="2.6" width="4.4" height="10.8" fill={fill} />}
      {part === 'canvas' && <>
        <rect x="10" y="2.6" width="4.4" height="10.8" fill={on ? 'currentColor' : 'none'} />
        {!on && <path d="M11.4 5.5h.01M13 5.5h.01M11.4 8h.01M13 8h.01M11.4 10.5h.01M13 10.5h.01" strokeWidth="1.4" strokeLinecap="round" />}
      </>}
    </>}
  </svg>
}
