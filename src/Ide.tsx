import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Terminal as Xterm } from '@xterm/xterm'
import {
  ArrowDown, ArrowUp, Braces, Check, ChevronRight, Circle, CircleAlert, CodeXml, Columns2, Copy, FilePlus2, Files, FolderOpen, FolderPlus,
  FolderSearch, GitBranch, GitCompareArrows, GitPullRequestArrow, Hammer, House, Moon, Package, PanelBottom, PanelLeft, Pencil, Play, Plus,
  RefreshCw, Rows2, Search, Server, Settings2, Square, SquareTerminal, Sun, TerminalSquare, Trash2, WrapText, X,
} from 'lucide-react'
import {
  api, desktop, fileName, fileSystem, home, mod, parentPath, pickFolder, ssh,
  type Branches, type Change, type Commit, type Diagnostic, type Diff, type Entry, type GitStatus, type JobEvent, type Packages, type Runtimes,
  type SshHost, type SshOverview, type Workspace,
} from './bridge'
import mark from './still.svg?inline'
import Editor, { defaultIndent, language, type Cursor, type EditorHandle, type EditorMemory, type EditorOptions } from './Editor'
import type { OpenOptions } from './Home'
import { Explorer, PackagesPanel, Palette, SourceControl, isVirtual, symbolsFor, type PaletteItem } from './Panels'
import { HostDialog, OpenRemoteDialog, RemotePanel, blankHost } from './Remote'
import { SearchPanel } from './Search'
import type { SettingsSection } from './SettingsView'
import { useSettings } from './settings'
import Terminal, { type TerminalSession } from './Terminal'
import { presets } from './themes'
import { TitleBar } from './TitleBar'
import { Dialog, Output, Problems, SplitGrip, type DialogState, type OutputEntry } from './Workbench'
import { FileIcon, Icon, IconButton, Menu, type MenuEntry, type MenuState } from './ui'

type Side = 'explorer' | 'search' | 'git' | 'packages' | 'remote'
type Drawer = 'terminal' | 'output' | 'problems'
type Tab = { id: string; path: string; contents: string; saved: string; memory?: EditorMemory; diff?: Diff; staged?: boolean; line?: number }
type Job = { id: string; kind: 'run' | 'git' | 'packages'; action: string }

const emptyStatus: GitStatus = { branch: null, changes: [] }
const initialOutput: OutputEntry[] = [
  { kind: 'command', text: '$ python -u src/app.py' },
  { kind: 'stdout', text: 'ISS         92.58 min\nHubble      95.30 min' },
  { kind: 'exit', text: 'Process exited with code 0.', code: 0 },
]
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const dirty = (tab: Tab) => !tab.diff && tab.contents !== tab.saved
const fileTab = (path: string, contents: string, line?: number): Tab => ({ id: path, path, contents, saved: contents, memory: {}, line })
const localRunnable = ['Python', 'Java', 'JavaScript', 'Go', ...(navigator.userAgent.includes('Windows') ? [] : ['Shell'])]
const remoteRunnable = ['Python', 'Java', 'JavaScript', 'Go', 'Shell', 'Ruby']

