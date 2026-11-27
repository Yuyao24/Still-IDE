import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Copy, Ellipsis, FolderOpen, FolderSearch, Moon, Pin, PinOff, Sun, Trash2, X } from 'lucide-react'
import {
  type HomeState, type JobEvent, type ProjectSummary, type SshHost, type SshOverview, type Workspace,
  api, demo, desktop, forgetProject, home, hostLabel, mod, pickFile, pickFolder, recentFiles, ssh, type RecentFile,
} from './bridge'
import { ConnectDialog, HostDialog, OpenRemoteDialog } from './Remote'
import { useSettings } from './settings'
import mark from './still.svg?inline'
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
  const [connecting, setConnecting] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null)
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

  /** A single file on its own, without making its folder a project. */
  async function openLoose(path: string) {
    if (!desktop) { props.notify('Opening single files is available in the Still desktop app.'); return }
    try { const workspace = await home.openFile(path); props.onOpen(workspace, { file: workspace.file! }) }
    catch (error) { recentFiles.remove(path); setLoose(recentFiles.list()); props.notify(error) }
  }
  async function openFile() {
    try {
      const path = await pickFile('Open a file')
      if (path) await openLoose(path)
    } catch (error) { props.notify(error) }
  }
  const [loose, setLoose] = useState<RecentFile[]>(() => recentFiles.list())

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
      if (creating || cloning || editingHost || remoteHost || connecting || journalOpen || document.querySelector('.modal-backdrop')) return
      const meta = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (meta && key === 'n') { event.preventDefault(); setCreating(true) }
      else if (meta && key === 'o') { event.preventDefault(); if (event.shiftKey) void openFile(); else void openFolder() }
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
      'separator' as const,
      // A project deleted outside Still can be taken off the list; one that's there can be deleted (to the trash).
      ...(project.missing || project.location === 'external' ? [{
        label: project.missing ? 'Remove from the list' : 'Remove from Home', icon: X, action: () => { void home.forget(project.path).then(refresh).catch(props.notify) },
      }] : []),
      ...(!project.missing && desktop ? [{ label: 'Delete project…', icon: Trash2, danger: true, action: () => setDeleting(project) }] : []),
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
    return <div key={project.path} className={'calm-row' + (project.missing ? ' missing' : '')} onContextMenu={event => showMenu(event, projectMenu(project))}>
      <button className="project-open" onClick={() => { if (!project.missing) void open(project.path) }} disabled={project.missing} title={project.path} onKeyDown={rowKey}>
        <span className="calm-name">{project.name}{project.pinned && <Icon glyph={Pin} size={11} className="project-pin" />}</span>
        <span className="calm-meta">{project.missing ? 'Missing' : [project.location === 'external' ? 'elsewhere' : '', project.languages.slice(0, 2).join(', '), when].filter(Boolean).join(' · ')}</span>
      </button>
      <IconButton glyph={Ellipsis} label={'Actions for ' + project.name} className="row-action" onClick={event => showMenu(event, projectMenu(project), true)} />
    </div>
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
  const fileRow = (item: RecentFile) => {
    const parts = item.path.split(/[\\/]/)
    return <div key={item.path} className="calm-row">
      <button className="project-open" onClick={() => { void openLoose(item.path) }} title={item.path} onKeyDown={rowKey}>
        <span className="calm-name">{parts.at(-1)}</span>
        <span className="calm-meta">{[shortPath(parts.slice(0, -1).join(item.path.includes('\\') ? '\\' : '/'), homeDir), relativeTime(item.time).toLowerCase()].filter(Boolean).join(' · ')}</span>
      </button>
      <IconButton glyph={X} label={'Remove ' + parts.at(-1) + ' from recent files'} className="row-action" onClick={() => { recentFiles.remove(item.path); setLoose(recentFiles.list()) }} />
    </div>
  }
  const files = term ? loose.filter(item => item.path.toLowerCase().includes(term)) : loose

  return <div className="app home-app">
    <TitleBar onError={props.notify}
      left={<span className="brand"><img src={mark} alt="" /><span className="brand-word">Still</span></span>}
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
        <IconButton glyph={theme.kind === 'dark' ? Sun : Moon} label={theme.kind === 'dark' ? 'Light theme' : 'Dark theme'} onClick={props.onToggleTheme} />
        <button className="quiet-link" onClick={() => props.onSettings()}>Settings</button>
      </>} />

    <main className="home" onKeyDown={rowKey}>
      <div className="paper">
        <header className="paper-hero">
          <h1>{greeting()}.</h1>
          <p>Pick up where you left off, or start something new.</p>
          <div className="paper-actions">
            <button className="paper-btn primary" onClick={() => setCreating(true)} title={'New project (' + mod + '+N)'}>New project</button>
            <button className="calm-action" onClick={() => { void openFolder() }} title={'Open folder (' + mod + '+O)'}>Open folder</button>
            <button className="calm-action" onClick={() => { void openFile() }} title={'Open a single file (' + mod + '+Shift+O)'}>Open file</button>
            <button className="calm-action" onClick={() => desktop ? setCloning(true) : props.notify('Cloning is available in the Still desktop app.')}>Clone</button>
            <button className="calm-action" onClick={() => desktop ? setConnecting(true) : props.notify('SSH is available in the Still desktop app.')}>Connect to server</button>
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

        {latest && !term && <section className="calm-continue">
          <button onClick={() => { void open(latest.path, resume ?? undefined) }} onContextMenu={event => showMenu(event, projectMenu(latest))}>
            <span className="calm-label">Continue</span>
            <b>{latest.name}</b>
            <span className="calm-where">{[resume ? resume.path.split('/').at(-1) + ', line ' + resume.line : '', relativeTime(latest.lastOpened).toLowerCase()].filter(Boolean).join(' · ')}{changed ? <em> · {changed} changed</em> : null}</span>
          </button>
        </section>}

        <section className="calm-grid">
          <div ref={list} className="calm-projects">
            <div className="calm-head">
              <h2>{term ? 'Matching projects' : 'Projects'}</h2>
              {!term && <span className="calm-sort">
                <button className={sort === 'recent' ? 'is-active' : ''} onClick={() => setSort('recent')}>Recent</button>
                <button className={sort === 'name' ? 'is-active' : ''} onClick={() => setSort('name')}>Name</button>
              </span>}
            </div>
            <div className="calm-list">
              {(showAll || term ? filtered : filtered.slice(0, 7)).map(row)}
              {state && !filtered.length && <p className="calm-quiet">
                {term ? <>No projects match “{filter}”.</> : <>No projects yet. <button className="link" onClick={() => setCreating(true)}>Create one</button>, or try the Orbit Lab sample from New project.</>}
              </p>}
            </div>
            {!term && filtered.length > 7 && <button className="calm-more" onClick={() => setShowAll(value => !value)}>{showAll ? 'Fewer' : 'All ' + filtered.length + ' projects'}</button>}
            {state?.projectsRoot && !term && <button className="calm-root" onClick={event => showMenu(event, [
              { label: 'Change projects folder…', icon: FolderOpen, action: () => { void chooseRoot() } },
              { label: 'Reveal in file manager', icon: FolderSearch, action: () => { void home.reveal(state.projectsRoot!).catch(props.notify) } },
            ], true)} title={state.projectsRoot}>{shortPath(state.projectsRoot, homeDir)}</button>}
            {files.length > 0 && <>
              <div className="calm-head calm-files-head"><h2>Files</h2></div>
              <div className="calm-list">{files.slice(0, 5).map(fileRow)}</div>
            </>}
          </div>
          {!term && <div className="calm-journal">
            <div className="calm-head"><h2>Today</h2></div>
            {todays.map(entry => <button key={entry.id} className="calm-entry" onClick={() => { void open(entry.root, entry.path ? { path: entry.path, line: 1, time: entry.time } : undefined) }} title={entry.project}>
              <time>{clock(entry.time)}</time><span>{entryText(entry)}</span>
            </button>)}
            <button className="calm-more" onClick={() => setJournal(true)}>Open journal</button>
          </div>}
        </section>
      </div>
    </main>

    {deleting && <DeleteProjectDialog project={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); void refresh(); props.notify('Moved ' + deleting.name + ' to the trash.') }} notify={props.notify} />}
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
    {connecting && <ConnectDialog hosts={hosts} onClose={() => { setConnecting(false); void refresh() }} onOpen={props.onOpenRemote} onAdvanced={host => { setConnecting(false); setEditingHost(host) }} />}
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

