import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { ArrowUp, Ellipsis, File, FileKey, Folder, FolderOpen, Pencil, Plug, Plus, RefreshCw, Server, SquareTerminal, Trash2 } from 'lucide-react'
import { type RemoteListing, type SshHost, type SshOverview, desktop, hostLabel, nameHost, ssh } from './bridge'
import { Icon, IconButton, Modal, type MenuEntry } from './ui'

export const blankHost: SshHost = { id: '', name: '', host: '', user: '', port: null, identityFile: '', jump: '', forwards: [], remotePath: '', source: 'saved' }

export function HostDialog({ host, onClose, onSaved }: { host: SshHost; onClose: () => void; onSaved: (host: SshHost) => void }) {
  const [draft, setDraft] = useState({ ...blankHost, ...host, port: host.port ?? null })
  const [forwards, setForwards] = useState(host.forwards.join(', '))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (change: Partial<SshHost>) => setDraft(value => ({ ...value, ...change }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const saved = await ssh.save({ ...draft, source: 'saved', forwards: forwards.split(/[,\s]+/).filter(Boolean) })
      onSaved(saved)
      onClose()
    } catch (failure) { setError(String(failure)) } finally { setBusy(false) }
  }

  async function chooseKey() {
    const path = await open({ multiple: false, directory: false, title: 'Choose a private key' }).catch(() => null)
    if (typeof path === 'string') set({ identityFile: path })
  }

  // Accept "user@host:port" pasted into the host field.
  function parseHost(value: string) {
    const match = /^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/.exec(value.trim())
    if (match && (match[1] || match[3])) set({ host: match[2], user: match[1] ?? draft.user, port: match[3] ? Number(match[3]) : draft.port })
    else set({ host: value })
  }

  return <Modal title={host.id ? 'Edit server' : 'Add server'} onClose={onClose}>
    <form className="sheet-body form-grid" onSubmit={submit}>
      <label>Name<input className="field" value={draft.name} onChange={event => set({ name: event.target.value })} placeholder="Build server" /></label>
      <label>Host<input className="field" value={draft.host} onChange={event => parseHost(event.target.value)} placeholder="example.com or 10.0.0.5" autoFocus required spellCheck={false} /></label>
      <div className="grid grid-cols-[1fr_96px] gap-2">
        <label>User<input className="field" value={draft.user ?? ''} onChange={event => set({ user: event.target.value })} placeholder="Your user name" spellCheck={false} /></label>
        <label>Port<input className="field" inputMode="numeric" value={draft.port ?? ''} onChange={event => set({ port: event.target.value ? Number(event.target.value.replace(/\D/g, '')) || null : null })} placeholder="22" /></label>
      </div>
      <label>Private key <span className="help">optional; agents and ~/.ssh keys are used automatically</span>
        <span className="flex gap-1"><input className="field" value={draft.identityFile ?? ''} onChange={event => set({ identityFile: event.target.value })} placeholder="~/.ssh/id_ed25519" spellCheck={false} />
          {desktop && <IconButton glyph={FileKey} label="Choose key file" onClick={() => { void chooseKey() }} />}</span>
      </label>
      <label>Jump host <span className="help">optional, for servers behind a bastion</span><input className="field" value={draft.jump ?? ''} onChange={event => set({ jump: event.target.value })} placeholder="user@bastion.example.com" spellCheck={false} /></label>
      <label>Default folder <span className="help">optional</span><input className="field" value={draft.remotePath ?? ''} onChange={event => set({ remotePath: event.target.value })} placeholder="~/projects/app" spellCheck={false} /></label>
      <label>Port forwards <span className="help">optional, local:host:remote</span><input className="field" value={forwards} onChange={event => setForwards(event.target.value)} placeholder="8080:localhost:80, 5432:db:5432" spellCheck={false} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="sheet-actions">
        <button type="button" className="text-btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="text-btn primary" disabled={busy || !draft.host.trim()}>Save server</button>
      </div>
    </form>
  </Modal>
}

