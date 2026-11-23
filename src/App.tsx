import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Terminal as Xterm } from '@xterm/xterm'
import {
  ArrowDown, ArrowUp, Braces, ChevronRight, Circle, CircleAlert, CodeXml, FilePlus2,
  Files, FolderOpen, GitBranch, GitCompareArrows, Hammer, Minus, Moon, Package,
  PanelBottom, PanelLeft, Play, Plus, Search, Square, Sun, TerminalSquare, Trash2, X,
} from 'lucide-react'
import {
  api, chooseWorkspace, desktop, fileName, initialWorkspace, mod, parentPath,
  type Change, type Diagnostic, type Diff, type Entry, type GitStatus, type JobEvent, type Packages, type Runtimes, type Workspace,
} from './bridge'
import mark from './still.svg?inline'
import Editor, { language, type EditorHandle, type EditorMemory } from './Editor'
import { Explorer, PackagesPanel, Palette, SourceControl, symbolsFor, type PaletteItem } from './Panels'
import Terminal from './Terminal'
import { Dialog, Output, Problems, SplitGrip, type DialogState, type OutputEntry } from './Workbench'
import { FileIcon, Icon, IconButton } from './ui'

type Side = 'explorer' | 'git' | 'packages'
type Drawer = 'terminal' | 'output' | 'problems'
type Theme = 'dark' | 'light'
type Tab = { id: string; path: string; contents: string; saved: string; memory?: EditorMemory; diff?: Diff; staged?: boolean }
type Job = { id: string; kind: 'run' | 'git' | 'packages'; action: string }

const emptyStatus: GitStatus = { branch: null, changes: [] }
const initialOutput: OutputEntry[] = [
  { kind: 'command', text: '$ python -u src/app.py' },
  { kind: 'stdout', text: 'ISS         92.58 min\nHubble      95.30 min' },
  { kind: 'exit', text: 'Process exited with code 0.', code: 0 },
]
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const dirty = (tab: Tab) => tab.contents !== tab.saved
const fileTab = (path: string, contents: string): Tab => ({ id: path, path, contents, saved: contents, memory: {} })

