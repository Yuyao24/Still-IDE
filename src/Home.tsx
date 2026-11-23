import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Copy, Ellipsis, FolderOpen, FolderSearch, Moon, Pin, PinOff, Sun, X } from 'lucide-react'
import {
  type HomeState, type JobEvent, type ProjectSummary, type SshHost, type SshOverview, type Workspace,
  api, demo, desktop, home, hostLabel, mod, pickFolder, ssh,
} from './bridge'
import { blankHost, HostDialog, hostMenu, OpenRemoteDialog } from './Remote'
import { useSettings } from './settings'
import { entryText, JournalSheet, useJournal } from './Journal'
import { type Resume, clock, journal, resumeFor, sameDay } from './activity'
import { TitleBar } from './TitleBar'
import { Icon, IconButton, Menu, Modal, Toggle, relativeTime, type MenuEntry, type MenuState } from './ui'

export interface OpenOptions { venv?: boolean; file?: string; line?: number }

interface Props {
  onOpen: (workspace: Workspace, options?: OpenOptions) => void
  onOpenRemote: (host: SshHost, path: string) => Promise<void>
  onSettings: (section?: string) => void
  onToggleTheme: () => void
  notify: (message: unknown) => void
}

function greeting() {
  const hour = new Date().getHours()
  return hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}

const shortPath = (path: string, homeDir: string) => homeDir && path.startsWith(homeDir) ? '~' + path.slice(homeDir.length) : path

