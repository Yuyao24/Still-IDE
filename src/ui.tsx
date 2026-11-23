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
  action: () => void
}
export type MenuEntry = MenuItem | 'separator'

/** A small popup menu anchored at a point. Arrow keys move, Enter chooses, Escape closes. */
export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const { width, height } = node.getBoundingClientRect()
    setPosition({ left: Math.max(6, Math.min(x, innerWidth - width - 6)), top: Math.max(6, Math.min(y, innerHeight - height - 6)) })
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y])
  useEffect(() => {
    const close = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    addEventListener('mousedown', close, true)
    addEventListener('blur', onClose)
    addEventListener('resize', onClose)
    return () => { removeEventListener('mousedown', close, true); removeEventListener('blur', onClose); removeEventListener('resize', onClose) }
  }, [onClose])
  return <div ref={ref} className="menu" role="menu" style={position} onKeyDown={event => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
    } else if (event.key === 'Tab') event.preventDefault()
  }}>
    {items.map((item, index) => item === 'separator' ? <div key={index} className="menu-separator" role="separator" /> :
      <button key={index} type="button" role="menuitem" className={'menu-item' + (item.danger ? ' danger' : '')} disabled={item.disabled}
        onClick={() => { onClose(); item.action() }}>
        {item.icon ? <Icon glyph={item.icon} size={14} /> : <span className="w-[14px]" />}
        <span className="flex-1 truncate">{item.label}</span>
        {item.shortcut && <kbd>{item.shortcut}</kbd>}
      </button>)}
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