function storedSize(key: string, fallback: number) {
  const value = Number(localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [selected, setSelected] = useState('')
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [sidebar, setSidebar] = useState<Side | null>('explorer')
  const [lastSide, setLastSide] = useState<Side>('explorer')
  const [sideWidth, setSideWidth] = useState(() => storedSize('still.sidebar.width', 228))
  const [drawer, setDrawer] = useState<Drawer>('output')
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [drawerHeight, setDrawerHeight] = useState(() => storedSize('still.drawer.height', 242))
  const [terminalEpoch, setTerminalEpoch] = useState(0)
  const [terminalMounted, setTerminalMounted] = useState(false)
  const [frame, setFrame] = useState({ width: window.innerWidth, height: window.innerHeight })
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('still.theme') === 'light' ? 'light' : 'dark')
  const [directories, setDirectories] = useState<Record<string, Entry[]>>({})
  const [expanded, setExpanded] = useState(new Set<string>())
  const [files, setFiles] = useState<Entry[]>([])
  const [status, setStatus] = useState(emptyStatus)
  const [gitError, setGitError] = useState('')
  const [packageState, setPackageState] = useState<Packages | null>(null)
  const [runtimes, setRuntimes] = useState<Runtimes | null>(null)
  const [output, setOutput] = useState<OutputEntry[]>([])
  const [sampleRun, setSampleRun] = useState(false)
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [job, setJob] = useState<Job | null>(null)
  const [runningRequest, setRunningRequest] = useState(false)
  const [jobReady, setJobReady] = useState(!desktop)
  const [gitBusy, setGitBusy] = useState(false)
  const [commit, setCommit] = useState('')
  const [palette, setPalette] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [toast, setToast] = useState('')
  const generation = useRef(0)
  const editor = useRef<EditorHandle | null>(null)
  const terminal = useRef<Xterm | null>(null)
  const activeJob = useRef<Job | null>(null)
  const latest = useRef({ tabs, workspace, selected, expanded })
  latest.current = { tabs, workspace, selected, expanded }
  const saving = useRef(new Map<string, Promise<void>>())
  const opening = useRef(new Map<string, Promise<void>>())
  const pendingJump = useRef<{ path: string; line: number; column?: number } | null>(null)
  const windowCloseApproved = useRef(false)
  const returnedFocus = useRef<HTMLElement | null>(null)

  const active = tabs.find(tab => tab.id === selected)
  const mode = active ? language(active.path) : null
  const runnable = active && !active.diff && (mode === 'Python' || mode === 'Java')
  const symbols = useMemo(() => active && !active.diff ? symbolsFor(active.contents, active.path) : [], [active?.path, active?.contents, active?.diff])
  const currentSymbol = [...symbols].reverse().find(symbol => symbol.line <= cursor.line)
  const problemCount = diagnostics.filter(item => item.severity === 'error').length
  const warningCount = diagnostics.length - problemCount
  const runtime = mode === 'Java' ? runtimes?.java : (mode === 'Python' ? runtimes?.python : runtimes?.python ?? runtimes?.java)
  const runtimeMissing = mode === 'Java' ? 'JDK unavailable' : mode === 'Python' ? 'Python unavailable' : 'No runtime'
  const sideMax = Math.max(140, Math.min(450, frame.width <= 690 ? Math.floor(frame.width * .27) : frame.width <= 790 ? Math.floor(frame.width * .32) : frame.width - 330))
  const workspaceWidth = Math.min(sideWidth, sideMax)
  const drawerMax = Math.max(128, frame.height - 260)
  const actualDrawerHeight = Math.min(drawerHeight, drawerMax)

  function notify(error: unknown) { setToast(errorText(error)) }

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111113' : '#fafafa')
    localStorage.setItem('still.theme', theme)
  }, [theme])
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
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 5200)
    return () => clearTimeout(timer)
  }, [toast])

  async function refreshGit(root: string, id = generation.current) {
    try {
      const result = await api.git(root)
      if (generation.current === id) { setStatus(result); setGitError('') }
    } catch (error) { if (generation.current === id) setGitError(errorText(error)) }
  }

  async function refreshPackages(root: string, id = generation.current) {
    try {
      const result = await api.packages(root)
      if (generation.current === id) setPackageState(result)
    } catch (error) { if (generation.current === id) notify(error) }
  }

  async function directory(root: string, path: string, id = generation.current) {
    try {
      const result = await api.list(root, path)
      if (generation.current === id) setDirectories(previous => ({ ...previous, [path]: result }))
    } catch (error) { if (generation.current === id) notify(error) }
  }

  async function refreshFiles(root: string, folders: Iterable<string> = [], id = generation.current) {
    try {
      const [result] = await Promise.all([api.files(root), ...['', ...folders].map(path => directory(root, path, id))])
      if (generation.current === id) setFiles(result)
    } catch (error) { if (generation.current === id) notify(error) }
  }

  async function refreshCleanTabs(root: string, id = generation.current) {
    const originals = latest.current.tabs.filter(tab => !tab.diff && !dirty(tab))
    const reads = await Promise.allSettled(originals.map(tab => api.read(root, tab.path)))
    if (generation.current !== id) return
    const replacements = new Map<string, { original: Tab; contents: string }>()
    reads.forEach((result, index) => {
      const original = originals[index]
      if (result.status === 'fulfilled' && result.value !== original.saved) {
        replacements.set(original.id, { original, contents: result.value })
      }
    })
    if (!replacements.size) return
    setTabs(previous => previous.map(tab => {
      const replacement = replacements.get(tab.id)
      return replacement && tab.memory === replacement.original.memory && !dirty(tab) && tab.saved === replacement.original.saved
        ? fileTab(tab.path, replacement.contents) : tab
    }))
  }

  async function enterWorkspace(next: Workspace) {
    const id = ++generation.current
    opening.current.clear()
    pendingJump.current = null
    setWorkspace(next)
    setTabs([])
    setSelected('')
    setCursor({ line: 1, column: 1 })
    setStatus(emptyStatus)
    setGitError('')
    setDirectories({})
    setFiles([])
    setDiagnostics([])
    setPackageState(null)
    setRuntimes(null)
    setCommit('')
    setTerminalMounted(false)
    setDrawer('output')
    const initialFolders = next.sample ? ['src', 'tests'] : []
    setExpanded(new Set(initialFolders))
    setOutput(next.sample ? initialOutput : [])
    setSampleRun(next.sample)
    void refreshFiles(next.root, initialFolders, id)
    void refreshGit(next.root, id)
    void api.runtimes(next.root).then(result => {
      if (generation.current === id) setRuntimes(result)
    }).catch(error => { if (generation.current === id) notify(error) })
    if (next.sample) {
      const paths = ['README.md', 'src/app.py', 'src/Main.java']
      const initial = await Promise.all(paths.map(path => api.read(next.root, path).then(contents => fileTab(path, contents)).catch(() => null)))
      if (generation.current !== id) return
      const available = initial.filter(tab => tab !== null)
      setTabs(previous => [...available.filter(tab => !previous.some(existing => existing.id === tab.id)), ...previous])
      setSelected(previous => previous || (available.some(tab => tab.id === 'src/app.py') ? 'src/app.py' : available[0]?.id ?? ''))
    }
  }

  useEffect(() => {
    void initialWorkspace().then(enterWorkspace).catch(notify)
    return () => { generation.current++ }
  }, [])

  useEffect(() => {
    if (!workspace) return
    if (sidebar === 'git') void refreshGit(workspace.root)
    if (sidebar === 'packages') void refreshPackages(workspace.root)
  }, [workspace?.root, sidebar])

  function askDiscard(title: string, description: string, action: () => void) {
    setDialog({ title, description, label: 'Discard changes', action })
  }

  function chooseFolder() {
    if (activeJob.current || runningRequest || saving.current.size || gitBusy) { notify('Wait for the current operation before switching folders.'); return }
    const choose = () => { void chooseWorkspace().then(next => { if (next) void enterWorkspace(next) }).catch(notify) }
    if (desktop && latest.current.tabs.some(dirty)) askDiscard('Switch workspace?', 'The open workspace has unsaved files.', choose)
    else choose()
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
      const root = latest.current.workspace?.root
      if (!root) return
      if (current.kind === 'git') {
        void refreshGit(root)
        if (current.action === 'pull' && payload.code === 0) {
          void refreshFiles(root, latest.current.expanded)
          void refreshCleanTabs(root)
        }
        if (current.action === 'commit' && payload.code === 0) setCommit('')
      }
      if (current.kind === 'packages') void refreshPackages(root)
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

  function expandParents(path: string, root: string) {
    const ancestors: string[] = []
    for (let parent = parentPath(path); parent; parent = parentPath(parent)) ancestors.push(parent)
    if (!ancestors.length) return
    setExpanded(previous => new Set([...previous, ...ancestors]))
    for (const item of ancestors) if (!directories[item]) void directory(root, item)
  }

  async function openFile(path: string) {
    const root = latest.current.workspace?.root
    if (!root) return
    const id = generation.current
    if (latest.current.tabs.some(tab => tab.id === path)) { activate(path); return }
    if (opening.current.has(path)) return opening.current.get(path)
    const task = api.read(root, path).then(contents => {
      if (generation.current !== id) return
      setTabs(previous => previous.some(tab => tab.id === path) ? previous : [...previous, fileTab(path, contents)])
      activate(path)
      expandParents(path, root)
    }).catch(error => {
      if (generation.current === id) { pendingJump.current = null; notify(error) }
    }).finally(() => { if (generation.current === id) opening.current.delete(path) })
    opening.current.set(path, task)
    return task
  }

  function selectEditor(handle: EditorHandle | null) {
    editor.current = handle
    const jump = pendingJump.current
    if (handle && jump && jump.path === selected) {
      pendingJump.current = null
      requestAnimationFrame(() => handle.jump(jump.line, jump.column))
    }
  }

  function jumpTo(item: Diagnostic) {
    if (latest.current.selected === item.path) editor.current?.jump(item.line, item.column)
    else { pendingJump.current = item; void openFile(item.path) }
  }

  useEffect(() => {
    if (!selected || palette !== null || dialog || !active) return
    const id = requestAnimationFrame(() => editor.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [selected, !!active])

  async function openDiff(change: Change, indexed: boolean) {
    const root = latest.current.workspace?.root
    if (!root) return
    const id = generation.current
    try {
      const diff = await api.diff(root, change, indexed)
      if (generation.current !== id) return
      const key = (indexed ? 'staged:' : 'working:') + change.path
      const tab: Tab = { id: key, path: change.path, contents: '', saved: '', diff, staged: indexed }
      setTabs(previous => previous.some(item => item.id === key) ? previous.map(item => item.id === key ? tab : item) : [...previous, tab])
      activate(key)
    } catch (error) { notify(error) }
  }

  function closeTab(tab: Tab) {
    const close = () => {
      const current = latest.current.tabs
      const index = current.findIndex(item => item.id === tab.id)
      const next = current.filter(item => item.id !== tab.id)
      setTabs(next)
      if (latest.current.selected === tab.id) setSelected(next[Math.min(index, next.length - 1)]?.id ?? '')
    }
    if (dirty(tab)) askDiscard('Close ' + fileName(tab.path) + '?', 'This file has unsaved changes.', close)
    else close()
  }

  async function store(tab?: Tab) {
    const root = latest.current.workspace?.root
    if (!root || !tab || tab.diff) return
    const id = generation.current
    const key = root + '\0' + tab.id
    const previousSave = saving.current.get(key)
    if (previousSave) { await previousSave; return store(tab) }
    const current = latest.current.tabs.find(item => item.id === tab.id)
    if (!current || !dirty(current)) return
    const task = api.save(root, current.path, current.contents, current.saved).then(() => {
      if (generation.current !== id) return
      const markSaved = (items: Tab[]) => items.map(item => item.id === current.id ? { ...item, saved: current.contents } : item)
      latest.current.tabs = markSaved(latest.current.tabs)
      setTabs(markSaved)
      void refreshGit(root, id)
    })
    saving.current.set(key, task)
    try { await task } finally { if (saving.current.get(key) === task) saving.current.delete(key) }
  }

  function newFile() {
    const root = latest.current.workspace?.root
    if (!root) return
    const id = generation.current
    setDialog({
      title: 'New file', description: 'Enter a path relative to the workspace.', input: '', label: 'Create file',
      action: path => { void api.create(root, path).then(async () => {
        if (generation.current !== id) return
        await openFile(path)
        void refreshFiles(root, new Set([...expanded, parentPath(path)].filter(Boolean)), id)
        void refreshGit(root, id)
      }).catch(notify) },
    })
  }

  function toggleFolder(path: string) {
    const root = latest.current.workspace?.root
    if (root && !directories[path]) void directory(root, path)
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
  }

  function showDrawer(which: Drawer, focus = false) {
    setDrawer(which)
    setDrawerOpen(true)
    if (which === 'terminal') {
      setTerminalMounted(true)
      if (focus) requestAnimationFrame(() => terminal.current?.focus())
    }
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
    if (!workspace || !active || !runnable || runningRequest || activeJob.current) return
    if (!desktop) {
      showDrawer('output')
      notify('Run and Build use local runtimes in the Still desktop app.')
      return
    }
    setRunningRequest(true)
    try {
      await store(active)
      setDiagnostics([])
      await launch('run', buildOnly ? 'build' : 'run', 'run_file', { rootPath: workspace.root, path: active.path, buildOnly })
    } catch (error) { notify(error) }
    finally { setRunningRequest(false) }
  }

  async function updateStage(change: Change, index: boolean) {
    if (!workspace || gitBusy) return
    setGitBusy(true)
    try { await api.stage(workspace.root, change, index); await refreshGit(workspace.root) }
    catch (error) { notify(error) }
    finally { setGitBusy(false) }
  }

  function gitAction(action: 'commit' | 'pull' | 'push') {
    if (!workspace) return
    if (!desktop) {
      if (action === 'commit' && commit.trim()) {
        api.previewCommit()
        setCommit('')
        void refreshGit(workspace.root)
        notify('Sample changes committed in this preview.')
      } else if (action !== 'commit') notify('Remote Git operations are available in the Still desktop app.')
      return
    }
    void launch('git', action, 'git_action', { rootPath: workspace.root, action, message: action === 'commit' ? commit : null })
  }

  function packageAction(action: string, name?: string) {
    if (!workspace) return
    if (!desktop) { notify('Package changes are available in the Still desktop app.'); return }
    const start = () => { void launch('packages', action, 'package_action', { rootPath: workspace.root, action, name: name ?? null }) }
    if (action === 'remove' && name) setDialog({
      title: 'Remove ' + name + '?', description: 'This uninstalls the package from the active Python environment.', label: 'Remove package', action: start,
    })
    else start()
  }

  function openPalette(query: string) {
    returnedFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPalette(query)
    const root = latest.current.workspace?.root
    const id = generation.current
    if (root) void api.files(root).then(result => {
      if (generation.current === id) setFiles(result)
    }).catch(notify)
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

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || dialog) return
      const key = event.key.toLowerCase()
      if (!['k', 'p', 's', 'w', 'b', 'j', 'o', 'enter'].includes(key)) return
      if (key === 'enter' && palette !== null) return
      event.preventDefault()
      if (key === 'p' || key === 'k') { palette !== null ? closePalette() : openPalette(event.shiftKey ? '>' : ''); return }
      if (palette !== null) return
      if (key === 's') void store(active).catch(notify)
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

  const commands: PaletteItem[] = [
    { id: 'folder', label: 'Open workspace folder', shortcut: mod + '+O', icon: FolderOpen, action: chooseFolder },
    { id: 'new', label: 'New file', icon: FilePlus2, action: newFile },
    { id: 'save', label: 'Save active file', shortcut: mod + '+S', icon: Files, action: () => { void store(active).catch(notify) } },
    ...(runnable ? [
      { id: 'run', label: 'Run active file', shortcut: mod + '+Enter', icon: Play, action: () => { void run() } },
      { id: 'build', label: 'Build active file', shortcut: mod + '+Shift+Enter', icon: Hammer, action: () => { void run(true) } },
    ] : []),
    { id: 'dark', label: 'Use dark theme', icon: Moon, action: () => setTheme('dark') },
    { id: 'light', label: 'Use light theme', icon: Sun, action: () => setTheme('light') },
    { id: 'explorer', label: 'Show explorer', icon: Files, action: () => showSide('explorer') },
    { id: 'git', label: 'Show source control', icon: GitBranch, action: () => showSide('git') },
    { id: 'packages', label: 'Show packages', icon: Package, action: () => showSide('packages') },
    { id: 'terminal', label: 'Show terminal', shortcut: mod + '+J', icon: TerminalSquare, action: () => showDrawer('terminal', true) },
    { id: 'output', label: 'Show process output', icon: CodeXml, action: () => showDrawer('output') },
    { id: 'problems', label: 'Show compiler problems', icon: CircleAlert, action: () => showDrawer('problems') },
  ]
  const fileItems: PaletteItem[] = files.map(file => ({ id: file.path, label: file.name, detail: parentPath(file.path), path: file.path, action: () => { void openFile(file.path) } }))
  const rail = [
    { key: 'explorer', label: 'Explorer', glyph: Files },
    { key: 'git', label: 'Source Control', glyph: GitBranch },
    { key: 'packages', label: 'Packages', glyph: Package },
  ] as const
  const drawerTabs = [
    { key: 'terminal', label: 'Terminal', glyph: TerminalSquare },
    { key: 'output', label: 'Output', glyph: CodeXml },
    { key: 'problems', label: 'Problems', glyph: CircleAlert },
  ] as const
  const breadcrumb = active?.path.split('/') ?? []
  const toggleTheme = () => setTheme(value => value === 'dark' ? 'light' : 'dark')

  return <div className="app">
    <header className="chrome" onMouseDown={event => {
      if (desktop && event.button === 0 && !(event.target as Element).closest('button')) {
        const current = getCurrentWindow()
        void (event.detail === 2 ? current.toggleMaximize() : current.startDragging()).catch(notify)
      }
    }}>
      <button className="brand" onClick={chooseFolder} title="Open workspace folder">
        <img src={mark} alt="" /><span className="brand-word">Still</span><span className="chrome-divider" /><span className="chrome-project">{workspace?.name}</span>
      </button>
      <button className="jump" aria-label="Open command palette" onClick={() => openPalette('')}>
        <Icon glyph={Search} size={13} /><span>Jump to file or command…</span><kbd>{mod}+K</kbd>
      </button>
      <div className="chrome-actions">
        <IconButton glyph={PanelLeft} label="Toggle sidebar" onClick={() => setSidebar(value => value ? null : lastSide)} />
        <IconButton glyph={PanelBottom} label="Toggle bottom drawer" onClick={() => setDrawerOpen(value => !value)} />
        <IconButton glyph={theme === 'dark' ? Sun : Moon} label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'} onClick={toggleTheme} />
        {desktop && <div className="window-controls">
          <IconButton glyph={Minus} size={13} label="Minimize" onClick={() => { void getCurrentWindow().minimize().catch(notify) }} />
          <IconButton glyph={Square} size={11} label="Toggle maximize" onClick={() => { void getCurrentWindow().toggleMaximize().catch(notify) }} />
          <IconButton glyph={X} size={14} label="Close window" className="window-close" onClick={() => { void getCurrentWindow().close().catch(notify) }} />
        </div>}
      </div>
    </header>

    <div className="workspace">
      <nav className="rail" aria-label="Workspace views">
        {rail.map(({ key, label, glyph }) => <button key={key} className={sidebar === key ? 'is-active' : ''} title={label} aria-label={label} aria-pressed={sidebar === key} onClick={() => showSide(key, true)}>
          <Icon glyph={glyph} size={16} />
          {key === 'git' && status.changes.length > 0 && <span className="rail-count">{Math.min(status.changes.length, 99)}</span>}
        </button>)}
        <div className="flex-1" />
        <button className={drawerOpen && drawer === 'terminal' ? 'is-active' : ''} aria-label="Toggle terminal" title="Toggle terminal"
          onClick={() => drawerOpen && drawer === 'terminal' ? setDrawerOpen(false) : showDrawer('terminal', true)}><Icon glyph={TerminalSquare} size={16} /></button>
      </nav>

      {sidebar && <aside className="side" style={{ width: workspaceWidth }} aria-label={sidebar === 'git' ? 'Source Control panel' : sidebar === 'packages' ? 'Packages panel' : 'Explorer panel'}>
        {sidebar === 'explorer' && <Explorer workspace={workspace} directories={directories} expanded={expanded} active={active?.path} changes={status} symbols={symbols}
          onOpen={path => { void openFile(path) }} onExpand={toggleFolder} onNew={newFile} onWorkspace={chooseFolder}
          onRefresh={() => { if (workspace) void refreshFiles(workspace.root, expanded) }} onJump={line => editor.current?.jump(line)} />}
        {sidebar === 'git' && <SourceControl status={status} busy={Boolean(job) || gitBusy} error={gitError} commit={commit} onCommitText={setCommit}
          onDiff={(change, index) => { void openDiff(change, index) }} onStage={(change, index) => { void updateStage(change, index) }} onAction={gitAction}
          onRefresh={() => { if (workspace) void refreshGit(workspace.root) }} />}
        {sidebar === 'packages' && <PackagesPanel key={workspace?.root} state={packageState} busy={Boolean(job)} onOpen={path => { void openFile(path) }}
          onSearch={api.search} onAction={packageAction} onRefresh={() => { if (workspace) void refreshPackages(workspace.root) }} />}
        <SplitGrip vertical value={workspaceWidth} min={140} max={sideMax} change={setSideWidth} />
      </aside>}

      <main className="main">
        <div className="tab-strip">
          <div className="tab-scroll" role="tablist" aria-label="Open files">
            {tabs.map((tab, index) => <div key={tab.id} className={'tab' + (tab.id === selected ? ' is-active' : '')}>
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
            {breadcrumb.map((part, index) => index === breadcrumb.length - 1
              ? <span key={index} className="crumb-current flex items-center gap-1.5 truncate"><FileIcon path={active.path} size={13} />{part}</span>
              : <span key={index} className="inline-flex items-center gap-1.5"><button onClick={() => { showSide('explorer'); if (workspace) expandParents(active.path, workspace.root) }}>{part}</button><Icon glyph={ChevronRight} size={12} /></span>)}
            {currentSymbol && <><Icon glyph={ChevronRight} size={12} /><button className="crumb-symbol inline-flex items-center gap-1" onClick={() => editor.current?.jump(currentSymbol.line)}>
              <Icon glyph={currentSymbol.kind === 'class' ? Braces : CodeXml} size={12} />{currentSymbol.name}</button></>}
            {active.diff && <><Icon glyph={ChevronRight} size={12} /><span>{active.staged ? 'Staged' : 'Working tree'}</span></>}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {runnable && <button type="button" className="run" title={'Run active file (' + mod + '+Enter)'} disabled={Boolean(job) || runningRequest || !jobReady} onClick={() => { void run() }}>
              <Icon glyph={Play} />Run</button>}
            {runnable && <IconButton glyph={Hammer} label={'Build active file (' + mod + '+Shift+Enter)'} disabled={Boolean(job) || runningRequest || !jobReady} onClick={() => { void run(true) }} />}
            {active.diff && <IconButton glyph={Files} label="Open working file" onClick={() => { void openFile(active.path) }} />}
          </div>
        </div>}

        <section className="editor-wrap" id="editor-panel" role="tabpanel" aria-labelledby={active ? 'file-tab-' + tabs.indexOf(active) : undefined}>
          {active ? <Editor path={active.path} text={active.contents} memory={active.memory} diff={active.diff} sample={workspace?.sample}
            diagnostics={diagnostics} handle={selectEditor} onCursor={setCursor}
            onEdit={contents => setTabs(previous => previous.map(tab => tab.id === active.id ? { ...tab, contents } : tab))} /> : <div className="empty-editor">
            <div className="text-center"><img src={mark} alt="" />
              <button className="text-btn primary mr-2" onClick={chooseFolder}><Icon glyph={FolderOpen} />Open folder</button>
              <button className="text-btn" onClick={() => openPalette('')}><Icon glyph={Search} />Find file <kbd>{mod}+P</kbd></button>
            </div>
          </div>}
        </section>

        {(drawerOpen || terminalMounted) && <section className="drawer" style={{ height: actualDrawerHeight, display: drawerOpen ? undefined : 'none' }} aria-label="Bottom drawer">
          <SplitGrip value={actualDrawerHeight} min={128} max={drawerMax} change={setDrawerHeight} />
          <div className="drawer-nav" role="tablist" aria-label="Console views">
            {drawerTabs.map(({ key, label, glyph }) => <button key={key} type="button" role="tab" aria-selected={drawer === key}
              className={'drawer-tab' + (drawer === key ? ' is-active' : '')} onClick={() => showDrawer(key, true)}>
              <Icon glyph={glyph} size={14} />{label}{key === 'problems' && diagnostics.length > 0 && <span className="help">{diagnostics.length}</span>}
            </button>)}
            <div className="drawer-actions">
              {drawer === 'terminal' && desktop && <IconButton glyph={Plus} label="New terminal" onClick={() => { setTerminalMounted(true); setTerminalEpoch(value => value + 1) }} />}
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
            {desktop && workspace && terminalMounted && <Terminal key={workspace.root + ':' + terminalEpoch} root={workspace.root} visible={drawerOpen && drawer === 'terminal'} theme={theme} onReady={value => { terminal.current = value }} />}
            {!desktop && drawer === 'terminal' && <div className="console-scroll"><div className="console-banner"><Icon glyph={TerminalSquare} />The local shell is available in the Still desktop app.</div></div>}
            {drawer === 'output' && <Output entries={output} sample={sampleRun} />}
            {drawer === 'problems' && <Problems items={diagnostics} jump={jumpTo} />}
          </div>
        </section>}
      </main>
    </div>

    <footer className="status" aria-label="Workspace status">
      <button className="status-item status-branch" onClick={() => showSide('git')} title="Show source control"><Icon glyph={GitBranch} size={13} />{status.branch ?? 'No branch'}</button>
      <button className="status-item" onClick={() => showDrawer('problems')} aria-label={problemCount + ' errors and ' + warningCount + ' warnings'}>
        <Icon glyph={CircleAlert} size={12} />{problemCount}<span className="ml-0.5" aria-hidden="true">/</span>{warningCount}
      </button>
      {job && <button className="status-item" onClick={() => showDrawer('output')}>Process running</button>}
      <div className="flex-1" />
      {active && <><span className="status-item">Ln {cursor.line}, Col {cursor.column}</span><span className="status-item status-optional">{mode === 'Python' || mode === 'Java' ? 'Spaces: 4' : 'Spaces: 2'}</span>
        <span className="status-item status-language">{mode}</span></>}
      <button className="status-item" title="Show runtimes and packages" onClick={() => showSide('packages')}>
        <span className={'status-dot' + (!runtime ? ' inactive' : '')} />{!desktop ? 'Browser preview' : runtime ? runtime + (mode === 'Python' && runtimes?.pythonVenv ? ' · .venv' : '') : runtimes ? runtimeMissing : 'Detecting runtimes…'}
      </button>
    </footer>

    {palette !== null && <Palette commands={commands} files={fileItems} start={palette} onClose={closePalette} />}
    {dialog && <Dialog dialog={dialog} close={() => setDialog(null)} />}
    {toast && <div className="toast" role="status"><Icon glyph={CircleAlert} /><span className="flex-1">{toast}</span><IconButton glyph={X} label="Dismiss message" onClick={() => setToast('')} /></div>}
  </div>
}