export default function Home(props: Props) {
  const { theme, settings } = useSettings()
  const entries = useJournal()
  const [journalOpen, setJournal] = useState(false)
  const [state, setState] = useState<HomeState | null>(null)
  const [servers, setServers] = useState<SshOverview | null>(null)
  const [homeDir, setHomeDir] = useState('')
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<'recent' | 'name'>(() => localStorage.getItem('still.home.sort') === 'name' ? 'name' : 'recent')
  const [creating, setCreating] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [editingHost, setEditingHost] = useState<SshHost | null>(null)
  const [remoteHost, setRemoteHost] = useState<SshHost | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const filterInput = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  async function refresh() {
    try { setState(await home.state()) } catch (error) { props.notify(error) }
    if (desktop) void ssh.hosts().then(setServers).catch(() => {})
  }
  useEffect(() => {
    void refresh()
    if (desktop) void home.paths().then(paths => setHomeDir(paths.home)).catch(() => {})
    const focus = () => { void refresh() }
    addEventListener('focus', focus)
    return () => removeEventListener('focus', focus)
  }, [])
  useEffect(() => { localStorage.setItem('still.home.sort', sort) }, [sort])

  async function open(path: string, resume?: Resume) {
    if (!desktop) { props.onOpen(demo); return }
    try { props.onOpen(await home.open(path), resume ? { file: resume.path, line: resume.line } : undefined) } catch (error) { props.notify(error) }
  }

  async function openFolder() {
    try {
      const path = await pickFolder('Open a project folder')
      if (path) await open(path)
    } catch (error) { props.notify(error) }
  }

  async function chooseRoot(path?: string) {
    try {
      const chosen = path ?? await pickFolder('Choose your projects folder')
      if (!chosen) return
      await home.setRoot(chosen)
      await refresh()
    } catch (error) { props.notify(error) }
  }

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (creating || cloning || editingHost || remoteHost || journalOpen || document.querySelector('.modal-backdrop')) return
      const meta = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (meta && key === 'n') { event.preventDefault(); setCreating(true) }
      else if (meta && key === 'o') { event.preventDefault(); void openFolder() }
      else if (meta && (key === 'k' || key === 'p' || key === 'f')) { event.preventDefault(); filterInput.current?.focus() }
      else if (meta && key === ',') { event.preventDefault(); props.onSettings() }
      else if (key === '/' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); filterInput.current?.focus() }
    }
    addEventListener('keydown', handle)
    return () => removeEventListener('keydown', handle)
  })

  const projects = state?.projects ?? []
  const term = filter.trim().toLowerCase()
  const filtered = useMemo(() => {
    const matches = projects.filter(project => !term || project.name.toLowerCase().includes(term) || project.path.toLowerCase().includes(term) || project.languages.some(language => language.toLowerCase().includes(term)))
    return sort === 'name' ? [...matches].sort((a, b) => a.name.localeCompare(b.name)) : matches
  }, [projects, term, sort])
  const recent = useMemo(() => [...projects].filter(project => !project.missing && (project.lastOpened || project.pinned))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastOpened ?? 0) - (a.lastOpened ?? 0)).slice(0, 4), [projects])
  const hosts = [...(servers?.saved ?? []), ...(servers?.imported ?? [])]

  function projectMenu(project: ProjectSummary): MenuEntry[] {
    return [
      ...(!project.missing ? [
        { label: 'Open', icon: FolderOpen, action: () => { void open(project.path) } },
        { label: 'Reveal in file manager', icon: FolderSearch, action: () => { void home.reveal(project.path).catch(props.notify) } },
      ] : []),
      { label: 'Copy path', icon: Copy, action: () => { void navigator.clipboard.writeText(project.path) } },
      { label: project.pinned ? 'Unpin from recents' : 'Pin to recents', icon: project.pinned ? PinOff : Pin, action: () => { void home.pin(project.path, !project.pinned).then(refresh).catch(props.notify) } },
      ...(project.location === 'external' ? ['separator' as const, {
        label: 'Remove from Home', icon: X, action: () => { void home.forget(project.path).then(refresh).catch(props.notify) },
      }] : []),
    ]
  }

  function showMenu(event: MouseEvent, items: MenuEntry[], anchor = false) {
    event.preventDefault()
    event.stopPropagation()
    if (anchor) {
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
      setMenu({ x: box.right - 200, y: box.bottom + 4, items })
    } else setMenu({ x: event.clientX, y: event.clientY, items })
  }

  function rowKey(event: ReactKeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('.project-open') ?? [])]
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }

  function row(project: ProjectSummary) {
    const when = project.lastOpened ? relativeTime(project.lastOpened) : project.modified ? 'edited ' + relativeTime(project.modified).toLowerCase() : ''
    return <div key={project.path} className={'paper-row' + (project.missing ? ' missing' : '')} onContextMenu={event => showMenu(event, projectMenu(project))}>
      <button className="project-open" onClick={() => { if (!project.missing) void open(project.path) }} disabled={project.missing} title={project.path} onKeyDown={rowKey}>
        <span className="paper-name">{project.name}{project.location === 'external' && <span className="muted"> · elsewhere</span>}{project.pinned && <Icon glyph={Pin} size={11} className="project-pin" />}</span>
        <span className="paper-meta">{project.missing ? 'Missing' : [project.languages.slice(0, 2).join(', '), when].filter(Boolean).join(' · ')}</span>
      </button>
      <IconButton glyph={Ellipsis} label={'Actions for ' + project.name} className="row-action" onClick={event => showMenu(event, projectMenu(project), true)} />
    </div>
  }

  const serverActions = {
    onTerminal: (host: SshHost) => setRemoteHost(host),
    onOpenFolder: (host: SshHost) => setRemoteHost(host),
    onEdit: (host: SshHost) => setEditingHost(host),
    onDelete: (host: SshHost) => { void ssh.remove(host.id).then(refresh).catch(props.notify) },
    onTest: (host: SshHost) => { props.notify('Connecting to ' + host.name + '…'); void ssh.test(host.id).then(result => props.notify('Connected: ' + result)).catch(props.notify) },
  }

  const latest = recent.find(project => !project.missing && project.lastOpened)
  const resume = latest ? resumeFor(latest.path) : null
  const [changed, setChanged] = useState<number | null>(null)
  useEffect(() => {
    setChanged(null)
    if (!latest || !desktop) return
    let live = true
    void api.git(latest.path).then(result => { if (live) setChanged(result.changes.length) }).catch(() => {})
    return () => { live = false }
  }, [latest?.path])
  const todays = entries.filter(entry => sameDay(entry.time, Date.now())).slice(-3).reverse()

  return <div className="app home-app">
    <TitleBar onError={props.notify}
      left={<span className="brand"><span className="brand-word">Still</span></span>}
      right={<>
        <label className="paper-search">
          <input ref={filterInput} value={filter} onChange={event => setFilter(event.target.value)} placeholder="Search" aria-label="Search projects" spellCheck={false}
            onKeyDown={event => {
              if (event.key === 'Escape') { setFilter(''); event.currentTarget.blur() }
              if (event.key === 'Enter' && filtered[0] && !filtered[0].missing) void open(filtered[0].path)
              if (event.key === 'ArrowDown') { event.preventDefault(); list.current?.querySelector<HTMLButtonElement>('.project-open')?.focus() }
            }} />
          {!filter && <kbd>{mod}+K</kbd>}
        </label>
        <IconButton glyph={theme.kind === 'dark' ? Sun : Moon} label="Toggle light and dark" onClick={props.onToggleTheme} />
        <button className="quiet-link" onClick={() => props.onSettings()}>Settings</button>
      </>} />

    <main className="home" onKeyDown={rowKey}>
      <div className="paper">
        <header className="paper-hero">
          <h1>{greeting()}.</h1>
          <p>Pick up where you left off, or start something new.</p>
          <div className="paper-actions">
            <button className="paper-btn primary" onClick={() => setCreating(true)}>New project</button>
            <button className="paper-btn" onClick={() => { void openFolder() }}>Open folder</button>
            <button className="paper-btn" onClick={() => desktop ? setCloning(true) : props.notify('Cloning is available in the Still desktop app.')}>Clone</button>
            <button className="paper-btn" onClick={() => desktop ? setEditingHost(blankHost) : props.notify('SSH is available in the Still desktop app.')}>Connect to server</button>
          </div>
        </header>

        {state && !state.projectsRoot && desktop && <section className="setup-card">
          <div>
            <h2>Where should your projects live?</h2>
            <p>Still keeps new projects in one folder so they are easy to find. You can still create or open individual projects anywhere, and uninstalling Still never touches them.</p>
          </div>
          <div className="setup-actions">
            <button className="paper-btn primary" onClick={() => { void chooseRoot(state.suggestedRoot) }}>Use {shortPath(state.suggestedRoot, homeDir)}</button>
            <button className="paper-btn" onClick={() => { void chooseRoot() }}>Choose folder…</button>
          </div>
        </section>}

        {latest && !term && <section className="paper-section">
          <h2>Continue</h2>
          <button className="paper-continue" onClick={() => { void open(latest.path, resume ?? undefined) }} onContextMenu={event => showMenu(event, projectMenu(latest))}>
            <b>{latest.name}</b>
            {resume && <span className="muted">{resume.path}, line {resume.line}</span>}
            {changed ? <span className="paper-amber">{changed} changed</span> : null}
            <span className="muted paper-when">{relativeTime(latest.lastOpened)}</span>
          </button>
        </section>}

        <section className="paper-columns">
          <div ref={list}>
            <div className="paper-head">
              <h2>{term ? 'Matching projects' : 'Projects'}{state?.projectsRoot && !term && <> · <button className="paper-root" onClick={event => showMenu(event, [
                { label: 'Change projects folder…', icon: FolderOpen, action: () => { void chooseRoot() } },
                { label: 'Reveal in file manager', icon: FolderSearch, action: () => { void home.reveal(state.projectsRoot!).catch(props.notify) } },
              ], true)} title={state.projectsRoot}>{shortPath(state.projectsRoot, homeDir)}</button></>}</h2>
              <span className="paper-sort">
                <button className={sort === 'recent' ? 'is-active' : ''} onClick={() => setSort('recent')}>Recent</button>
                <button className={sort === 'name' ? 'is-active' : ''} onClick={() => setSort('name')}>Name</button>
              </span>
            </div>
            <div className="paper-list">
              {filtered.map(row)}
              {state && !filtered.length && <div className="paper-empty">
                {term ? <p>No projects match “{filter}”.</p> : <p>No projects yet. <button className="link" onClick={() => setCreating(true)}>Create one</button>, or try the Orbit Lab sample from New project.</p>}
              </div>}
            </div>
          </div>
          <div>
            <div className="paper-head"><h2>Today</h2></div>
            <div className="paper-list">
              {todays.map(entry => <button key={entry.id} className="paper-row journal-line" onClick={() => { void open(entry.root, entry.path ? { path: entry.path, line: 1, time: entry.time } : undefined) }} title={entry.project}>
                <time>{clock(entry.time)}</time><span>{entryText(entry)}</span>
              </button>)}
              {!todays.length && <p className="paper-row paper-quiet">Nothing yet today.</p>}
              <button className="paper-row journal-line paper-quiet journal-open" onClick={() => setJournal(true)}><span>Open journal</span></button>
            </div>
          </div>
        </section>

        {desktop && <section className="paper-servers">
          <h2>Servers</h2>
          {hosts.map(host => <button key={host.id} onClick={() => setRemoteHost(host)} onContextMenu={event => showMenu(event, hostMenu(host, serverActions))} title={'Open a folder on ' + host.name}>
            <span>{host.name}</span> <code>{host.source === 'config' && !host.user ? 'ssh config' : hostLabel(host)}</code>
          </button>)}
          {!hosts.length && <span className="muted">None saved yet.</span>}
          <button className="paper-add" onClick={() => setEditingHost(blankHost)}>Add server</button>
        </section>}

        <footer className="paper-foot">
          <span><kbd>{mod}+N</kbd> new project</span><span><kbd>{mod}+O</kbd> open folder</span><span><kbd>/</kbd> search</span><span><kbd>{mod}+,</kbd> settings</span>
        </footer>
      </div>
    </main>

    {creating && <NewProjectDialog root={state?.projectsRoot ?? null} homeDir={homeDir} onClose={() => setCreating(false)} notify={props.notify}
      onChooseRoot={() => { void chooseRoot() }} onCreated={(workspace, options) => {
        setCreating(false)
        if (settings.journal) journal.add({ kind: 'create', project: workspace.name, root: workspace.root, text: 'Created ' + workspace.name })
        props.onOpen(workspace, options)
      }} />}
    {cloning && <CloneDialog root={state?.projectsRoot ?? null} homeDir={homeDir} onClose={() => setCloning(false)}
      onCloned={path => {
        setCloning(false)
        if (settings.journal) journal.add({ kind: 'clone', project: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path, root: path, text: 'Cloned ' + (path.split(/[\\/]/).filter(Boolean).at(-1) ?? path) })
        void open(path)
      }} />}
    {journalOpen && <JournalSheet onClose={() => setJournal(false)} onOpen={entry => { setJournal(false); void open(entry.root, entry.path ? { path: entry.path, line: 1, time: entry.time } : undefined) }} />}
    {editingHost && <HostDialog host={editingHost} onClose={() => setEditingHost(null)} onSaved={host => { void refresh(); setRemoteHost(host) }} />}
    {remoteHost && <OpenRemoteDialog host={remoteHost} onClose={() => setRemoteHost(null)} onOpen={path => props.onOpenRemote(remoteHost, path)} />}
    {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
  </div>
}

