import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Terminal as Xterm } from '@xterm/xterm'
import {
  Check, Circle, CircleAlert, CodeXml, Columns2, Copy, FilePlus2, Files, FolderOpen, FolderPlus,
  FolderSearch, GitBranch, GitCompareArrows, GitPullRequestArrow, Hammer, House, Moon, Package,  Pencil, Play, Plus,
  RefreshCw, Rows2, Search, Server, Settings2, Square, SquareTerminal, Sun, TerminalSquare, Trash2, WrapText, X,
  Camera, Eye, PenLine, LayoutGrid, Maximize2, Minimize2, Network, BookOpen,
} from 'lucide-react'
import {
  api, desktop, fileName, fileSystem, home, mod, parentPath, pickFolder, ssh,
  type Branches, type Change, type Commit, type Diagnostic, type Diff, type Entry, type GitStatus, type JobEvent, type Packages, type Runtimes,
  type SshHost, type SshOverview, type Workspace,
} from './bridge'
import Editor, { defaultIndent, language, type CodeCapture, type Cursor, type EditorHandle, type EditorMemory, type EditorOptions } from './Editor'
import CodeShot from './CodeShot'
import { Preview, docKind } from './Preview'
import type { OpenOptions } from './Home'
import { Explorer, PackagesPanel, Palette, SourceControl, isVirtual, symbolsFor, type PaletteItem } from './Panels'
import { HostDialog, OpenRemoteDialog, RemotePanel, blankHost } from './Remote'
import { SearchPanel } from './Search'
import type { SettingsSection } from './SettingsView'
import { useSettings } from './settings'
import { type Graph, buildGraph } from './graph'
import { GraphView, MiniGraph } from './GraphView'
import { Idle, useIdle } from './Idle'
import { JournalSheet, useJournal } from './Journal'
import { bump, clock, journal, lineChanges, remember } from './activity'
import { Overview, type OverviewCard, type OverviewSpace } from './Overview'
import Terminal, { type TerminalSession } from './Terminal'
import { presets } from './themes'
import { TitleBar } from './TitleBar'
import { Dialog, Output, Problems, SplitGrip, type DialogState, type OutputEntry } from './Workbench'
import { Icon, IconButton, Menu, useSlider, type MenuEntry, type MenuState } from './ui'

