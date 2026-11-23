import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Braces, ChevronDown, ChevronRight, CircleAlert, CodeXml, FilePlus2, Folder, FolderOpen, GitCommitHorizontal, Minus, Package, Plus, RefreshCw, Search, type LucideIcon } from 'lucide-react'
import { type Change, type Entry, type GitStatus, type PackageMatch, type Packages, type Workspace, desktop, fileName, parentPath } from './bridge'
import { FileIcon, Icon, IconButton } from './ui'

export interface SymbolItem { name: string; line: number; kind: 'class' | 'function' | 'heading' }

export function symbolsFor(text: string, path: string): SymbolItem[] {
  const python = /^\s*(?:(?:async\s+)?(def)|class)\s+([\w]+)/
  const java = /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*(?:(class|interface|record)\s+(\w+)|[\w<>\[\],.?]+\s+(\w+)\s*\()/
  return text.split('\n').flatMap((line, index): SymbolItem[] => {
    const lineNumber = index + 1
    if (path.endsWith('.py')) {
      const match = python.exec(line)
      return match ? [{ name: match[2], line: lineNumber, kind: match[1] ? 'function' : 'class' }] : []
    }
    if (path.endsWith('.java')) {
      const match = java.exec(line)
      return match ? [{ name: match[2] ?? match[3], line: lineNumber, kind: match[1] ? 'class' : 'function' }] : []
    }
    const heading = path.endsWith('.md') && /^#{1,6}\s+(.+)/.exec(line)
    return heading ? [{ name: heading[1], line: lineNumber, kind: 'heading' }] : []
  })
}

interface ExplorerProps {
  workspace: Workspace | null
  directories: Record<string, Entry[]>
  expanded: Set<string>
  active?: string
  changes: GitStatus
  symbols: SymbolItem[]
  onOpen: (path: string) => void
  onExpand: (path: string) => void
  onNew: () => void
  onWorkspace: () => void
  onRefresh: () => void
  onJump: (line: number) => void
}

export function Explorer(props: ExplorerProps) {
  const [outline, setOutline] = useState(true)
  const [rootOpen, setRootOpen] = useState(true)
  useEffect(() => setRootOpen(true), [props.workspace?.root])
  const changes = useMemo(() => new Map(props.changes.changes.map(change => [change.path, change])), [props.changes])
  function rows(path: string, depth: number) {
    return props.directories[path]?.map((item): React.ReactNode => {
      const expanded = props.expanded.has(item.path)
      const change = changes.get(item.path)
      const mark = change?.worktree === '?' ? 'U' : (change?.worktree.trim() || change?.index.trim())
      return <div key={item.path}>
        <button type="button" className={'tree-row' + (props.active === item.path ? ' is-active' : '')}
          style={{ paddingLeft: 11 + depth * 15, paddingRight: 9 }} title={item.path}
          aria-expanded={item.directory ? expanded : undefined}
          aria-current={props.active === item.path ? 'true' : undefined}
          onClick={() => item.directory ? props.onExpand(item.path) : props.onOpen(item.path)}>
          <span className="tree-chev">{item.directory && <Icon size={12} glyph={expanded ? ChevronDown : ChevronRight} />}</span>
          {item.directory ? <Icon glyph={expanded ? FolderOpen : Folder} className="file-muted" /> : <FileIcon path={item.path} />}
          <span className="tree-name">{item.name}</span>
          {mark && <span className={'tree-mark' + (mark === 'U' ? ' untracked' : '')}>{mark}</span>}
        </button>
        {item.directory && expanded && rows(item.path, depth + 1)}
      </div>
    })
  }

  return <>
    <div className="side-head">
      <h2 className="section-label">Explorer</h2>
      <div className="flex items-center gap-0.5">
        <IconButton glyph={FilePlus2} label="New file" onClick={props.onNew} disabled={!props.workspace} />
        <IconButton glyph={RefreshCw} label="Refresh files" onClick={props.onRefresh} disabled={!props.workspace} />
        <IconButton glyph={FolderOpen} label="Open workspace folder" onClick={props.onWorkspace} />
      </div>
    </div>
    <div className="tree-scroll">
      {props.workspace && <>
        <button className="project-row" onClick={() => setRootOpen(open => !open)} aria-expanded={rootOpen} title={props.workspace.root}>
          <Icon glyph={rootOpen ? ChevronDown : ChevronRight} size={12} /><Icon glyph={Folder} className="project-folder" />
          <span className="truncate">{props.workspace.name}</span>
        </button>
        {rootOpen && rows('', 0)}
      </>}
    </div>
    <section className="symbols-panel">
      <button className="outline-head" onClick={() => setOutline(value => !value)} aria-expanded={outline}>
        <Icon glyph={outline ? ChevronDown : ChevronRight} size={12} /><span className="section-label">Outline</span>
      </button>
      {outline && (props.symbols.length ? props.symbols.map(symbol => <button key={symbol.line} className="outline-symbol" onClick={() => props.onJump(symbol.line)}>
        <Icon glyph={symbol.kind === 'class' ? Braces : CodeXml} size={13} /><span className="truncate">{symbol.name}</span>
      </button>) : <p className="help px-4 pb-1">No symbols in this file.</p>)}
    </section>
  </>
}

interface GitProps {
  status: GitStatus
  busy: boolean
  error: string
  commit: string
  onCommitText: (message: string) => void
  onDiff: (change: Change, index: boolean) => void
  onStage: (change: Change, index: boolean) => void
  onAction: (action: 'commit' | 'pull' | 'push') => void
  onRefresh: () => void
}

export function SourceControl(props: GitProps) {
  const indexed = props.status.changes.filter(change => change.index.trim() && change.index !== '?')
  const changed = props.status.changes.filter(change => change.worktree.trim())
  function group(label: string, changes: Change[], index: boolean) {
    return <section className="panel-group">
      <h3>{label}<span>{changes.length}</span></h3>
      {changes.length ? changes.map(change => <div className="panel-row" key={change.path}>
        <button className="panel-row-main" onClick={() => props.onDiff(change, index)} title={'View diff for ' + change.path}>
          <FileIcon path={change.path} size={13} /><span>{fileName(change.path)}</span>
          <span className="help">{parentPath(change.path)}</span>
        </button>
        <IconButton glyph={index ? Minus : Plus} size={14} label={(index ? 'Unstage ' : 'Stage ') + change.path}
          disabled={props.busy} onClick={() => props.onStage(change, index)} />
      </div>) : <p className="help">No files</p>}
    </section>
  }
  return <>
    <div className="side-head"><h2 className="section-label">Source Control</h2><IconButton glyph={RefreshCw} label="Refresh Git status" onClick={props.onRefresh} /></div>
    <div className="sidebar-content">
      {props.error ? <p className="help">{props.error}</p> : props.status.branch ? <>
        <form onSubmit={event => { event.preventDefault(); props.onAction('commit') }}>
          <label className="field-label" htmlFor="commit-message">Commit message</label>
          <textarea id="commit-message" className="field resize-y" placeholder="Describe the changes" rows={2} value={props.commit} onChange={event => props.onCommitText(event.target.value)} />
          <button className="text-btn primary mt-1 w-full" type="submit" disabled={!props.commit.trim() || !indexed.length || props.busy}><Icon glyph={GitCommitHorizontal} size={14} /> Commit</button>
        </form>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button className="text-btn" disabled={props.busy} onClick={() => props.onAction('pull')}><Icon glyph={ArrowDownToLine} size={13} /> Pull</button>
          <button className="text-btn" disabled={props.busy} onClick={() => props.onAction('push')}><Icon glyph={ArrowUpFromLine} size={13} /> Push</button>
        </div>
        {group('Staged changes', indexed, true)}
        {group('Changes', changed, false)}
      </> : <p className="help">This folder has no Git repository.</p>}
    </div>
  </>
}

interface PackageProps {
  state: Packages | null
  busy: boolean
  onRefresh: () => void
  onOpen: (path: string) => void
  onSearch: (name: string) => Promise<PackageMatch[]>
  onAction: (action: string, name?: string) => void
}

export function PackagesPanel(props: PackageProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PackageMatch[] | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const pending = useRef(0)
  async function search(event: FormEvent) {
    event.preventDefault()
    if (!query.trim() || waiting) return
    const id = ++pending.current
    setWaiting(true)
    setError('')
    setResults(null)
    try { const found = await props.onSearch(query.trim()); if (id === pending.current) setResults(found) }
    catch (error) { if (id === pending.current) setError(String(error)) }
    finally { if (id === pending.current) setWaiting(false) }
  }
  const installed = props.state?.installed.filter(item => !query || item.name.toLowerCase().includes(query.trim().toLowerCase())) ?? []
  const python = Boolean(props.state?.environment) || !desktop
  return <>
    <div className="side-head"><h2 className="section-label">Packages</h2><IconButton glyph={RefreshCw} label="Refresh packages" onClick={props.onRefresh} /></div>
    <div className="sidebar-content">
      <form onSubmit={search}>
        <label className="field-label" htmlFor="pypi-search">Find on PyPI</label>
        <div className="flex items-center gap-1">
          <input id="pypi-search" type="search" className="field" placeholder="Package name" value={query} onChange={event => {
            pending.current++; setWaiting(false); setQuery(event.target.value); setResults(null); setError(''); setSelected('')
          }} />
          <IconButton type="submit" glyph={Search} label="Search packages" disabled={!query.trim() || waiting} />
        </div>
      </form>
      {waiting && <p className="help mt-2">Searching PyPI…</p>}
      {error && <p className="help mt-2" role="alert">{error}</p>}
      {results && <section className="panel-group">
        <h3>Search results</h3>
        {results.length ? results.map(item => <div key={item.name} className="mb-2">
          <div className="panel-row">
            <button className="panel-row-main" onClick={() => setSelected(selected === item.name ? '' : item.name)}>
              <Icon glyph={Package} size={13} /><span>{item.name}</span><span className="help">{item.version}</span>
            </button>
            <IconButton label={'Install ' + item.name} glyph={Plus} size={14} disabled={!python || props.busy} onClick={() => props.onAction('install', item.name)} />
          </div>
          {selected === item.name && item.summary && <p className="help pl-2">{item.summary}</p>}
        </div>) : <p className="help">No matching package.</p>}
      </section>}
      <section className="panel-group">
        <h3>Manifests</h3>
        {props.state?.manifests.length ? props.state.manifests.map(path => <div className="panel-row" key={path}>
          <button className="panel-row-main" onClick={() => props.onOpen(path)} title={'Open ' + path}><FileIcon path={path} size={13} /><span>{path}</span></button>
          {path !== 'pyproject.toml' && <IconButton glyph={ArrowDownToLine} size={14} disabled={props.busy || (path === 'requirements.txt' && !python)}
            label={path === 'requirements.txt' ? 'Install requirements' : path === 'pom.xml' ? 'Resolve Maven dependencies' : 'Inspect Gradle dependencies'}
            onClick={() => props.onAction(path === 'requirements.txt' ? 'requirements' : path === 'pom.xml' ? 'maven' : 'gradle')} />}
        </div>) : <p className="help">{props.state ? 'No supported manifests found.' : 'Checking workspace…'}</p>}
      </section>
      <section className="panel-group">
        <h3>Installed Python packages</h3>
        {props.state?.environment && <p className="help mb-2">{props.state.environment}</p>}
        {props.state?.warning && <p className="help mb-2 flex gap-1"><Icon glyph={CircleAlert} />{props.state.warning}</p>}
        {installed.map(item => <div className="panel-row" key={item.name}>
          <div className="panel-row-main" title={item.name}><Icon glyph={Package} size={13} /><span>{item.name}</span><span className="help">{item.version}</span></div>
          <IconButton label={'Remove ' + item.name} glyph={Minus} size={14} onClick={() => props.onAction('remove', item.name)} disabled={props.busy} />
        </div>)}
        {!installed.length && <p className="help">{!desktop ? 'Available in the desktop app.' : !props.state ? 'Checking environment…' : props.state.environment ? 'No matching installed packages.' : 'Python 3 is unavailable.'}</p>}
      </section>
    </div>
  </>
}

export interface PaletteItem {
  id: string
  label: string
  detail?: string
  shortcut?: string
  icon?: LucideIcon
  path?: string
  action: () => void
}

function score(term: string, candidate: string) {
  const text = candidate.toLowerCase()
  if (!term) return 0
  const exact = text.indexOf(term)
  if (exact >= 0) return exact
  let offset = 0
  for (const character of term) {
    offset = text.indexOf(character, offset) + 1
    if (!offset) return Infinity
  }
  return 100 + offset
}

export function Palette({ commands, files, start, onClose }: { commands: PaletteItem[]; files: PaletteItem[]; start: string; onClose: () => void }) {
  const [query, setQuery] = useState(start)
  const [index, setIndex] = useState(0)
  const active = useRef<HTMLButtonElement>(null)
  const search = query.trim().toLowerCase()
  const onlyCommands = search.startsWith('>')
  const term = onlyCommands ? search.slice(1).trim() : search
  const filtered = (items: PaletteItem[]) => items.map(item => ({ item, score: Math.min(score(term, item.label), item.detail ? score(term, item.detail) + 15 : Infinity) }))
    .filter(item => item.score < Infinity).sort((a, b) => a.score - b.score).slice(0, 70).map(({ item }) => item)
  const commandMatches = filtered(commands)
  const fileMatches = onlyCommands ? [] : filtered(files)
  const items = onlyCommands ? commandMatches : fileMatches.concat(commandMatches)
  useEffect(() => { active.current?.scrollIntoView({ block: 'nearest' }) }, [index])
  function choose(item: PaletteItem) {
    onClose()
    item.action()
  }
  function rows(values: PaletteItem[], label: string, offset: number) {
    return !!values.length && <>
      <p className="section-label palette-group">{label}</p>
      {values.map((item, number) => {
        const selected = offset + number === index
        return <button id={'palette-option-' + (offset + number)} key={item.id} ref={selected ? active : undefined} className={'palette-result' + (selected ? ' is-selected' : '')}
          onMouseMove={() => setIndex(offset + number)} onClick={() => choose(item)} role="option" aria-selected={selected} tabIndex={-1}>
          {item.path ? <FileIcon path={item.path} /> : item.icon && <Icon glyph={item.icon} />}
          <span className="shrink-0">{item.label}</span>
          {item.detail && <small>{item.detail}</small>}
          {item.shortcut && <kbd className="ml-auto">{item.shortcut}</kbd>}
        </button>
      })}
    </>
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="palette-input">
        <Icon glyph={Search} size={17} />
        <input autoFocus spellCheck={false} placeholder="Type a file name or command…" value={query} onChange={event => { setQuery(event.target.value); setIndex(0) }}
          role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="palette-results" aria-label="Search files and commands"
          aria-activedescendant={items[index] ? 'palette-option-' + index : undefined}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); if (items.length) setIndex(value => (value + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
            } else if (event.key === 'Enter' && items[index]) {
              event.preventDefault(); choose(items[index])
            } else if (event.key === 'Escape') onClose()
            else if (event.key === 'Tab') event.preventDefault()
          }} />
        <button onClick={onClose} title="Close palette" tabIndex={-1}><kbd>Esc</kbd></button>
      </div>
      <div id="palette-results" className="palette-results" role="listbox">
        {rows(fileMatches, 'Files', 0)}
        {rows(commandMatches, 'Commands', fileMatches.length)}
        {!items.length && <p className="help p-3">No matching files or commands.</p>}
      </div>
      <div className="palette-footer"><span><kbd>↑</kbd> <kbd>↓</kbd> Navigate <kbd className="ml-2">↵</kbd> Open</span><span><kbd>&gt;</kbd> Commands</span></div>
    </section>
  </div>
}