function NewProjectDialog({ root, homeDir, onClose, onCreated, onChooseRoot, notify, initialName = '' }: {
  initialName?: string; root: string | null; homeDir: string; onClose: () => void; onCreated: (workspace: Workspace, options: OpenOptions) => void; onChooseRoot: () => void; notify: (error: unknown) => void
}) {
  const { settings, update } = useSettings()
  const [name, setName] = useState(initialName)
  const [template, setTemplate] = useState(settings.newProjectTemplate)
  const [custom, setCustom] = useState<string | null>(root ? null : '')
  const [git, setGit] = useState(settings.newProjectGit)
  const [readme, setReadme] = useState(settings.newProjectReadme)
  const [requirements, setRequirements] = useState(settings.newProjectRequirements)
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
      const workspace = await home.create(name.trim(), template, custom || null, git, readme, requirements)
      await forgetProject(workspace.root)
      update({ newProjectTemplate: template, newProjectGit: git, newProjectReadme: readme, ...(template === 'python' ? { newProjectRequirements: requirements } : {}) })
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
        {template !== 'sample' && <Toggle label="Add a README" description="README.md with the project name, for notes about the project." checked={readme} onChange={setReadme} />}
        {template === 'python' && <Toggle label="Add requirements.txt" description="Lists the packages the project needs, for pip install -r." checked={requirements} onChange={setRequirements} />}
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

function CloneDialog({ root, homeDir, onClose, onCloned, initialUrl = '' }: { root: string | null; homeDir: string; onClose: () => void; onCloned: (path: string) => void; initialUrl?: string }) {
  const [url, setUrl] = useState(initialUrl)
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


/** Deleting a project moves its folder to the trash. Typing the project's name confirms it. */
function DeleteProjectDialog({ project, onClose, onDeleted, notify }: { project: ProjectSummary; onClose: () => void; onDeleted: () => void; notify: (message: unknown) => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const matches = typed === project.name
  async function remove() {
    if (!matches || busy) return
    setBusy(true)
    try { await home.remove(project.path); await forgetProject(project.path); onDeleted() } catch (error) { notify(error); setBusy(false) }
  }
  return <Modal title={'Delete ' + project.name + '?'} onClose={onClose} className="delete-sheet">
    <p className="sheet-text">The folder <code>{project.path}</code> and everything in it go to the system trash. You can restore it from there.</p>
    <label className="field-label" htmlFor="delete-confirm">Type <b>{project.name}</b> to confirm</label>
    <input id="delete-confirm" className="field field-lg" value={typed} onChange={event => setTyped(event.target.value)} autoFocus spellCheck={false} autoComplete="off"
      onKeyDown={event => { if (event.key === 'Enter') void remove() }} placeholder={project.name} />
    <div className="sheet-actions">
      <button className="paper-btn" onClick={onClose}>Cancel</button>
      <button className="paper-btn danger" disabled={!matches || busy} onClick={() => { void remove() }}>{busy ? 'Deleting…' : 'Delete project'}</button>
    </div>
  </Modal>
}