const recentKey = (id: string) => 'still.remote.recent.' + id
export function recentRemote(id: string): string[] {
  try { return JSON.parse(localStorage.getItem(recentKey(id)) ?? '[]') } catch { return [] }
}
function rememberRemote(id: string, path: string) {
  try { localStorage.setItem(recentKey(id), JSON.stringify([path, ...recentRemote(id).filter(item => item !== path)].slice(0, 5))) } catch { /* optional */ }
}
const baseName = (path: string) => path === '/' ? '/' : path.split('/').filter(Boolean).at(-1) ?? path
const parentOf = (path: string) => path === '/' ? '/' : path.replace(/\/[^/]+\/?$/, '') || '/'

/**
 * Connects to the server first, then lets the user walk its folders and pick one,
 * the way VS Code's remote "Open Folder" works. Nothing has to be typed in advance.
 */
export function OpenRemoteDialog({ host, onClose, onOpen, onBack }: { host: SshHost; onClose: () => void; onOpen: (path: string) => Promise<void>; onBack?: () => void }) {
  const [listing, setListing] = useState<RemoteListing | null>(null)
  const [typed, setTyped] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [hidden, setHidden] = useState(false)
  const [active, setActive] = useState(0)
  const [opening, setOpening] = useState(false)
  const request = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const crumbRef = useRef<HTMLElement>(null)
  useEffect(() => { nameHost(host.id, host.name) }, [host])
  useEffect(() => { const nav = crumbRef.current; if (nav) nav.scrollLeft = nav.scrollWidth }, [listing?.path])

  async function go(path: string) {
    const ticket = ++request.current
    setLoading(true); setError('')
    try {
      const next = await ssh.browse(host.id, path)
      if (ticket !== request.current) return
      setListing(next); setTyped(next.path); setActive(0)
      listRef.current?.scrollTo({ top: 0 })
      const focused = document.activeElement
      if (!focused || focused === document.body || listRef.current?.contains(focused) || focused.closest('.rb-crumbs, .rb-places, .rb-up')) requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }))
    } catch (failure) {
      if (ticket !== request.current) return
      setError(String(failure))
      if (listing) setTyped(listing.path)
    } finally { if (ticket === request.current) setLoading(false) }
  }
  useEffect(() => { void go(host.remotePath || '~') }, [host.id])

  async function openPath(path: string) {
    setOpening(true); setError('')
    try { await onOpen(path); rememberRemote(host.id, path); onClose() } catch (failure) { setError(String(failure)) } finally { setOpening(false) }
  }

  const folders = (listing?.entries ?? []).filter(entry => hidden || !entry.name.startsWith('.'))
  const pretty = (path: string) => listing?.home && (path === listing.home || path.startsWith(listing.home + '/')) ? '~' + path.slice(listing.home.length) : path
  const crumbs = listing ? listing.path.split('/').filter(Boolean).map((part, index, parts) => ({ label: part, path: '/' + parts.slice(0, index + 1).join('/') })) : []
  const recents = recentRemote(host.id)
  const connected = !!listing

  function keys(event: KeyboardEvent<HTMLElement>) {
    const dirs = folders.filter(entry => entry.directory)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(0, Math.min(dirs.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)))
      setActive(next)
      listRef.current?.querySelectorAll('.rb-dir')[next]?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && listing) { event.preventDefault(); void openPath(listing.path) }
    else if ((event.key === 'ArrowRight' || (event.key === 'Enter' && event.target === listRef.current)) && dirs[active] && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); void go(dirs[active].path) }
    else if ((event.key === 'ArrowLeft' || event.key === 'Backspace') && listing && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); void go(parentOf(listing.path)) }
  }

  return <Modal title={'Open folder on ' + host.name} onClose={onClose} wide className="remote-browser">
    <div className="sheet-body rb" onKeyDown={keys}>
      <div className="rb-status">
        <span className={'rb-dot' + (connected ? ' on' : loading ? ' busy' : '')} />
        <span>{connected ? 'Connected to ' + hostLabel(host) : loading ? 'Connecting to ' + hostLabel(host) + '…' : 'Not connected'}</span>
        {onBack && <button type="button" className="quiet-link ml-auto" onClick={onBack}>Other server</button>}
      </div>

      {connected && <>
        <form className="rb-path" onSubmit={event => { event.preventDefault(); void go(typed) }}>
          <button type="button" className="rb-up" onClick={() => void go(parentOf(listing.path))} disabled={listing.path === '/'} title="Up one folder (Backspace)" aria-label="Up one folder"><Icon glyph={ArrowUp} size={13} /></button>
          <nav className="rb-crumbs" aria-label="Current folder" ref={crumbRef}>
            <button type="button" onClick={() => void go('/')}>/</button>
            {crumbs.map(crumb => <button type="button" key={crumb.path} onClick={() => void go(crumb.path)}>{crumb.label}</button>)}
          </nav>
          <input className="field rb-type" value={typed === listing.path ? '' : typed} onChange={event => setTyped(event.target.value || listing.path)} placeholder="Go to path…" spellCheck={false} aria-label="Go to a path" />
        </form>
        <div className="rb-places">
          <button type="button" onClick={() => void go('~')} className={listing.path === listing.home ? 'is-active' : ''}>Home</button>
          {recents.filter(path => path !== listing.home).slice(0, 4).map(path => <button type="button" key={path} onClick={() => void go(path)} title={path}>{pretty(path)}</button>)}
          <label className="rb-hidden"><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} /> Hidden</label>
        </div>
      </>}

      <div className={'rb-list' + (loading ? ' is-loading' : '')} ref={listRef} tabIndex={-1} role="listbox" aria-label="Folders">
        {!connected && loading && <p className="rb-note">Connecting… If the server needs a password, Still will ask for it once.</p>}
        {connected && !folders.length && !loading && <p className="rb-note">This folder is empty.</p>}
        {(() => { let dir = -1; return folders.map(entry => {
          if (!entry.directory) return <div key={entry.path} className="rb-row rb-file"><Icon glyph={File} size={13} /><span>{entry.name}</span></div>
          dir++
          const index = dir
          return <div key={entry.path} className={'rb-row rb-dir' + (index === active ? ' is-active' : '')} role="option" aria-selected={index === active} onMouseEnter={() => setActive(index)}>
            <button type="button" className="rb-enter" onClick={() => void go(entry.path)} onDoubleClick={() => void openPath(entry.path)} title={'Show what is in ' + entry.name}>
              <Icon glyph={Folder} size={13} /><span>{entry.name}</span>
            </button>
            <button type="button" className="rb-open" onClick={() => void openPath(entry.path)}>Open</button>
          </div>
        }) })()}
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="sheet-actions">
        <span className="help mr-auto truncate">{connected ? 'Click a folder to look inside · Ctrl+Enter opens this one' : 'Files are read and saved over SSH'}</span>
        <button type="button" className="text-btn" onClick={onClose}>Cancel</button>
        {!connected && !loading && <button type="button" className="text-btn primary" onClick={() => void go(host.remotePath || '~')}>Try again</button>}
        {connected && <button type="button" className="text-btn primary" disabled={opening || loading} onClick={() => void openPath(listing.path)}>{opening ? 'Opening…' : listing.path === listing.home ? 'Open home folder' : 'Open ' + baseName(listing.path)}</button>}
      </div>
    </div>
  </Modal>
}

