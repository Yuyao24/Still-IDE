import { useEffect, useMemo, useRef, useState } from 'react'
import { CaseSensitive, ChevronDown, ChevronRight, Regex, WholeWord, X } from 'lucide-react'
import { type SearchOptions, type SearchResult, fileName, parentPath } from './bridge'
import { FileIcon, Icon, IconButton } from './ui'

interface Props {
  search: (query: string, options: SearchOptions) => Promise<SearchResult>
  remote: boolean
  focusKey: number
  onOpen: (path: string, line: number, column: number, length: number) => void
  seed?: { query: string; key: number } | null
}

export function SearchPanel({ search, remote, focusKey, onOpen, seed }: Props) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchOptions>({ regex: false, caseSensitive: false, wholeWord: false })
  const [result, setResult] = useState<SearchResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState(new Set<string>())
  const input = useRef<HTMLInputElement>(null)
  const request = useRef(0)

  useEffect(() => { input.current?.focus(); input.current?.select() }, [focusKey])
  useEffect(() => { if (seed?.query) { setQuery(seed.query); requestAnimationFrame(() => { input.current?.focus(); input.current?.select() }) } }, [seed?.key])

  useEffect(() => {
    const id = ++request.current
    if (!query.trim()) { setResult(null); setError(''); setBusy(false); return }
    setBusy(true)
    const timer = setTimeout(() => {
      search(query, options).then(found => {
        if (id !== request.current) return
        setResult(found); setError(''); setCollapsed(new Set())
      }).catch(failure => { if (id === request.current) { setError(String(failure)); setResult(null) } })
        .finally(() => { if (id === request.current) setBusy(false) })
    }, remote ? 600 : 250)
    return () => clearTimeout(timer)
  }, [query, options, search, remote])

  const groups = useMemo(() => {
    const map = new Map<string, SearchResult['matches']>()
    for (const match of result?.matches ?? []) map.set(match.path, [...(map.get(match.path) ?? []), match])
    return [...map.entries()]
  }, [result])

  const toggle = (key: keyof SearchOptions, label: string, glyph: typeof Regex) =>
    <IconButton glyph={glyph} size={15} label={label} className={'small' + (options[key] ? ' is-on' : '')} aria-pressed={options[key]}
      onClick={() => setOptions(value => ({ ...value, [key]: !value[key] }))} />

  function preview(text: string, column: number) {
    const start = Math.max(0, column - 1)
    let length = query.length
    if (options.regex) {
      try { length = new RegExp(query, options.caseSensitive ? '' : 'i').exec(text.slice(start))?.[0].length ?? query.length } catch { /* invalid */ }
    }
    const head = text.slice(Math.max(0, start - 14), start).trimStart()
    return <><span>{start > 14 ? '…' : ''}{head}</span><mark>{text.slice(start, start + length)}</mark><span>{text.slice(start + length)}</span></>
  }

  return <>
    <div className="side-head"><h2 className="section-label">Search</h2>{query && <IconButton glyph={X} label="Clear search" onClick={() => setQuery('')} />}</div>
    <div className="px-[11px] pb-2">
      <div className="search-field">
        <input ref={input} className="field" placeholder={remote ? 'Search files on the server' : 'Search in files'} value={query} spellCheck={false}
          aria-label="Search in files" onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && result?.matches[0]) { const m = result.matches[0]; onOpen(m.path, m.line, m.column, query.length) } }} />
        <div className="search-toggles">
          {toggle('caseSensitive', 'Match case', CaseSensitive)}
          {toggle('wholeWord', 'Match whole word', WholeWord)}
          {toggle('regex', 'Use regular expression', Regex)}
        </div>
      </div>
      <p className="help mt-1.5" aria-live="polite">
        {busy ? 'Searching…' : error ? error : result ? (result.matches.length ? `${result.matches.length}${result.truncated ? '+' : ''} results in ${result.files} ${result.files === 1 ? 'file' : 'files'}` : 'No results') : ''}
      </p>
    </div>
    <div className="tree-scroll search-results">
      {groups.map(([path, matches]) => {
        const open = !collapsed.has(path)
        return <div key={path}>
          <button className="search-file" onClick={() => setCollapsed(value => { const next = new Set(value); if (open) next.add(path); else next.delete(path); return next })} aria-expanded={open} title={path}>
            <Icon glyph={open ? ChevronDown : ChevronRight} size={12} /><FileIcon path={path} size={13} />
            <span className="truncate">{fileName(path)}</span><span className="help truncate">{parentPath(path)}</span><span className="search-count">{matches.length}</span>
          </button>
          {open && matches.map(match => <button key={match.line + ':' + match.column} className="search-hit" title={'Line ' + match.line}
            onClick={() => onOpen(match.path, match.line, match.column, options.regex ? 0 : query.length)}>
            <span className="search-line">{match.line}</span><span className="search-preview">{preview(match.preview, match.column)}</span>
          </button>)}
        </div>
      })}
    </div>
  </>
}
