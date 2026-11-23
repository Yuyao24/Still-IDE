import { useEffect, useState, type FormEvent, type MouseEvent } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Ellipsis, FileKey, FolderOpen, Pencil, Plug, Plus, RefreshCw, Server, SquareTerminal, Trash2 } from 'lucide-react'
import { type SshHost, type SshOverview, desktop, hostLabel, nameHost, ssh } from './bridge'
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

export function OpenRemoteDialog({ host, onClose, onOpen }: { host: SshHost; onClose: () => void; onOpen: (path: string) => Promise<void> }) {
  const [path, setPath] = useState(host.remotePath || '~')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { nameHost(host.id, host.name) }, [host])
  return <Modal title={'Open folder on ' + host.name} onClose={onClose}>
    <form className="sheet-body form-grid" onSubmit={event => {
      event.preventDefault()
      setBusy(true); setError('')
      onOpen(path).then(onClose).catch(failure => setError(String(failure))).finally(() => setBusy(false))
    }}>
      <label>Folder on the server<input className="field" value={path} onChange={event => setPath(event.target.value)} autoFocus spellCheck={false} placeholder="~/projects/app" /></label>
      <p className="help">{hostLabel(host)} · Files are read and saved over SSH. If the server needs a password, Still asks for it once and keeps it in memory until you quit.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="sheet-actions">
        <button type="button" className="text-btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="text-btn primary" disabled={busy || !path.trim()}>{busy ? 'Connecting…' : 'Open folder'}</button>
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
  const [value, setValue] = useState('')
  return <Modal title={'Password for ' + host} onClose={() => onAnswer(null)}>
    <form className="sheet-body form-grid" onSubmit={event => { event.preventDefault(); onAnswer(value) }}>
      <label>Password<input className="field field-lg" type="password" value={value} onChange={event => setValue(event.target.value)} autoFocus autoComplete="current-password" /></label>
      {retry && <p className="form-error" role="alert">That password didn't work. Try again.</p>}
      <p className="help">Used to browse, save and run files on {host}. Still keeps it in memory until you quit and never writes it to disk. An SSH key avoids this prompt entirely.</p>
      <div className="sheet-actions">
        <button type="button" className="text-btn" onClick={() => onAnswer(null)}>Cancel</button>
        <button type="submit" className="text-btn primary" disabled={!value}>Connect</button>
      </div>
    </form>
  </Modal>
}