/** "Connect to server": pick a known server or type user@host, then browse its folders. */
export function ConnectDialog({ hosts, onClose, onOpen, onAdvanced, initial = '' }: { hosts: SshHost[]; onClose: () => void; onOpen: (host: SshHost, path: string) => Promise<void>; onAdvanced: (host: SshHost) => void; initial?: string }) {
  const [target, setTarget] = useState(initial)
  const [host, setHost] = useState<SshHost | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (host) return <OpenRemoteDialog host={host} onClose={onClose} onOpen={path => onOpen(host, path)} onBack={() => setHost(null)} />

  const term = target.trim().toLowerCase()
  const matches = hosts.filter(item => !term || item.name.toLowerCase().includes(term) || hostLabel(item).toLowerCase().includes(term))
  const parsed = /^(?:([^@\s]+)@)?([^:\s@]+)(?::(\d+))?$/.exec(target.trim())

  async function connectNew() {
    if (!parsed) { setError('Type a server as user@host, for example mike@10.0.0.12'); return }
    const existing = hosts.find(item => item.host === parsed[2] && (item.user || '') === (parsed[1] || item.user || '') && (!parsed[3] || item.port === Number(parsed[3])))
    if (existing) { setHost(existing); return }
    setBusy(true); setError('')
    try { setHost(await ssh.save({ ...blankHost, name: parsed[2], host: parsed[2], user: parsed[1] ?? '', port: parsed[3] ? Number(parsed[3]) : null })) }
    catch (failure) { setError(String(failure)) } finally { setBusy(false) }
  }

  return <Modal title="Connect to server" onClose={onClose} className="remote-browser">
    <form className="sheet-body rb" onSubmit={event => { event.preventDefault(); if (matches.length === 1 && term && !parsed?.[1]) setHost(matches[0]); else void connectNew() }}>
      <input className="field field-lg" value={target} onChange={event => { setTarget(event.target.value); setError('') }} placeholder="user@host" autoFocus spellCheck={false} aria-label="Server" />
      <div className="rb-list rb-hosts">
        {matches.map(item => <button type="button" key={item.id} className="rb-row rb-host" onClick={() => setHost(item)}>
          <Icon glyph={Server} size={13} /><span>{item.name}</span><code>{item.source === 'config' && !item.user ? 'ssh config' : hostLabel(item)}</code>
        </button>)}
        {parsed && !matches.some(item => hostLabel(item) === target.trim()) && <button type="submit" className="rb-row rb-host" disabled={busy}>
          <Icon glyph={Plus} size={13} /><span>Connect to {target.trim()}</span>
        </button>}
        {!matches.length && !parsed && <p className="rb-note">Type a server as user@host. Servers from ~/.ssh/config show up here too.</p>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="sheet-actions">
        <button type="button" className="quiet-link mr-auto" onClick={() => onAdvanced(parsed ? { ...blankHost, host: parsed[2], user: parsed[1] ?? '', port: parsed[3] ? Number(parsed[3]) : null } : blankHost)}>Keys, jump host, ports…</button>
        <button type="button" className="text-btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="text-btn primary" disabled={busy || !term}>Connect</button>
      </div>
    </form>
  </Modal>
}

interface PanelProps {
  overview: SshOverview | null
  onRefresh: () => void
  onTerminal: (host: SshHost) => void
  onOpenFolder: (host: SshHost) => void
  onEdit: (host: SshHost) => void
  onMenu: (event: MouseEvent, items: MenuEntry[]) => void
  onDelete: (host: SshHost) => void
  onTest: (host: SshHost) => void
}

export function hostMenu(host: SshHost, props: Pick<PanelProps, 'onTerminal' | 'onOpenFolder' | 'onEdit' | 'onDelete' | 'onTest'>): MenuEntry[] {
  return [
    { label: 'Open terminal', icon: SquareTerminal, action: () => props.onTerminal(host) },
    { label: 'Open folder…', icon: FolderOpen, action: () => props.onOpenFolder(host) },
    { label: 'Test connection', icon: Plug, action: () => props.onTest(host) },
    'separator',
    host.source === 'saved'
      ? { label: 'Edit…', icon: Pencil, action: () => props.onEdit(host) }
      : { label: 'Save a copy…', icon: Pencil, action: () => props.onEdit({ ...host, id: '', source: 'saved', name: host.name }) },
    ...(host.source === 'saved' ? [{ label: 'Remove server', icon: Trash2, danger: true, action: () => props.onDelete(host) }] : []),
  ]
}

export function HostRow({ host, ...props }: { host: SshHost } & Omit<PanelProps, 'overview' | 'onRefresh'>) {
  return <div className="panel-row host-row" onContextMenu={event => { event.preventDefault(); props.onMenu(event, hostMenu(host, props)) }}>
    <button className="panel-row-main" onClick={() => props.onTerminal(host)} title={'Open a terminal on ' + hostLabel(host)}>
      <Icon glyph={Server} size={13} /><span>{host.name}</span><span className="help">{hostLabel(host)}</span>
    </button>
    <IconButton glyph={FolderOpen} size={14} className="row-action" label={'Open folder on ' + host.name} onClick={() => props.onOpenFolder(host)} />
    <IconButton glyph={Ellipsis} size={14} className="row-action" label={'More actions for ' + host.name} onClick={event => {
      const box = event.currentTarget.getBoundingClientRect()
      props.onMenu({ ...event, clientX: box.left, clientY: box.bottom + 4 } as MouseEvent, hostMenu(host, props))
    }} />
  </div>
}

export function RemotePanel(props: PanelProps) {
  useEffect(() => { props.onRefresh() }, [])
  const overview = props.overview
  return <>
    <div className="side-head"><h2 className="section-label">Remote</h2>
      <div className="flex items-center gap-0.5">
        <IconButton glyph={Plus} label="Add server" onClick={() => props.onEdit(blankHost)} disabled={!desktop} />
        <IconButton glyph={RefreshCw} label="Refresh servers" onClick={props.onRefresh} />
      </div>
    </div>
    <div className="sidebar-content">
      {!desktop && <p className="help">SSH connections are available in the Still desktop app.</p>}
      {desktop && overview && !overview.client && <p className="help mb-3">The OpenSSH client was not found. Install it (Windows: Settings → Optional features → OpenSSH Client) to connect to servers.</p>}
      <section className="panel-group mt-1">
        <h3>Saved servers<span>{overview?.saved.length ?? 0}</span></h3>
        {overview?.saved.map(host => <HostRow key={host.id} host={host} {...props} />)}
        {overview && !overview.saved.length && <button className="text-btn w-full" onClick={() => props.onEdit(blankHost)} disabled={!desktop}><Icon glyph={Plus} size={13} /> Add a server</button>}
      </section>
      {!!overview?.imported.length && <section className="panel-group">
        <h3>From ~/.ssh/config<span>{overview.imported.length}</span></h3>
        {overview.imported.map(host => <HostRow key={host.id} host={host} {...props} />)}
      </section>}
      {overview?.client && <p className="help mt-4">{overview.client}. Keys, agents, ProxyJump and known hosts follow your normal SSH setup.</p>}
    </div>
  </>
}

/** Asks for a server password. The answer stays in memory for this session only. */
export function PasswordDialog({ host, retry, onAnswer }: { host: string; retry: boolean; onAnswer: (password: string | null) => void }) {
  return <LoginPrompt host={host} prompt="Password:" kind="password" retry={retry} onAnswer={onAnswer} />
}

/**
 * One question from the server while signing in, in the server's own words: a password,
 * a key passphrase, or a one-time verification code. Passwords stay in memory for this session.
 */
export function LoginPrompt({ host, prompt, kind, retry, onAnswer }: { host: string; prompt: string; kind: string; retry: boolean; onAnswer: (answer: string | null) => void }) {
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const code = kind === 'code'
  const label = prompt.replace(/\s*:\s*$/, '').replace(/^\([^)]*\)\s*/, '') || 'Password'
  return <Modal title={'Sign in to ' + host} onClose={() => onAnswer(null)} className="login-prompt">
    <form className="sheet-body form-grid" onSubmit={event => { event.preventDefault(); onAnswer(value) }}>
      <label>{label}
        <span className="flex gap-1">
          <input className="field field-lg" type={code || show ? 'text' : 'password'} value={value} onChange={event => setValue(event.target.value)} autoFocus
            autoComplete={code ? 'one-time-code' : 'current-password'} inputMode={code && /code|pin|otp/i.test(prompt) ? 'numeric' : undefined} spellCheck={false} />
          {!code && <button type="button" className="text-btn" onClick={() => setShow(value => !value)}>{show ? 'Hide' : 'Show'}</button>}
        </span>
      </label>
      {retry && <p className="form-error" role="alert">{kind === 'password' ? "That password didn't work. Try again." : 'The server asked again. Check what you typed.'}</p>}
      <p className="help">{code
        ? 'The server asks for a one-time code as a second step. It is sent straight to the server and not kept.'
        : kind === 'passphrase' ? 'Unlocks your SSH key for this session. Still keeps it in memory until you quit and never writes it to disk.'
        : 'Still keeps this password in memory until you quit and never writes it to disk. An SSH key avoids this prompt entirely.'}</p>
      <div className="sheet-actions">
        <button type="button" className="text-btn" onClick={() => onAnswer(null)}>Cancel</button>
        <button type="submit" className="text-btn primary" disabled={!value}>Continue</button>
      </div>
    </form>
  </Modal>
}
