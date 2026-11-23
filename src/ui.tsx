import { createContext, useContext, type ButtonHTMLAttributes } from 'react'
import { Braces, Coffee, FileCode2, FileText, type LucideIcon } from 'lucide-react'

export const IconContext = createContext(1.5)
export function Icon({ glyph: Glyph, size = 15, className }: { glyph: LucideIcon; size?: number; className?: string }) {
  const strokeWidth = useContext(IconContext)
  return <Glyph size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
}

export function IconButton({ glyph, label, className = '', size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { glyph: LucideIcon; label: string; size?: number }) {
  return <button type="button" className={'icon-btn ' + className} title={label} aria-label={label} {...props}><Icon glyph={glyph} size={size} /></button>
}

export function FileIcon({ path, size }: { path: string; size?: number }) {
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (extension === 'py') return <Icon glyph={FileCode2} size={size} className="file-python" />
  if (extension === 'java') return <Icon glyph={Coffee} size={size} className="file-java" />
  if (extension === 'json' || extension === 'toml') return <Icon glyph={Braces} size={size} className="file-muted" />
  return <Icon glyph={FileText} size={size} className={extension === 'md' ? 'file-doc' : 'file-muted'} />
}