function storedSize(key: string, fallback: number) {
  const value = Number(localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

interface Props {
  workspace: Workspace
  initial?: OpenOptions
  onHome: () => void
  onSwitch: (workspace: Workspace) => void
  onSettings: (section?: SettingsSection) => void
  onToggleTheme: () => void
  notify: (message: unknown) => void
}

export default function Ide({ workspace, initial, onHome, onSwitch, onSettings, onToggleTheme, notify: toast }: Props) {
  const { settings, theme, update } = useSettings()
  const fs = useMemo(() => fileSystem(workspace), [workspace])
  const remote = Boolean(workspace.remote)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [selected, setSelected] = useState('')
  const [cursor, setCursor] = useState<Cursor>({ line: 1, column: 1 })
  const [sidebar, setSidebar] = useState<Side | null>('explorer')
  const [lastSide, setLastSide] = useState<Side>('explorer')
  const [sideWidth, setSideWidth] = useState(() => storedSize('still.sidebar.width', 240))
  const [drawer, setDrawer] = useState<Drawer>('output')
  const [drawerOpen, setDrawerOpen] = useState(Boolean(workspace.sample) || remote)
  const [drawerHeight, setDrawerHeight] = useState(() => storedSize('still.drawer.height', 242))
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [activeSession, setActiveSession] = useState('')
  const sessionsRef = useRef<TerminalSession[]>([])
  const [frame, setFrame] = useState({ width: window.innerWidth, height: window.innerHeight })
  const [directories, setDirectories] = useState<Record<string, Entry[]>>({})
  const [expanded, setExpanded] = useState(new Set<string>())
  const [files, setFiles] = useState<Entry[]>([])
  const [status, setStatus] = useState(emptyStatus)
  const [gitError, setGitError] = useState('')
  const [log, setLog] = useState<Commit[]>([])
  const [packageState, setPackageState] = useState<Packages | null>(null)
  const [runtimes, setRuntimes] = useState<Runtimes | null>(null)
  const [servers, setServers] = useState<SshOverview | null>(null)
  const [output, setOutput] = useState<OutputEntry[]>([])
  const [sampleRun, setSampleRun] = useState(false)
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [job, setJob] = useState<Job | null>(null)
  const [runningRequest, setRunningRequest] = useState(false)
  const [jobReady, setJobReady] = useState(!desktop)
  const [gitBusy, setGitBusy] = useState(false)
  const [commit, setCommit] = useState('')
  const [runArgs, setRunArgs] = useState<Record<string, string>>({})
  const [palette, setPalette] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editingHost, setEditingHost] = useState<SshHost | null>(null)
  const [remoteHost, setRemoteHost] = useState<SshHost | null>(null)
  const [searchFocus, setSearchFocus] = useState(0)
  const generation = useRef(0)
  const editor = useRef<EditorHandle | null>(null)
  const terminal = useRef<Xterm | null>(null)
  const activeJob = useRef<Job | null>(null)
  const latest = useRef({ tabs, selected, expanded })
  latest.current = { tabs, selected, expanded }
  const saving = useRef(new Map<string, Promise<void>>())
  const opening = useRef(new Map<string, Promise<void>>())
  const pendingJump = useRef<{ path: string; line: number; column?: number; length?: number } | null>(null)
  const windowCloseApproved = useRef(false)
  const returnedFocus = useRef<HTMLElement | null>(null)
  const pendingVenv = useRef(Boolean(initial?.venv))

  const active = tabs.find(tab => tab.id === selected)
  const mode = active ? language(active.path) : null
  const runnable = Boolean(active && !active.diff && mode && (remote ? remoteRunnable : localRunnable).includes(mode))
  const symbols = useMemo(() => active && !active.diff ? symbolsFor(active.contents, active.path) : [], [active?.path, active?.contents, active?.diff])
  const currentSymbol = [...symbols].reverse().find(symbol => symbol.line <= cursor.line)
  const problemCount = diagnostics.filter(item => item.severity === 'error').length
  const warningCount = diagnostics.length - problemCount
  const runtime = remote ? null : mode === 'Java' ? runtimes?.java : mode === 'JavaScript' ? runtimes?.node : mode === 'Python' ? runtimes?.python : runtimes?.python ?? runtimes?.java
  const runtimeMissing = mode === 'Java' ? 'JDK unavailable' : mode === 'Python' ? 'Python unavailable' : mode === 'JavaScript' ? 'Node unavailable' : 'No runtime'
  const sideMax = Math.max(160, Math.min(520, frame.width <= 690 ? Math.floor(frame.width * .3) : frame.width <= 790 ? Math.floor(frame.width * .34) : frame.width - 360))
  const workspaceWidth = Math.min(sideWidth, sideMax)
  const drawerMax = Math.max(128, frame.height - 220)
  const actualDrawerHeight = Math.min(drawerHeight, drawerMax)
  const tabSize = settings.tabSize === 'auto' ? (active ? defaultIndent(active.path) : 4) : settings.tabSize
  const editorOptions: EditorOptions = { wrap: settings.wordWrap, lineNumbers: settings.lineNumbers, highlightLine: settings.highlightLine, tabSize, layout: settings.diffLayout }
  const host = remote ? [...(servers?.saved ?? []), ...(servers?.imported ?? [])].find(item => item.id === workspace.remote) : undefined

  const notify = useCallback((error: unknown) => toast(errorText(error)), [toast])

  useEffect(() => { localStorage.setItem('still.sidebar.width', String(sideWidth)) }, [sideWidth])
  useEffect(() => { localStorage.setItem('still.drawer.height', String(drawerHeight)) }, [drawerHeight])
  useEffect(() => {
    const resize = () => setFrame({ width: window.innerWidth, height: window.innerHeight })
    addEventListener('resize', resize)
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (latest.current.tabs.some(dirty)) { event.preventDefault(); event.returnValue = '' }
    }
    if (!desktop) window.addEventListener('beforeunload', beforeUnload)
    return () => { removeEventListener('resize', resize); window.removeEventListener('beforeunload', beforeUnload) }
  }, [])

  async function refreshGit(id = generation.current) {
    if (remote) return
    try {
      const result = await api.git(workspace.root)
      if (generation.current === id) { setStatus(result); setGitError('') }
    } catch (error) { if (generation.current === id) setGitError(errorText(error)) }
  }

  async function refreshLog(id = generation.current) {
    if (remote) return
    try {
      const result = await api.log(workspace.root)
      if (generation.current === id) setLog(result)
    } catch { /* not a repository */ }
  }

  async function refreshPackages(id = generation.current) {
    if (remote) return
    try {
      const result = await api.packages(workspace.root)
      if (generation.current === id) setPackageState(result)
    } catch (error) { if (generation.current === id) notify(error) }
  }

  async function refreshServers() {
    try { setServers(await ssh.hosts()) } catch (error) { notify(error) }
  }

  async function directory(path: string, id = generation.current) {
    try {
      const result = await fs.list(path)
      if (generation.current === id) setDirectories(previous => ({ ...previous, [path]: result }))
    } catch (error) { if (generation.current === id) notify(error) }
  }

  async function refreshFiles(folders: Iterable<string> = latest.current.expanded, id = generation.current) {
    try {
      await Promise.all(['', ...folders].map(path => directory(path, id)))
      if (!remote) { const result = await fs.files(); if (generation.current === id) setFiles(result) }
    } catch (error) { if (generation.current === id) notify(error) }
  }

  async function refreshCleanTabs(id = generation.current) {
    const originals = latest.current.tabs.filter(tab => !tab.diff && !dirty(tab))
    const reads = await Promise.allSettled(originals.map(tab => fs.read(tab.path)))
    if (generation.current !== id) return
    const replacements = new Map<string, { original: Tab; contents: string }>()
    reads.forEach((result, index) => {
      const original = originals[index]
      if (result.status === 'fulfilled' && result.value !== original.saved) replacements.set(original.id, { original, contents: result.value })
    })
    if (!replacements.size) return
    setTabs(previous => previous.map(tab => {
      const replacement = replacements.get(tab.id)
      return replacement && tab.memory === replacement.original.memory && !dirty(tab) && tab.saved === replacement.original.saved
        ? fileTab(tab.path, replacement.contents) : tab
    }))
  }

  useEffect(() => {
    const id = ++generation.current
    const initialFolders = workspace.sample ? ['src', 'tests'] : []
    setExpanded(new Set(initialFolders))
    setOutput(workspace.sample ? initialOutput : [])
    setSampleRun(Boolean(workspace.sample))
    void refreshFiles(initialFolders, id)
    void refreshGit(id)
    if (remote) void refreshServers()
    else void api.runtimes(workspace.root).then(result => { if (generation.current === id) setRuntimes(result) }).catch(error => { if (generation.current === id) notify(error) })
    if (remote) showDrawer('terminal')
    void (async () => {
      const readme = ['README.md', 'readme.md', 'README.txt']
      const entries = await fs.list('').catch(() => [] as Entry[])
      const paths = workspace.sample ? ['README.md', 'src/app.py', 'src/Main.java'] : entries.filter(entry => !entry.directory && readme.includes(entry.name)).map(entry => entry.path).slice(0, 1)
      const opened = await Promise.all(paths.map(path => fs.read(path).then(contents => fileTab(path, contents, workspace.sample && path === 'src/app.py' ? 11 : undefined)).catch(() => null)))
      if (generation.current !== id) return
      const available = opened.filter(tab => tab !== null)
      setTabs(previous => [...available.filter(tab => !previous.some(existing => existing.id === tab.id)), ...previous])
      setSelected(previous => previous || (available.some(tab => tab.id === 'src/app.py') ? 'src/app.py' : available[0]?.id ?? ''))
    })()
    return () => { generation.current++ }
  }, [])

  useEffect(() => {
    if (sidebar === 'git') { void refreshGit(); void refreshLog() }
    if (sidebar === 'packages') void refreshPackages()
  }, [sidebar])

  useEffect(() => {
    if (!jobReady || !pendingVenv.current) return
    pendingVenv.current = false
    packageAction('venv')
  }, [jobReady])

  function askDiscard(title: string, description: string, action: () => void) {
    setDialog({ title, description, label: 'Discard changes', danger: true, action })
  }

  function busyGuard() {
    if (activeJob.current || runningRequest || saving.current.size || gitBusy) { notify('Wait for the current operation to finish.'); return true }
    return false
  }

  function leave(action: () => void, title: string) {
    if (busyGuard()) return
    if (latest.current.tabs.some(dirty)) askDiscard(title, 'Open files have unsaved changes.', action)
    else action()
  }

  function goHome() { leave(onHome, 'Leave ' + workspace.name + '?') }

  function chooseFolder() {
    leave(() => {
      void pickFolder('Open a project folder').then(async path => {
        if (path) onSwitch(await home.open(path))
      }).catch(notify)
    }, 'Switch project?')
  }

  function approvalAndClose() {
    windowCloseApproved.current = true
    void getCurrentWindow().close().catch(error => { windowCloseApproved.current = false; notify(error) })
  }

  useEffect(() => {
    if (!desktop) return
    let unlisten: UnlistenFn | undefined
    let closed = false
    void getCurrentWindow().onCloseRequested(event => {
      if (!windowCloseApproved.current && latest.current.tabs.some(dirty)) {
        event.preventDefault()
        askDiscard('Close Still?', 'Open files have unsaved changes.', approvalAndClose)
      }
    }).then(stop => { if (closed) stop(); else unlisten = stop }).catch(notify)
    return () => { closed = true; unlisten?.() }
  }, [])

  useEffect(() => {
    if (!desktop) return
    let unsubscribe: UnlistenFn | undefined
    let cancelled = false
    void listen<JobEvent>('job-output', ({ payload }) => {
      const current = activeJob.current
      if (!current || payload.id !== current.id) return
      setOutput(previous => {
        const last = previous.at(-1)
        if (last && (payload.kind === 'stdout' || payload.kind === 'stderr') && last.kind === payload.kind) {
          return [...previous.slice(0, -1), { ...last, text: (last.text + payload.text).slice(-180000) }]
        }
        return [...previous.slice(-299), { kind: payload.kind, text: payload.text, code: payload.code }]
      })
      if (payload.kind !== 'exit') return
      activeJob.current = null
      setJob(null)
      if (current.kind === 'run') setDiagnostics(payload.diagnostics)
      if (current.kind === 'git') {
        void refreshGit()
        if (['pull', 'fetch'].includes(current.action)) void refreshLog()
        if (current.action === 'pull' && payload.code === 0) { void refreshFiles(); void refreshCleanTabs() }
        if (current.action === 'commit' && payload.code === 0) { setCommit(''); void refreshLog() }
      }
      if (current.kind === 'packages') {
        void refreshPackages()
        if (current.action === 'venv') {
          void api.runtimes(workspace.root).then(setRuntimes).catch(() => {})
          void refreshFiles()
        }
      }
    }).then(stop => {
      if (cancelled) stop()
      else { unsubscribe = stop; setJobReady(true) }
    }).catch(notify)
    return () => { cancelled = true; unsubscribe?.() }
  }, [])

  function activate(path: string) {
    if (latest.current.selected === path) editor.current?.focus()
    else setSelected(path)
  }

  function expandParents(path: string) {
    const ancestors: string[] = []
    for (let parent = parentPath(path); parent; parent = parentPath(parent)) ancestors.push(parent)
    if (!ancestors.length) return
    setExpanded(previous => new Set([...previous, ...ancestors]))
    for (const item of ancestors) if (!directories[item]) void directory(item)
  }

  async function openFile(path: string) {
    const id = generation.current
    if (latest.current.tabs.some(tab => tab.id === path)) {
      activate(path)
      const jump = pendingJump.current
      if (jump?.path === path && latest.current.selected === path) { pendingJump.current = null; editor.current?.jump(jump.line, jump.column, jump.length) }
      return
    }
    if (opening.current.has(path)) return opening.current.get(path)
    const task = fs.read(path).then(contents => {
      if (generation.current !== id) return
      setTabs(previous => previous.some(tab => tab.id === path) ? previous : [...previous, fileTab(path, contents)])
      activate(path)
      expandParents(path)
    }).catch(error => {
      if (generation.current === id) { pendingJump.current = null; notify(error) }
    }).finally(() => { if (generation.current === id) opening.current.delete(path) })
    opening.current.set(path, task)
    return task
  }

  function selectEditor(handle: EditorHandle | null) {
    editor.current = handle
    const jump = pendingJump.current
    if (handle && jump && jump.path === latest.current.selected) {
      pendingJump.current = null
      requestAnimationFrame(() => handle.jump(jump.line, jump.column, jump.length))
    }
  }

  function jumpTo(item: { path: string; line: number; column?: number; length?: number }) {
    if (latest.current.selected === item.path) editor.current?.jump(item.line, item.column, item.length)
    else { pendingJump.current = item; void openFile(item.path) }
  }

  useEffect(() => {
    if (!selected || palette !== null || dialog || !active) return
    const id = requestAnimationFrame(() => editor.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [selected, !!active])

  async function openDiff(change: Change, indexed: boolean) {
    const id = generation.current
    try {
      const diff = await api.diff(workspace.root, change, indexed)
      if (generation.current !== id) return
      const key = (indexed ? 'staged:' : 'working:') + change.path
      const tab: Tab = { id: key, path: change.path, contents: '', saved: '', diff, staged: indexed }
      setTabs(previous => previous.some(item => item.id === key) ? previous.map(item => item.id === key ? tab : item) : [...previous, tab])
      activate(key)
    } catch (error) { notify(error) }
  }

  function closeTabs(close: Tab[]) {
    const ids = new Set(close.map(tab => tab.id))
    const current = latest.current.tabs
    const index = current.findIndex(item => item.id === latest.current.selected)
    const next = current.filter(item => !ids.has(item.id))
    setTabs(next)
    if (ids.has(latest.current.selected)) setSelected(next[Math.min(Math.max(index, 0), next.length - 1)]?.id ?? '')
  }

  function closeTab(tab: Tab) {
    if (dirty(tab)) askDiscard('Close ' + fileName(tab.path) + '?', 'This file has unsaved changes.', () => closeTabs([tab]))
    else closeTabs([tab])
  }

  async function store(tab?: Tab) {
    if (!tab || tab.diff) return
    const id = generation.current
    const key = tab.id
    const previousSave = saving.current.get(key)
    if (previousSave) { await previousSave; return store(tab) }
    const current = latest.current.tabs.find(item => item.id === tab.id)
    if (!current || !dirty(current)) return
    const task = fs.save(current.path, current.contents, current.saved).then(() => {
      if (generation.current !== id) return
      const markSaved = (items: Tab[]) => items.map(item => item.id === current.id ? { ...item, saved: current.contents } : item)
      latest.current.tabs = markSaved(latest.current.tabs)
      setTabs(markSaved)
      void refreshGit(id)
    })
    saving.current.set(key, task)
    try { await task } finally { if (saving.current.get(key) === task) saving.current.delete(key) }
  }

  async function storeAll() {
    for (const tab of latest.current.tabs.filter(dirty)) await store(tab).catch(notify)
  }

  // Auto save after a pause in typing.
  const dirtySignature = tabs.filter(dirty).map(tab => tab.id + ':' + tab.contents.length).join('|')
  useEffect(() => {
    if (settings.autoSave !== 'delay' || !dirtySignature) return
    const timer = setTimeout(() => { void storeAll() }, 1200)
    return () => clearTimeout(timer)
  }, [dirtySignature, settings.autoSave])
  useEffect(() => {
    if (settings.autoSave !== 'blur') return
    const blur = () => { void storeAll() }
    addEventListener('blur', blur)
    return () => removeEventListener('blur', blur)
  }, [settings.autoSave])

  function newFile(folder = '') {
    const id = generation.current
    setDialog({
      title: 'New file', description: 'Enter a path relative to the ' + (remote ? 'remote folder.' : 'workspace.'), input: folder ? folder + '/' : '', label: 'Create file',
      action: path => { void fs.create(path).then(async () => {
        if (generation.current !== id) return
        await openFile(path)
        void refreshFiles(new Set([...latest.current.expanded, parentPath(path)].filter(Boolean)), id)
        void refreshGit(id)
      }).catch(notify) },
    })
  }

  function newFolder(folder = '') {
    const id = generation.current
    setDialog({
      title: 'New folder', description: 'Enter a folder path relative to the ' + (remote ? 'remote folder.' : 'workspace.'), input: folder ? folder + '/' : '',
      placeholder: 'src/utils', inputLabel: 'Folder path', label: 'Create folder',
      action: path => { void fs.createFolder(path).then(() => {
        if (generation.current !== id) return
        setExpanded(previous => new Set([...previous, path, parentPath(path)].filter(Boolean)))
        void refreshFiles(new Set([...latest.current.expanded, path, parentPath(path)].filter(Boolean)), id)
      }).catch(notify) },
    })
  }

  function renameEntry(entry: Entry) {
    setDialog({
      title: 'Rename', input: entry.path, inputLabel: 'New path', placeholder: entry.path, label: 'Rename',
      action: to => {
        if (to === entry.path) return
        void fs.rename(entry.path, to).then(() => {
          const moved = (path: string) => path === entry.path ? to : path.startsWith(entry.path + '/') ? to + path.slice(entry.path.length) : null
          setTabs(previous => previous.map(tab => {
            const next = moved(tab.path)
            return next && !tab.diff ? { ...tab, id: next, path: next } : tab
          }))
          setSelected(previous => moved(previous) ?? previous)
          void refreshFiles(new Set([...latest.current.expanded].map(path => moved(path) ?? path).concat(parentPath(to)).filter(Boolean)))
          void refreshGit()
        }).catch(notify)
      },
    })
  }

  function deleteEntry(entry: Entry) {
    const run = () => {
      void fs.remove(entry.path).then(() => {
        closeTabs(latest.current.tabs.filter(tab => !tab.diff && (tab.path === entry.path || tab.path.startsWith(entry.path + '/'))))
        void refreshFiles()
        void refreshGit()
        if (!remote && desktop) notify(entry.name + ' was moved to the trash.')
      }).catch(notify)
    }
    if (settings.confirmDelete || remote) setDialog({
      title: 'Delete ' + entry.name + '?', label: remote ? 'Delete permanently' : 'Move to trash', danger: true, action: run,
      description: remote ? 'This permanently deletes it on the server. It cannot be undone.' : (entry.directory ? 'The folder and everything in it' : 'The file') + ' will be moved to the system trash.',
    })
    else run()
  }

  function copyText(text: string) { void navigator.clipboard.writeText(text).then(() => notify('Copied ' + text)).catch(notify) }
  const absolute = (path: string) => {
    const separator = workspace.root.includes('\\') ? '\\' : '/'
    return path ? workspace.root.replace(/[\\/]$/, '') + separator + path.split('/').join(separator) : workspace.root
  }

  function explorerMenu(event: ReactMouseEvent, entry: Entry | null) {
    const folder = entry ? (entry.directory ? entry.path : parentPath(entry.path)) : ''
    const items: MenuEntry[] = []
    if (entry && !entry.directory) items.push({ label: 'Open', icon: Files, action: () => { void openFile(entry.path) } })
    items.push({ label: 'New file…', icon: FilePlus2, action: () => newFile(folder) })
    if (desktop || remote) items.push({ label: 'New folder…', icon: FolderPlus, action: () => newFolder(folder) })
    if (entry) {
      items.push('separator',
        { label: 'Rename…', icon: Pencil, shortcut: 'F2', action: () => renameEntry(entry) },
        { label: remote ? 'Delete' : 'Move to trash', icon: Trash2, shortcut: 'Del', danger: true, action: () => deleteEntry(entry) })
    }
    items.push('separator',
      { label: 'Copy path', icon: Copy, action: () => copyText(remote ? (workspace.root + '/' + (entry?.path ?? '')).replace(/\/$/, '') : absolute(entry?.path ?? '')) },
      ...(entry ? [{ label: 'Copy relative path', icon: Copy, action: () => copyText(entry.path) }] : []))
    if (desktop && !remote) items.push({ label: 'Reveal in file manager', icon: FolderSearch, action: () => { void home.reveal(absolute(entry?.directory ? entry.path : entry ? parentPath(entry.path) : '')).catch(notify) } })
    if (!entry) items.push({ label: 'Refresh', icon: RefreshCw, action: () => { void refreshFiles() } })
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  function explorerKey(event: ReactKeyboardEvent, entry: Entry) {
    if (event.key === 'F2') { event.preventDefault(); renameEntry(entry) }
    else if (event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey)) { event.preventDefault(); deleteEntry(entry) }
  }

  function toggleFolder(path: string) {
    if (!directories[path]) void directory(path)
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function showSide(side: Side, toggle = false) {
    setLastSide(side)
    setSidebar(previous => toggle && previous === side ? null : side)
    if (side === 'search') setSearchFocus(value => value + 1)
  }

  function newSession(sshHost?: SshHost, remotePath?: string) {
    const id = crypto.randomUUID()
    const shellName = (settings.terminalShell || runtimes?.shell || 'shell').split(/[\\/]/).at(-1)!.replace(/\.exe$/i, '')
    const base = sshHost ? sshHost.name : shellName
    const taken = sessionsRef.current.filter(item => item.label === base || item.label.startsWith(base + ' ')).length
    const label = taken ? base + ' ' + (taken + 1) : base
    const session: TerminalSession = sshHost ? { id, label, ssh: sshHost.id, remotePath } : { id, label }
    sessionsRef.current = [...sessionsRef.current, session]
    setSessions(sessionsRef.current)
    setActiveSession(id)
    return session
  }

  function remoteSession() {
    const hostId = workspace.remote!
    const id = crypto.randomUUID()
    const session: TerminalSession = { id, label: workspace.hostName ?? 'ssh', ssh: hostId, remotePath: workspace.root }
    sessionsRef.current = [...sessionsRef.current, session]
    setSessions(sessionsRef.current)
    setActiveSession(id)
  }

  function showDrawer(which: Drawer, focus = false) {
    setDrawer(which)
    setDrawerOpen(true)
    if (which === 'terminal') {
      if (desktop && !sessionsRef.current.length) {
        if (remote) remoteSession()
        else newSession()
      }
      if (focus) requestAnimationFrame(() => terminal.current?.focus())
    }
  }

  function closeSession(id: string) {
    const previous = sessionsRef.current
    const index = previous.findIndex(item => item.id === id)
    const next = previous.filter(item => item.id !== id)
    sessionsRef.current = next
    setSessions(next)
    if (activeSession === id) setActiveSession(next[Math.min(index, next.length - 1)]?.id ?? '')
    if (!next.length) terminal.current = null
  }

  async function launch(kind: Job['kind'], action: string, command: string, args: object) {
    if (activeJob.current || !jobReady) { notify('The process runner is busy or still starting.'); return }
    const current = { id: crypto.randomUUID(), kind, action }
    activeJob.current = current
    setJob(current)
    setOutput([])
    setSampleRun(false)
    showDrawer('output')
    try { await invoke(command, { ...args, id: current.id }) }
    catch (error) {
      if (activeJob.current?.id === current.id) {
        activeJob.current = null
        setJob(null)
        setOutput([{ kind: 'stderr', text: errorText(error) }])
      }
    }
  }

  async function run(buildOnly = false) {
    if (!active || !runnable || runningRequest || activeJob.current) return
    if (!desktop) {
      showDrawer('output')
      notify('Run and Build use local runtimes in the Still desktop app.')
      return
    }
    if (remote && buildOnly) { notify('Check and compile run locally only. Use Run to execute the file on the server.'); return }
    setRunningRequest(true)
    try {
      await store(active)
      setDiagnostics([])
      const args = runArgs[active.path] || null
      if (remote) await launch('run', 'run', 'ssh_run', { hostId: workspace.remote, root: workspace.root, path: active.path, args })
      else await launch('run', buildOnly ? 'build' : 'run', 'run_file', { rootPath: workspace.root, path: active.path, buildOnly, args })
    } catch (error) { notify(error) }
    finally { setRunningRequest(false) }
  }

  function askArguments() {
    if (!active || !runnable) return
    const path = active.path
    setDialog({
      title: 'Run with arguments', description: 'Arguments for ' + fileName(path) + '. They are remembered for this file until you close the project.',
      input: runArgs[path] ?? '', placeholder: '--verbose input.txt "two words"', inputLabel: 'Program arguments', label: 'Run',
      action: value => { setRunArgs(previous => ({ ...previous, [path]: value })); setTimeout(() => { void run() }) },
    })
  }

  async function updateStage(change: Change, index: boolean) {
    if (gitBusy) return
    setGitBusy(true)
    try { await api.stage(workspace.root, change, index); await refreshGit() }
    catch (error) { notify(error) }
    finally { setGitBusy(false) }
  }

  async function stageAll(unstage: boolean) {
    if (gitBusy) return
    setGitBusy(true)
    try { await api.stageAll(workspace.root, unstage); await refreshGit() }
    catch (error) { notify(error) }
    finally { setGitBusy(false) }
  }

  function discard(change: Change) {
    const untracked = change.worktree === '?'
    setDialog({
      title: (untracked ? 'Move ' : 'Discard changes to ') + fileName(change.path) + (untracked ? ' to the trash?' : '?'), danger: true,
      description: untracked ? 'This file is not tracked by Git. It will be moved to the system trash.' : 'Your unstaged edits to this file will be lost. Staged changes are kept.',
      label: untracked ? 'Move to trash' : 'Discard changes',
      action: () => {
        if (!desktop) { notify('Discarding is available in the Still desktop app.'); return }
        setGitBusy(true)
        void api.discard(workspace.root, change).then(async () => {
          await refreshGit()
          void refreshFiles()
          if (untracked) closeTabs(latest.current.tabs.filter(tab => tab.path === change.path && !tab.diff))
          setTabs(previous => previous.filter(tab => !(tab.diff && tab.path === change.path && !tab.staged)))
          await refreshCleanTabs()
        }).catch(notify).finally(() => setGitBusy(false))
      },
    })
  }

  async function branchMenu(event: ReactMouseEvent) {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    let branches: Branches = { current: status.branch, local: status.branch ? [status.branch] : [], remote: [] }
    if (desktop) try { branches = await api.branches(workspace.root) } catch (error) { notify(error); return }
    const checkout = (branch: string, create = false) => {
      if (latest.current.tabs.some(dirty)) { notify('Save or close modified files before switching branches.'); return }
      setGitBusy(true)
      void api.checkout(workspace.root, branch, create).then(async () => {
        await refreshGit(); void refreshLog(); void refreshFiles(); await refreshCleanTabs()
      }).catch(notify).finally(() => setGitBusy(false))
    }
    const items: MenuEntry[] = [
      { label: 'Create branch…', icon: Plus, action: () => setDialog({ title: 'Create branch', description: 'Creates a branch from the current commit and switches to it.', input: '', placeholder: 'feature/new-idea', inputLabel: 'Branch name', label: 'Create and switch', action: name => checkout(name, true) }) },
      'separator',
      ...branches.local.slice(0, 20).map(name => ({ label: name, icon: name === branches.current ? Check : GitBranch, disabled: name === branches.current, action: () => checkout(name) })),
    ]
    const remotes = branches.remote.filter(name => !branches.local.includes(name.split('/').slice(1).join('/'))).slice(0, 12)
    if (remotes.length) items.push('separator', ...remotes.map(name => ({ label: name, icon: GitPullRequestArrow, action: () => checkout(name) })))
    setMenu({ x: box.left, y: box.bottom + 4, items })
  }

  function gitAction(action: 'commit' | 'pull' | 'push' | 'fetch') {
    if (!desktop) {
      if (action === 'commit' && commit.trim()) {
        api.previewCommit()
        setCommit('')
        void refreshGit()
        notify('Sample changes committed in this preview.')
      } else if (action !== 'commit') notify('Remote Git operations are available in the Still desktop app.')
      return
    }
    void launch('git', action, 'git_action', { rootPath: workspace.root, action, message: action === 'commit' ? commit : null })
  }

  function packageAction(action: string, name?: string) {
    if (!desktop) { notify('Package changes are available in the Still desktop app.'); return }
    const start = () => { void launch('packages', action, 'package_action', { rootPath: workspace.root, action, name: name ?? null }) }
    if (action === 'remove' && name) setDialog({
      title: 'Remove ' + name + '?', description: 'This uninstalls the package from the active Python environment.', label: 'Remove package', danger: true, action: start,
    })
    else start()
  }

  function openPalette(query: string) {
    returnedFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPalette(query)
    const id = generation.current
    void fs.files().then(result => { if (generation.current === id) setFiles(result) }).catch(error => { if (!remote) notify(error) })
  }

  function closePalette() {
    setPalette(null)
    const previous = returnedFocus.current
    requestAnimationFrame(() => {
      if (document.activeElement?.closest('[role="dialog"]')) return
      if (previous?.isConnected) previous.focus()
      else editor.current?.focus()
    })
  }

  function cycleTab(step: number) {
    const list = latest.current.tabs
    if (!list.length) return
    const index = list.findIndex(tab => tab.id === latest.current.selected)
    activate(list[(index + step + list.length) % list.length].id)
  }

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || dialog || menu) return
      if (document.querySelector('.settings-backdrop, .sheet')) return
      const key = event.key.toLowerCase()
      const shiftOnly = event.shiftKey && ['f', 'h', 'e', 'g', '`', '~'].includes(key)
      if (event.altKey || !(['k', 'p', 's', 'w', 'b', 'j', 'o', 'enter', 'tab', ','].includes(key) || shiftOnly)) return
      if (key === 'enter' && palette !== null) return
      event.preventDefault()
      if (key === 'p' || key === 'k') { palette !== null ? closePalette() : openPalette(event.shiftKey ? '>' : ''); return }
      if (palette !== null) return
      if (key === 'tab') { cycleTab(event.shiftKey ? -1 : 1); return }
      if (key === 'f') showSide('search')
      if (key === 'e' && event.shiftKey) showSide('explorer')
      if (key === 'g' && event.shiftKey && !remote) showSide('git')
      if (key === 'h' && event.shiftKey) goHome()
      if (key === '`' || key === '~') { setDrawer('terminal'); setDrawerOpen(true); if (desktop) { remote ? remoteSession() : newSession() } }
      if (key === ',') onSettings()
      if (key === 's') void (event.shiftKey ? storeAll() : store(active)).catch(notify)
      if (key === 'o') chooseFolder()
      if (key === 'enter') void run(event.shiftKey)
      if (key === 'b') setSidebar(value => value ? null : lastSide)
      if (key === 'j') {
        if (drawerOpen) setDrawerOpen(false)
        else showDrawer('terminal', true)
      }
      if (key === 'w' && active) closeTab(active)
    }
    document.addEventListener('keydown', handle, true)
    return () => document.removeEventListener('keydown', handle, true)
  })

  const allThemes = [...presets, ...settings.customThemes]
  const commands: PaletteItem[] = [
    { id: 'home', label: 'Go to Home', shortcut: mod + '+Shift+H', icon: House, action: goHome },
    { id: 'folder', label: 'Open folder', shortcut: mod + '+O', icon: FolderOpen, action: chooseFolder },
    { id: 'new', label: 'New file', icon: FilePlus2, action: () => newFile() },
    ...(desktop || remote ? [{ id: 'new-folder', label: 'New folder', icon: FolderPlus, action: () => newFolder() }] : []),
    { id: 'save', label: 'Save active file', shortcut: mod + '+S', icon: Files, action: () => { void store(active).catch(notify) } },
    { id: 'save-all', label: 'Save all files', shortcut: mod + '+Shift+S', icon: Files, action: () => { void storeAll() } },
    { id: 'search', label: 'Find in files', shortcut: mod + '+Shift+F', icon: Search, action: () => showSide('search') },
    ...(runnable ? [
      { id: 'run', label: 'Run active file', shortcut: mod + '+Enter', icon: Play, action: () => { void run() } },
      { id: 'run-args', label: 'Run active file with arguments…', icon: Play, action: askArguments },
      ...(!remote ? [{ id: 'build', label: mode === 'Java' ? 'Compile active file' : 'Check active file', shortcut: mod + '+Shift+Enter', icon: Hammer, action: () => { void run(true) } }] : []),
    ] : []),
    { id: 'close-saved', label: 'Close saved tabs', icon: X, action: () => closeTabs(latest.current.tabs.filter(tab => !dirty(tab))) },
    { id: 'settings', label: 'Open settings', shortcut: mod + '+,', icon: Settings2, action: () => onSettings() },
    { id: 'appearance', label: 'Customize theme…', icon: Settings2, action: () => onSettings('appearance') },
    { id: 'toggle-theme', label: 'Toggle light and dark theme', icon: theme.kind === 'dark' ? Sun : Moon, action: onToggleTheme },
    ...allThemes.map(item => ({ id: 'theme-' + item.id, label: 'Theme: ' + item.name, detail: item.kind === 'dark' ? 'Dark' : 'Light', icon: item.kind === 'dark' ? Moon : Sun, action: () => update({ theme: item.id, followSystem: false }) })),
    { id: 'wrap', label: settings.wordWrap ? 'Turn off line wrapping' : 'Turn on line wrapping', icon: WrapText, action: () => update({ wordWrap: !settings.wordWrap }) },
    { id: 'diff-layout', label: settings.diffLayout === 'split' ? 'Show diffs inline' : 'Show diffs side by side', icon: settings.diffLayout === 'split' ? Rows2 : Columns2, action: () => update({ diffLayout: settings.diffLayout === 'split' ? 'inline' : 'split' }) },
    { id: 'explorer', label: 'Show explorer', shortcut: mod + '+Shift+E', icon: Files, action: () => showSide('explorer') },
    ...(!remote ? [
      { id: 'git', label: 'Show source control', shortcut: mod + '+Shift+G', icon: GitBranch, action: () => showSide('git') },
      { id: 'git-commit', label: 'Git: Commit staged changes', icon: GitBranch, action: () => { showSide('git'); if (commit.trim()) gitAction('commit') } },
      { id: 'git-pull', label: 'Git: Pull', icon: GitBranch, action: () => gitAction('pull') },
      { id: 'git-push', label: 'Git: Push', icon: GitBranch, action: () => gitAction('push') },
      { id: 'git-fetch', label: 'Git: Fetch', icon: GitBranch, action: () => gitAction('fetch') },
      { id: 'packages', label: 'Show packages', icon: Package, action: () => showSide('packages') },
    ] : []),
    { id: 'remote', label: 'Show servers (SSH)', icon: Server, action: () => showSide('remote') },
    { id: 'add-server', label: 'Add SSH server…', icon: Server, action: () => setEditingHost(blankHost) },
    { id: 'terminal', label: 'Show terminal', shortcut: mod + '+J', icon: TerminalSquare, action: () => showDrawer('terminal', true) },
    { id: 'new-terminal', label: 'New terminal', shortcut: mod + '+Shift+`', icon: SquareTerminal, action: () => { setDrawer('terminal'); setDrawerOpen(true); remote ? remoteSession() : newSession() } },
    { id: 'output', label: 'Show process output', icon: CodeXml, action: () => showDrawer('output') },
    { id: 'problems', label: 'Show compiler problems', icon: CircleAlert, action: () => showDrawer('problems') },
  ]
  const fileItems: PaletteItem[] = files.map(file => ({ id: file.path, label: file.name, detail: parentPath(file.path), path: file.path, action: () => { void openFile(file.path) } }))
  const rail = ([
    { key: 'explorer', label: 'Explorer', glyph: Files },
    { key: 'search', label: 'Search', glyph: Search },
    ...(!remote ? [{ key: 'git', label: 'Source Control', glyph: GitBranch }, { key: 'packages', label: 'Packages', glyph: Package }] : []),
    { key: 'remote', label: 'Servers', glyph: Server },
  ]) as { key: Side; label: string; glyph: typeof Files }[]
  const drawerTabs = [
    { key: 'terminal', label: 'Terminal', glyph: TerminalSquare },
    { key: 'output', label: 'Output', glyph: CodeXml },
    { key: 'problems', label: 'Problems', glyph: CircleAlert },
  ] as const
  const breadcrumb = active?.path.split('/') ?? []
  const remoteActions = {
    onTerminal: (target: SshHost) => { setDrawer('terminal'); setDrawerOpen(true); newSession(target) },
    onOpenFolder: (target: SshHost) => setRemoteHost(target),
    onEdit: (target: SshHost) => setEditingHost(target),
    onDelete: (target: SshHost) => { void ssh.remove(target.id).then(refreshServers).catch(notify) },
    onTest: (target: SshHost) => { notify('Connecting to ' + target.name + '…'); void ssh.test(target.id).then(result => notify('Connected: ' + result)).catch(notify) },
  }

  return <div className="app">
    <TitleBar onError={notify} onClose={desktop ? () => { void getCurrentWindow().close().catch(notify) } : undefined}
      left={<>
        <button className="brand" onClick={goHome} title={'Home (' + mod + '+Shift+H)'}>
          <img src={mark} alt="" /><span className="brand-word">Still</span>
        </button>
        <span className="chrome-divider" />
        <button className="chrome-project" onClick={event => {
          const box = event.currentTarget.getBoundingClientRect()
          setMenu({ x: box.left, y: box.bottom + 4, items: [
            { label: 'Go to Home', icon: House, shortcut: mod + '+Shift+H', action: goHome },
            { label: 'Open another folder…', icon: FolderOpen, shortcut: mod + '+O', action: chooseFolder },
            ...(desktop && !remote ? [{ label: 'Reveal in file manager', icon: FolderSearch, action: () => { void home.reveal(workspace.root).catch(notify) } }] : []),
            { label: 'Copy path', icon: Copy, action: () => copyText(workspace.root) },
          ] })
        }} title={remote ? workspace.hostName + ':' + workspace.root : workspace.root}>
          {remote && <Icon glyph={Server} size={12} />}{workspace.name}
        </button>
      </>}
      center={<button className="jump" aria-label="Open command palette" onClick={() => openPalette('')}>
        <Icon glyph={Search} size={13} /><span>Jump to file or command…</span><kbd>{mod}+K</kbd>
      </button>}
      right={<>
        <IconButton glyph={PanelLeft} label={'Toggle sidebar (' + mod + '+B)'} onClick={() => setSidebar(value => value ? null : lastSide)} />
        <IconButton glyph={PanelBottom} label={'Toggle bottom drawer (' + mod + '+J)'} onClick={() => drawerOpen ? setDrawerOpen(false) : showDrawer(drawer)} />
        <IconButton glyph={theme.kind === 'dark' ? Sun : Moon} label="Toggle light and dark" onClick={onToggleTheme} />
        <IconButton glyph={Settings2} label={'Settings (' + mod + '+,)'} onClick={() => onSettings()} />
      </>} />

    <div className="workspace">
      <nav className="rail" aria-label="Workspace views">
        {rail.map(({ key, label, glyph }) => <button key={key} className={sidebar === key ? 'is-active' : ''} title={label} aria-label={label} aria-pressed={sidebar === key} onClick={() => showSide(key, true)}>
          <Icon glyph={glyph} size={16} />
          {key === 'git' && status.changes.length > 0 && <span className="rail-count">{Math.min(status.changes.length, 99)}</span>}
        </button>)}
        <div className="flex-1" />
        <button className={drawerOpen && drawer === 'terminal' ? 'is-active' : ''} aria-label="Toggle terminal" title="Toggle terminal"
          onClick={() => drawerOpen && drawer === 'terminal' ? setDrawerOpen(false) : showDrawer('terminal', true)}><Icon glyph={TerminalSquare} size={16} /></button>
        <button aria-label="Settings" title="Settings" onClick={() => onSettings()}><Icon glyph={Settings2} size={16} /></button>
      </nav>

      {sidebar && <aside className="side" style={{ width: workspaceWidth }} aria-label={rail.find(item => item.key === sidebar)?.label + ' panel'}>
        {sidebar === 'explorer' && <Explorer workspace={workspace} directories={directories} expanded={expanded} active={active?.path} changes={status} symbols={symbols}
          onOpen={path => { void openFile(path) }} onExpand={toggleFolder} onNew={() => newFile()} onNewFolder={() => newFolder()} onWorkspace={chooseFolder}
          onRefresh={() => { void refreshFiles() }} onJump={line => editor.current?.jump(line)} onContext={explorerMenu} onKey={explorerKey} />}
        {sidebar === 'search' && <SearchPanel search={fs.search} remote={remote} focusKey={searchFocus} onOpen={(path, line, column, length) => jumpTo({ path, line, column, length })} />}
        {sidebar === 'git' && <SourceControl status={status} busy={Boolean(job) || gitBusy} error={gitError} commit={commit} log={log} onCommitText={setCommit}
          onDiff={(change, index) => { void openDiff(change, index) }} onStage={(change, index) => { void updateStage(change, index) }} onAction={gitAction}
          onStageAll={unstage => { void stageAll(unstage) }} onDiscard={discard} onBranch={event => { void branchMenu(event) }}
          onInit={() => { void api.gitInit(workspace.root).then(() => refreshGit()).catch(notify) }} onRefresh={() => { void refreshGit(); void refreshLog() }} />}
        {sidebar === 'packages' && <PackagesPanel key={workspace.root} state={packageState} busy={Boolean(job)} onOpen={path => { void openFile(path) }}
          onSearch={api.search} onAction={packageAction} onRefresh={() => { void refreshPackages() }} />}
        {sidebar === 'remote' && <RemotePanel overview={servers} onRefresh={() => { void refreshServers() }} {...remoteActions}
          onMenu={(event, items) => setMenu({ x: event.clientX, y: event.clientY, items })} />}
        <SplitGrip vertical value={workspaceWidth} min={160} max={sideMax} change={setSideWidth} />
      </aside>}

      <main className="main">
        <div className="tab-strip">
          <div className="tab-scroll" role="tablist" aria-label="Open files">
            {tabs.map((tab, index) => <div key={tab.id} className={'tab' + (tab.id === selected ? ' is-active' : '')}
              onAuxClick={event => { if (event.button === 1) closeTab(tab) }}
              onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, items: [
                { label: 'Close', icon: X, shortcut: mod + '+W', action: () => closeTab(tab) },
                { label: 'Close others', action: () => { const others = tabs.filter(item => item.id !== tab.id); if (others.some(dirty)) askDiscard('Close other tabs?', 'Some have unsaved changes.', () => closeTabs(others)); else closeTabs(others) } },
                { label: 'Close saved tabs', action: () => closeTabs(tabs.filter(item => !dirty(item))) },
                'separator',
                { label: 'Copy relative path', icon: Copy, action: () => copyText(tab.path) },
                ...(desktop && !remote ? [{ label: 'Reveal in file manager', icon: FolderSearch, action: () => { void home.reveal(absolute(parentPath(tab.path))).catch(notify) } }] : []),
              ] }) }}>
              <button role="tab" type="button" id={'file-tab-' + index} aria-controls="editor-panel" aria-selected={tab.id === selected} className="tab-select"
                title={tab.path} onClick={() => activate(tab.id)}
                onKeyDown={event => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length
                  activate(tabs[next].id)
                }}>
                {tab.diff ? <Icon glyph={GitCompareArrows} /> : <FileIcon path={tab.path} />}
                <span>{fileName(tab.path)}{tab.diff && (tab.staged ? ' · Staged' : ' · Diff')}</span>
              </button>
              <IconButton glyph={dirty(tab) ? Circle : X} className={'tab-close' + (dirty(tab) ? ' dirty' : '')} label={'Close ' + fileName(tab.path)} size={dirty(tab) ? 9 : 12} onClick={() => closeTab(tab)} />
            </div>)}
          </div>
          <IconButton glyph={Plus} className="tab-add" label="Find and open a file" onClick={() => openPalette('')} />
        </div>

        {active && <div className="crumbs">
          <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
            {remote && <><span className="crumb-host"><Icon glyph={Server} size={12} />{workspace.hostName}</span><Icon glyph={ChevronRight} size={12} /></>}
            {breadcrumb.map((part, index) => index === breadcrumb.length - 1
              ? <span key={index} className="crumb-current flex items-center gap-1.5 truncate"><FileIcon path={active.path} size={13} />{part}</span>
              : <span key={index} className="inline-flex items-center gap-1.5"><button onClick={() => { showSide('explorer'); expandParents(active.path) }}>{part}</button><Icon glyph={ChevronRight} size={12} /></span>)}
            {currentSymbol && <><Icon glyph={ChevronRight} size={12} /><button className="crumb-symbol inline-flex items-center gap-1" onClick={() => editor.current?.jump(currentSymbol.line)}>
              <Icon glyph={currentSymbol.kind === 'class' ? Braces : CodeXml} size={12} />{currentSymbol.name}</button></>}
            {active.diff && <><Icon glyph={ChevronRight} size={12} /><span>{active.staged ? 'Staged' : 'Working tree'}</span></>}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {active.diff && <IconButton glyph={settings.diffLayout === 'split' ? Rows2 : Columns2} label={settings.diffLayout === 'split' ? 'Show inline diff' : 'Show side-by-side diff'}
              onClick={() => update({ diffLayout: settings.diffLayout === 'split' ? 'inline' : 'split' })} />}
            {runnable && runArgs[active.path] && <span className="run-args" title="Program arguments">{runArgs[active.path]}</span>}
            {runnable && <button type="button" className="run" title={'Run ' + (remote ? 'on ' + workspace.hostName + ' ' : '') + '(' + mod + '+Enter)'} disabled={Boolean(job) || runningRequest || !jobReady}
              onClick={() => { void run() }} onContextMenu={event => { event.preventDefault(); askArguments() }}>
              <Icon glyph={Play} />Run</button>}
            {runnable && !remote && <IconButton glyph={Hammer} label={(mode === 'Java' ? 'Compile' : 'Check') + ' active file (' + mod + '+Shift+Enter)'} disabled={Boolean(job) || runningRequest || !jobReady} onClick={() => { void run(true) }} />}
            {active.diff && <IconButton glyph={Files} label="Open working file" onClick={() => { void openFile(active.path) }} />}
          </div>
        </div>}

        <section className="editor-wrap" id="editor-panel" role="tabpanel" aria-labelledby={active ? 'file-tab-' + tabs.indexOf(active) : undefined}>
          {active ? <Editor path={active.path} text={active.contents} memory={active.memory} diff={active.diff} initialLine={active.line}
            options={editorOptions} diagnostics={diagnostics} handle={selectEditor} onCursor={setCursor}
            onBlur={() => { if (settings.autoSave === 'blur') void store(latest.current.tabs.find(tab => tab.id === active.id)).catch(notify) }}
            onEdit={contents => setTabs(previous => previous.map(tab => tab.id === active.id ? { ...tab, contents } : tab))} /> : <div className="empty-editor">
            <div className="empty-inner">
              <img src={mark} alt="" />
              <p className="empty-title">{workspace.name}</p>
              <div className="empty-keys">
                <button onClick={() => openPalette('')}><span>Find a file</span><kbd>{mod}+P</kbd></button>
                <button onClick={() => openPalette('>')}><span>Run a command</span><kbd>{mod}+Shift+K</kbd></button>
                <button onClick={() => newFile()}><span>New file</span><kbd>…</kbd></button>
                <button onClick={() => showSide('search')}><span>Find in files</span><kbd>{mod}+Shift+F</kbd></button>
                <button onClick={() => showDrawer('terminal', true)}><span>Open terminal</span><kbd>{mod}+J</kbd></button>
                <button onClick={goHome}><span>Back to Home</span><kbd>{mod}+Shift+H</kbd></button>
              </div>
            </div>
          </div>}
        </section>

        {(drawerOpen || sessions.length > 0) && <section className="drawer" style={{ height: actualDrawerHeight, display: drawerOpen ? undefined : 'none' }} aria-label="Bottom drawer">
          <SplitGrip value={actualDrawerHeight} min={128} max={drawerMax} change={setDrawerHeight} />
          <div className="drawer-nav">
            <div className="drawer-tabs" role="tablist" aria-label="Console views">
              {drawerTabs.map(({ key, label, glyph }) => <button key={key} type="button" role="tab" aria-selected={drawer === key}
                className={'drawer-tab' + (drawer === key ? ' is-active' : '')} onClick={() => showDrawer(key, true)}>
                <Icon glyph={glyph} size={14} />{label}{key === 'problems' && diagnostics.length > 0 && <span className="help">{diagnostics.length}</span>}
              </button>)}
            </div>
            {drawer === 'terminal' && sessions.length > 0 && <div className="session-tabs" role="tablist" aria-label="Terminal sessions">
              {sessions.map(session => <div key={session.id} className={'session' + (session.id === activeSession ? ' is-active' : '') + (session.exited ? ' exited' : '')}>
                <button role="tab" aria-selected={session.id === activeSession} onClick={() => { setActiveSession(session.id); requestAnimationFrame(() => terminal.current?.focus()) }}>
                  <Icon glyph={session.ssh ? Server : SquareTerminal} size={12} />{session.label}
                </button>
                <IconButton glyph={X} size={11} label={'Close ' + session.label} className="small" onClick={() => closeSession(session.id)} />
              </div>)}
            </div>}
            <div className="drawer-actions">
              {drawer === 'terminal' && desktop && <IconButton glyph={Plus} label={'New terminal (' + mod + '+Shift+`)'} onClick={() => remote ? remoteSession() : newSession()} />}
              {job && <IconButton glyph={Square} label="Stop process" onClick={() => { void invoke('stop_job', { id: job.id }).catch(notify) }} />}
              {drawer !== 'problems' && <IconButton glyph={Trash2} label={drawer === 'terminal' ? 'Clear terminal' : 'Clear output'} onClick={() => {
                if (drawer === 'terminal') terminal.current?.clear()
                else { setOutput([]); setSampleRun(false) }
              }} />}
              <IconButton glyph={actualDrawerHeight > frame.height * .45 ? ArrowDown : ArrowUp} label={actualDrawerHeight > frame.height * .45 ? 'Restore drawer height' : 'Expand drawer'} onClick={() => setDrawerHeight(actualDrawerHeight > frame.height * .45 ? 242 : drawerMax)} />
              <IconButton glyph={X} label="Close drawer" onClick={() => { setDrawerOpen(false); editor.current?.focus() }} />
            </div>
          </div>
          <div className="drawer-body">
            {desktop && sessions.map(session => <Terminal key={session.id} session={session} root={remote ? null : workspace.root} visible={drawerOpen && drawer === 'terminal' && session.id === activeSession}
              theme={theme} fontSize={settings.terminalFontSize} fontFamily={settings.editorFont} cursor={settings.terminalCursor} shell={settings.terminalShell}
              onReady={value => { if (session.id === activeSession || !terminal.current) terminal.current = value }}
              onExit={id => setSessions(previous => previous.map(item => item.id === id ? { ...item, exited: true } : item))} />)}
            {desktop && drawer === 'terminal' && !sessions.length && <div className="console-scroll"><button className="text-btn" onClick={() => remote ? remoteSession() : newSession()}><Icon glyph={Plus} size={13} />New terminal</button></div>}
            {!desktop && drawer === 'terminal' && <div className="console-scroll"><div className="console-banner"><Icon glyph={TerminalSquare} />The local shell is available in the Still desktop app.</div></div>}
            {drawer === 'output' && <Output entries={output} sample={sampleRun}
              onInput={job?.kind === 'run' ? text => { void invoke('job_input', { id: job.id, text }).catch(notify) } : undefined} />}
            {drawer === 'problems' && <Problems items={diagnostics} jump={jumpTo} />}
          </div>
        </section>}
      </main>
    </div>

    <footer className="status" aria-label="Workspace status">
      {remote ? <button className="status-item status-branch" onClick={() => showSide('remote')} title="Connected over SSH"><Icon glyph={Server} size={12} />{workspace.hostName}</button>
        : <button className="status-item status-branch" onClick={() => showSide('git')} title="Show source control"><Icon glyph={GitBranch} size={13} />{status.branch ?? 'No branch'}</button>}
      <button className="status-item" onClick={() => showDrawer('problems')} aria-label={problemCount + ' errors and ' + warningCount + ' warnings'}>
        <Icon glyph={CircleAlert} size={12} />{problemCount}<span className="ml-0.5" aria-hidden="true">/</span>{warningCount}
      </button>
      {job && <button className="status-item" onClick={() => showDrawer('output')}><span className="status-dot busy" />{job.kind === 'run' ? 'Running' : job.kind === 'git' ? 'Git ' + job.action : 'Packages'}…</button>}
      {settings.autoSave !== 'off' && <span className="status-item status-optional" title="Auto save is on">Auto save</span>}
      <div className="flex-1" />
      {active && <><span className="status-item">Ln {cursor.line}, Col {cursor.column}{cursor.selected ? ` (${cursor.selected} selected)` : ''}</span>
        <button className="status-item status-optional" onClick={() => onSettings('editor')} title="Indentation settings">Spaces: {tabSize}</button>
        <span className="status-item status-language">{mode}</span></>}
      {!remote && <button className="status-item" title="Show runtimes and packages" onClick={() => showSide('packages')}>
        <span className={'status-dot' + (!runtime ? ' inactive' : '')} />{!desktop ? 'Browser preview' : runtime ? runtime + (mode === 'Python' && (runtimes?.pythonVenv || isVirtual(packageState)) ? ' · .venv' : '') : runtimes ? runtimeMissing : 'Detecting runtimes…'}
      </button>}
      {remote && host && <span className="status-item">{host.user ? host.user + '@' : ''}{host.address || host.host}</span>}
    </footer>

    {palette !== null && <Palette commands={commands} files={fileItems} start={palette} onClose={closePalette} />}
    {dialog && <Dialog dialog={dialog} close={() => setDialog(null)} />}
    {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    {editingHost && <HostDialog host={editingHost} onClose={() => setEditingHost(null)} onSaved={() => { void refreshServers() }} />}
    {remoteHost && <OpenRemoteDialog host={remoteHost} onClose={() => setRemoteHost(null)} onOpen={async path => {
      const root = await ssh.resolve(remoteHost.id, path)
      leave(() => onSwitch({ root, name: root.split('/').filter(Boolean).at(-1) ?? root, remote: remoteHost.id, hostName: remoteHost.name }), 'Switch project?')
    }} />}
  </div>
}