const templates = [
  { id: 'python', label: 'Python', detail: 'main.py, requirements.txt' },
  { id: 'java', label: 'Java', detail: 'src/Main.java' },
  { id: 'node', label: 'JavaScript', detail: 'index.js, package.json' },
  { id: 'empty', label: 'Empty', detail: 'Just a README' },
  { id: 'sample', label: 'Orbit Lab sample', detail: 'Python + Java example' },
]

function Location({ root, homeDir, custom, setCustom, onChooseRoot }: { root: string | null; homeDir: string; custom: string | null; setCustom: (path: string | null) => void; onChooseRoot: () => void }) {
  async function choose() {
    const path = await pickFolder('Choose where to create the project').catch(() => null)
    if (path) setCustom(path)
  }
  return <fieldset className="location-choice">
    <legend className="field-label">Location</legend>
    <label className={'choice' + (custom === null ? ' is-active' : '')}>
      <input type="radio" checked={custom === null} disabled={!root} onChange={() => setCustom(null)} />
      <span><b>Projects folder</b><small>{root ? shortPath(root, homeDir) : 'Not set yet'}</small></span>
      {!root && <button type="button" className="text-btn ml-auto" onClick={onChooseRoot}>Choose…</button>}
    </label>
    <label className={'choice' + (custom !== null ? ' is-active' : '')}>
      <input type="radio" checked={custom !== null} onChange={() => { void choose() }} />
      <span><b>Somewhere else</b><small>{custom ? shortPath(custom, homeDir) : 'An individual project outside the projects folder'}</small></span>
      <button type="button" className="text-btn ml-auto" onClick={() => { void choose() }}>Browse…</button>
    </label>
  </fieldset>
}