type Side = 'explorer' | 'search' | 'git' | 'packages' | 'remote'
type Drawer = 'terminal' | 'output' | 'problems'
type DocView = 'edit' | 'split' | 'preview'
type Tab = { id: string; path: string; contents: string; saved: string; memory?: EditorMemory; diff?: Diff; staged?: boolean; line?: number; view?: DocView }
type Job = { id: string; kind: 'run' | 'git' | 'packages'; action: string; path?: string; detail?: string }
type Edit = { time: number; line: number }
type Islands = { side: Side | null; graph: boolean; drawer: boolean }
const layouts: { id: string; label: string; islands?: Islands }[] = [
  { id: 'classic', label: 'Classic', islands: { side: 'explorer', graph: true, drawer: true } },
  { id: 'code-graph', label: 'Code and graph', islands: { side: null, graph: true, drawer: false } },
  { id: 'review', label: 'Review', islands: { side: 'git', graph: false, drawer: true } },
  { id: 'writing', label: 'Writing', islands: { side: null, graph: false, drawer: false } },
  { id: 'focus', label: 'Focus' },
]
function savedLayout(): Islands | null {
  try { return JSON.parse(localStorage.getItem('still.layout.custom') ?? 'null') } catch { return null }
}

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
  const [shot, setShot] = useState<CodeCapture | null>(null)
  // Over SSH the graph reads many files, so it starts hidden there.
  const [graphOpen, setGraphOpen] = useState(() => !workspace.remote && localStorage.getItem('still.island.graph') !== 'off' && window.innerWidth > 1180)
  const [focusMode, setFocusMode] = useState(false)
  const [focusOutput, setFocusOutput] = useState(false)
  const [maximized, setMaximized] = useState<'editor' | 'side' | 'terminal' | null>(null)
  const [overview, setOverview] = useState(false)
  const [graphView, setGraphView] = useState(false)
  const [graph, setGraph] = useState<Graph | null>(null)
  const [graphError, setGraphError] = useState('')
  const [journalOpen, setJournalOpen] = useState(false)
  const [edits, setEdits] = useState<Record<string, Edit[]>>({})
  const [spaces, setSpaces] = useState<OverviewSpace[]>([])
  const [lastRun, setLastRun] = useState<{ path: string; code: number | null; time: number } | null>(null)
  const graphWanted = useRef(false)
  const graphBuild = useRef(0)
  const graphTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
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
  const doc = active && !active.diff ? docKind(active.path) : null
  const docView: DocView = doc ? active?.view ?? 'edit' : 'edit'
  const editorOptions: EditorOptions = { wrap: settings.wordWrap || Boolean(doc), lineNumbers: settings.lineNumbers, highlightLine: settings.highlightLine, tabSize, layout: settings.diffLayout }
  const host = remote ? [...(servers?.saved ?? []), ...(servers?.imported ?? [])].find(item => item.id === workspace.remote) : undefined

  const notify = useCallback((error: unknown) => toast(errorText(error)), [toast])
  const [idle, wake] = useIdle(settings.idleMinutes, Boolean(dialog || palette !== null || shot))
  const record = settings.journal
  const journalEntries = useJournal()
  const latestRecord = useRef(record)
  latestRecord.current = record
  const changedPaths = useMemo(() => new Set(status.changes.map(change => change.path)), [status])

  useEffect(() => { if (!remote) localStorage.setItem('still.island.graph', graphOpen ? 'on' : 'off') }, [graphOpen])

  // Count active minutes for today's numbers on the idle screen.
  useEffect(() => {
    if (idle) return
    const timer = setInterval(() => { if (document.hasFocus()) { bump({ activeMs: 30000 }) } }, 30000)
    return () => clearInterval(timer)
  }, [idle])

  // Remember where you were so Home can offer to continue there.
  useEffect(() => {
    if (!active || active.diff || workspace.sample) return
    const timer = setTimeout(() => remember(workspace.root, { path: active.path, line: cursor.line, time: Date.now() }), 700)
    return () => clearTimeout(timer)
  }, [active?.path, cursor.line])

  async function loadGraph() {
    graphWanted.current = true
    const id = ++graphBuild.current
    try {
      const entries = await fs.files()
      const open = new Map(latest.current.tabs.filter(tab => !tab.diff).map(tab => [tab.path, tab.contents]))
      const result = await buildGraph(entries, path => open.has(path) ? Promise.resolve(open.get(path)!) : fs.read(path), remote ? 150 : 400)
      if (id === graphBuild.current) { setGraph(result); setGraphError('') }
    } catch (error) { if (id === graphBuild.current) setGraphError(errorText(error)) }
  }
  useEffect(() => { if ((graphOpen && !graphWanted.current) || graphView) void loadGraph() }, [graphOpen, graphView])
  function staleGraph() {
    if (!graphWanted.current) return
    clearTimeout(graphTimer.current)
    graphTimer.current = setTimeout(() => { void loadGraph() }, 900)
  }

  useEffect(() => { localStorage.setItem('still.sidebar.width', String(sideWidth)) }, [sideWidth])
  // Coming back to the window: pick up files and Git changes made in other programs.
  useEffect(() => {
    if (remote) return
    let last = 0
    const back = () => {
      if (Date.now() - last < 4000) return
      last = Date.now()
      void refreshFiles(); void refreshGit(); void refreshCleanTabs()
    }
    addEventListener('focus', back)
    return () => removeEventListener('focus', back)
  }, [])
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
      staleGraph()
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
      const resume = initial?.file
      const found = workspace.sample ? ['README.md', 'src/app.py', 'src/Main.java'] : entries.filter(entry => !entry.directory && readme.includes(entry.name)).map(entry => entry.path).slice(0, 1)
      const paths = resume && !found.includes(resume) ? [...found, resume] : found
      const lineFor = (path: string) => path === resume ? initial?.line : workspace.sample && path === 'src/app.py' ? 11 : undefined
      const opened = await Promise.all(paths.map(path => fs.read(path).then(contents => fileTab(path, contents, lineFor(path))).catch(() => null)))
      if (generation.current !== id) return
      const available = opened.filter(tab => tab !== null)
      setTabs(previous => [...available.filter(tab => !previous.some(existing => existing.id === tab.id)), ...previous])
      const preferred = resume && available.some(tab => tab.id === resume) ? resume : available.some(tab => tab.id === 'src/app.py') ? 'src/app.py' : available[0]?.id ?? ''
      setSelected(previous => previous || preferred)
      if (resume) expandParents(resume)
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
      if (current.kind === 'run') {
        setDiagnostics(payload.diagnostics)
        if (current.action === 'run' && current.path) {
          bump({ runs: 1, passed: payload.code === 0 ? 1 : 0 })
          setLastRun({ path: current.path, code: payload.code ?? null, time: Date.now() })
          if (latestRecord.current && !workspace.sample) journal.add({ kind: 'run', project: workspace.name, root: workspace.root, path: current.path, text: 'Ran ' + fileName(current.path), detail: payload.code === null || payload.code === undefined ? 'stopped' : 'exit ' + payload.code })
        }
      }
      if (current.kind === 'git') {
        void refreshGit()
        if (['pull', 'fetch'].includes(current.action)) void refreshLog()
        if (current.action === 'pull' && payload.code === 0) { void refreshFiles(); void refreshCleanTabs() }
        if (current.action === 'commit' && payload.code === 0) {
          setCommit(''); void refreshLog()
          if (latestRecord.current) journal.add({ kind: 'commit', project: workspace.name, root: workspace.root, text: 'Committed “' + (current.detail ?? '').split('\n')[0].slice(0, 80) + '”' })
        }
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
      const { added, removed } = lineChanges(current.saved, current.contents)
      if (added || removed) {
        bump({ added })
        if (record && !workspace.sample) journal.add({ kind: 'edit', project: workspace.name, root: workspace.root, path: current.path, text: 'Edited ' + fileName(current.path), detail: '+' + added + ' −' + removed, added, removed })
      }
      staleGraph()
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

  async function launch(kind: Job['kind'], action: string, command: string, args: object, extra: Pick<Job, 'path' | 'detail'> = {}) {
    if (activeJob.current || !jobReady) { notify('The process runner is busy or still starting.'); return }
    const current: Job = { id: crypto.randomUUID(), kind, action, ...extra }
    activeJob.current = current
    setJob(current)
    setOutput([])
    setSampleRun(false)
    if (focusMode) { setFocusOutput(true); setDrawer('output') }
    else showDrawer('output')
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
      if (focusMode) setFocusOutput(true); else showDrawer('output')
      notify('Run and Build use local runtimes in the Still desktop app.')
      return
    }
    if (remote && buildOnly) { notify('Check and compile run locally only. Use Run to execute the file on the server.'); return }
    setRunningRequest(true)
    try {
      await store(active)
      setDiagnostics([])
      const args = runArgs[active.path] || null
      if (remote) await launch('run', 'run', 'ssh_run', { hostId: workspace.remote, root: workspace.root, path: active.path, args }, { path: active.path })
      else await launch('run', buildOnly ? 'build' : 'run', 'run_file', { rootPath: workspace.root, path: active.path, buildOnly, args }, { path: active.path })
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
    void launch('git', action, 'git_action', { rootPath: workspace.root, action, message: action === 'commit' ? commit : null }, { detail: action === 'commit' ? commit : undefined })
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

  function setDocView(view: DocView) {
    if (!active) return
    const id = active.id
    setTabs(previous => previous.map(tab => tab.id === id ? { ...tab, view } : tab))
  }

  function cycleDocView() {
    if (!doc) return
    setDocView(docView === 'edit' ? 'split' : docView === 'split' ? 'preview' : 'edit')
  }

  function captureCode() {
    const captured = editor.current?.capture() ?? null
    if (captured) setShot(captured)
    else notify('Select some code first, then create the image.')
  }

  function openLink(href: string) {
    if (/^(https?:|mailto:)/i.test(href)) {
      if (desktop) void invoke('open_external', { url: href }).catch(notify)
      else window.open(href, '_blank', 'noopener')
      return
    }
    if (href.startsWith('#') || !active) return
    // A link to another file in the project, relative to this file.
    const parts = (parentPath(active.path) ? parentPath(active.path).split('/') : [])
    for (const part of decodeURIComponent(href.split('#')[0]).split('/')) {
      if (part === '..') parts.pop()
      else if (part && part !== '.') parts.push(part)
    }
    if (parts.length) void openFile(parts.join('/'))
  }

  const cursorLine = useRef(1)
  cursorLine.current = cursor.line
  function edited(tab: Tab, contents: string) {
    setTabs(previous => previous.map(item => item.id === tab.id ? { ...item, contents } : item))
    // One timeline mark per burst of typing: a new mark after a pause or a jump elsewhere in the file.
    const now = Date.now(), line = cursorLine.current
    setEdits(previous => {
      const list = previous[tab.path] ?? []
      const last = list.at(-1)
      if (last && now - last.time < 90000 && Math.abs(last.line - line) < 12) return { ...previous, [tab.path]: [...list.slice(0, -1), { time: now, line }] }
      return { ...previous, [tab.path]: [...list, { time: now, line }].slice(-40) }
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
      const shiftOnly = event.shiftKey && ['f', 'h', 'e', 'g', 'v', '`', '~', 'u', 'r', 'd', 'm'].includes(key)
      // Plain Ctrl/Cmd+F outside the editor would open the web view's own find bar; send it to the editor instead.
      if (key === 'f' && !event.shiftKey && !event.altKey && !(event.target as Element | null)?.closest?.('.cm-editor, input, textarea, .xterm')) {
        event.preventDefault(); editor.current?.find(); return
      }
      if (event.altKey || !(['k', 'p', 's', 'w', 'b', 'j', 'o', 'enter', 'tab', ',', 'arrowup', '.'].includes(key) || shiftOnly)) return
      if ((overview || graphView) && !['k', 'p', '.'].includes(key)) return
      if (key === 'enter' && palette !== null) return
      event.preventDefault()
      if (key === 'p' || key === 'k') { palette !== null ? closePalette() : openPalette(event.shiftKey ? '>' : ''); return }
      if (palette !== null) return
      if (key === 'tab') { cycleTab(event.shiftKey ? -1 : 1); return }
      if (key === 'arrowup') { openOverview(); return }
      if (key === '.') { toggleFocus(); return }
      if (key === 'v' && event.shiftKey) { cycleDocView(); return }
      if (key === 'f') showSide('search')
      if (key === 'e' && event.shiftKey) showSide('explorer')
      if (key === 'g' && event.shiftKey && !remote) showSide('git')
      if (key === 'u' && event.shiftKey && !remote) showSide('packages', true)
      if (key === 'r' && event.shiftKey) showSide('remote', true)
      if (key === 'd' && event.shiftKey) setGraphOpen(value => !value)
      if (key === 'm' && event.shiftKey) toggleMaximize()
      if (key === 'h' && event.shiftKey) goHome()
      if (key === '`' || key === '~') { setDrawer('terminal'); setDrawerOpen(true); if (desktop) { remote ? remoteSession() : newSession() } }
      if (key === ',') onSettings()
      if (key === 's') void (event.shiftKey ? storeAll() : store(active)).catch(notify)
      if (key === 'o') chooseFolder()
      if (key === 'enter') void run(event.shiftKey)
      if (key === 'b') { if (focusMode) setFocusMode(false); setSidebar(value => value ? null : lastSide) }
      if (key === 'j') {
        if (focusMode) { setFocusMode(false); showDrawer('terminal', true) }
        else if (drawerOpen) setDrawerOpen(false)
        else showDrawer('terminal', true)
      }
      if (key === 'w' && active) closeTab(active)
    }
    document.addEventListener('keydown', handle, true)
    return () => document.removeEventListener('keydown', handle, true)
  })

  // When the focus output opens or closes, keep the line you are on in view.
  useEffect(() => {
    if (!focusMode) return
    const id = setTimeout(() => editor.current?.reveal(), 260)
    return () => clearTimeout(id)
  }, [focusOutput, focusMode])

  useEffect(() => {
    if (!focusMode && !maximized) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || overview || graphView || dialog || menu || palette !== null || shot) return
      if ((event.target as Element | null)?.closest?.('.xterm, .modal-backdrop, .console-input')) return
      if (focusMode && focusOutput) { setFocusOutput(false); return }
      if (maximized) { setMaximized(null); return }
      setFocusMode(false)
    }
    addEventListener('keydown', escape)
    return () => removeEventListener('keydown', escape)
  })

  function toggleFocus() {
    setFocusMode(value => !value)
    setFocusOutput(false)
    setMaximized(null)
    setOverview(false)
    requestAnimationFrame(() => editor.current?.focus())
  }

  /** Fills the window with the island that has focus (the editor by default). */
  function toggleMaximize(which?: 'editor' | 'side' | 'terminal') {
    if (maximized && (!which || which === maximized)) { setMaximized(null); requestAnimationFrame(() => editor.current?.focus()); return }
    const inside = document.activeElement?.closest('.island')
    const target = which ?? (inside?.classList.contains('drawer') ? 'terminal' : inside?.classList.contains('side') ? 'side' : 'editor')
    setFocusMode(false)
    setOverview(false)
    if (target === 'terminal' && !drawerOpen) showDrawer('terminal', true)
    if (target === 'side' && !sidebar) showSide(lastSide)
    setMaximized(target)
  }

  function openOverview() {
    setOverview(true)
    if (!desktop) { setSpaces([{ id: 'home', label: 'Home', kind: 'home' }, { id: 'current', label: workspace.name, kind: remote ? 'server' : 'project', current: true }]); return }
    void home.state().then(state => {
      const others = state.projects.filter(project => !project.missing && project.path !== workspace.root && project.lastOpened)
        .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0)).slice(0, 3)
      setSpaces([
        { id: 'home', label: 'Home', kind: 'home' },
        { id: 'current', label: workspace.name, kind: remote ? 'server' : 'project', current: true, preview: remote ? ['$ ssh ' + workspace.hostName, '~ $ ls'] : undefined },
        ...others.map(project => ({ id: project.path, label: project.name, kind: 'project' as const })),
      ])
    }).catch(() => setSpaces([{ id: 'home', label: 'Home', kind: 'home' }, { id: 'current', label: workspace.name, kind: 'project', current: true }]))
  }

  const islands: Islands = { side: sidebar, graph: graphOpen, drawer: drawerOpen }
  const currentLayout = focusMode ? 'focus' : layouts.find(item => item.islands && item.islands.side === islands.side && item.islands.graph === islands.graph && item.islands.drawer === islands.drawer)?.id ?? null

  function applyLayout(id: string) {
    setMaximized(null)
    if (id === 'focus') { setFocusMode(true); setOverview(false); requestAnimationFrame(() => editor.current?.focus()); return }
    const chosen = id === 'custom' ? savedLayout() : layouts.find(item => item.id === id)?.islands
    if (!chosen) return
    setFocusMode(false)
    setOverview(false)
    if (chosen.side) showSide(chosen.side); else setSidebar(null)
    setGraphOpen(chosen.graph)
    if (chosen.drawer) showDrawer(drawer); else setDrawerOpen(false)
  }

  function toggleIsland(key: string) {
    if (key === 'graph') setGraphOpen(value => !value)
    else if (key === 'terminal') { if (drawerOpen) setDrawerOpen(false); else showDrawer('terminal') }
    else if (key === 'editor' || key.startsWith('tab:') || key === 'journal') return
    else { const side = key as Side; setSidebar(value => value === side ? null : side); setLastSide(side) }
  }

  function fullscreenIsland(key: string) {
    setOverview(false)
    setFocusMode(false)
    if (key === 'graph') { setGraphView(true); return }
    if (key === 'journal') { setJournalOpen(true); return }
    if (key.startsWith('tab:')) { activate(key.slice(4)); toggleMaximize('editor'); return }
    if (key === 'editor') { toggleMaximize('editor'); return }
    if (key === 'terminal') { toggleMaximize('terminal'); return }
    showSide(key as Side)
    setMaximized('side')
  }

  function jumpIsland(key: string) {
    setOverview(false)
    setFocusMode(false)
    setMaximized(null)
    if (key === 'editor') { requestAnimationFrame(() => editor.current?.focus()); return }
    if (key.startsWith('tab:')) { activate(key.slice(4)); return }
    if (key === 'journal') { setJournalOpen(true); return }
    if (key === 'graph') { setGraphOpen(true); return }
    if (key === 'terminal') { showDrawer('terminal', true); return }
    showSide(key as Side)
  }

  const allThemes = [...presets, ...settings.customThemes]
  const commands: PaletteItem[] = [
    { id: 'home', label: 'Go to Home', shortcut: mod + '+Shift+H', icon: House, action: goHome },
    { id: 'folder', label: 'Open folder', shortcut: mod + '+O', icon: FolderOpen, action: chooseFolder },
    { id: 'overview', label: 'Overview of everything', shortcut: mod + '+↑', icon: LayoutGrid, action: openOverview },
    { id: 'focus', label: focusMode ? 'Leave focus mode' : 'Focus mode', shortcut: mod + '+.', icon: Maximize2, action: toggleFocus },
    { id: 'graph-view', label: 'Open project graph', icon: Network, action: () => setGraphView(true) },
    { id: 'graph-island', label: graphOpen ? 'Hide the graph island' : 'Show the graph island', icon: Network, action: () => setGraphOpen(value => !value) },
    { id: 'journal', label: 'Open journal', icon: BookOpen, action: () => setJournalOpen(true) },
    ...layouts.filter(item => item.islands).map(item => ({ id: 'layout-' + item.id, label: 'Layout: ' + item.label, icon: LayoutGrid, action: () => applyLayout(item.id) })),
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
    ...(doc ? [{ id: 'doc-preview', label: docView === 'preview' ? 'Edit ' + (doc === 'markdown' ? 'Markdown' : 'text') : 'Preview ' + (doc === 'markdown' ? 'Markdown' : 'text') + ' file', shortcut: mod + '+Shift+V', icon: Eye, action: cycleDocView }] : []),
    ...(active && !active.diff && docView !== 'preview' ? [{ id: 'code-image', label: 'Create image of selected code', icon: Camera, action: captureCode }] : []),
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
  const drawerTabs = [
    { key: 'terminal', label: 'Terminal', glyph: TerminalSquare },
    { key: 'output', label: 'Output', glyph: CodeXml },
    { key: 'problems', label: 'Problems', glyph: CircleAlert },
  ] as const
  const remoteActions = {
    onTerminal: (target: SshHost) => { setDrawer('terminal'); setDrawerOpen(true); newSession(target) },
    onOpenFolder: (target: SshHost) => setRemoteHost(target),
    onEdit: (target: SshHost) => setEditingHost(target),
    onDelete: (target: SshHost) => { void ssh.remove(target.id).then(refreshServers).catch(notify) },
    onTest: (target: SshHost) => { notify('Connecting to ' + target.name + '…'); void ssh.test(target.id).then(result => notify('Connected: ' + result)).catch(notify) },
  }

  const sideItems = ([
    { key: 'explorer', label: 'Files', keys: 'Shift+E' },
    { key: 'search', label: 'Search', keys: 'Shift+F' },
    ...(!remote ? [{ key: 'git', label: 'Git', keys: 'Shift+G' }, { key: 'packages', label: 'Packages', keys: 'Shift+U' }] : []),
    { key: 'remote', label: 'Servers', keys: 'Shift+R' },
  ]) as { key: Side; label: string; keys: string }[]
  const editorProps = active ? {
    path: active.path, text: active.contents, memory: active.memory, diff: active.diff, initialLine: active.line,
    options: focusMode ? { ...editorOptions, lineNumbers: false, highlightLine: true } : editorOptions, diagnostics, handle: selectEditor, onCursor: setCursor,
    onBlur: () => { if (settings.autoSave === 'blur') void store(latest.current.tabs.find(tab => tab.id === active.id)).catch(notify) },
    onEdit: (contents: string) => edited(active, contents),
  } : null
  // On narrow windows the graph island steps aside on its own; the setting is kept for when there is room again.
  const showGraph = graphOpen && frame.width >= 1080
  const columns = maximized ? 'minmax(0, 1fr)' : [sidebar ? workspaceWidth + 'px' : '', 'minmax(0, 1fr)', showGraph ? '272px' : ''].filter(Boolean).join(' ')
  const rows = maximized ? 'minmax(0, 1fr)' : drawerOpen ? 'minmax(0, 1fr) ' + actualDrawerHeight + 'px' : 'minmax(0, 1fr)'
  const marks = active ? edits[active.path] ?? [] : []
  const tabSlider = useSlider(selected + tabs.length + sidebar + graphOpen + focusMode)
  const drawerSlider = useSlider(drawer + drawerOpen + sidebar)
  const projectEntries = journalEntries.filter(entry => entry.root === workspace.root).slice(-3).reverse()
  const otherTabs = tabs.filter(tab => tab.id !== selected && !tab.diff).slice(0, 3)
  const excerpt = (text: string, count: number) => <pre>{text.split('\n').slice(0, count).join('\n')}</pre>
  const cards: OverviewCard[] = [
    { key: 'editor', title: active ? 'Editor · ' + fileName(active.path) : 'Editor', note: 'active', wide: true, current: true, body: active ? excerpt(active.diff ? active.diff.after : active.contents, 7) : <span>No file open</span> },
    ...otherTabs.map(tab => ({ key: 'tab:' + tab.id, title: fileName(tab.path), note: dirty(tab) ? 'unsaved' : undefined, body: excerpt(tab.contents, 6) })),
    { key: 'explorer', title: 'Files', hidden: sidebar !== 'explorer', body: <span className="ov-list">{(directories[''] ?? []).slice(0, 5).map(entry => <span key={entry.path}>{entry.name}{entry.directory ? '/' : ''}</span>)}</span> },
    { key: 'terminal', title: 'Terminal', hidden: !drawerOpen, body: excerpt(output.map(entry => entry.text).join('\n').split('\n').filter(Boolean).slice(-4).join('\n') || (sessions.length ? sessions.length + (sessions.length === 1 ? ' session open' : ' sessions open') : 'No output yet'), 4) },
    { key: 'graph', title: 'Graph', hidden: !graphOpen, fullLabel: 'Open graph', body: <span className="ov-dots" aria-hidden="true"><i /><i /><i /><i /><i /></span> },
    { key: 'journal', title: 'Journal', fullLabel: 'Open journal', body: <span className="ov-list">{projectEntries.length ? projectEntries.map(entry => <span key={entry.id}>{clock(entry.time)} {entry.text}</span>) : <span>Nothing noted yet</span>}</span> },
    remote
      ? { key: 'remote', title: 'Servers', hidden: sidebar !== 'remote', body: <span className="ov-list"><span>{workspace.hostName}</span><span>{workspace.root}</span></span> }
      : { key: 'git', title: 'Git', hidden: sidebar !== 'git', body: <span className="ov-list"><span>{status.changes.length} {status.changes.length === 1 ? 'change' : 'changes'} on {status.branch ?? 'no branch'}</span>{sidebar !== 'git' && <span>Click to show</span>}</span> },
  ]
  const runButton = runnable && active && <button type="button" className="run" title={'Run ' + (remote ? 'on ' + workspace.hostName + ' ' : '') + '(' + mod + '+Enter). Right-click for arguments.'} disabled={Boolean(job) || runningRequest || !jobReady}
    onClick={() => { void run() }} onContextMenu={event => { event.preventDefault(); askArguments() }}>{job?.kind === 'run' ? 'Running…' : 'Run'}</button>

  return <div className={'app bench-app' + (focusMode ? ' is-focus' : '')}>
    <TitleBar onError={notify} onClose={desktop ? () => { void getCurrentWindow().close().catch(notify) } : undefined}
      left={focusMode
        ? <span className="focus-path">{workspace.name}{active && active.path.split('/').map((part, index, all) => <span key={index}><i>/</i>{index === all.length - 1 ? <b>{part}</b> : part}</span>)}</span>
        : <>
          <button className="brand" onClick={goHome} title={'Home (' + mod + '+Shift+H)'}><span className="brand-word">Still</span></button>
          <span className="chrome-slash">/</span>
          <button className="chrome-project" onClick={event => {
            const box = event.currentTarget.getBoundingClientRect()
            setMenu({ x: box.left, y: box.bottom + 4, items: [
              { label: 'Go to Home', icon: House, shortcut: mod + '+Shift+H', action: goHome },
              { label: 'Open another folder…', icon: FolderOpen, shortcut: mod + '+O', action: chooseFolder },
              ...(desktop && !remote ? [{ label: 'Reveal in file manager', icon: FolderSearch, action: () => { void home.reveal(workspace.root).catch(notify) } }] : []),
              { label: 'Copy path', icon: Copy, action: () => copyText(workspace.root) },
              'separator',
              { label: 'Journal', icon: BookOpen, action: () => setJournalOpen(true) },
            ] })
          }} title={remote ? workspace.hostName + ':' + workspace.root : workspace.root}>
            {remote && <Icon glyph={Server} size={12} />}{workspace.name}
          </button>
        </>}
      center={focusMode ? undefined : <nav className="islands-nav" aria-label="Show or hide islands">
        {sideItems.map(item => <button key={item.key} aria-pressed={sidebar === item.key} className={sidebar === item.key ? 'is-on' : ''} onClick={() => showSide(item.key, true)}
          data-tip={(sidebar === item.key ? 'Hide ' : 'Show ') + item.label.toLowerCase() + ' · ' + mod + '+' + item.keys}>
          {item.label}{item.key === 'git' && status.changes.length > 0 && <span className="nav-count">{Math.min(status.changes.length, 99)}</span>}
        </button>)}
        <span className="nav-rule" />
        <button aria-pressed={graphOpen} className={graphOpen ? 'is-on' : ''} onClick={() => setGraphOpen(value => !value)} data-tip={(graphOpen ? 'Hide' : 'Show') + ' graph · ' + mod + '+Shift+D'}>Graph</button>
        <button aria-pressed={drawerOpen} className={drawerOpen ? 'is-on' : ''} onClick={() => drawerOpen && drawer === 'terminal' ? setDrawerOpen(false) : showDrawer('terminal', true)} data-tip={(drawerOpen && drawer === 'terminal' ? 'Hide' : 'Show') + ' terminal · ' + mod + '+J'}>Terminal</button>
        <span className="nav-rule" />
        <button onClick={toggleFocus} data-tip={'Only the code · ' + mod + '+.'}>Focus</button>
        <button onClick={openOverview} data-tip={'See everything · ' + mod + '+↑'}>Overview</button>
      </nav>}
      right={focusMode
        ? <button className="quiet-link" onClick={() => setFocusMode(false)}>Esc to show everything</button>
        : <>
          <button className="chrome-jump" onClick={() => openPalette('')} title="Find a file or run a command"><span>Go to</span><kbd>{mod}+K</kbd></button>
          <IconButton glyph={theme.kind === 'dark' ? Sun : Moon} label="Toggle light and dark" onClick={onToggleTheme} />
          <IconButton glyph={Settings2} label={'Settings (' + mod + '+,)'} onClick={() => onSettings()} />
          {remote ? <span className="chrome-branch"><Icon glyph={Server} size={12} />{workspace.hostName}</span>
            : <button className="chrome-branch" onClick={event => { void branchMenu(event) }} title="Switch branch">{status.branch ?? 'No branch'}</button>}
          {runButton}
        </>} />

    {focusMode && active && <div className="focus-ghost" aria-hidden="true">{fileName(active.path)}</div>}
    {focusMode && active && !active.diff && <aside className="focus-edits" aria-label="Edits this session">
      <span>Edits</span>
      <div className="focus-track">
        {marks.map((mark, index) => {
          const first = marks[0].time, span = Math.max(60000, Date.now() - first)
          return <button key={index} className={index === marks.length - 1 ? 'is-last' : ''} style={{ top: ((mark.time - first) / span) * 100 + '%' }}
            title={clock(mark.time) + ' · line ' + mark.line} aria-label={'Edit at ' + clock(mark.time) + ', line ' + mark.line} onClick={() => editor.current?.jump(mark.line)} />
        })}
      </div>
    </aside>}

    <div className={'bench' + (maximized ? ' max-' + maximized : '') + (focusMode && focusOutput ? ' with-output' : '')} style={{ gridTemplateColumns: focusMode ? undefined : columns, gridTemplateRows: focusMode ? undefined : rows }}>
      {sidebar && <aside className={'island side' + (drawerOpen ? ' tall' : '')} key={'side-' + sidebar} aria-label={sideItems.find(item => item.key === sidebar)?.label + ' island'}>
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
        <SplitGrip vertical value={workspaceWidth} min={180} max={sideMax} change={setSideWidth} />
      </aside>}

      <main className="island main">
        <div className="tab-strip" onDoubleClick={event => { if (event.target === event.currentTarget || (event.target as Element).classList.contains('tab-scroll')) toggleMaximize('editor') }}>
          <div className="tab-scroll" role="tablist" aria-label="Open files" ref={tabSlider.ref}>
            {tabs.map((tab, index) => <div key={tab.id} className={'tab' + (tab.id === selected ? ' is-active' : '')} data-slide={tab.id === selected ? '' : undefined}
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
                {tab.diff && <Icon glyph={GitCompareArrows} size={13} />}
                <span>{fileName(tab.path)}{tab.diff && (tab.staged ? ' · staged' : ' · diff')}</span>
              </button>
              <IconButton glyph={dirty(tab) ? Circle : X} className={'tab-close' + (dirty(tab) ? ' dirty' : '')} label={(dirty(tab) ? 'Unsaved. Close ' : 'Close ') + fileName(tab.path)} size={dirty(tab) ? 7 : 12} onClick={() => closeTab(tab)} />
            </div>)}
            {tabSlider.bar}
            <IconButton glyph={Plus} className="tab-add" label="Find and open a file" onClick={() => openPalette('')} />
          </div>
          {active && <div className="tab-tools">
            {remote && <span className="crumb-host" title={workspace.hostName + ':' + workspace.root + '/' + active.path}><Icon glyph={Server} size={12} />{workspace.hostName}</span>}
            {currentSymbol && !active.diff && <button className="crumb-symbol" onClick={() => editor.current?.jump(currentSymbol.line)} title="Jump to the start of this symbol">{currentSymbol.name}</button>}
            {active.diff && <span className="crumb-symbol">{active.staged ? 'Staged changes' : 'Working tree'}</span>}
            {!active.diff && (cursor.selected ?? 0) > 0 && docView !== 'preview' && <IconButton glyph={Camera} label="Create image of selected code" onClick={captureCode} />}
            {doc && <div className="doc-switch" role="radiogroup" aria-label="Document view">
              <IconButton glyph={PenLine} label="Edit" role="radio" aria-checked={docView === 'edit'} className={docView === 'edit' ? 'is-on' : ''} onClick={() => setDocView('edit')} />
              <IconButton glyph={Columns2} label="Edit and preview side by side" role="radio" aria-checked={docView === 'split'} className={docView === 'split' ? 'is-on' : ''} onClick={() => setDocView('split')} />
              <IconButton glyph={Eye} label={'Preview (' + mod + '+Shift+V)'} role="radio" aria-checked={docView === 'preview'} className={docView === 'preview' ? 'is-on' : ''} onClick={() => setDocView('preview')} />
            </div>}
            {active.diff && <IconButton glyph={settings.diffLayout === 'split' ? Rows2 : Columns2} label={settings.diffLayout === 'split' ? 'Show inline diff' : 'Show side-by-side diff'}
              onClick={() => update({ diffLayout: settings.diffLayout === 'split' ? 'inline' : 'split' })} />}
            {runnable && runArgs[active.path] && <span className="run-args" title="Program arguments">{runArgs[active.path]}</span>}
            {runnable && !remote && <IconButton glyph={Hammer} label={(mode === 'Java' ? 'Compile' : 'Check') + ' active file (' + mod + '+Shift+Enter)'} disabled={Boolean(job) || runningRequest || !jobReady} onClick={() => { void run(true) }} />}
            {active.diff && <IconButton glyph={Files} label="Open working file" onClick={() => { void openFile(active.path) }} />}
          </div>}
          <IconButton glyph={maximized === 'editor' ? Minimize2 : Maximize2} className="tab-max" label={(maximized === 'editor' ? 'Restore' : 'Fullscreen') + ' (' + mod + '+Shift+M)'} onClick={() => toggleMaximize('editor')} />
        </div>

        <section className="editor-wrap" id="editor-panel" role="tabpanel" aria-labelledby={active ? 'file-tab-' + tabs.indexOf(active) : undefined}>
          {active && editorProps ? (doc && docView !== 'edit'
            ? <div className={'doc-split' + (docView === 'preview' ? ' preview-only' : '')}>
                {docView === 'split' && <div className="doc-pane"><Editor {...editorProps} /></div>}
                <div className="doc-pane doc-pane-preview"><Preview text={active.contents} kind={doc} onLink={openLink} /></div>
              </div>
            : <Editor {...editorProps} />) : <div className="empty-editor">
            <div className="empty-inner">
              <p className="empty-title">{workspace.name}</p>
              <div className="empty-keys">
                <button onClick={() => openPalette('')}><span>Find a file</span><kbd>{mod}+P</kbd></button>
                <button onClick={() => openPalette('>')}><span>Run a command</span><kbd>{mod}+Shift+K</kbd></button>
                <button onClick={() => newFile()}><span>New file</span></button>
                <button onClick={() => showSide('search')}><span>Find in files</span><kbd>{mod}+Shift+F</kbd></button>
                <button onClick={() => showDrawer('terminal', true)}><span>Open terminal</span><kbd>{mod}+J</kbd></button>
                <button onClick={openOverview}><span>Overview</span><kbd>{mod}+↑</kbd></button>
                <button onClick={goHome}><span>Back to Home</span><kbd>{mod}+Shift+H</kbd></button>
              </div>
            </div>
          </div>}
        </section>
      </main>

      {showGraph && <aside className="island graph-island" aria-label="Graph island">
        <MiniGraph graph={graph} active={active && !active.diff ? active.path : undefined} onOpen={path => { void openFile(path) }} onExpand={() => setGraphView(true)} />
      </aside>}

      {(drawerOpen || sessions.length > 0) && <section className="island drawer" style={{ display: drawerOpen ? undefined : 'none', gridColumn: maximized ? '1 / -1' : sidebar ? '2 / -1' : '1 / -1', gridRow: maximized ? '1' : undefined }} aria-label="Terminal island">
        <SplitGrip value={actualDrawerHeight} min={128} max={drawerMax} change={setDrawerHeight} />
        <div className="drawer-nav">
          <div className="drawer-tabs" role="tablist" aria-label="Console views" ref={drawerSlider.ref}>
            {drawerTabs.map(({ key, label }) => <button key={key} type="button" role="tab" aria-selected={drawer === key} data-slide={drawer === key ? '' : undefined}
              className={'drawer-tab' + (drawer === key ? ' is-active' : '')} onClick={() => showDrawer(key, true)}>
              {label}{key === 'problems' && diagnostics.length > 0 && <span className="nav-count">{diagnostics.length}</span>}
            </button>)}
            {drawerSlider.bar}
          </div>
          {drawer === 'terminal' && sessions.length > 0 && <div className="session-tabs" role="tablist" aria-label="Terminal sessions">
            {sessions.map(session => <div key={session.id} className={'session' + (session.id === activeSession ? ' is-active' : '') + (session.exited ? ' exited' : '')}>
              <button role="tab" aria-selected={session.id === activeSession} onClick={() => { setActiveSession(session.id); requestAnimationFrame(() => terminal.current?.focus()) }}>
                {session.ssh && <Icon glyph={Server} size={11} />}{session.label}
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
            <IconButton glyph={maximized === 'terminal' ? Minimize2 : Maximize2} label={(maximized === 'terminal' ? 'Restore' : 'Fullscreen') + ' (' + mod + '+Shift+M)'} onClick={() => toggleMaximize('terminal')} />
            <IconButton glyph={X} label={'Hide (' + mod + '+J)'} onClick={() => { setDrawerOpen(false); editor.current?.focus() }} />
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
    </div>

    {focusMode && focusOutput && <section className="focus-output" aria-label="Output">
      <div className="focus-output-head">
        <span>Output{job?.kind === 'run' ? ' · running' : lastRun ? ' · ' + fileName(lastRun.path) + ' · ' + (lastRun.code === null ? 'stopped' : 'exit ' + lastRun.code) : ''}</span>
        {job && <button className="quiet-link" onClick={() => { void invoke('stop_job', { id: job.id }).catch(notify) }}>Stop</button>}
        <button className="quiet-link" onClick={() => { setOutput([]); setSampleRun(false) }}>Clear</button>
        <button className="quiet-link" onClick={() => { setFocusOutput(false); editor.current?.focus() }}>Hide <kbd>Esc</kbd></button>
      </div>
      <div className="focus-output-body">
        <Output entries={output} sample={sampleRun} onInput={job?.kind === 'run' ? text => { void invoke('job_input', { id: job.id, text }).catch(notify) } : undefined} />
      </div>
    </section>}

    {focusMode ? <footer className="status focus-foot" aria-label="Focus status">
      <span className="status-item focus-pos">{active ? 'Ln ' + cursor.line + ', Col ' + cursor.column : workspace.name}</span>
      <nav className="focus-files" aria-label="Open files">
        {tabs.filter(tab => !tab.diff).slice(0, 6).map(tab => <button key={tab.id} className={tab.id === selected ? 'is-active' : ''} aria-current={tab.id === selected ? 'page' : undefined} title={tab.path}
          onClick={() => activate(tab.id)}>{fileName(tab.path)}{dirty(tab) && <span className="dot" aria-label="unsaved" />}</button>)}
        <button className="focus-open" onClick={() => openPalette('')} title="Open another file">Open… <kbd>{mod}+P</kbd></button>
      </nav>
      <span className="focus-actions">
        <button className={'focus-toggle' + (focusOutput ? ' is-on' : '')} aria-pressed={focusOutput} onClick={() => setFocusOutput(value => !value)}>Output</button>
        {runButton}
      </span>
    </footer> : <footer className="status" aria-label="Workspace status">
      {remote ? <button className="status-item" onClick={() => showSide('remote')} title="Connected over SSH">{host ? (host.user ? host.user + '@' : '') + (host.address || host.host) : workspace.hostName}</button>
        : <button className="status-item" onClick={() => showSide('git')} title="Show source control">{status.branch ?? 'No branch'}{status.changes.length > 0 && <span className="status-amber"> · {status.changes.length} changed</span>}</button>}
      <button className="status-item" onClick={() => showDrawer('problems')} aria-label={problemCount + ' errors and ' + warningCount + ' warnings'}>
        {problemCount} {problemCount === 1 ? 'error' : 'errors'} · {warningCount} {warningCount === 1 ? 'warning' : 'warnings'}
      </button>
      {maximized && <button className="status-item status-strong" onClick={() => setMaximized(null)}>Fullscreen · Esc or {mod}+Shift+M to restore</button>}
      {job && <button className="status-item" onClick={() => showDrawer('output')}><span className="status-dot busy" />{job.kind === 'run' ? 'Running' : job.kind === 'git' ? 'Git ' + job.action : 'Packages'}…</button>}
      {settings.autoSave !== 'off' && <span className="status-item status-optional" title="Auto save is on">Auto save</span>}
      <div className="flex-1" />
      {active && <><span className="status-item">Ln {cursor.line}, Col {cursor.column}{cursor.selected ? ` (${cursor.selected} selected)` : ''}</span>
        <button className="status-item status-optional" onClick={() => onSettings('editor')} title="Indentation settings">Spaces: {tabSize}</button>
        <span className="status-item status-language">{mode}</span></>}
      {!remote && <button className="status-item" title="Show runtimes and packages" onClick={() => showSide('packages')}>
        <span className={'status-dot' + (!runtime ? ' inactive' : '')} />{!desktop ? 'Browser preview' : runtime ? runtime + (mode === 'Python' && (runtimes?.pythonVenv || isVirtual(packageState)) ? ' · .venv' : '') : runtimes ? runtimeMissing : 'Detecting runtimes…'}
      </button>}
    </footer>}

    {overview && <Overview title={workspace.name} cards={cards} spaces={spaces} layouts={[...layouts, ...(savedLayout() ? [{ id: 'custom', label: 'Saved' }] : [])]} layout={currentLayout}
      onJump={jumpIsland} onToggle={toggleIsland} onFullscreen={fullscreenIsland} onClose={() => { setOverview(false); requestAnimationFrame(() => editor.current?.focus()) }}
      onSpace={id => { setOverview(false); if (id === 'home') goHome(); else leave(() => { void home.open(id).then(onSwitch).catch(notify) }, 'Switch project?') }}
      onNewSpace={() => { setOverview(false); chooseFolder() }}
      onLayout={id => applyLayout(id)}
      onSaveLayout={() => { try { localStorage.setItem('still.layout.custom', JSON.stringify(islands)) } catch { /* ignore */ } notify('Saved this layout. Pick it under Layouts as Saved.') }} />}
    {graphView && <GraphView graph={graph} error={graphError} project={workspace.name} active={active && !active.diff ? active.path : undefined} changed={changedPaths}
      onOpen={path => { setGraphView(false); void openFile(path) }} onClose={() => { setGraphView(false); requestAnimationFrame(() => editor.current?.focus()) }} />}
    {idle && <Idle sources={tabs.filter(tab => !tab.diff).map(tab => ({ path: tab.path, project: workspace.name, text: tab.contents, edited: edits[tab.path]?.at(-1)?.time }))} onWake={wake} />}
    {palette !== null && <Palette commands={commands} files={fileItems} start={palette} onClose={closePalette} />}
    {dialog && <Dialog dialog={dialog} close={() => setDialog(null)} />}
    {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    {journalOpen && <JournalSheet root={workspace.root} onClose={() => setJournalOpen(false)}
      onOpen={entry => { if (entry.root === workspace.root && entry.path) { setJournalOpen(false); void openFile(entry.path) } }} />}
    {shot && <CodeShot capture={shot} onClose={() => { setShot(null); editor.current?.focus() }} notify={notify} />}
    {editingHost && <HostDialog host={editingHost} onClose={() => setEditingHost(null)} onSaved={() => { void refreshServers() }} />}
    {remoteHost && <OpenRemoteDialog host={remoteHost} onClose={() => setRemoteHost(null)} onOpen={async path => {
      const root = await ssh.resolve(remoteHost.id, path)
      leave(() => onSwitch({ root, name: root.split('/').filter(Boolean).at(-1) ?? root, remote: remoteHost.id, hostName: remoteHost.name }), 'Switch project?')
    }} />}
  </div>
}