function NewProjectDialog({ root, homeDir, onClose, onCreated, onChooseRoot, notify }: {
  root: string | null; homeDir: string; onClose: () => void; onCreated: (workspace: Workspace, options: OpenOptions) => void; onChooseRoot: () => void; notify: (error: unknown) => void
}) {
  const { settings, update } = useSettings()
  const [name, setName] = useState('')
  const [template, setTemplate] = useState(settings.newProjectTemplate)
  const [custom, setCustom] = useState<string | null>(root ? null : '')
  const [git, setGit] = useState(settings.newProjectGit)
  const [venv, setVenv] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (template === 'sample' && !name) setName('Orbit Lab') }, [template])
  useEffect(() => { if (root && custom === '') setCustom(null) }, [root])
  const parent = custom || root
  const separator = parent?.includes('\\') ? '\\' : '/'
  const invalid = /[<>:"/\\|?*]/.test(name)

  async function submit() {
    if (!desktop) { notify('Creating projects is available in the Still desktop app.'); return }
    setBusy(true)
    setError('')
    try {
      const workspace = await home.create(name.trim(), template, custom || null, git)
      update({ newProjectTemplate: template, newProjectGit: git })
      onCreated(workspace, { venv: venv && template === 'python' })
    } catch (failure) { setError(String(failure)) } finally { setBusy(false) }
  }

  return <Modal title="New project" onClose={onClose} wide>
    <form className="sheet-body form-grid" onSubmit={event => { event.preventDefault(); void submit() }}>
      <label>Name<input className="field field-lg" value={name} onChange={event => setName(event.target.value)} placeholder="my-project" autoFocus spellCheck={false} /></label>
      {invalid && <p className="form-error">Names cannot contain &lt; &gt; : " / \ | ? *</p>}
      <fieldset>
        <legend className="field-label">Start from</legend>
        <div className="template-grid">
          {templates.map(item => <button type="button" key={item.id} className={'template' + (template === item.id ? ' is-active' : '')} onClick={() => setTemplate(item.id)} aria-pressed={template === item.id}>
            <b>{item.label}</b><small>{item.detail}</small>
          </button>)}
        </div>
      </fieldset>
      <Location root={root} homeDir={homeDir} custom={custom} setCustom={setCustom} onChooseRoot={onChooseRoot} />
      <div className="toggles">
        <Toggle label="Initialize a Git repository" checked={git} onChange={setGit} />
        {template === 'python' && <Toggle label="Create a virtual environment (.venv)" description="Runs python -m venv .venv after the project opens." checked={venv} onChange={setVenv} />}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="sheet-actions">
        <span className="help mr-auto truncate">{parent && name.trim() ? 'Creates ' + shortPath(parent + separator + name.trim(), homeDir) : ''}</span>
        <button type="button" className="text-btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="text-btn primary" disabled={busy || !name.trim() || invalid || !parent}>Create project</button>
      </div>
    </form>
  </Modal>
}

function CloneDialog({ root, homeDir, onClose, onCloned }: { root: string | null; homeDir: string; onClose: () => void; onCloned: (path: string) => void }) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [custom, setCustom] = useState<string | null>(root ? null : '')
  const [log, setLog] = useState('')
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const job = useRef<{ id: string; target: string } | null>(null)
  const guess = url.trim().replace(/\/+$/, '').split(/[/:]/).at(-1)?.replace(/\.git$/, '') ?? ''

  useEffect(() => {
    const stop = listen<JobEvent>('job-output', ({ payload }) => {
      if (payload.id !== job.current?.id) return
      if (payload.kind === 'exit') {
        setRunning(false)
        if (payload.code === 0) onCloned(job.current.target)
        else setError('Clone failed. Check the URL and your Git credentials.')
        return
      }
      setLog(value => (value + payload.text).slice(-6000))
    })
    return () => { void stop.then(unlisten => unlisten()) }
  }, [])

  async function submit() {
    setError(''); setLog(''); setRunning(true)
    const id = crypto.randomUUID()
    try {
      job.current = { id, target: '' }
      job.current.target = await home.clone(id, url.trim(), name.trim() || null, custom || null)
    } catch (failure) { setRunning(false); job.current = null; setError(String(failure)) }
  }

  return <Modal title="Clone repository" onClose={onClose} wide>
    <form className="sheet-body form-grid" onSubmit={event => { event.preventDefault(); void submit() }}>
      <label>Repository URL<input className="field field-lg" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repo.git or git@host:owner/repo.git" autoFocus spellCheck={false} /></label>
      <label>Folder name<input className="field" value={name} onChange={event => setName(event.target.value)} placeholder={guess || 'repository'} spellCheck={false} /></label>
      <Location root={root} homeDir={homeDir} custom={custom} setCustom={setCustom} onChooseRoot={() => {}} />
      {log && <pre className="clone-log">{log.replace(/\r/g, '\n').split('\n').filter(Boolean).slice(-8).join('\n')}</pre>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="sheet-actions">
        <button type="button" className="text-btn" onClick={onClose}>{running ? 'Hide' : 'Cancel'}</button>
        <button type="submit" className="text-btn primary" disabled={running || !url.trim() || !(custom || root)}>{running ? 'Cloning…' : 'Clone'}</button>
      </div>
    </form>
  </Modal>
}

