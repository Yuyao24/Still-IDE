import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { findClassRange, setClassSource } from './completion'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Terminal as Xterm } from '@xterm/xterm'
import {
  Check, Circle, CircleAlert, CodeXml, Columns2, Copy, FilePlus2, Files, FolderOpen, FolderPlus,
  FolderSearch, GitBranch, GitCompareArrows, GitPullRequestArrow, Hammer, House, Moon, Package,  Pencil, Play, Plus,
  RefreshCw, Rows2, Search, Server, Settings2, Square, SquareTerminal, Sun, TerminalSquare, Trash2, WrapText, X,
  Camera, Eye, PenLine, LayoutGrid, Maximize2, Minimize2, Network, BookOpen, Sparkles, Bug, FlaskConical, ArrowLeftRight, AlignLeft, Flame, Wand2, Database as DatabaseIcon, FileText,
} from 'lucide-react'
import {
  api, backups, clipboard, desktop, editorSupport, fileName, fileTemplate, history, type BlameLine, type FileCommit, fileSystem, home, mod, normalize, parentPath, pickFile, pickFolder, ssh, textHash,
  type Branches, type Change, type Commit, type Diagnostic, type Diff, type Entry, type GitStatus, type JobEvent, type Packages, type Runtimes,
  type SshHost, type SshOverview, type Workspace,
  tex, type TexResult,
} from './bridge'
import Editor, { defaultIndent, highlightToHtml, language, refactorHook, type CodeCapture, type Cursor, type EditorHandle, type EditorMemory, type EditorOptions, type LiveIssue } from './Editor'
import CodeShot from './CodeShot'
import { Preview, docKind, type DocKind } from './Preview'
import { ImageView, PdfView, SvgView, TexPreview, binaryKind, fromBase64, type BinaryKind, viewerTakesZoom } from './DocViewers'
import { Minimap } from './Minimap'
import { RunConfigDialog } from './RunConfig'
import { Notebook } from './Notebook'
import { PullRequests } from './PullRequests'
import { GitGraph } from './GitGraph'
import { MergeEditor, conflictCount } from './MergeEditor'
import { spellHook } from './spell'
import { ProfilePanel, type MemoryData, type ProfileData } from './Profile'
import { importUpdatesForMove, type ImportUpdate } from './imports'
import { containers, type ContainerInfo } from './bridge'
import { DatabasePanel } from './Database'
import { bindings, comboOf } from './keymap'
import { Chunk } from '@codemirror/merge'
import { Text } from '@codemirror/state'
import { PaneGrid, paneIds, removePane, singlePane, splitPane, zoneAt, zoneBox, type DropZone, type PaneLayout } from './Panes'
import type { OpenOptions } from './Home'
import { Explorer, PackagesPanel, Palette, SourceControl, isVirtual, symbolsFor, type PaletteItem } from './Panels'
import { HostDialog, OpenRemoteDialog, RemotePanel, blankHost } from './Remote'
import { SearchPanel } from './Search'
import type { SettingsSection } from './SettingsView'
import { useSettings } from './settings'
import mark from './still.svg?inline'
import { type Graph, buildGraph } from './graph'
import { CanvasView, MiniCanvas } from './Canvas'
import { Chat } from './Chat'
import { DebugPanel, type DebugOp, type DebugSession, type DebugStop } from './Debug'
import { TestsPanel, resultFor, testsIn, type TestReport, type TestResult } from './Tests'
import { lspLanguage, startServer, toUri, workspaceSymbols, type Server as LanguageServer } from './lsp'
import { type AgentHost, explain, keys, suggestCode } from './ai'
import { Idle, useIdle } from './Idle'
import { JournalSheet, useJournal } from './Journal'
import { bump, clock, journal, lineChanges, remember } from './activity'
import { Overview, type OverviewCard, type OverviewSpace } from './Overview'
import Terminal, { type TerminalSession } from './Terminal'
import { presets } from './themes'
import { TitleBar } from './TitleBar'
import { Dialog, Output, Problems, SplitGrip, type DialogState, type OutputEntry } from './Workbench'
import { Icon, IconButton, LayoutIcon, Menu, relativeTime, useSlider, type MenuEntry, type MenuItem, type MenuState } from './ui'

type Side = 'explorer' | 'search' | 'git' | 'packages' | 'remote'
type Drawer = 'terminal' | 'output' | 'problems' | 'debug' | 'tests' | 'profile' | 'database'
type DocView = 'edit' | 'split' | 'preview'
type Tab = { id: string; path: string; contents: string; saved: string; memory?: EditorMemory; diff?: Diff; staged?: boolean; line?: number; view?: DocView; binary?: BinaryKind }
type RightView = 'canvas' | 'chat'
type DropTarget = { kind: 'strip'; index: number; left: number; top: number; height: number } | { kind: 'pane'; pane: string; zone: DropZone; box: DOMRect }
type TabDrag = { tab: string; x: number; y: number; target: DropTarget | null }
const defaultDocView = (kind: DocKind): DocView => kind === 'tex' || kind === 'svg' ? 'split' : kind === 'notebook' ? 'preview' : 'edit'
type Job = { id: string; kind: 'run' | 'git' | 'packages'; action: string; path?: string; detail?: string }
type Edit = { time: number; line: number }
type Islands = { side: Side | null; graph: boolean; drawer: boolean }
const layouts: { id: string; label: string; islands?: Islands }[] = [
  { id: 'classic', label: 'Classic', islands: { side: 'explorer', graph: true, drawer: true } },
  { id: 'code-graph', label: 'Code and canvas', islands: { side: null, graph: true, drawer: false } },
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
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // Add to dictionary (from a misspelled word's tooltip) keeps the word in Settings.
  spellHook.add = word => { if (!settingsRef.current.spellWords.includes(word.toLowerCase())) update({ spellWords: [...settingsRef.current.spellWords, word.toLowerCase()] }) }
  const fs = useMemo(() => fileSystem(workspace), [workspace])
  const remote = Boolean(workspace.remote)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [selected, setSelected] = useState('')
  // Panes: the editor area holds any number. The focused pane shows `selected`; the others remember their own tab.
  const [layout, setLayoutState] = useState<PaneLayout>(singlePane('p1'))
  const [paneTabs, setPaneTabsState] = useState<Record<string, string | null>>({})
  const [focused, setFocused] = useState('p1')
  const [tabDrag, setTabDrag] = useState<TabDrag | null>(null)
  const [binaries, setBinaries] = useState<Record<string, Uint8Array>>({})
  const [texResults, setTexResults] = useState<Record<string, TexResult>>({})
  const [texBusy, setTexBusy] = useState<string[]>([])
  const [cursor, setCursor] = useState<Cursor>({ line: 1, column: 1 })
  // A single file opened on its own starts with just the editor.
  const [sidebar, setSidebar] = useState<Side | null>(workspace.file ? null : 'explorer')
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
  /** For a single file on its own, the rest of its folder stays out of the way. */
  const onlyLoose = (entries: Entry[]) => workspace.file ? entries.filter(entry => entry.path === workspace.file) : entries
  const shownDirectories = useMemo(() => workspace.file ? { '': (directories[''] ?? []).filter(entry => entry.path === workspace.file) } : directories, [directories, workspace.file])
  const [expanded, setExpanded] = useState(new Set<string>())
  const [files, setFiles] = useState<Entry[]>([])
  // Member suggestions for `robot.`: classes defined in other files are found here.
  const classLookup = useRef({ tabs: [] as Tab[], files: [] as Entry[] })
  useEffect(() => {
    const declares = (text: string, name: string, python: boolean) => findClassRange(text, name, python) !== null
    setClassSource(async (name, fromPath, fileText) => {
      const python = /\.pyi?$/.test(fromPath)
      const { tabs: open, files: known } = classLookup.current
      for (const tab of open) if (tab.path !== fromPath && !tab.binary && /\.(py|pyi|java|kt|cs|ts|tsx|js|jsx)$/.test(tab.path) && declares(tab.contents, name, /\.pyi?$/.test(tab.path))) return { text: tab.contents, python: /\.pyi?$/.test(tab.path) }
      const candidates: string[] = []
      const paths = known.filter(item => !item.directory).map(item => item.path)
      // A class named after its file (Java, Kotlin, C#, TypeScript).
      for (const path of paths) if (new RegExp('(^|/)' + name + '\\.(java|kt|cs|ts|tsx|js|jsx)$').test(path)) candidates.push(path)
      // Python: the module an import names (from robots.base import Robot).
      if (python) {
        const imported = new RegExp('^\\s*from\\s+(\\.*)([\\w.]*)\\s+import\\s+[^\\n]*\\b' + name + '\\b', 'm').exec(fileText)
        if (imported) {
          const base = imported[1] ? fromPath.split('/').slice(0, -imported[1].length).join('/') : ''
          const module = [base, imported[2].replace(/\./g, '/')].filter(Boolean).join('/')
          for (const path of paths) if (path === module + '.py' || path.endsWith('/' + module + '.py') || path === module + '/__init__.py' || path.endsWith('/' + module + '/__init__.py')) candidates.push(path)
        }
        const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
        for (const path of paths) if (new RegExp('(^|/)(' + snake + '|' + name.toLowerCase() + ')\\.py$').test(path)) candidates.push(path)
      }
      for (const path of [...new Set(candidates)].slice(0, 6)) {
        const text = await fs.read(path).catch(() => '')
        if (declares(text, name, /\.pyi?$/.test(path))) return { text, python: /\.pyi?$/.test(path) }
      }
      // Anywhere in the project.
      const found = await fs.search('(class|interface|record|enum)\\s+' + name + '\\b', { regex: true, caseSensitive: true, wholeWord: false }).catch(() => null)
      for (const match of found?.matches.slice(0, 4) ?? []) {
        const text = await fs.read(match.path).catch(() => '')
        if (declares(text, name, /\.pyi?$/.test(match.path))) return { text, python: /\.pyi?$/.test(match.path) }
      }
      return null
    })
    return () => setClassSource(null)
  }, [fs])
  classLookup.current = { tabs, files }
  const [status, setStatus] = useState(emptyStatus)
  const [gitError, setGitError] = useState('')
  const [log, setLog] = useState<Commit[]>([])
  const [packageState, setPackageState] = useState<Packages | null>(null)
  const [runtimes, setRuntimes] = useState<Runtimes | null>(null)
  const [servers, setServers] = useState<SshOverview | null>(null)
  const [output, setOutput] = useState<OutputEntry[]>([])
  const [sampleRun, setSampleRun] = useState(false)
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  // Errors found while typing in the active file (syntax errors, undefined names, compiler results).
  const [live, setLive] = useState<{ path: string; issues: LiveIssue[] } | null>(null)
  const [heads, setHeads] = useState<Record<string, string | null>>({})
  const [searchSeed, setSearchSeed] = useState<{ query: string; key: number } | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [runningRequest, setRunningRequest] = useState(false)
  const [jobReady, setJobReady] = useState(!desktop)
  const [gitBusy, setGitBusy] = useState(false)
  const [commit, setCommit] = useState('')
  // Run configurations, per file: program arguments and environment variables (kept for the project).
  const runKey = 'still.runconfig.' + workspace.root
  const [runArgs, setRunArgs] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem(runKey) ?? '{}').args ?? {} } catch { return {} } })
  const [runEnv, setRunEnv] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem(runKey) ?? '{}').env ?? {} } catch { return {} } })
  const [runConfig, setRunConfig] = useState<string | null>(null)
  const [palette, setPalette] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editingHost, setEditingHost] = useState<SshHost | null>(null)
  const [remoteHost, setRemoteHost] = useState<SshHost | null>(null)
  const [searchFocus, setSearchFocus] = useState(0)
  const [shot, setShot] = useState<CodeCapture | null>(null)
  // The right bar is one island with views: the canvas, the assistant, and a minimap of the file.
  // Over SSH the canvas reads many files, so the bar starts hidden there.
  const [rightOpen, setRightOpen] = useState(() => {
    const stored = localStorage.getItem('still.island.right')
    if (stored) return stored === 'on' && (!workspace.remote || localStorage.getItem('still.island.rightView') !== 'canvas')
    return localStorage.getItem('still.island.chat') === 'on' || (!workspace.remote && localStorage.getItem('still.island.graph') !== 'off' && window.innerWidth > 1180)
  })
  const [rightView, setRightView] = useState<RightView>(() => {
    const stored = localStorage.getItem('still.island.rightView')
    return stored === 'chat' || stored === 'canvas' ? stored : localStorage.getItem('still.island.chat') === 'on' ? 'chat' : 'canvas'
  })
  const [rightWidth, setRightWidth] = useState(() => Number(localStorage.getItem('still.island.rightWidth')) || 320)
  const [chatEverOpen, setChatEverOpen] = useState(false)
  // Where each pane's editor is scrolled, for the minimap and a side-by-side preview. Kept outside
  // React state: scrolling would otherwise re-render the whole window on every frame.
  const viewports = useMemo(() => {
    const values = new Map<string, ViewportInfo>()
    const listeners = new Set<() => void>()
    return {
      get: (pane: string) => values.get(pane) ?? null,
      set: (pane: string, value: ViewportInfo) => { values.set(pane, value); listeners.forEach(listener => listener()) },
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
  }, [])
  const graphOpen = rightOpen && rightView === 'canvas'
  const [focusMode, setFocusMode] = useState(false)
  const [focusOutput, setFocusOutput] = useState(false)
  const chatOpen = rightOpen && rightView === 'chat'
  /** Shows a view in the right bar, or hides the bar when that view is already showing. */
  function toggleRight(view: RightView, open?: boolean) {
    const showing = rightOpen && rightView === view
    const next = open ?? !showing
    if (next) { setRightView(view); setRightOpen(true); if (view === 'chat') setChatEverOpen(true) } else if (showing) setRightOpen(false)
  }
  function setGraphOpen(next: boolean | ((value: boolean) => boolean)) { toggleRight('canvas', typeof next === 'function' ? next(graphOpen) : next) }
  function setChatOpen(next: boolean | ((value: boolean) => boolean)) { toggleRight('chat', typeof next === 'function' ? next(chatOpen) : next) }
  const [chatFocus, setChatFocus] = useState(0)
  const [maximized, setMaximized] = useState<'editor' | 'side' | 'terminal' | null>(null)
  const [resizing, setResizing] = useState(false)
  const [overview, setOverview] = useState(false)
  const [graphView, setGraphView] = useState(false)
  // Fullscreen Files and Git (opened from the overview, like the journal and the canvas).
  const [fullView, setFullView] = useState<'files' | 'git' | 'history' | 'pulls' | 'graph' | 'merge' | null>(null)
  const [mergeFor, setMergeFor] = useState<string | null>(null)
  // History of one file: versions kept on each save (local) and the commits that changed it.
  const [historyFor, setHistoryFor] = useState<{ path: string; tab: 'local' | 'commits' } | null>(null)
  const [historyItems, setHistoryItems] = useState<{ local: { id: string; time: number; size: number }[]; commits: FileCommit[] }>({ local: [], commits: [] })
  const [historyPick, setHistoryPick] = useState<{ key: string; label: string; before: string } | null>(null)
  const [blame, setBlame] = useState<{ path: string; lines: BlameLine[] } | null>(null)
  const [blameColumn, setBlameColumn] = useState(false)
  const [testReport, setTestReport] = useState<TestReport | null>(null)
  const [testsRunning, setTestsRunning] = useState(false)
  // Debugger: breakpoints per file (kept per project), watch expressions, and the running session.
  const [breakpoints, setBreakpoints] = useState<Record<string, number[]>>(() => { try { return JSON.parse(localStorage.getItem('still.breakpoints.' + workspace.root) ?? '{}') } catch { return {} } })
  // Conditions and log messages for breakpoints, keyed "path:line".
  const [breakpointOptions, setBreakpointOptions] = useState<Record<string, { condition?: string; log?: string }>>(() => { try { return JSON.parse(localStorage.getItem('still.breakpointOptions.' + workspace.root) ?? '{}') } catch { return {} } })
  const [watches, setWatches] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('still.watches.' + workspace.root) ?? '[]') } catch { return [] } })
  const [debug, setDebug] = useState<DebugSession | null>(null)
  const debugRef = useRef<DebugSession | null>(null)
  debugRef.current = debug
  // Events can arrive before React re-renders, so the ref is updated together with the state.
  const putDebug = (next: DebugSession | null) => { debugRef.current = next; setDebug(next) }
  const [filePreview, setFilePreview] = useState<{ path: string; text: string } | null>(null)
  const [gitPreview, setGitPreview] = useState<{ path: string; diff: Diff; staged: boolean } | null>(null)
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
  const focusedRef = useRef('p1')
  const layoutRef = useRef<PaneLayout>(layout)
  const paneTabsRef = useRef<Record<string, string | null>>({})
  const handles = useRef<Record<string, EditorHandle | null>>({})
  const paneCount = useRef(1)
  const tabDragRef = useRef<TabDrag | null>(null)
  const suppressTabClick = useRef(false)
  const saving = useRef(new Map<string, Promise<void>>())
  const opening = useRef(new Map<string, Promise<void>>())
  const pendingJump = useRef<{ path: string; line: number; column?: number; length?: number } | null>(null)
  const windowCloseApproved = useRef(false)
  const returnedFocus = useRef<HTMLElement | null>(null)
  const pendingVenv = useRef(Boolean(initial?.venv))

  const active = tabs.find(tab => tab.id === selected)
  const mainTab = active
  const panes = paneIds(layout)
  const tabOf = (pane: string) => pane === focused ? selected : paneTabs[pane] ?? null
  const shownTabs = panes.map(pane => tabs.find(tab => tab.id === tabOf(pane))).filter((tab): tab is Tab => Boolean(tab))
  const mode = active ? language(active.path) : null
  const runnable = Boolean(active && !active.diff && mode && (remote ? remoteRunnable : localRunnable).includes(mode))
  const symbols = useMemo(() => active && !active.diff ? symbolsFor(active.contents, active.path) : [], [active?.path, active?.contents, active?.diff])
  const currentSymbol = [...symbols].reverse().find(symbol => symbol.line <= cursor.line)
  const problems: Diagnostic[] = useMemo(() => [
    ...diagnostics.filter(item => !live || item.path !== live.path),
    ...(live ? live.issues.map(issue => ({ path: live.path, line: issue.line, column: issue.column, severity: issue.severity === 'error' ? 'error' as const : 'warning' as const, message: issue.message })) : []),
  ], [diagnostics, live])
  const problemCount = problems.filter(item => item.severity === 'error').length
  const warningCount = problems.length - problemCount
  const runtime = remote ? null : mode === 'Java' ? runtimes?.java : mode === 'JavaScript' ? runtimes?.node : mode === 'Python' ? runtimes?.python : runtimes?.python ?? runtimes?.java
  const runtimeMissing = mode === 'Java' ? 'JDK unavailable' : mode === 'Python' ? 'Python unavailable' : mode === 'JavaScript' ? 'Node unavailable' : 'No runtime'
  const sideMax = Math.max(160, Math.min(520, frame.width <= 690 ? Math.floor(frame.width * .3) : frame.width <= 790 ? Math.floor(frame.width * .34) : frame.width - 360))
  const workspaceWidth = Math.min(sideWidth, sideMax)
  const drawerMax = Math.max(128, frame.height - 220)
  const actualDrawerHeight = Math.min(drawerHeight, drawerMax)
  const tabSize = settings.tabSize === 'auto' ? (active ? defaultIndent(active.path) : 4) : settings.tabSize
  const doc = mainTab && !mainTab.diff ? docKind(mainTab.path) : null
  const docView: DocView = doc ? active?.view ?? defaultDocView(doc) : 'edit'
  const editorOptions: EditorOptions = {
    wrap: settings.wordWrap, lineNumbers: settings.lineNumbers, highlightLine: settings.highlightLine, tabSize, layout: settings.diffLayout, autocomplete: settings.autocomplete,
    occurrences: settings.occurrences, whitespace: settings.whitespace, indentGuides: settings.indentGuides, closeBrackets: settings.closeBrackets, scrollPastEnd: settings.scrollPastEnd,
    errors: settings.errors, changes: settings.gitGutter, cursorBlink: settings.cursorBlink, folding: settings.folding, blameColumn, constructors: settings.fillConstructors, docTemplates: settings.docTemplates, fStrings: settings.autoFString, continueComments: settings.continueComments, spellCheck: settings.spellCheck, sticky: settings.stickyScroll, inlayHints: settings.inlayHints,
  }
  // Prose (Markdown, text) wraps and skips indent guides and error checks.
  const optionsFor = (tab: Tab): EditorOptions => {
    const prose = !tab.diff && (docKind(tab.path) === 'markdown' || docKind(tab.path) === 'text')
    if (prose) return { ...editorOptions, wrap: true, indentGuides: false, errors: false }
    // The line guide: a set column, or the formatter's line length for this language.
    const ext = tab.path.split('.').at(-1)?.toLowerCase() ?? ''
    const column = settings.lineGuide === -1
      ? (/^pyi?$/.test(ext) ? settings.pythonLineLength : /^(m?[jt]sx?|c[jt]s|css|scss|html|vue|json)$/.test(ext) ? settings.webPrintWidth : ext === 'java' ? 100 : ext === 'rs' ? 100 : ext === 'go' ? 0 : 80)
      : settings.lineGuide
    return column > 0 ? { ...editorOptions, rulers: [column] } : editorOptions
  }
  const host = remote ? [...(servers?.saved ?? []), ...(servers?.imported ?? [])].find(item => item.id === workspace.remote) : undefined

  const notify = useCallback((error: unknown) => toast(errorText(error)), [toast])
  const [idle, wake] = useIdle(settings.idleMinutes, Boolean(dialog || palette !== null || shot))
  const record = settings.journal
  const journalEntries = useJournal()
  const latestRecord = useRef(record)
  latestRecord.current = record
  const changedPaths = useMemo(() => new Set(status.changes.map(change => change.path)), [status])

  // The last committed version of the active file, for the change markers beside the line numbers.
  useEffect(() => {
    if (!active || active.diff || remote || !desktop || !settings.gitGutter) return
    const path = active.path
    let current = true
    void editorSupport.head(workspace.root, path).then(text => { if (current) setHeads(previous => previous[path] === text ? previous : { ...previous, [path]: text }) }).catch(() => {})
    return () => { current = false }
  }, [active?.path, status, settings.gitGutter])
  useEffect(() => { if (live && live.path !== active?.path) setLive(null) }, [active?.path])

  useEffect(() => {
    try {
      localStorage.setItem('still.island.right', rightOpen ? 'on' : 'off')
      localStorage.setItem('still.island.rightView', rightView)
      localStorage.setItem('still.island.rightWidth', String(rightWidth))
    } catch { /* storage is optional */ }
  }, [rightOpen, rightView, rightWidth])
  useEffect(() => { if (chatOpen) setChatEverOpen(true) }, [chatOpen])

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

  // The open files, to reopen next time (Settings → Projects → When a project opens).
  const sessionKey = 'still.session.' + (workspace.remote ?? '') + workspace.root
  function savedSession(): { files: string[]; selected: string; lines: Record<string, number> } | null {
    try { const value = JSON.parse(localStorage.getItem(sessionKey) ?? 'null'); return value && Array.isArray(value.files) ? value : null } catch { return null }
  }
  const sessionLines = useRef<Record<string, number>>(savedSession()?.lines ?? {})
  useEffect(() => { if (active && !active.diff) sessionLines.current[active.path] = cursor.line }, [active?.path, cursor.line])
  useEffect(() => {
    if (workspace.sample) return
    const files = tabs.filter(tab => !tab.diff).map(tab => tab.path)
    const timer = setTimeout(() => {
      try { localStorage.setItem(sessionKey, JSON.stringify({ files, selected: active && !active.diff ? active.path : files[0] ?? '', lines: Object.fromEntries(files.map(path => [path, sessionLines.current[path] ?? 1])) })) } catch { /* storage unavailable */ }
    }, 400)
    return () => clearTimeout(timer)
  }, [tabs.map(tab => tab.path).join('|'), selected, cursor.line])

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

  async function directory(path: string, id = generation.current, quiet = false) {
    try {
      const result = await fs.list(path)
      if (generation.current !== id) return
      // Only re-render when something changed (the tree also refreshes on its own).
      setDirectories(previous => {
        const before = previous[path]
        if (before && before.length === result.length && before.every((entry, index) => entry.path === result[index].path && entry.directory === result[index].directory)) return previous
        return { ...previous, [path]: result }
      })
    } catch (error) { if (generation.current === id && !quiet) notify(error) }
  }

  async function refreshFiles(folders: Iterable<string> = latest.current.expanded, id = generation.current) {
    try {
      await Promise.all(['', ...folders].map(path => directory(path, id)))
      if (!remote) { const result = await fs.files(); if (generation.current === id) setFiles(onlyLoose(result)) }
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
      // Where you left off (Settings → Projects): the files that were open last time, or the README.
      const session = settings.openOnStart === 'last' && !workspace.sample ? savedSession() : null
      const resume = initial?.file ?? (session?.selected || undefined)
      const starters = ['main.py', 'app.py', 'index.js', 'main.js']
      const readmeFile = entries.filter(entry => !entry.directory && readme.includes(entry.name)).map(entry => entry.path).slice(0, 1)
      const found = workspace.sample ? ['README.md', 'src/app.py', 'src/Main.java']
        : session?.files.length ? session.files
        : readmeFile.length ? readmeFile
        : [...starters.filter(path => entries.some(entry => entry.path === path)), 'src/Main.java'].slice(0, 1)
      const paths = resume && !found.includes(resume) ? [...found, resume] : found
      const lineFor = (path: string) => path === initial?.file ? initial?.line : session?.lines[path] ?? (workspace.sample && path === 'src/app.py' ? 11 : undefined)
      const opened = await Promise.all(paths.map(path => fs.read(path).then(contents => fileTab(path, contents, lineFor(path))).catch(() => null)))
      if (generation.current !== id) return
      const available = opened.filter(tab => tab !== null)
      setTabs(previous => [...available.filter(tab => !previous.some(existing => existing.id === tab.id)), ...previous])
      const preferred = resume && available.some(tab => tab.id === resume) ? resume : available.some(tab => tab.id === 'src/app.py') ? 'src/app.py' : available[0]?.id ?? ''
      setSelected(previous => previous || preferred)
      if (resume) expandParents(resume)
      await restoreBackups(id)
    })()
    return () => { generation.current++ }
  }, [])

  // ---- Hot exit: unsaved edits are kept outside the project and come back next time ----
  const backupKey = (workspace.remote ?? '') + '|' + workspace.root
  const backupEntries = () => latest.current.tabs.filter(tab => !tab.diff && !tab.binary && dirty(tab))
    .map(tab => ({ path: tab.path, contents: tab.contents, base: textHash(normalize(tab.saved)), time: Date.now() }))
  const backupsReady = useRef(false)
  async function restoreBackups(id: number) {
    const entries = workspace.sample ? [] : await backups.read(backupKey)
    if (generation.current !== id) return
    backupsReady.current = true
    if (!entries.length) return
    const restored: Tab[] = []
    let changed = 0
    for (const entry of entries) {
      const disk = await fs.read(entry.path).catch(() => '')
      if (normalize(disk) === normalize(entry.contents)) continue
      if (textHash(normalize(disk)) !== entry.base) changed++
      restored.push({ ...fileTab(entry.path, disk), contents: entry.contents })
    }
    if (generation.current !== id || !restored.length) return
    // Restored files keep their place among the open tabs; the others are added at the end.
    setTabs(previous => [...previous.map(tab => restored.find(item => item.id === tab.id) ?? tab), ...restored.filter(item => !previous.some(tab => tab.id === item.id))])
    setSelected(previous => previous && !restored.some(item => item.id === previous) ? previous : restored[0].id)
    notify('Brought back unsaved changes in ' + (restored.length === 1 ? fileName(restored[0].path) : restored.length + ' files') + '.'
      + (changed ? ' ' + (changed === 1 ? 'One file' : changed + ' files') + ' changed on disk since; compare before saving.' : ''))
  }
  useEffect(() => {
    if (!desktop || workspace.sample || !backupsReady.current) return
    const timer = setTimeout(() => { void backups.write(backupKey, backupEntries()).catch(() => {}) }, 700)
    return () => clearTimeout(timer)
  }, [tabs])

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
    if (latest.current.tabs.some(dirty)) askDiscard(title, 'Open files have unsaved changes.', () => { void backups.write(backupKey, []).catch(() => {}); action() })
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

  /** Opens a single file on its own (its folder doesn't become a project). */
  function chooseFile() {
    leave(() => {
      void pickFile('Open a file').then(async path => {
        if (path) onSwitch(await home.openFile(path))
      }).catch(notify)
    }, 'Switch project?')
  }
  function openFolderAsProject() {
    leave(() => { void home.open(workspace.root).then(onSwitch).catch(notify) }, 'Open the whole folder?')
  }
  // A single file opens in the editor straight away.
  useEffect(() => { if (workspace.file) void openFile(workspace.file) }, [workspace.root, workspace.file])

  function approvalAndClose() {
    windowCloseApproved.current = true
    void getCurrentWindow().close().catch(error => { windowCloseApproved.current = false; notify(error) })
  }

  useEffect(() => {
    if (!desktop) return
    let unlisten: UnlistenFn | undefined
    let closed = false
    void getCurrentWindow().onCloseRequested(async event => {
      if (!windowCloseApproved.current && latest.current.tabs.some(dirty)) {
        event.preventDefault()
        if (settingsRef.current.hotExit && !workspace.sample) {
          // Keep the unsaved edits for next time, then close without asking.
          await backups.write(backupKey, backupEntries()).catch(() => {})
          approvalAndClose()
        } else askDiscard('Close Still?', 'Open files have unsaved changes.', () => { void backups.write(backupKey, []).catch(() => {}); approvalAndClose() })
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

  function setLayout(next: PaneLayout) { layoutRef.current = next; setLayoutState(next) }
  function setPaneTabs(next: Record<string, string | null>) { paneTabsRef.current = next; setPaneTabsState(next) }
  /** Makes a pane the one in use: commands, the tab strip and the status bar follow it. */
  function focusPane(pane: string) {
    if (focusedRef.current === pane || !paneIds(layoutRef.current).includes(pane)) return
    setPaneTabs({ ...paneTabsRef.current, [focusedRef.current]: latest.current.selected || null })
    focusedRef.current = pane
    setFocused(pane)
    setSelected(paneTabsRef.current[pane] ?? '')
    editor.current = handles.current[pane] ?? null
    // Problems follow the pane in use.
    editor.current?.command('lint')
  }
  /** Shows a tab in a pane, or in a new pane at an edge or corner of it. */
  function placeTab(tabId: string, pane: string, zone: DropZone) {
    if (zone === 'center') {
      if (pane === focusedRef.current) { setSelected(tabId); requestAnimationFrame(() => editor.current?.focus()); return }
      setPaneTabs({ ...paneTabsRef.current, [pane]: tabId })
      focusPane(pane)
      requestAnimationFrame(() => requestAnimationFrame(() => handles.current[pane]?.focus()))
      return
    }
    const id = 'p' + (++paneCount.current), empty = 'p' + (++paneCount.current)
    const result = splitPane(layoutRef.current, pane, zone, id, empty)
    setLayout(result.layout)
    setPaneTabs({ ...paneTabsRef.current, [id]: tabId, ...(result.empty ? { [result.empty]: null } : {}) })
    focusPane(id)
    requestAnimationFrame(() => requestAnimationFrame(() => handles.current[id]?.focus()))
  }
  function closePane(pane: string) {
    const next = removePane(layoutRef.current, pane)
    if (!next) return
    const order = paneIds(layoutRef.current)
    setLayout(next)
    delete handles.current[pane]
    const { [pane]: _gone, ...rest } = paneTabsRef.current
    if (focusedRef.current === pane) {
      const ids = paneIds(next)
      const target = ids[Math.max(0, Math.min(order.indexOf(pane), ids.length - 1))]
      focusedRef.current = target
      setFocused(target)
      setSelected(rest[target] ?? '')
      editor.current = handles.current[target] ?? null
      requestAnimationFrame(() => handles.current[target]?.focus())
    }
    setPaneTabs(rest)
  }
  function splitRight(tab: Tab | undefined = active, zone: DropZone = 'right') { if (tab) placeTab(tab.id, focusedRef.current, zone) }
  // A pane whose file was closed goes away (the pane in use moves on to another tab instead).
  useEffect(() => {
    const ids = new Set(tabs.map(tab => tab.id))
    for (const pane of paneIds(layoutRef.current)) {
      const tab = paneTabsRef.current[pane]
      if (pane !== focusedRef.current && tab && !ids.has(tab)) closePane(pane)
    }
  }, [tabs])

  // ---- Dragging tabs: along the strip to reorder, onto a pane to show or split ----
  function dropTarget(x: number, y: number): DropTarget | null {
    const element = document.elementFromPoint(x, y)
    const strip = element?.closest('.tab-scroll')
    if (strip) {
      const items = [...strip.querySelectorAll<HTMLElement>('.tab')]
      let index = items.findIndex(item => { const box = item.getBoundingClientRect(); return x < box.left + box.width / 2 })
      if (index < 0) index = items.length
      const box = (items[index] ?? items.at(-1))?.getBoundingClientRect()
      const area = strip.getBoundingClientRect()
      return { kind: 'strip', index, left: box ? (items[index] ? box.left : box.right) : area.left, top: area.top + 8, height: area.height - 16 }
    }
    const paneElement = element?.closest<HTMLElement>('[data-pane]')
    if (paneElement?.dataset.pane) { const box = paneElement.getBoundingClientRect(); return { kind: 'pane', pane: paneElement.dataset.pane, zone: zoneAt(box, x, y), box } }
    return null
  }
  function tabPointerDown(event: ReactPointerEvent, tab: Tab) {
    if (event.button !== 0 || (event.target as Element).closest('.tab-close')) return
    const start = { x: event.clientX, y: event.clientY }
    let cancelled = false
    const move = (next: PointerEvent) => {
      if (cancelled) return
      if (!tabDragRef.current && Math.hypot(next.clientX - start.x, next.clientY - start.y) < 6) return
      const value = { tab: tab.id, x: next.clientX, y: next.clientY, target: dropTarget(next.clientX, next.clientY) }
      tabDragRef.current = value
      setTabDrag(value)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', key, true)
      const dropped = tabDragRef.current
      tabDragRef.current = null
      setTabDrag(null)
      return dropped
    }
    const up = () => {
      const dropped = finish()
      if (!dropped || cancelled) return
      suppressTabClick.current = true
      setTimeout(() => { suppressTabClick.current = false }, 0)
      const target = dropped.target
      if (target?.kind === 'strip') {
        setTabs(previous => {
          const from = previous.findIndex(item => item.id === dropped.tab)
          if (from < 0) return previous
          const to = target.index > from ? target.index - 1 : target.index
          const next = previous.slice()
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          return next
        })
      } else if (target?.kind === 'pane') placeTab(dropped.tab, target.pane, target.zone)
    }
    const key = (next: KeyboardEvent) => { if (next.key === 'Escape') { next.preventDefault(); next.stopPropagation(); cancelled = true; finish() } }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', key, true)
  }

  // ---- PDFs, images and LaTeX ----
  useEffect(() => {
    for (const tab of tabs) {
      if (!tab.binary || binaries[tab.path]) continue
      const path = tab.path
      void fs.readBinary(path).then(data => setBinaries(previous => ({ ...previous, [path]: fromBase64(data) }))).catch(notify)
    }
  }, [tabs])
  const texWorks = desktop && !remote
  function compileTex(path: string) {
    if (!texWorks) { setTexResults(previous => previous[path] ? previous : { ...previous, [path]: { pdf: null, engine: null, seconds: 0, errors: [], log: '' } }); return }
    setTexBusy(previous => previous.includes(path) ? previous : [...previous, path])
    // A failed compile keeps showing the last PDF that worked.
    void tex.compile(workspace.root, path).then(result => setTexResults(previous => ({ ...previous, [path]: { ...result, pdf: result.pdf ?? previous[path]?.pdf ?? null } }))).catch(notify)
      .finally(() => setTexBusy(previous => previous.filter(item => item !== path)))
  }
  // A LaTeX file shown with its preview is compiled when it first appears (and again on each save).
  const texShown = shownTabs.filter(tab => !tab.diff && docKind(tab.path) === 'tex' && (tab.view ?? 'split') !== 'edit').map(tab => tab.path).join('|')
  useEffect(() => { for (const path of texShown ? texShown.split('|') : []) if (!texResults[path] && !texBusy.includes(path)) compileTex(path) }, [texShown])

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
    // A SQLite file opens in the Database tab.
    if (/\.(db|sqlite|sqlite3|db3)$/i.test(path) && desktop && !remote) { setDbFocus(previous => ({ path, nonce: (previous?.nonce ?? 0) + 1 })); showDrawer('database'); return }
    if (latest.current.tabs.some(tab => tab.id === path)) {
      activate(path)
      const jump = pendingJump.current
      if (jump?.path === path && latest.current.selected === path) { pendingJump.current = null; editor.current?.jump(jump.line, jump.column, jump.length) }
      return
    }
    if (opening.current.has(path)) return opening.current.get(path)
    const binary = binaryKind(path)
    const task = (binary ? Promise.resolve('') : fs.read(path)).then(contents => {
      if (generation.current !== id) return
      setTabs(previous => previous.some(tab => tab.id === path) ? previous : [...previous, binary ? { ...fileTab(path, ''), binary } : fileTab(path, contents)])
      activate(path)
      expandParents(path)
    }).catch(error => {
      if (generation.current === id) { pendingJump.current = null; notify(error) }
    }).finally(() => { if (generation.current === id) opening.current.delete(path) })
    opening.current.set(path, task)
    return task
  }

  function paneHandle(pane: string, handle: EditorHandle | null) {
    handles.current[pane] = handle
    if (focusedRef.current !== pane) return
    editor.current = handle
    const jump = pendingJump.current
    if (handle && jump && jump.path === latest.current.selected) {
      pendingJump.current = null
      requestAnimationFrame(() => handle.jump(jump.line, jump.column, jump.length))
    }
  }

  function jumpTo(item: { path: string; line: number; column?: number; length?: number }) {
    const current = latest.current.tabs.find(tab => tab.id === latest.current.selected)
    if (current && current.path === item.path && !current.diff && !current.binary) { editor.current?.jump(item.line, item.column, item.length); return }
    const other = paneIds(layoutRef.current).find(pane => pane !== focusedRef.current && paneTabsRef.current[pane] === item.path)
    if (other) { focusPane(other); requestAnimationFrame(() => handles.current[other]?.jump(item.line, item.column, item.length)); return }
    pendingJump.current = item
    void openFile(item.path)
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
    if (!tab || tab.diff || tab.binary) return
    const id = generation.current
    const key = tab.id
    const previousSave = saving.current.get(key)
    if (previousSave) { await previousSave; return store(tab) }
    let current = latest.current.tabs.find(item => item.id === tab.id)
    if (current && settings.formatOnSave && current.id === latest.current.selected && dirty(current) && !remote) {
      if (await formatDocument(true)) {
        const text = editor.current?.text()
        if (text !== undefined) { current = { ...current, contents: text }; const replaced = current; latest.current.tabs = latest.current.tabs.map(item => item.id === replaced.id ? replaced : item) }
      }
    }
    if (current && (settings.trimOnSave || settings.finalNewline) && current.id === latest.current.selected) {
      const tidied = editor.current?.tidy({ trim: settings.trimOnSave, finalNewline: settings.finalNewline })
      if (tidied !== undefined && tidied !== null && tidied !== current.contents) {
        current = { ...current, contents: tidied }
        const replaced = current
        latest.current.tabs = latest.current.tabs.map(item => item.id === replaced.id ? replaced : item)
      }
    }
    if (!current || !dirty(current)) return
    const task = fs.save(current.path, current.contents, current.saved).then(() => {
      if (generation.current !== id) return
      const { added, removed } = lineChanges(current.saved, current.contents)
      if (added || removed) {
        bump({ added })
        if (record && !workspace.sample) journal.add({ kind: 'edit', project: workspace.name, root: workspace.root, path: current.path, text: 'Edited ' + fileName(current.path), detail: '+' + added + ' −' + removed, added, removed })
      }
      staleGraph()
      if (!remote && !workspace.sample) void history.save(workspace.root, current.path, current.contents).catch(() => {})
      tellServers([{ path: current.path, type: 'changed' }])
      if (docKind(current.path) === 'tex') compileTex(current.path)
      testsAfterSave(current.path)
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
        // New files start from a template that fits their name (a Java class with its package, a test…).
        const template = fileTemplate(path)
        if (template) await fs.save(path, template, '').catch(() => {})
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
      title: 'Rename or move', description: 'Type a new name, or a path in another folder to move it there.', input: entry.path, inputLabel: 'New path', placeholder: entry.path, label: 'Rename',
      action: to => { void moveEntry(entry, to.replace(/^\/+|\/+$/g, '')) },
    })
  }

  /** Moves or renames a file or folder; if code imports it, offers to update those imports too. */
  async function moveEntry(entry: Entry, to: string) {
    if (!to || to === entry.path) return
    if (to.startsWith(entry.path + '/')) { notify('A folder can’t move inside itself.'); return }
    let updates: ImportUpdate[] = []
    if (settings.updateImports && (entry.directory || /\.(py|java|m?[jt]sx?|c[jt]s)$/.test(entry.path))) {
      try {
        const files = (await fs.files()).filter(item => !item.directory).map(item => item.path)
        const read = async (path: string) => latest.current.tabs.find(tab => tab.path === path && !tab.diff)?.contents ?? fs.read(path)
        updates = await importUpdatesForMove(files, read, entry.path, to, entry.directory)
      } catch (error) { console.warn('Working out import changes failed', error) }
    }
    const verb = parentPath(to) === parentPath(entry.path) ? 'Rename' : 'Move'
    if (!updates.length) { finishMove(entry, to, []); return }
    const others = updates.filter(update => update.path !== to && !update.path.startsWith(to + '/'))
    setDialog({
      title: verb + ' ' + entry.name,
      description: others.length ? `${others.length === 1 ? 'One file imports' : others.length + ' files import'} ${entry.directory ? 'from this folder' : 'it'}. Update ${others.length === 1 ? 'its imports' : 'their imports'} to the new place?` : 'Update the imports inside it to match the new place?',
      list: updates.map(update => update.path),
      label: verb + ' and update imports',
      secondary: { label: 'Just ' + verb.toLowerCase(), action: () => finishMove(entry, to, []) },
      action: () => finishMove(entry, to, updates),
    })
  }

  function finishMove(entry: Entry, to: string, updates: ImportUpdate[]) {
        void fs.rename(entry.path, to).then(async () => {
          const moved = (path: string) => path === entry.path ? to : path.startsWith(entry.path + '/') ? to + path.slice(entry.path.length) : null
          setTabs(previous => previous.map(tab => {
            const next = moved(tab.path)
            return next && !tab.diff ? { ...tab, id: next, path: next } : tab
          }))
          setSelected(previous => moved(previous) ?? previous)
          setExpanded(previous => new Set([...previous].map(path => moved(path) ?? path).concat(parentPath(to)).filter(Boolean)))
          void refreshFiles(new Set([...latest.current.expanded].map(path => moved(path) ?? path).concat(parentPath(to)).filter(Boolean)))
          tellServers([{ path: entry.path, type: 'deleted' }, { path: to, type: 'created' }])
          // Files are saved with their new imports; a tab with unsaved work keeps it and just takes
          // the change, so nothing you typed is written before you save it.
          let failed = 0
          for (const update of updates) {
            const open = latest.current.tabs.find(tab => !tab.diff && (tab.path === update.path || moved(tab.path) === update.path))
            const dirty = open && open.contents !== open.saved
            try { if (!dirty) await fs.save(update.path, update.after, open?.saved ?? update.before) } catch { failed++; continue }
            if (open) setTabs(previous => previous.map(tab => tab.id === open.id || tab.id === update.path ? { ...tab, contents: update.after, saved: dirty ? tab.saved : update.after } : tab))
          }
          if (updates.length) { tellServers(updates.map(update => ({ path: update.path, type: 'changed' as const }))); notify(`Updated imports in ${updates.length - failed} file${updates.length - failed === 1 ? '' : 's'}${failed ? `; ${failed} couldn’t be changed` : ''}.`) }
          void refreshGit()
        }).catch(notify)
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

  function copyText(text: string) { void clipboard.write(text).then(() => notify('Copied ' + text)).catch(notify) }
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

  // AI inline suggestions: keys are read once from the keychain, and a missing key is said once.
  const suggestKey = useRef<{ provider: string; key: string | null } | null>(null)
  const suggestWarned = useRef(false)
  async function suggestInline(prefix: string, suffix: string, signal: AbortSignal) {
    if (!active) return ''
    const provider = settings.aiCompleteProvider
    if (provider !== 'ollama' && suggestKey.current?.provider !== provider) suggestKey.current = { provider, key: await keys.get(provider).catch(() => null) }
    const key = provider === 'ollama' ? null : suggestKey.current?.key ?? null
    if (provider !== 'ollama' && !key) {
      if (!suggestWarned.current) { suggestWarned.current = true; notify('Inline suggestions need ' + (provider === 'github' ? 'a GitHub token' : 'an Anthropic API key') + ' in Settings → AI.') }
      return ''
    }
    try {
      return await suggestCode({
        settings: { provider, model: settings.aiCompleteModel, ollamaUrl: settings.ollamaUrl, githubModel: provider === 'github' ? settings.aiCompleteModel : settings.githubModel },
        key, path: active.path, language: mode ?? 'text', prefix, suffix, signal,
      })
    } catch (error) {
      if (!signal.aborted && !suggestWarned.current) { suggestWarned.current = true; notify('Inline suggestions: ' + explain(error)) }
      return ''
    }
  }

  /** Formats the active file with the project's formatter (ruff/black, google-java-format, prettier…). */
  async function formatDocument(quiet = false) {
    const handle = editor.current
    if (!active || active.diff || !handle || !desktop || remote) { if (!quiet) notify(remote ? 'Formatting works for local projects for now.' : 'Open a file to format it.'); return false }
    const path = active.path
    try {
      const result = await editorSupport.format(workspace.root, path, handle.text(), {
        javaStyle: settings.javaFormatStyle, pythonLineLength: settings.pythonLineLength, pythonIndent: settings.pythonIndent, pythonQuotes: settings.pythonQuotes,
        webIndent: settings.webIndent, webTabs: settings.webTabs, webSemicolons: settings.webSemicolons, webQuotes: settings.webQuotes, webPrintWidth: settings.webPrintWidth,
        webTrailingCommas: settings.webTrailingCommas, cStyle: settings.cStyle, cIndent: settings.cIndent, rustIndent: settings.rustIndent,
      })
      if (result.text === null && !result.tool && handle.command('format')) return true
      if (result.text === null) { if (!quiet) notify(result.hint ?? (result.tool ? result.tool + " couldn't format this file. Check it for syntax errors." : 'No formatter for this file.')); return false }
      if (editor.current === handle) handle.replaceAll(result.text)
      return true
    } catch (error) { if (!quiet) notify(error); return false }
  }

  // Blame for the active file (who last changed each line), refreshed after edits settle and after Git changes.
  const blameText = active && !active.diff ? active.contents : ''
  useEffect(() => {
    if (!active || active.diff || active.binary || remote || !desktop || (!settings.inlineBlame && !blameColumn) || !status.branch) { setBlame(null); return }
    const path = active.path, contents = active.contents
    let current = true
    const timer = setTimeout(() => { void history.blame(workspace.root, path, contents).then(lines => { if (current) setBlame({ path, lines }) }).catch(() => {}) }, 700)
    return () => { current = false; clearTimeout(timer) }
  }, [active?.path, blameText, status, settings.inlineBlame, blameColumn])

  function openHistory(path: string, tab: 'local' | 'commits' = 'local') {
    setHistoryPick(null)
    setHistoryFor({ path, tab })
    setFullView('history')
    void Promise.all([history.list(workspace.root, path).catch(() => []), history.fileLog(workspace.root, path).catch(() => [] as FileCommit[])])
      .then(([local, commits]) => setHistoryItems({ local, commits }))
  }
  function restoreVersion(path: string, text: string) {
    setFullView(null)
    const apply = () => { if (latest.current.tabs.find(tab => tab.id === latest.current.selected)?.path === path) editor.current?.replaceAll(text) }
    if (active?.path === path) requestAnimationFrame(apply)
    else void openFile(path).then(() => setTimeout(apply, 350))
    notify('Restored the earlier version in the editor. Save to keep it, or undo to go back.')
  }

  function searchFor(query: string) {
    setSearchSeed(previous => ({ query, key: (previous?.key ?? 0) + 1 }))
    showSide('search')
  }

  /** F12 / Ctrl+click: jump to where the word under the caret is defined, in this file or elsewhere in the project. */
  async function goToDefinition() {
    if (editor.current?.command('definition')) return
    const word = editor.current?.word()
    if (!word || !active || active.diff || !/^[A-Za-z_$][\w$]*$/.test(word.text)) return
    const name = word.text
    const local = symbols.find(symbol => symbol.name === name && symbol.line !== word.line)
    if (local) { editor.current?.jump(local.line); return }
    const pattern = '(\\b(def|class|function|fn|func|struct|enum|interface|trait|record|type|object|module)\\s+' + name + '\\b)|(\\b(const|let|var|val)\\s+' + name + '\\s*[=:])|(^\\s*' + name + '\\s*=[^=])|((public|private|protected|static)[\\w<>\\[\\],.? ]*\\s' + name + '\\s*\\()'
    try {
      const result = await fs.search(pattern, { regex: true, caseSensitive: true, wholeWord: false })
      const matches = result.matches.filter(match => !(match.path === active.path && match.line === word.line))
      const best = matches.find(match => match.path === active.path) ?? matches.find(match => /\b(def|class|function|fn|func|struct|interface|record)\b/.test(match.preview)) ?? matches[0]
      if (best) jumpTo({ path: best.path, line: best.line, column: best.column })
      else notify('No definition found for ' + name + '.')
    } catch (error) { notify(error) }
  }

  const mainMenuItems = useRef<MenuEntry[] | null>(null)
  /** The menu behind the Still logo, like the main menu in JetBrains IDEs. */
  async function openMainMenu(anchor: HTMLElement) {
    if (menu && menu.items === mainMenuItems.current) { setMenu(null); return }
    const box = anchor.getBoundingClientRect()
    const recent = desktop ? await home.state().then(state => state.projects.filter(project => !project.missing && project.lastOpened && project.path !== workspace.root)
      .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0)).slice(0, 8)).catch(() => []) : []
    const handle = editor.current
    const editing = Boolean(active && !active.diff)
    const item = (label: string, action: () => void, shortcut?: string, extra: Partial<MenuItem> = {}): MenuItem => ({ label, action, shortcut, ...extra })
    const items: MenuEntry[] = [
      { label: 'File', items: [
        item('New file…', () => newFile()),
        ...(desktop || remote ? [item('New folder…', () => newFolder())] : []),
        'separator',
        item('Open file…', () => openPalette(''), mod + '+P'),
        item('Open folder…', chooseFolder, mod + '+O'),
        item('Open file…', chooseFile, mod + '+Shift+O'),
        { label: 'Open recent', disabled: !recent.length, items: recent.length ? recent.map(project => item(project.name, () => leave(() => { void home.open(project.path).then(onSwitch).catch(notify) }, 'Switch project?'))) : [item('Nothing yet', () => {}, undefined, { disabled: true })] },
        'separator',
        item('Save', () => { void store(active).catch(notify) }, mod + '+S', { disabled: !active || !dirty(active) }),
        item('Save all', () => { void storeAll() }, mod + '+Shift+S', { disabled: !tabs.some(dirty) }),
        'separator',
        item('Local history of this file…', () => { if (active) openHistory(active.path, 'local') }, undefined, { disabled: !active || Boolean(active.diff) || remote }),
        'separator',
        item('Close tab', () => { if (active) closeTab(active) }, mod + '+W', { disabled: !active }),
        item('Close saved tabs', () => closeTabs(latest.current.tabs.filter(tab => !dirty(tab))), undefined, { disabled: !tabs.length }),
        item('Close project', goHome, mod + '+Shift+H'),
      ] },
      { label: 'Edit', items: [
        item('Undo', () => { handle?.command('undo') }, mod + '+Z', { disabled: !editing }),
        item('Redo', () => { handle?.command('redo') }, mod + '+Shift+Z', { disabled: !editing }),
        'separator',
        item('Cut', () => { handle?.command('cut') }, mod + '+X', { disabled: !editing }),
        item('Copy', () => { handle?.command('copy') }, mod + '+C', { disabled: !active }),
        item('Paste', () => { void clipboard.read().then(text => { editor.current?.insert(text); editor.current?.focus() }).catch(notify) }, mod + '+V', { disabled: !editing }),
        item('Select all', () => { handle?.command('selectAll') }, mod + '+A', { disabled: !active }),
        'separator',
        item('Find', () => handle?.find(), mod + '+F', { disabled: !active }),
        item('Find in files', () => showSide('search'), mod + '+Shift+F'),
        item('Select next match', () => { handle?.command('selectNext') }, mod + '+D', { disabled: !editing }),
        item('Rename in this file', () => { handle?.command('rename') }, 'F2', { disabled: !editing }),
        item('Toggle comment', () => { handle?.command('comment') }, mod + '+/', { disabled: !editing }),
        item('Format document', () => { void formatDocument() }, 'Shift+Alt+F', { disabled: !editing }),
      ] },
      { label: 'View', items: [
        item('Command palette', () => openPalette('>'), mod + '+Shift+K'),
        'separator',
        item('Sidebar', () => setSidebar(value => value ? null : lastSide), mod + '+B', { checked: Boolean(sidebar) }),
        ...sideItems.map(side => item(side.label, () => showSide(side.key), mod + '+' + side.keys, { checked: sidebar === side.key })),
        'separator',
        item('Right bar', () => setRightOpen(value => !value), undefined, { checked: showRight }),
        item('Canvas', () => setGraphOpen(value => !value), mod + '+Shift+D', { checked: showGraph }),
        item('Assistant', toggleChat, mod + '+Shift+A', { checked: showChat }),
        item('Minimap', () => toggleMinimap(), mod + '+Shift+Y', { checked: settings.minimap }),
        item('Terminal', () => drawerOpen ? setDrawerOpen(false) : showDrawer('terminal', true), mod + '+J', { checked: drawerOpen }),
        'separator',
        item('Split editor right', () => splitRight(), mod + '+\\', { disabled: !active }),
        item('Split editor down', () => splitRight(active, 'bottom'), undefined, { disabled: !active }),
        item('Close this pane', () => closePane(focusedRef.current), undefined, { disabled: panes.length < 2 }),
        item('Focus mode', toggleFocus, mod + '+.'),
        item('Overview', openOverview, mod + '+Alt+O'),
        item('Fullscreen editor', () => toggleMaximize('editor'), mod + '+Shift+M', { checked: maximized === 'editor' }),
        'separator',
        item('Zoom in', () => update({ editorFontSize: Math.min(28, settings.editorFontSize + 1) }), mod + '+='),
        item('Zoom out', () => update({ editorFontSize: Math.max(9, settings.editorFontSize - 1) }), mod + '+-'),
        item('Reset zoom', () => update({ editorFontSize: 14 }), mod + '+0'),
        item('Wrap long lines', () => update({ wordWrap: !settings.wordWrap }), undefined, { checked: settings.wordWrap }),
        item(theme.kind === 'dark' ? 'Light theme' : 'Dark theme', onToggleTheme),
      ] },
      { label: 'Go', items: [
        item('Go to file…', () => openPalette(''), mod + '+P'),
        item('Go to line…', () => { handle?.command('gotoLine') }, mod + '+Alt+G', { disabled: !active }),
        item('Go to definition', () => { void goToDefinition() }, 'F12', { disabled: !editing }),
        'separator',
        item('Next tab', () => cycleTab(1), mod + '+Tab', { disabled: tabs.length < 2 }),
        item('Previous tab', () => cycleTab(-1), mod + '+Shift+Tab', { disabled: tabs.length < 2 }),
        item('Problems', () => showDrawer('problems'), undefined),
      ] },
      { label: 'Run', items: [
        item(active ? 'Run ' + fileName(active.path) : 'Run', () => { void run() }, mod + '+Enter', { disabled: !runnable || Boolean(job) }),
        item('Run configuration…', askArguments, undefined, { disabled: !runnable || Boolean(job) }),
        'separator',
        item('Run all tests', () => { void runTests(null) }, undefined, { disabled: Boolean(testsWhy) || Boolean(job) }),
        item('Run tests in this file', () => runTestsFrom('file'), undefined, { disabled: Boolean(testsWhy) || Boolean(job) || !active }),
        item('Show test results', () => showDrawer('tests')),
        'separator',
        item('Debug', () => { void startDebug() }, 'F5', { disabled: Boolean(debugWhy) || !active || Boolean(job) }),
        item('Toggle breakpoint', () => { if (active) { const list = breakpoints[active.path] ?? []; changeBreakpoints(active.path, list.includes(cursor.line) ? list.filter(line => line !== cursor.line) : [...list, cursor.line]) } }, 'F9', { disabled: !active || Boolean(active.diff) }),
        ...(!remote ? [item(mode === 'Java' ? 'Compile' : 'Check', () => { void run(true) }, mod + '+Shift+Enter', { disabled: !runnable || Boolean(job) })] : []),
        item('Stop', () => { if (job) void invoke('stop_job', { id: job.id }).catch(notify) }, undefined, { disabled: !job }),
        'separator',
        item('Show output', () => showDrawer('output')),
        item('New terminal', () => { setDrawer('terminal'); setDrawerOpen(true); if (desktop) { remote ? remoteSession() : newSession() } }, mod + '+Shift+`'),
      ] },
      ...(!remote ? [{ label: 'Git', items: [
        item('Show changes', () => showSide('git'), mod + '+Shift+G'),
        item('History of this file…', () => { if (active) openHistory(active.path, 'commits') }, undefined, { disabled: !active || Boolean(active.diff) }),
        item('Blame for every line', () => setBlameColumn(value => !value), undefined, { checked: blameColumn, disabled: !active }),
        item('Commit…', () => { showSide('git'); if (commit.trim()) gitAction('commit') }),
        item('Pull', () => gitAction('pull')),
        item('Push', () => gitAction('push')),
        item('Fetch', () => gitAction('fetch')),
        'separator',
        item('Stash changes…', stashChanges, undefined, { disabled: !status.changes.length }),
        item('Bring back the latest stash', () => { void runStash('pop') }),
        item('Stashes…', () => { void showStashes() }),
        item('Pull requests…', () => setFullView('pulls')),
      ] } as MenuEntry] : []),
      { label: 'Tools', items: [
        item('Create image of code', captureCode, undefined, { disabled: !active || Boolean(active.diff) }),
        item('Ask the assistant', () => { if (!chatOpen) toggleChat() }, mod + '+Shift+A'),
        item('Open the canvas', () => setGraphView(true)),
        item('Journal', () => setJournalOpen(true)),
        item('Servers (SSH)…', () => showSide('remote')),
      ] },
      { label: 'Help', items: [
        item('Keyboard shortcuts', () => onSettings('shortcuts')),
        item('Check for updates…', () => onSettings('about')),
        item('About Still', () => onSettings('about')),
      ] },
      'separator',
      item('Settings…', () => onSettings(), mod + '+,'),
      item('Home', goHome, mod + '+Shift+H'),
      ...(desktop ? ['separator' as const, item('Quit', () => { void getCurrentWindow().close().catch(notify) })] : []),
    ]
    mainMenuItems.current = items
    setMenu({ x: box.left, y: box.bottom + 6, items })
  }

  // ---- Git: stashes, and staging or reverting one change from the gutter ----
  async function runStash(action: 'push' | 'pop' | 'apply' | 'drop', index?: number, message?: string) {
    try {
      await api.stash(workspace.root, action, index, message)
      notify(action === 'push' ? 'Changes stashed.' : action === 'drop' ? 'Stash dropped.' : 'Stash brought back.')
      await refreshGit()
      reloadFromDisk()
    } catch (error) { notify(error) }
  }
  // Files changed on disk under the open tabs (another program, a script, Git): reload the tabs
  // with no unsaved edits. Tabs you have edited keep your version.
  function reloadFromDisk() {
    for (const tab of latest.current.tabs) {
      if (tab.diff || tab.binary || dirty(tab)) continue
      void fs.read(tab.path).then(contents => {
        if (contents !== tab.saved) setTabs(previous => previous.map(item => item.id === tab.id && !dirty(item) ? { ...item, contents, saved: contents } : item))
      }).catch(() => {})
    }
  }
  const reloadRef = useRef(reloadFromDisk)
  reloadRef.current = reloadFromDisk
  useEffect(() => {
    // Coming back to Still after editing elsewhere picks up the changes (local projects; a remote
    // one would mean a round trip per tab, so Refresh in Files does it there): the files open in
    // tabs, and files and folders added or removed in File Explorer or another program.
    if (remote) return
    const onFocus = () => { reloadRef.current(); treeRef.current() }
    window.addEventListener('focus', onFocus)
    // While Still is in front, the tree also checks for changes every few seconds.
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && document.hasFocus()) treeRef.current() }, 3000)
    return () => { window.removeEventListener('focus', onFocus); clearInterval(timer) }
  }, [])
  const treeRef = useRef(() => {})
  treeRef.current = () => {
    const id = generation.current
    for (const path of ['', ...latest.current.expanded]) void directory(path, id, true)
  }
  function stashChanges() {
    setDialog({ title: 'Stash changes', description: 'Puts your uncommitted changes (new files too) aside and leaves the working tree clean. Bring them back from Git → Stashes.', input: '', placeholder: 'Half-done login form', inputLabel: 'Note (optional)', label: 'Stash',
      action: value => { void (async () => { await storeAll(); await runStash('push', undefined, value) })() } })
  }
  async function showStashes() {
    try {
      const list = await api.stash(workspace.root, 'list')
      if (!list.length) { notify('No stashes.'); return }
      setMenu({ x: Math.round(frame.width / 2) - 160, y: 120, items: list.slice(0, 12).map(entry => ({ label: (entry.message || 'stash@{' + entry.index + '}') + ' · ' + entry.when, items: [
        { label: 'Apply and remove', action: () => { void runStash('pop', entry.index) } },
        { label: 'Apply and keep', action: () => { void runStash('apply', entry.index) } },
        { label: 'Drop', danger: true, action: () => { void runStash('drop', entry.index) } },
      ] })) })
    } catch (error) { notify(error) }
  }
  function changeMarkerMenu(tab: Tab, pane: string, line: number, event: MouseEvent) {
    const base = heads[tab.path]
    if (base === undefined || base === null) return
    const a = Text.of(base.split('\n')), b = Text.of(tab.contents.split('\n'))
    const lines = (doc: Text, from: number, to: number) => {
      if (to <= from) return { start: doc.lineAt(Math.min(from, doc.length)).number, text: [] as string[] }
      const first = doc.lineAt(from).number, last = doc.lineAt(Math.min(to - 1, doc.length)).number
      return { start: first, text: Array.from({ length: last - first + 1 }, (_, index) => doc.line(first + index).text) }
    }
    const chunk = Chunk.build(a, b).find(item => {
      const range = lines(b, item.fromB, item.toB)
      return range.text.length ? line >= range.start && line < range.start + range.text.length : line === range.start || line === range.start - 1
    })
    if (!chunk) return
    const old = lines(a, chunk.fromA, chunk.toA), now = lines(b, chunk.fromB, chunk.toB)
    const header = `@@ -${old.text.length ? old.start : old.start - 1},${old.text.length} +${now.text.length ? now.start : now.start - 1},${now.text.length} @@`
    const patch = `diff --git a/${tab.path} b/${tab.path}\n--- a/${tab.path}\n+++ b/${tab.path}\n${header}\n${old.text.map(text => '-' + text + '\n').join('')}${now.text.map(text => '+' + text + '\n').join('')}`
    const what = !old.text.length ? 'added lines' : !now.text.length ? 'removed lines' : 'change'
    setMenu({ x: event.clientX + 6, y: event.clientY, items: [
      { label: 'Revert this ' + what, action: () => {
        const reverted = b.sliceString(0, chunk.fromB) + a.sliceString(chunk.fromA, Math.min(chunk.toA, a.length)) + b.sliceString(Math.min(chunk.toB, b.length))
        const handle = handles.current[pane]
        if (handle) handle.replaceAll(reverted); else edited(tab, reverted)
      } },
      ...(!remote && desktop ? [{ label: 'Stage just this ' + what, action: () => { void (async () => {
        try { await store(tab); await api.applyPatch(workspace.root, patch, true); notify('Staged.'); await refreshGit() }
        catch (error) { notify("Couldn't stage that change by itself: " + String(error)) }
      })() } }] : []),
      ...(old.text.length ? [{ label: 'Copy the previous version', action: () => copyText(old.text.join('\n')) }] : []),
    ] })
  }

  // ---- Shortcuts from the keymap (a preset and your own); checked before everything else ----
  const keyHandlers: Record<string, () => void> = {
    'palette.files': () => openPalette(''), 'palette.commands': () => openPalette('>'), 'palette.symbols': () => openPalette('#'),
    save: () => { void store(active).catch(notify) }, close: () => { if (active) closeTab(active) },
    'next-tab': () => { const index = tabs.findIndex(tab => tab.id === selected); if (tabs.length) activate(tabs[(index + 1) % tabs.length].id) },
    'prev-tab': () => { const index = tabs.findIndex(tab => tab.id === selected); if (tabs.length) activate(tabs[(index - 1 + tabs.length) % tabs.length].id) },
    split: () => splitRight(), run: () => { void run() }, debug: () => { void startDebug() }, tests: () => { void runTests(null) },
    format: () => { void formatDocument() }, rename: () => { editor.current?.command('rename') }, definition: () => { void goToDefinition() },
    references: () => { editor.current?.command('references') }, quickfix: () => { void showQuickFixes() },
    refactor: () => { void showRefactors() }, 'extract-variable': () => { editor.current?.refactor('extract-variable') }, 'extract-method': () => { editor.current?.refactor('extract-method') }, 'inline-variable': () => { editor.current?.refactor('inline-variable') }, 'goto-line': () => { editor.current?.command('gotoLine') },
    comment: () => { editor.current?.command('comment') }, terminal: () => { if (drawerOpen) setDrawerOpen(false); else showDrawer('terminal', true) },
    'side.files': () => showSide('explorer', true), 'side.search': () => showSide('search', true), 'side.git': () => { if (!remote) showSide('git', true) },
    commit: () => { if (!remote) { showSide('git'); if (commit.trim()) gitAction('commit') } }, push: () => { if (!remote) gitAction('push') }, pull: () => { if (!remote) gitAction('pull') },
    assistant: toggleChat, minimap: () => toggleMinimap(), focus: toggleFocus, overview: openOverview, home: goHome, settings: () => onSettings(),
  }
  const keyHandlersRef = useRef(keyHandlers)
  keyHandlersRef.current = keyHandlers
  const keyBindingKey = settings.keymap + JSON.stringify(settings.keybindings)
  useEffect(() => {
    const byCombo = new Map(Object.entries(bindings(settings.keymap, settings.keybindings)).map(([action, combo]) => [combo, action]))
    if (!byCombo.size) return
    const handle = (event: KeyboardEvent) => {
      if (event.repeat || document.querySelector('.modal-backdrop, .settings-backdrop, .palette') || (event.target as Element | null)?.closest?.('.key-recorder, .nb')) return
      const combo = comboOf(event)
      const action = combo ? byCombo.get(combo) : undefined
      if (!action || !keyHandlersRef.current[action]) return
      event.preventDefault(); event.stopPropagation()
      keyHandlersRef.current[action]()
    }
    window.addEventListener('keydown', handle, true)
    return () => window.removeEventListener('keydown', handle, true)
  }, [keyBindingKey])

  /** Alt+Enter: the language server's fixes for this line, in a menu at the caret. */
  async function showQuickFixes(at?: { x: number; y: number }) {
    const handle = editor.current
    if (!handle) return
    const point = at ?? handle.caretPoint() ?? { x: 400, y: 300 }
    let fixes: Awaited<ReturnType<EditorHandle['quickFixes']>> = null
    try { fixes = await handle.quickFixes() } catch (error) { notify(error); return }
    if (fixes === null) { notify(active && lspLanguage(active.path) ? 'Quick fixes come from a language server. Install one (Settings → Editor) to get them.' : 'No quick fixes for this kind of file.'); return }
    if (!fixes.length) { notify('No quick fixes here.'); return }
    setMenu({ x: point.x, y: point.y, items: fixes.slice(0, 14).map(fix => ({ label: fix.title, action: () => { void fix.run().catch(notify) } })) })
  }
  /** Ctrl+Shift+R: extract variable or function, and the language server's refactorings. */
  async function showRefactors(at?: { x: number; y: number }) {
    const handle = editor.current
    if (!handle || !active || active.diff) return
    const point = at ?? handle.caretPoint() ?? { x: 400, y: 300 }
    let items: Awaited<ReturnType<EditorHandle['refactors']>> = []
    try { items = await handle.refactors() } catch (error) { notify(error); return }
    if (!items.length) { notify(handle.selection() ? 'No refactorings for this selection. Select a whole expression to extract a variable' + (mode === 'Python' ? ', or whole lines to extract a function.' : '.') : 'Select an expression or some lines first, then refactor.'); return }
    setMenu({ x: point.x, y: point.y, items: items.slice(0, 16).map(item => ({ label: item.title, action: () => { void Promise.resolve(item.run()).catch(notify) } })) })
  }
  useEffect(() => { refactorHook.notify = message => notify(message) })
  const coveragePercents = useMemo(() => {
    const coverage = testReport?.coverage
    if (!coverage) return undefined
    const result: Record<string, number> = {}
    for (const [path, lines] of Object.entries(coverage)) { const total = lines.covered.length + lines.missed.length; if (total) result[path] = Math.round(lines.covered.length / total * 100) }
    return result
  }, [testReport])
  useEffect(() => {
    const open = (event: Event) => {
      const { x, y } = (event as CustomEvent<{ x: number; y: number }>).detail
      setMenu({ x, y, items: [{ label: 'Hide the sticky header', action: () => { update({ stickyScroll: false }); toast('Sticky header is off. Turn it back on in Settings → Editor, or with “Toggle sticky header”.') } }] })
    }
    window.addEventListener('still-sticky-menu', open)
    return () => window.removeEventListener('still-sticky-menu', open)
  })
  useEffect(() => {
    const open = () => { void showQuickFixes() }
    window.addEventListener('still-quick-fix', open)
    return () => window.removeEventListener('still-quick-fix', open)
  })

  function editorMenu(event: ReactMouseEvent) {
    if (!active) return
    const handle = editor.current
    const selectedText = handle?.selection() ?? ''
    const word = handle?.word()
    const readOnly = Boolean(active.diff)
    const hasServer = Boolean(handle?.command('server'))
    const items: MenuEntry[] = [
      { label: 'Cut', shortcut: mod + '+X', disabled: !selectedText || readOnly, action: () => { handle?.command('cut') } },
      { label: 'Copy', shortcut: mod + '+C', disabled: !selectedText, action: () => { handle?.command('copy') } },
      { label: 'Paste', shortcut: mod + '+V', disabled: readOnly, action: () => { void clipboard.read().then(text => { editor.current?.insert(text); editor.current?.focus() }).catch(notify) } },
      { label: 'Select all', shortcut: mod + '+A', action: () => { handle?.command('selectAll') } },
      'separator',
      ...(!readOnly ? [
        { label: 'Go to definition', shortcut: 'F12', disabled: !word, action: () => { void goToDefinition() } },
        ...(hasServer ? [{ label: 'Find all references', shortcut: 'Shift+F12', disabled: !word, action: () => { handle?.command('references') } }, { label: 'Quick fix…', shortcut: 'Alt+Enter', action: () => { void showQuickFixes({ x: event.clientX, y: event.clientY }) } }] : []),
        { label: 'Refactor…', shortcut: mod + '+Shift+R', disabled: !selectedText && !hasServer, action: () => { void showRefactors({ x: event.clientX, y: event.clientY }) } },
        { label: hasServer ? (word ? 'Rename “' + word.text.slice(0, 24) + '”' : 'Rename symbol') : word ? 'Rename “' + word.text.slice(0, 24) + '” in this file' : 'Rename in this file', shortcut: 'F2', disabled: !word, action: () => { handle?.command('rename') } },
        { label: 'Select next match', shortcut: mod + '+D', disabled: !word && !selectedText, action: () => { handle?.command('selectNext') } },
      ] : []),
      { label: 'Find in file', shortcut: mod + '+F', action: () => handle?.find() },
      { label: (selectedText || word?.text) ? 'Find “' + (selectedText || word?.text || '').split('\n')[0].slice(0, 24) + '” in all files' : 'Find in all files', shortcut: mod + '+Shift+F', action: () => searchFor((selectedText || word?.text || '').split('\n')[0]) },
      'separator',
      ...(!readOnly ? [{ label: 'Toggle comment', shortcut: mod + '+/', action: () => { handle?.command('comment') } }, { label: 'Format document', shortcut: 'Shift+Alt+F', action: () => { void formatDocument() } }] : []),
      { label: 'Fold all', action: () => { handle?.command('foldAll') } },
      { label: 'Unfold all', action: () => { handle?.command('unfoldAll') } },
      'separator',
      ...(runnable ? [{ label: 'Run ' + fileName(active.path), shortcut: mod + '+Enter', action: () => { void run() } }] : []),
      { label: selectedText ? 'Create image of selection' : 'Create image of this file', icon: Camera, action: captureCode },
      { label: 'Ask the assistant about this', icon: Sparkles, action: () => { if (!chatOpen) toggleChat(); else setChatFocus(count => count + 1) } },
      'separator',
      ...(!remote && desktop ? [{ label: 'History of this file…', action: () => openHistory(active.path) }] : []),
      { label: 'Copy relative path', action: () => copyText(active.path) },
      { label: 'Show in files', action: () => { showSide('explorer'); expandParents(active.path) } },
      ...(desktop && !remote ? [{ label: 'Reveal in file manager', action: () => { void home.reveal(absolute(parentPath(active.path))).catch(notify) } }] : []),
    ]
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  function showSide(side: Side, toggle = false) {
    setLastSide(side)
    setSidebar(previous => toggle && previous === side ? null : side)
    if (side === 'search') setSearchFocus(value => value + 1)
  }

  function newSession(sshHost?: SshHost, remotePath?: string) {
    const id = crypto.randomUUID()
    const shellName = (settings.terminalShell || runtimes?.shell || 'shell').split(/[\\/]/).at(-1)!.replace(/\.exe$/i, '')
    const inContainer = !sshHost && containerOn
    if (inContainer && container?.state !== 'running') { notify('Start the dev container first (Dev container in the status bar).'); }
    const base = sshHost ? sshHost.name : inContainer ? 'container' : shellName
    const taken = sessionsRef.current.filter(item => item.label === base || item.label.startsWith(base + ' ')).length
    const label = taken ? base + ' ' + (taken + 1) : base
    const session: TerminalSession = sshHost ? { id, label, ssh: sshHost.id, remotePath } : inContainer ? { id, label, container: true } : { id, label }
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

  useEffect(() => { try { localStorage.setItem('still.breakpoints.' + workspace.root, JSON.stringify(breakpoints)) } catch { /* ignore */ } }, [breakpoints])
  useEffect(() => { try { localStorage.setItem('still.breakpointOptions.' + workspace.root, JSON.stringify(breakpointOptions)) } catch { /* ignore */ } }, [breakpointOptions])
  useEffect(() => { try { localStorage.setItem(runKey, JSON.stringify({ args: runArgs, env: runEnv })) } catch { /* ignore */ } }, [runArgs, runEnv])
  const breakpointItems = (lines: Record<string, number[]> = breakpoints, options = breakpointOptions) =>
    Object.entries(lines).flatMap(([file, list]) => list.map(line => ({ file, line, ...options[file + ':' + line] })))
  function breakpointMenu(path: string, line: number, event: MouseEvent) {
    const key = path + ':' + line
    const current = breakpointOptions[key] ?? {}
    const has = (breakpoints[path] ?? []).includes(line)
    const setOption = (next: { condition?: string; log?: string } | null) => {
      const options = { ...breakpointOptions }
      if (next && (next.condition || next.log)) options[key] = next; else delete options[key]
      setBreakpointOptions(options)
      const lines = has ? breakpoints : { ...breakpoints, [path]: [...(breakpoints[path] ?? []), line].sort((a, b) => a - b) }
      if (!has) setBreakpoints(lines)
      if (debugRef.current?.state === 'paused') debugSend({ op: 'breakpoints', items: breakpointItems(lines, options) })
    }
    setMenu({ x: event.clientX, y: event.clientY, items: [
      { label: current.condition ? 'Edit condition…' : 'Stop only when…', action: () => setDialog({
        title: 'Breakpoint condition', description: 'Stop on line ' + line + ' only when this expression is true.', input: current.condition ?? '', placeholder: 'count > 10', inputLabel: 'Condition', label: 'Set',
        action: value => setOption({ condition: value.trim() || undefined }),
      }) },
      { label: current.log ? 'Edit log message…' : 'Log a message instead…', action: () => setDialog({
        title: 'Logpoint', description: 'Print a message when line ' + line + ' runs, without stopping. Put expressions in braces.', input: current.log ?? '', placeholder: 'total is {total}', inputLabel: 'Message', label: 'Set',
        action: value => setOption({ log: value.trim() || undefined }),
      }) },
      ...(current.condition || current.log ? [{ label: 'Make it a plain breakpoint', action: () => setOption(null) }] : []),
      ...(has ? ['separator' as const, { label: 'Remove breakpoint', action: () => { setOption(null); changeBreakpoints(path, (breakpoints[path] ?? []).filter(item => item !== line)) } }] : []),
    ] })
  }
  useEffect(() => { try { localStorage.setItem('still.watches.' + workspace.root, JSON.stringify(watches)) } catch { /* ignore */ } }, [watches])
  useEffect(() => {
    if (!desktop) return
    let stop: UnlistenFn | null = null, cancelled = false
    void listen<{ id: string; event: string } & Partial<DebugStop> & { expression?: string; value?: string; ok?: boolean }>('debug-event', ({ payload }) => {
      const current = debugRef.current
      if (!current || payload.id !== current.id) return
      if (payload.event === 'started') putDebug({ ...current, state: 'running' })
      else if (payload.event === 'stopped') {
        const stopped = payload as unknown as DebugStop
        putDebug({ ...current, state: 'paused', stop: stopped })
        if (!stopped.frameFile.startsWith('/') && !/^[a-z]:/i.test(stopped.frameFile)) jumpTo({ path: stopped.frameFile, line: stopped.frameLine })
        setDrawer('debug'); setDrawerOpen(true)
        void getCurrentWindow().setFocus().catch(() => {})
      } else if (payload.event === 'eval') putDebug({ ...current, evals: [...current.evals, { expression: payload.expression ?? '', value: payload.value ?? '', ok: payload.ok !== false }] })
      else if (payload.event === 'ended') putDebug(null)
    }).then(unlisten => { if (cancelled) unlisten(); else stop = unlisten })
    return () => { cancelled = true; stop?.() }
  }, [])

 useEffect(() => {
    if (!desktop) return
    let stop: UnlistenFn | null = null, cancelled = false
    void listen<{ id: string; tool: string; results: TestResult[]; coverage?: TestReport['coverage'] }>('test-results', ({ payload }) => {
      setTestsRunning(false)
      setTestReport({ tool: payload.tool, results: payload.results, time: Date.now(), coverage: payload.coverage ?? null })
      setDrawer('tests'); setDrawerOpen(true)
    }).then(unlisten => { if (cancelled) unlisten(); else stop = unlisten })
    return () => { cancelled = true; stop?.() }
  }, [])
  // ---- Database tab: stays mounted once opened, so SQL and results survive switching tabs ----
  const [dbFocus, setDbFocus] = useState<{ path: string; nonce: number } | null>(null)
  const [dbVisited, setDbVisited] = useState(false)
  useEffect(() => { if (drawer === 'database') setDbVisited(true) }, [drawer])

  // ---- Dev container: run, test and open terminals inside the project's container ----
  const [container, setContainer] = useState<ContainerInfo | null>(null)
  const containerKey = 'still.container.use.' + workspace.root
  const [containerUse, setContainerUse] = useState(() => { try { return localStorage.getItem(containerKey) === '1' } catch { return false } })
  const containerOn = Boolean(containerUse && container?.config && !remote && desktop)
  const afterContainer = useRef<(() => void) | null>(null)
  const containerStarting = useRef(false)
  const refreshContainer = useCallback(async () => {
    if (!desktop || remote) { setContainer(null); return }
    try { setContainer(await containers.status(workspace.root)) } catch { setContainer(null) }
  }, [workspace.root, remote])
  // Look again when a .devcontainer folder appears or goes, and when the window comes back.
  const hasDevcontainer = Boolean(directories['']?.some(entry => entry.name === '.devcontainer' || entry.name === '.devcontainer.json'))
  useEffect(() => { void refreshContainer() }, [refreshContainer, hasDevcontainer])
  useEffect(() => {
    if (!desktop || remote) return
    const focus = () => { void refreshContainer() }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [refreshContainer])
  useEffect(() => {
    if (!desktop || remote) return
    let stop: UnlistenFn | null = null, cancelled = false
    void listen('container-changed', () => { void refreshContainer() }).then(unlisten => { if (cancelled) unlisten(); else stop = unlisten })
    return () => { cancelled = true; stop?.() }
  }, [refreshContainer])
  // Once the container is up, do what was waiting for it (a run or tests).
  useEffect(() => {
    if (container?.state === 'running' && afterContainer.current && !job) { const next = afterContainer.current; afterContainer.current = null; setTimeout(next, 50) }
    if (!job && container && container.state !== 'running' && afterContainer.current && !containerStarting.current) afterContainer.current = null
  }, [container, job])
  // Mention the dev container once per project.
  useEffect(() => {
    if (!container?.config) return
    const seen = 'still.container.seen.' + workspace.root
    try { if (localStorage.getItem(seen)) return; localStorage.setItem(seen, '1') } catch { return }
    toast('This project has a dev container. Use “Dev container” in the status bar to run, test and open terminals inside it.')
  }, [container?.config])
  function chooseContainer(value: boolean) {
    setContainerUse(value)
    try { localStorage.setItem(containerKey, value ? '1' : '0') } catch { /* private window */ }
  }
  async function startContainer(rebuild: boolean) {
    if (!container?.config) return
    if (!container.docker) { notify(container.note ?? 'Docker is not available.'); afterContainer.current = null; return }
    containerStarting.current = true
    try { await launch('run', rebuild ? 'rebuild' : 'container', 'container_up', { rootPath: workspace.root, rebuild }) }
    finally { containerStarting.current = false }
    if (focusMode) setFocusOutput(true); else showDrawer('output')
  }
  function containerMenu(event: ReactMouseEvent) {
    if (!container) return
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const running = container.state === 'running'
    const items: MenuEntry[] = [
      containerOn
        ? { label: 'Run on this computer instead', action: () => chooseContainer(false) }
        : { label: 'Use the dev container', action: () => { chooseContainer(true); if (!running) void startContainer(false) } },
      'separator',
      ...(running ? [{ label: 'Stop the container', action: () => { void containers.stop(workspace.root).then(refreshContainer).catch(notify) } }]
        : [{ label: container.state === 'stopped' ? 'Start the container' : 'Build and start the container', disabled: Boolean(job), action: () => { void startContainer(false) } }]),
      { label: 'Rebuild the container', disabled: Boolean(job), action: () => { void startContainer(true) } },
      { label: 'New terminal in the container', disabled: !running, action: () => { setDrawer('terminal'); setDrawerOpen(true); const session = { id: crypto.randomUUID(), label: 'container', container: true }; sessionsRef.current = [...sessionsRef.current, session]; setSessions(sessionsRef.current); setActiveSession(session.id) } },
      'separator',
      { label: 'Open ' + container.config, action: () => { void openFile(container.config) } },
    ]
    setMenu({ x: box.left, y: box.top, items })
  }

  // ---- Profiler: run a Python file under the sampler, then show the flame graph ----
  const [profile, setProfile] = useState<{ data: ProfileData | MemoryData; path: string } | null>(null)
  const [profiling, setProfiling] = useState(false)
  useEffect(() => {
    if (!desktop) return
    let stop: UnlistenFn | null = null, cancelled = false
    void listen<{ id: string; path: string; data: string }>('profile-result', ({ payload }) => {
      try { setProfile({ data: JSON.parse(payload.data) as ProfileData | MemoryData, path: payload.path }) } catch (error) { notify(error) }
      setProfiling(false)
      setDrawer('profile'); setDrawerOpen(true)
    }).then(unlisten => { if (cancelled) unlisten(); else stop = unlisten })
    return () => { cancelled = true; stop?.() }
  }, [])
  useEffect(() => { if (!job) setProfiling(false) }, [job])
  const profileWhy = !desktop ? 'Profiling runs in the Still desktop app.' : remote ? 'Profiling works for projects on this computer for now.' : mode !== 'Python' ? 'Open a Python file to profile it.' : undefined
  async function startProfile(memory = false) {
    if (!active || profileWhy || activeJob.current) { if (profileWhy) notify(profileWhy); return }
    await store(active)
    setProfiling(true)
    setDrawer('profile'); setDrawerOpen(true)
    await launch('run', 'profile', 'profile_start', { rootPath: workspace.root, path: active.path, args: runArgs[active.path] || null, env: runEnv[active.path] || null, dotenv: settings.loadDotEnv, memory }, { path: active.path })
  }
  // Language servers: one per language in use, started when a file of that language is open.
  const [langServers, setLangServers] = useState<Record<string, LanguageServer | 'starting' | 'none'>>({})
  const [serverNonce, setServerNonce] = useState(0)
  const langServersRef = useRef(langServers)
  langServersRef.current = langServers
  const openRef = useRef(openFile)
  openRef.current = openFile
  // A change from the language server (a rename) to a file no editor is showing.
  async function editInBackground(path: string, edit: (text: string) => string) {
    const tab = latest.current.tabs.find(item => item.path === path && !item.diff)
    if (tab) { setTabs(previous => previous.map(item => item.id === tab.id ? { ...item, contents: edit(item.contents) } : item)); return }
    const before = await fs.read(path)
    const after = edit(before)
    if (after !== before) { await fs.save(path, after, before); tellServers([{ path, type: 'changed' }]) }
  }
  const editRef = useRef(editInBackground)
  editRef.current = editInBackground
  const langServersOn = Boolean(settings.languageServers) && desktop
  const langServersOnRef = useRef(langServersOn)
  langServersOnRef.current = langServersOn
  const serverKey = [...new Set(shownTabs.map(tab => !tab.diff && !tab.binary ? lspLanguage(tab.path)?.server : undefined).filter(Boolean))].sort().join(',')
  useEffect(() => {
    if (!langServersOn || !serverKey) return
    for (const language of serverKey.split(',')) {
      if (langServersRef.current[language]) continue
      langServersRef.current = { ...langServersRef.current, [language]: 'starting' }
      setLangServers(previous => ({ ...previous, [language]: 'starting' }))
      const host = { root: workspace.root, remote: workspace.remote ?? null, open: async (path: string) => { await openRef.current(path) }, editFile: (path: string, edit: (text: string) => string) => editRef.current(path, edit), notify,
        read: async (path: string) => latest.current.tabs.find(tab => tab.path === path && !tab.diff)?.contents ?? fs.read(path) }
      void startServer(host, language, log => {
        setLangServers(previous => ({ ...previous, [language]: 'none' }))
        // On a server with no language server installed, just carry on without one.
        if (log.includes('NOSERVER')) return
        const last = log.split('\n').map(line => line.trim()).filter(Boolean).at(-1)
        notify('The ' + language + ' language server stopped.' + (last ? ' ' + last.slice(0, 160) : '') + ' Click its name in the status bar to restart it.')
      }).then(server => {
        if (!langServersOnRef.current || langServersRef.current[language] !== 'starting') { server?.close(); return }
        setLangServers(previous => ({ ...previous, [language]: server ?? 'none' }))
      }).catch(() => setLangServers(previous => ({ ...previous, [language]: 'none' })))
    }
  }, [serverKey, langServersOn, serverNonce])
  function closeServers() {
    for (const value of Object.values(langServersRef.current)) if (typeof value === 'object') value.close()
    langServersRef.current = {}
    setLangServers({})
  }
  useEffect(() => { if (!langServersOn) closeServers() }, [langServersOn])
  useEffect(() => () => closeServers(), [])
  // Servers read files that aren't open from disk; tell them when files appear, go or are saved.
  function tellServers(changes: { path: string; type: 'created' | 'changed' | 'deleted' }[]) {
    for (const value of Object.values(langServersRef.current)) if (typeof value === 'object') value.filesChanged(changes)
  }
  const knownFiles = useRef<Set<string> | null>(null)
  useEffect(() => {
    const now = new Set(files.filter(entry => !entry.directory).map(entry => entry.path))
    const before = knownFiles.current
    knownFiles.current = now
    if (!before) return
    const changes = [
      ...[...now].filter(path => !before.has(path)).map(path => ({ path, type: 'created' as const })),
      ...[...before].filter(path => !now.has(path)).map(path => ({ path, type: 'deleted' as const })),
    ]
    if (changes.length && changes.length < 2000) tellServers(changes)
  }, [files])
  function restartServer(language: string) {
    const value = langServersRef.current[language]
    if (typeof value === 'object') value.close()
    const { [language]: _, ...rest } = langServersRef.current
    langServersRef.current = rest
    setLangServers(rest)
    setServerNonce(count => count + 1)
  }
  const serverOf = (tab: Tab) => {
    const language = !tab.diff && langServersOn ? lspLanguage(tab.path)?.server : undefined
    const value = language ? langServers[language] : undefined
    return typeof value === 'object' ? value : null
  }
  const activeServerLanguage = active && !active.diff && langServersOn ? lspLanguage(active.path)?.server : undefined
  const activeServer = activeServerLanguage ? langServers[activeServerLanguage] : undefined

  const testLanguage = mode === 'Java' || (!mode && files.some(file => file.path === 'pom.xml' || file.path.startsWith('build.gradle'))) ? 'java' : 'python'
  const testsWhy = !desktop ? 'Tests run in the Still desktop app.' : remote && testLanguage !== 'python' ? 'On a server, Still runs Python tests (pytest) for now.' : undefined
  // Watch mode: the last tests you ran run again after each save.
  const [testWatch, setTestWatch] = useState(false)
  const lastTests = useRef<{ target: string | null; language: string }>({ target: null, language: testLanguage })
  const watchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  function testsAfterSave(path: string) {
    if (!testWatch || !/\.(py|java)$/.test(path)) return
    clearTimeout(watchTimer.current)
    watchTimer.current = setTimeout(() => { if (!activeJob.current) void runTests(lastTests.current.target, lastTests.current.language as 'java' | 'python', true) }, 500)
  }
  async function runTests(target: string | null, language = testLanguage, quiet = false) {
    if (testsWhy) { notify(testsWhy); return }
    lastTests.current = { target, language }
    if (activeJob.current) { notify('Wait for the current process to finish.'); return }
    if (active && dirty(active)) await store(active).catch(notify)
    await storeAll()
    setTestsRunning(true)
    if (remote) await launch('run', 'test', 'ssh_tests_run', { hostId: workspace.remote, root: workspace.root, target })
    else if (containerOn && container?.state !== 'running') { setTestsRunning(false); afterContainer.current = () => { void runTests(target, language, quiet) }; await startContainer(false); return }
    else if (containerOn) await launch('run', 'test', 'container_tests', { rootPath: workspace.root, target, language, coverage: settings.testCoverage })
    else await launch('run', 'test', 'tests_run', { rootPath: workspace.root, target, language, dotenv: settings.loadDotEnv, coverage: settings.testCoverage })
    if (!quiet || drawerOpen) { setDrawer('tests'); setDrawerOpen(true) }
    if (!activeJob.current) setTestsRunning(false)
  }
  function runTestsFrom(which: 'all' | 'failed' | 'file') {
    if (which === 'all') { void runTests(null); return }
    if (which === 'file') {
      if (!active) return
      const found = testsIn(active.path, active.contents)
      void runTests(mode === 'Java' ? (found[0]?.id.split('#')[0] ?? null) : active.path, mode === 'Java' ? 'java' : 'python')
      return
    }
    const failed = testReport?.results.filter(result => result.status === 'failed' || result.status === 'error') ?? []
    if (!failed.length) return
    // pytest takes several ids; Maven/Gradle take one pattern, so run the first file's failures.
    const ids = testReport?.tool === 'pytest' ? failed.map(result => (result.file ?? result.group.replace(/\./g, '/') + '.py') + '::' + (result.group.split('.').filter(part => /^Test/.test(part)).map(part => part + '::').join('')) + result.name).join(' ') : failed[0].group + '#' + failed[0].name
    void runTests(ids)
  }
  function jumpToTest(result: TestResult) {
    const byFile = result.file ?? files.find(file => file.path.replace(/\.(py|java)$/, '').replace(/\//g, '.').endsWith(result.group.split('.').filter(part => !/^Test[A-Z]/.test(part) || part.endsWith('Test')).join('.')))?.path
    // Prefer the line a failure points at inside the test file.
    const failureLine = byFile ? new RegExp(byFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+)').exec(result.message)?.[1] : undefined
    if (byFile) jumpTo({ path: byFile, line: Number(failureLine ?? result.line ?? 1) })
  }

  const debugWhy = !desktop ? 'Debugging runs in the Still desktop app.' : mode !== 'Python' && mode !== 'Java' ? 'The debugger works with Python and Java files for now.' : undefined
  async function startDebug() {
    if (!active || debugWhy || activeJob.current) { if (debugWhy) notify(debugWhy); return }
    await store(active)
    const items = breakpointItems()
    putDebug({ id: '', state: 'starting', stop: null, evals: [] })
    const options = { path: active.path, breakpoints: items, watches, stopOnEntry: false, args: runArgs[active.path] || null, env: runEnv[active.path] || null, dotenv: settings.loadDotEnv, pauseOn: settings.pauseOnExceptions }
    const started = remote
      ? launch('run', 'debug', 'ssh_debug_start', { ...options, hostId: workspace.remote, root: workspace.root }, { path: active.path })
      : launch('run', 'debug', 'debug_start', { ...options, rootPath: workspace.root }, { path: active.path })
    const id = (activeJob.current as Job | null)?.id ?? ''
    putDebug({ id, state: 'starting', stop: null, evals: [] })
    setDrawer('debug'); setDrawerOpen(true)
    await started
    if (!activeJob.current) putDebug(null)
  }
  function debugSend(command: Record<string, unknown>) {
    const current = debugRef.current
    if (!current?.id) return
    void invoke('debug_send', { id: current.id, command }).catch(notify)
  }
  function debugCommand(op: DebugOp) {
    const current = debugRef.current
    if (!current) return
    if (op === 'stop') {
      if (current.state === 'paused') debugSend({ op: 'stop' })
      if (activeJob.current) void invoke('stop_job', { id: activeJob.current.id }).catch(() => {})
      putDebug(null)
      return
    }
    if (current.state !== 'paused') return
    putDebug({ ...current, state: 'running' })
    debugSend({ op })
  }
  function changeBreakpoints(path: string, lines: number[]) {
    setBreakpoints(previous => {
      const next = { ...previous, [path]: [...new Set(lines)].sort((a, b) => a - b) }
      if (!next[path].length) delete next[path]
      // A running program learns about new breakpoints at once.
      if (debugRef.current?.state === 'paused') debugSend({ op: 'breakpoints', items: breakpointItems(next) })
      return next
    })
  }
  function changeWatches(next: string[]) {
    setWatches(next)
    if (debugRef.current?.state === 'paused') debugSend({ op: 'watches', items: next })
  }

  // F5 debug / continue, Shift+F5 stop, F9 breakpoint, F10 step over, F11 step into, Shift+F11 step out.
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyF' && !document.querySelector('.modal-backdrop, .settings-backdrop')) { event.preventDefault(); void formatDocument(); return }
      if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && event.key === 'Enter' && (event.target as Element | null)?.closest?.('.cm-editor') && !(event.target as Element).closest('.nb') && !document.querySelector('.modal-backdrop, .settings-backdrop')) { event.preventDefault(); void showQuickFixes(); return }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyR' && (event.target as Element | null)?.closest?.('.cm-editor') && !(event.target as Element).closest('.nb') && !document.querySelector('.modal-backdrop, .settings-backdrop')) { event.preventDefault(); event.stopImmediatePropagation(); void showRefactors(); return }
      if (!/^F(5|9|10|11)$/.test(event.key) || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('.modal-backdrop, .settings-backdrop')) return
      event.preventDefault()
      const current = debugRef.current
      if (event.key === 'F5') { if (event.shiftKey) debugCommand('stop'); else if (current) debugCommand('continue'); else void startDebug() }
      else if (event.key === 'F9' && active && !active.diff) { const list = breakpoints[active.path] ?? []; changeBreakpoints(active.path, list.includes(cursor.line) ? list.filter(line => line !== cursor.line) : [...list, cursor.line]) }
      else if (event.key === 'F10') debugCommand('next')
      else if (event.key === 'F11') debugCommand(event.shiftKey ? 'out' : 'step')
    }
    addEventListener('keydown', keys, true)
    return () => removeEventListener('keydown', keys, true)
  })

  async function launch(kind: Job['kind'], action: string, command: string, args: object, extra: Pick<Job, 'path' | 'detail'> = {}) {
    if (activeJob.current || !jobReady) { notify('The process runner is busy or still starting.'); return }
    const current: Job = { id: crypto.randomUUID(), kind, action, ...extra }
    activeJob.current = current
    setJob(current)
    setOutput([])
    setSampleRun(false)
    if (focusMode) { setFocusOutput(true); setDrawer('output') }
    else showDrawer(action === 'debug' ? 'debug' : 'output')
    try { await invoke(command, { ...args, id: current.id }) }
    catch (error) {
      if (activeJob.current?.id === current.id) {
        activeJob.current = null
        setJob(null)
        setOutput([{ kind: 'stderr', text: errorText(error) }])
      }
    }
  }

  // `config` carries arguments and environment just saved in the run configuration, before the
  // state holding them has re-rendered.
  async function run(buildOnly = false, config?: { args: string; env: string }) {
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
      const args = (config ? config.args : runArgs[active.path]) || null
      const env = (config ? config.env : runEnv[active.path]) || null
      if (remote) await launch('run', 'run', 'ssh_run', { hostId: workspace.remote, root: workspace.root, path: active.path, args, env, dotenv: settings.loadDotEnv }, { path: active.path })
      else if (containerOn && !buildOnly) {
        if (container?.state !== 'running') { afterContainer.current = () => { void run(false, config) }; await startContainer(false); return }
        await launch('run', 'run', 'container_run', { rootPath: workspace.root, path: active.path, args, env, dotenv: settings.loadDotEnv }, { path: active.path })
      }
      else await launch('run', buildOnly ? 'build' : 'run', 'run_file', { rootPath: workspace.root, path: active.path, buildOnly, args, env, dotenv: settings.loadDotEnv }, { path: active.path })
    } catch (error) { notify(error) }
    finally { setRunningRequest(false) }
  }

  function askArguments() {
    if (!active || !runnable) return
    setRunConfig(active.path)
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

  /** Ctrl+T: symbols across the project. The language server knows them best; otherwise search for definitions. */
  async function findSymbols(query: string): Promise<PaletteItem[]> {
    if (!query) return []
    const server = Object.values(langServersRef.current).find((value): value is LanguageServer => typeof value === 'object' && (!active || lspLanguage(active.path)?.server === value.language))
      ?? Object.values(langServersRef.current).find((value): value is LanguageServer => typeof value === 'object')
    if (server) {
      try {
        const found = await workspaceSymbols(server, workspace.root, query)
        if (found.length) return found.map((item, index) => ({ id: 'symbol-' + index, label: item.name, detail: (item.container ? item.container + ' · ' : '') + item.path + ':' + item.line, path: item.path, action: () => jumpTo({ path: item.path, line: item.line, column: item.column }) }))
      } catch { /* fall back to searching */ }
    }
    const name = query.replace(/[^\w$]/g, '')
    if (!name) return []
    const pattern = `\\b(def|class|function|interface|struct|enum|trait|fn|func|record|type|const|let|var)\\s+[\\w$]*${name}[\\w$]*|(public|private|protected|static)[\\w<>\\[\\], ?]*\\s+[\\w$]*${name}[\\w$]*\\s*\\(`
    const result = await fs.search(pattern, { regex: true, caseSensitive: false, wholeWord: false })
    return result.matches.slice(0, 60).map((match, index) => {
      const symbol = new RegExp(`[\\w$]*${name}[\\w$]*`, 'i').exec(match.preview.trim())?.[0] ?? name
      return { id: 'symbol-' + index, label: symbol, detail: match.path + ':' + match.line + ' · ' + match.preview.trim().slice(0, 60), path: match.path, action: () => jumpTo({ path: match.path, line: match.line, column: match.column }) }
    })
  }

  function openPalette(query: string) {
    returnedFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPalette(query)
    const id = generation.current
    void fs.files().then(result => { if (generation.current === id) setFiles(onlyLoose(result)) }).catch(error => { if (!remote) notify(error) })
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
    else notify('This file is too long for one image. Select the lines you want, then try again.')
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
      const shiftOnly = event.shiftKey && ['f', 'h', 'e', 'g', 'v', '`', '~', 'u', 'r', 'd', 'm', 'a', 'y'].includes(key)
      // Plain Ctrl/Cmd+F outside the editor would open the web view's own find bar; send it to the editor instead.
      if (key === 'f' && !event.shiftKey && !event.altKey && !(event.target as Element | null)?.closest?.('.cm-editor, input, textarea, .xterm')) {
        event.preventDefault(); editor.current?.find(); return
      }
      // Code zoom: Ctrl+= / Ctrl+- / Ctrl+0, as in browsers and other editors.
      if (!event.altKey && ['=', '+', '-', '_', '0'].includes(key) && !(event.target as Element | null)?.closest?.('.xterm, input, textarea') && !viewerTakesZoom()) {
        event.preventDefault()
        update({ editorFontSize: key === '0' ? 14 : Math.max(9, Math.min(28, settings.editorFontSize + (key === '-' || key === '_' ? -1 : 1))) })
        return
      }
      // Overview: Ctrl/Cmd+Alt+O. (Ctrl+Shift+↑ stays with the editor for selecting lines above.)
      if (event.altKey && !event.shiftKey && key === 'o') { event.preventDefault(); if (overview) setOverview(false); else openOverview(); return }
      if (event.altKey || !(['k', 'p', 's', 'w', 'b', 'j', 'o', 't', 'enter', 'tab', ',', '.', '\\'].includes(key) || shiftOnly)) return
      if ((overview || graphView) && !['k', 'p', '.'].includes(key)) return
      if (key === 'enter' && palette !== null) return
      // Ctrl+Enter in a text box (SQL, a commit message, the assistant) belongs to that box, not Run.
      if (key === 'enter' && (event.target as Element | null)?.closest?.('textarea, input, select')) return
      event.preventDefault()
      if (key === 'p' || key === 'k') { palette !== null ? closePalette() : openPalette(event.shiftKey ? '>' : ''); return }
      if (palette !== null) return
      if (key === 'tab') { cycleTab(event.shiftKey ? -1 : 1); return }
      if (key === '.') { toggleFocus(); return }
      if (key === '\\' && !event.shiftKey) { splitRight(); return }
      if (key === 't' && !event.shiftKey) { event.preventDefault(); openPalette('#'); return }
      if (key === 'v' && event.shiftKey) { cycleDocView(); return }
      // The island shortcuts toggle: press once to show, again to hide.
      if (key === 'f') { if (focusMode) setFocusMode(false); showSide('search', true) }
      if (key === 'e' && event.shiftKey) { if (focusMode) setFocusMode(false); showSide('explorer', true) }
      if (key === 'g' && event.shiftKey && !remote) { if (focusMode) setFocusMode(false); showSide('git', true) }
      if (key === 'u' && event.shiftKey && !remote) showSide('packages', true)
      // In the editor Ctrl+Shift+R is Refactor; elsewhere it shows Servers.
      if (key === 'r' && event.shiftKey && !(event.target as Element | null)?.closest?.('.cm-editor')) showSide('remote', true)
      if (key === 'd' && event.shiftKey) setGraphOpen(value => !value)
      if (key === 'y' && event.shiftKey) toggleMinimap()
      if (key === 'm' && event.shiftKey) toggleMaximize()
      if (key === 'a' && event.shiftKey) toggleChat()
      if (key === 'h' && event.shiftKey) goHome()
      if (key === '`' || key === '~') { setDrawer('terminal'); setDrawerOpen(true); if (desktop) { remote ? remoteSession() : newSession() } }
      if (key === ',') onSettings()
      if (key === 's') void (event.shiftKey ? storeAll() : store(active)).catch(notify)
      if (key === 'o') { if (event.shiftKey) chooseFile(); else chooseFolder() }
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

  function toggleChat() {
    if (focusMode) setFocusMode(false)
    setChatOpen(value => { if (!value) setChatFocus(count => count + 1); return !value })
  }

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
    // Files, Git and the canvas open fullscreen from the overview.
    if (key === 'graph') { setGraphView(true); return }
    if (key === 'explorer') { setFilePreview(null); setFullView('files'); return }
    if (key === 'git') { setGitPreview(null); void refreshLog(); setFullView('git'); return }
    if (key === 'terminal') { showDrawer('terminal', true); return }
    showSide(key as Side)
  }

  const allThemes = [...presets, ...settings.customThemes]
  const commands: PaletteItem[] = [
    { id: 'home', label: 'Go to Home', shortcut: mod + '+Shift+H', icon: House, action: goHome },
    { id: 'folder', label: 'Open folder', shortcut: mod + '+O', icon: FolderOpen, action: chooseFolder },
    { id: 'open-file', label: 'Open a single file', shortcut: mod + '+Shift+O', icon: FileText, action: chooseFile },
    ...(workspace.file ? [{ id: 'whole-folder', label: 'Open this file’s folder as a project', icon: FolderOpen, action: openFolderAsProject }] : []),
    { id: 'symbols', label: 'Go to symbol in project', shortcut: mod + '+T', icon: Search, action: () => openPalette('#') },
    ...(!remote ? [
      { id: 'stash', label: 'Git: stash changes', icon: GitBranch, action: stashChanges },
      { id: 'stash-pop', label: 'Git: bring back the latest stash', icon: GitBranch, action: () => { void runStash('pop') } },
      { id: 'stashes', label: 'Git: stashes…', icon: GitBranch, action: () => { void showStashes() } },
      { id: 'pulls', label: 'Git: pull requests', icon: GitBranch, action: () => setFullView('pulls') },
      { id: 'graph', label: 'Git: commit graph', icon: GitBranch, action: () => setFullView('graph') },
      ...(active && !active.diff && conflictCount(active.contents) ? [{ id: 'merge', label: 'Git: resolve conflicts in the merge editor', icon: GitBranch, action: () => { setMergeFor(active.id); setFullView('merge') } }] : []),
    ] : []),
    { id: 'run-config', label: 'Run configuration…', icon: Play, action: askArguments },
    { id: 'minimap', label: settings.minimap ? 'Hide the minimap' : 'Show the minimap', shortcut: mod + '+Shift+Y', icon: AlignLeft, action: toggleMinimap },
    { id: 'sticky', label: settings.stickyScroll ? 'Toggle sticky header (on)' : 'Toggle sticky header (off)', icon: AlignLeft, action: () => update({ stickyScroll: !settings.stickyScroll }) },
    ...(active && !active.diff && !active.binary ? [
      { id: 'refactor', label: 'Refactor…', icon: Wand2, action: () => { void showRefactors() } },
      { id: 'extract-variable', label: 'Extract variable…', icon: Wand2, action: () => { editor.current?.refactor('extract-variable') } },
      { id: 'inline-variable', label: 'Inline variable', icon: Wand2, action: () => { editor.current?.refactor('inline-variable') } },
      ...(mode === 'Python' ? [{ id: 'extract-method', label: 'Extract function…', icon: Wand2, action: () => { editor.current?.refactor('extract-method') } }] : []),
    ] : []),
    ...(!profileWhy ? [{ id: 'profile', label: 'Profile this file (flame graph)', icon: Flame, action: () => { void startProfile() } }, { id: 'profile-memory', label: 'Profile memory of this file', icon: Flame, action: () => { void startProfile(true) } }] : []),
    ...(!testsWhy ? [
      { id: 'tests-all', label: 'Run all tests', icon: FlaskConical, action: () => runTestsFrom('all') },
      { id: 'tests-file', label: 'Run the tests in this file', icon: FlaskConical, action: () => runTestsFrom('file') },
      ...(testReport?.results.some(result => result.status === 'failed' || result.status === 'error') ? [{ id: 'tests-failed', label: 'Run failed tests', icon: FlaskConical, action: () => runTestsFrom('failed') }] : []),
    ] : []),
    { id: 'overview', label: 'Overview of everything', shortcut: mod + '+Alt+O', icon: LayoutGrid, action: openOverview },
    { id: 'focus', label: focusMode ? 'Leave focus mode' : 'Focus mode', shortcut: mod + '+.', icon: Maximize2, action: toggleFocus },
    ...(active ? [{ id: 'split', label: 'Split editor right', shortcut: mod + '+\\', icon: Columns2, action: () => splitRight() }, { id: 'split-down', label: 'Split editor down', icon: Rows2, action: () => splitRight(active, 'bottom') }] : []),
    ...(panes.length > 1 ? [{ id: 'close-pane', label: 'Close this pane', icon: X, action: () => closePane(focusedRef.current) }] : []),
    { id: 'graph-view', label: 'Open the canvas', icon: Network, action: () => setGraphView(true) },
    { id: 'graph-island', label: graphOpen ? 'Hide the canvas island' : 'Show the canvas island', icon: Network, action: () => setGraphOpen(value => !value) },
    { id: 'journal', label: 'Open journal', icon: BookOpen, action: () => setJournalOpen(true) },
    { id: 'chat', label: chatOpen ? 'Hide chat' : 'Chat with the assistant', shortcut: mod + '+Shift+A', icon: BookOpen, action: toggleChat },
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
    ...(doc ? [{ id: 'doc-preview', label: (docView === 'preview' ? 'Edit ' : 'Preview ') + ({ markdown: 'Markdown', text: 'text', tex: 'LaTeX', svg: 'SVG', notebook: 'notebook' } as const)[doc] + ' file', shortcut: mod + '+Shift+V', icon: Eye, action: cycleDocView }] : []),
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
    { key: 'tests', label: 'Tests', glyph: FlaskConical },
    { key: 'debug', label: 'Debug', glyph: Bug },
    { key: 'profile', label: 'Profile', glyph: Flame },
    { key: 'database', label: 'Database', glyph: DatabaseIcon },
  ] as const
  const remoteActions = {
    onTerminal: (target: SshHost) => { setDrawer('terminal'); setDrawerOpen(true); newSession(target) },
    onOpenFolder: (target: SshHost) => setRemoteHost(target),
    onEdit: (target: SshHost) => setEditingHost(target),
    onDelete: (target: SshHost) => { void ssh.remove(target.id).then(refreshServers).catch(notify) },
    onTest: (target: SshHost) => { notify('Connecting to ' + target.name + '…'); void ssh.test(target.id).then(result => notify('Connected: ' + result)).catch(notify) },
  }

  const sideItems = ([
    { key: 'explorer', label: 'Files', keys: 'Shift+E', glyph: Files },
    { key: 'search', label: 'Search', keys: 'Shift+F', glyph: Search },
    ...(!remote ? [{ key: 'git', label: 'Git', keys: 'Shift+G', glyph: GitBranch }, { key: 'packages', label: 'Packages', keys: 'Shift+U', glyph: Package }] : []),
    { key: 'remote', label: 'Servers', keys: 'Shift+R', glyph: Server },
  ]) as { key: Side; label: string; keys: string; glyph: typeof Files }[]
  const testCache = useRef(new Map<string, { contents: string; report: TestReport | null; tests: { line: number; id: string; name: string; status?: string }[] }>())
  const testsFor = (tab: Tab) => {
    if (tab.diff || tab.binary || !desktop || (remote && !tab.path.endsWith('.py'))) return []
    const cached = testCache.current.get(tab.id)
    if (cached && cached.contents === tab.contents && cached.report === testReport) return cached.tests
    const tests = testsIn(tab.path, tab.contents).map(test => ({ ...test, status: resultFor(testReport, tab.path, test) }))
    testCache.current.set(tab.id, { contents: tab.contents, report: testReport, tests })
    return tests
  }
  // Ctrl+click and right-click can arrive before the pane they're in has become the current one,
  // so they run on the next tick, against what is current then.
  const later = useRef({ editorMenu, goToDefinition })
  later.current = { editorMenu, goToDefinition }
  function paneProps(tab: Tab, pane: string) {
    // Only one pane can keep a tab's editor state between visits: the first pane showing it.
    const primary = panes.find(item => tabOf(item) === tab.id) === pane
    return {
      path: tab.path, text: tab.contents, memory: primary ? tab.memory : undefined, diff: tab.diff, initialLine: tab.line,
      options: focusMode ? { ...optionsFor(tab), lineNumbers: false, highlightLine: true } : optionsFor(tab), diagnostics,
      handle: (handle: EditorHandle | null) => paneHandle(pane, handle),
      onFocus: () => focusPane(pane),
      onViewport: (next: { top: number; height: number; lines: number; topLine: number }) => {
        viewports.set(pane, next)
      },
      onCursor: (next: Cursor) => { if (focusedRef.current === pane) setCursor(next) },
      onBlur: () => { if (settings.autoSave === 'blur') void store(latest.current.tabs.find(item => item.id === tab.id)).catch(notify) },
      onEdit: (contents: string) => edited(tab, contents),
      base: !tab.diff && !remote ? heads[tab.path] ?? null : null,
      check: desktop && !remote && !tab.diff && language(tab.path) === 'Python' ? (text: string) => editorSupport.checkPython(workspace.root, text, tab.path, settings.lintWithRuff) : undefined,
      onIssues: (issues: LiveIssue[]) => {
        if (focusedRef.current !== pane) return
        const path = tab.path
        setLive(previous => previous && previous.path === path && JSON.stringify(previous.issues) === JSON.stringify(issues) ? previous : { path, issues })
      },
      onContextMenu: (event: ReactMouseEvent) => {
        if (focusedRef.current === pane) { editorMenu(event); return }
        focusPane(pane)
        const { clientX, clientY } = event
        setTimeout(() => later.current.editorMenu({ clientX, clientY } as ReactMouseEvent))
      },
      onDefinition: () => { focusPane(pane); setTimeout(() => { void later.current.goToDefinition() }) },
      suggest: settings.aiComplete && !tab.diff ? suggestInline : undefined,
      breakpoints: breakpoints[tab.path] ?? [],
      onBreakpoints: (lines: number[]) => changeBreakpoints(tab.path, lines),
      breakpointKinds: Object.fromEntries((breakpoints[tab.path] ?? []).flatMap((line): [number, 'condition' | 'log'][] => { const option = breakpointOptions[tab.path + ':' + line]; return option?.log ? [[line, 'log']] : option?.condition ? [[line, 'condition']] : [] })),
      onBreakpointMenu: (line: number, event: MouseEvent) => breakpointMenu(tab.path, line, event),
      onChangeMarker: (line: number, event: MouseEvent) => changeMarkerMenu(tab, pane, line, event),
      coverage: testReport?.coverage?.[tab.path] ?? null,
      debugLine: debug?.state === 'paused' && debug.stop && debug.stop.frameFile === tab.path ? debug.stop.frameLine : null,
      blame: blame && blame.path === tab.path ? blame.lines : null,
      tests: testsFor(tab),
      onRunTest: (id: string) => { void runTests(id, tab.path.endsWith('.java') ? 'java' : 'python') },
      server: serverOf(tab),
      serverUri: toUri(workspace.root, tab.path),
      blameMode: blameColumn ? 'all' as const : settings.inlineBlame ? 'line' as const : 'off' as const,
    }
  }
  const editorProps = active && !active.binary ? paneProps(active, focused) : null
  function previewFor(kind: DocKind, tab: Tab, pane: string, split = false) {
    if (kind === 'tex') return <TexPreview text={tab.contents} result={texResults[tab.path] ?? null} compiling={texBusy.includes(tab.path)}
      onJump={line => { focusPane(pane); requestAnimationFrame(() => handles.current[pane]?.jump(line)) }} />
    if (kind === 'svg') return <SvgView text={tab.contents} />
    if (split) return <FollowingPreview viewports={viewports} pane={pane} text={tab.contents} kind={kind} onLink={openLink}
      onJumpLine={line => { focusPane(pane); requestAnimationFrame(() => handles.current[pane]?.jump(line)) }} />
    return <Preview text={tab.contents} kind={kind} onLink={openLink} />
  }
  function paneContent(tab: Tab, pane: string) {
    if (tab.binary === 'pdf') return <PdfView data={binaries[tab.path] ?? null} label={fileName(tab.path)} />
    if (tab.binary === 'image') return <ImageView data={binaries[tab.path] ?? null} path={tab.path} />
    const props = paneProps(tab, pane)
    const kind = tab.diff ? null : docKind(tab.path)
    const view = kind ? tab.view ?? defaultDocView(kind) : 'edit'
    if (!kind || view === 'edit') return <Editor {...props} />
    if (kind === 'notebook') return <Notebook key={tab.id + pane} text={tab.contents} path={tab.path} rootPath={workspace.root} canRun={desktop && !remote}
      why={!desktop ? 'Running cells works in the Still desktop app.' : 'Running cells works for local projects for now.'} onChange={text => edited(tab, text)} />
    return <div className={'doc-split' + (view === 'preview' ? ' preview-only' : '')}>
      {view === 'split' && <div className="doc-pane"><Editor {...props} /></div>}
      <div className="doc-pane doc-pane-preview">{previewFor(kind, tab, pane, view === 'split')}</div>
    </div>
  }
  function toggleMinimap() { update({ minimap: !settings.minimap }) }
  function renderPane(pane: string) {
    const tab = tabs.find(item => item.id === tabOf(pane))
    const many = panes.length > 1
    // The map sits beside a plain code editor (not previews, PDFs or notebooks).
    const mapped = Boolean(settings.minimap && tab && !tab.binary && (tab.diff || !docKind(tab.path) || (tab.view ?? defaultDocView(docKind(tab.path)!)) === 'edit'))
    return <div key={pane} data-pane={pane} className={'pane' + (pane === focused ? ' is-current' : '') + (many ? ' has-head' : '')} onMouseDown={() => focusPane(pane)}>
      {many && <div className="pane-head">
        <span className="pane-name" title={tab?.path}>{tab ? fileName(tab.path) + (tab.diff ? ' · diff' : '') : 'Empty pane'}{tab && dirty(tab) && <i className="split-dot" aria-label="unsaved" />}</span>
        <IconButton glyph={X} label="Close pane" onClick={event => { event.stopPropagation(); closePane(pane) }} />
      </div>}
      <div className={'pane-body' + (mapped ? ' with-map' : '')}>{mapped && tab && <div className="pane-map">
        <Minimap path={tab.path} text={tab.diff?.after ?? tab.contents} viewports={viewports} pane={pane} onScroll={fraction => handles.current[pane]?.scrollTo(fraction)} />
        <button className="pane-map-close" onClick={event => { event.stopPropagation(); update({ minimap: false }) }} title={'Hide the minimap (' + mod + '+Shift+Y)'} aria-label="Hide the minimap"><Icon glyph={X} size={11} /></button>
      </div>}{tab ? paneContent(tab, pane) : <div className="pane-empty">
        <p>Drag a tab here, or choose a file.</p>
        <div className="pane-empty-list">{tabs.filter(item => !item.diff).slice(0, 8).map(item => <button key={item.id} onClick={() => placeTab(item.id, pane, 'center')}>{fileName(item.path)}<span>{parentPath(item.path)}</span></button>)}</div>
        <button className="text-btn" onClick={() => openPalette('')}>Find a file… <kbd>{mod}+P</kbd></button>
      </div>}</div>
    </div>
  }
  // On narrow windows the graph island steps aside on its own; the setting is kept for when there is room again.
  const showRight = rightOpen && frame.width >= 900
  const showChat = showRight && rightView === 'chat'
  const showGraph = showRight && rightView === 'canvas'
  // The grid always has the same tracks (sidebar, editor, canvas, chat × editor, drawer); a hidden island's track
  // is 0px. Keeping the track count fixed lets the browser animate the widths, so islands slide in and out.
  const gap = frame.width <= 720 ? 12 : 20
  const rightTrack = Math.min(rightWidth, Math.max(260, frame.width * 0.4))
  const sideTrack = sidebar && (!maximized || maximized === 'side') ? workspaceWidth + gap : 0
  const columns = maximized === 'side' ? 'minmax(0, 1fr) 0px 0px 0px'
    : [sideTrack + 'px', 'minmax(0, 1fr)', (showRight && !maximized ? rightTrack + gap : 0) + 'px', '0px'].join(' ')
  const rows = maximized === 'terminal' ? '0px minmax(0, 1fr)' : 'minmax(0, 1fr) ' + (drawerOpen && !maximized ? actualDrawerHeight + gap : 0) + 'px'
  const sideMounted = usePresence(Boolean(sidebar))
  const rightMounted = usePresence(showRight)
  const shownSide: Side = sidebar ?? lastSide
  const drawerMounted = usePresence(drawerOpen)
  const idleShown = usePresence(idle, 520)
  const marks = active ? edits[active.path] ?? [] : []
  // Re-measured when the order changes too (a restored or dragged tab moves the active one).
  const tabSlider = useSlider(selected + '|' + tabs.map(tab => tab.id).join('|') + sidebar + graphOpen + focusMode)
  const drawerSlider = useSlider(drawer + drawerOpen + sidebar)
  const projectEntries = journalEntries.filter(entry => entry.root === workspace.root).slice(-5).reverse()
  const codeOf = (path: string, text: string) => highlightToHtml(text.split('\n').slice(0, 34).join('\n'), path.split('.').at(-1) ?? '')
  const excerpt = (text: string, count: number) => <pre>{text.split('\n').slice(0, count).join('\n')}</pre>
  const cards: OverviewCard[] = [
    // Every open file is a window, the one you're in first and larger.
    ...[...tabs].sort((a, b) => Number(b.id === selected) - Number(a.id === selected)).slice(0, 9).map(tab => ({
      key: 'tab:' + tab.id, kind: 'file' as const, title: fileName(tab.path) + (tab.diff ? ' · diff' : ''), note: tab.id === selected ? 'editing' : dirty(tab) ? 'unsaved' : parentPath(tab.path),
      wide: tab.id === selected, current: tab.id === selected, code: codeOf(tab.path, tab.diff ? tab.diff.after : tab.contents), body: null,
    })),
    ...(!tabs.length ? [{ key: 'editor', title: 'Editor', note: 'no file open', wide: true, current: true, body: <span className="ov-list"><span>Open a file with {mod}+P</span></span> }] : []),
    { key: 'explorer', kind: 'tool', title: 'Files', note: 'fullscreen', fullLabel: 'Open files', full: false, body: <span className="ov-list">{(directories[''] ?? []).slice(0, 7).map(entry => <span key={entry.path}>{entry.name}{entry.directory ? '/' : ''}</span>)}</span> },
    remote
      ? { key: 'remote', kind: 'tool', title: 'Servers', full: false, body: <span className="ov-list"><span>{workspace.hostName}</span><span>{workspace.root}</span></span> }
      : { key: 'git', kind: 'tool', title: 'Git', note: status.branch ?? undefined, full: false, body: <span className="ov-list"><span>{status.changes.length} {status.changes.length === 1 ? 'change' : 'changes'}</span>{status.changes.slice(0, 5).map(change => <span key={change.path}>{change.worktree === '?' ? 'new' : 'changed'} · {fileName(change.path)}</span>)}</span> },
    { key: 'graph', kind: 'tool', title: 'Canvas', full: false, body: <span className="ov-dots" aria-hidden="true"><i /><i /><i /><i /><i /></span> },
    { key: 'terminal', kind: 'tool', title: 'Terminal', hidden: !drawerOpen, body: excerpt(output.map(entry => entry.text).join('\n').split('\n').filter(Boolean).slice(-5).join('\n') || (sessions.length ? sessions.length + (sessions.length === 1 ? ' session open' : ' sessions open') : 'No output yet'), 5) },
    { key: 'journal', kind: 'tool', title: 'Journal', full: false, body: <span className="ov-list">{projectEntries.length ? projectEntries.map(entry => <span key={entry.id}>{clock(entry.time)} {entry.text}</span>) : <span>Nothing noted yet</span>}</span> },
  ]
  const agentHost: Omit<AgentHost, 'approve'> = {
    root: workspace.root,
    remote,
    activeFile: active && !active.diff ? { path: active.path, text: active.contents, selection: editor.current?.selection() || undefined } : undefined,
    listFiles: async () => (await fs.files()).map(entry => entry.path),
    read: async path => latest.current.tabs.find(tab => tab.path === path && !tab.diff)?.contents ?? fs.read(path),
    search: async query => {
      const result = await fs.search(query, { regex: false, caseSensitive: false, wholeWord: false })
      if (!result.matches.length) return 'No matches.'
      return result.matches.slice(0, 200).map(match => `${match.path}:${match.line}: ${match.preview.trim()}`).join('\n') + (result.truncated || result.matches.length > 200 ? '\n… more matches not shown' : '')
    },
    write: async (path, contents) => {
      const open = latest.current.tabs.find(tab => tab.path === path && !tab.diff)
      const exists = open ? true : await fs.read(path).then(() => true, () => false)
      if (!exists) await fs.create(path)
      const previous = open?.saved ?? (exists ? await fs.read(path) : '')
      await fs.save(path, contents, previous)
      const { added, removed } = lineChanges(previous, contents)
      if (record && !workspace.sample) journal.add({ kind: 'edit', project: workspace.name, root: workspace.root, path, text: 'Agent edited ' + fileName(path), detail: '+' + added + ' −' + removed, added, removed })
      setTabs(previous => previous.map(tab => tab.path === path && !tab.diff ? { ...fileTab(path, contents), id: tab.id } : tab))
      void refreshFiles(); void refreshGit()
    },
    run: async command => {
      if (!desktop) return 'Commands run in the Still desktop app.'
      if (remote) return invoke<string>('ssh_command', { id: workspace.remote, root: workspace.root, commandLine: command })
      const result = await invoke<{ code: number | null; stdout: string; stderr: string; timed_out: boolean }>('ai_run_command', { rootPath: workspace.root, commandLine: command, timeoutSecs: 180 })
      return [result.stdout && 'stdout:\n' + result.stdout, result.stderr && 'stderr:\n' + result.stderr, result.timed_out ? 'Stopped after 3 minutes.' : 'exit code ' + result.code].filter(Boolean).join('\n')
    },
    open: (path, line) => jumpTo({ path, line: line ?? 1 }),
  }

  const debugButton = runnable && active && mode === 'Python' && !remote && desktop && <IconButton glyph={Bug} className={'debug-btn' + (debug ? ' is-on' : '')} label={debug ? 'Debugging · Shift+F5 stops' : 'Debug (F5)'} disabled={Boolean(job) && !debug} onClick={() => { if (debug) debugCommand('stop'); else void startDebug() }} />
  const runButton = runnable && active && <button type="button" className="run" title={'Run ' + (remote ? 'on ' + workspace.hostName + ' ' : '') + '(' + mod + '+Enter). Right-click for arguments.'} disabled={Boolean(job) || runningRequest || !jobReady}
    onClick={() => { void run() }} onContextMenu={event => { event.preventDefault(); askArguments() }}>{job?.kind === 'run' ? 'Running…' : 'Run'}</button>

  return <div className={'app bench-app' + (focusMode ? ' is-focus' : '') + (settings.autoHideTopBar ? ' top-autohide' : '') + (idleShown && !idle ? ' is-waking' : '')}>
    <TitleBar onError={notify} autoHide={settings.autoHideTopBar} onClose={desktop ? () => { void getCurrentWindow().close().catch(notify) } : undefined}
      left={focusMode
        ? <span className="focus-path">{workspace.name}{active && active.path.split('/').map((part, index, all) => <span key={index}><i>/</i>{index === all.length - 1 ? <b>{part}</b> : part}</span>)}</span>
        : <>
          <button className={'brand' + (menu?.items === mainMenuItems.current ? ' is-open' : '')} onClick={event => { void openMainMenu(event.currentTarget) }} title="Menu" aria-haspopup="menu"><img src={mark} alt="" /><span className="brand-word">Still</span></button>
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
      right={focusMode
        ? <button className="quiet-link" onClick={() => setFocusMode(false)}>Esc to show everything</button>
        : <>
          <nav className="layout-toggles" aria-label="Show or hide parts of the window">
            <button aria-pressed={Boolean(sidebar)} className={sidebar ? 'is-on' : ''} onClick={() => { if (focusMode) setFocusMode(false); setSidebar(value => value ? null : lastSide) }}
              data-tip={(sidebar ? 'Hide' : 'Show') + ' sidebar · ' + mod + '+B'} aria-label="Sidebar"><LayoutIcon part="left" on={Boolean(sidebar)} />{status.changes.length > 0 && !remote && !sidebar && <i className="toggle-dot" />}</button>
            <button aria-pressed={drawerOpen} className={drawerOpen ? 'is-on' : ''} onClick={() => drawerOpen ? setDrawerOpen(false) : showDrawer('terminal', true)}
              data-tip={(drawerOpen ? 'Hide' : 'Show') + ' terminal and output · ' + mod + '+J'} aria-label="Terminal"><LayoutIcon part="bottom" on={drawerOpen} /></button>
            <button aria-pressed={showRight} className={showRight ? 'is-on' : ''} onClick={() => { if (focusMode) setFocusMode(false); setRightOpen(value => !value) }}
              data-tip={(showRight ? 'Hide' : 'Show') + ' the right bar (canvas, assistant, minimap)'} aria-label="Right bar"><LayoutIcon part="right" on={showRight} /></button>
            <span className="nav-rule" />
            <button onClick={toggleFocus} data-tip={'Focus: only the code · ' + mod + '+.'} aria-label="Focus"><LayoutIcon part="focus" on={false} /></button>
            <button onClick={openOverview} data-tip={'Overview · ' + mod + '+Alt+O'} aria-label="Overview"><LayoutIcon part="overview" on={false} /></button>
          </nav>
          <IconButton glyph={Settings2} label={'Settings (' + mod + '+,)'} onClick={() => onSettings()} />
          {remote ? <span className="chrome-branch"><Icon glyph={Server} size={12} />{workspace.hostName}</span>
            : <button className="chrome-branch" onClick={event => { void branchMenu(event) }} title="Switch branch">{status.branch ?? 'No branch'}</button>}
          {debugButton}
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

    <div className={'bench' + (resizing ? ' is-resizing' : '') + (maximized ? ' max-' + maximized : '') + (focusMode && focusOutput ? ' with-output' : '') + (maximized === 'editor' || (!sidebar && !showGraph && !drawerOpen && !showChat) ? ' solo' : '')} style={{ gridTemplateColumns: focusMode ? undefined : columns, gridTemplateRows: focusMode ? undefined : rows }}>
      <div className={'slot slot-side' + (sidebar ? ' is-open' : '')} aria-hidden={!sidebar || undefined}>
      {sideMounted && <aside className="island side tall" style={{ width: maximized === 'side' ? undefined : workspaceWidth }} aria-label={sideItems.find(item => item.key === shownSide)?.label + ' island'} inert={!sidebar || undefined}>
        <nav className="side-views" role="tablist" aria-label="Sidebar views">
          {sideItems.map(item => <button key={item.key} type="button" role="tab" aria-selected={shownSide === item.key} className={shownSide === item.key ? 'is-active' : ''}
            onClick={() => showSide(item.key)} data-tip={item.label + ' · ' + mod + '+' + item.keys} aria-label={item.label}>
            <Icon glyph={item.glyph} size={14} /><span>{item.label}</span>{item.key === 'git' && status.changes.length > 0 && <span className="nav-count">{Math.min(status.changes.length, 99)}</span>}
          </button>)}
          <span className="flex-1" />
          <IconButton glyph={X} label={'Hide the sidebar (' + mod + '+B)'} onClick={() => setSidebar(null)} className="side-close" />
        </nav>
        <div className="side-body" key={'side-' + shownSide}>
        {shownSide === 'explorer' && <Explorer workspace={workspace} directories={shownDirectories} expanded={expanded} active={active?.path} coverage={coveragePercents} changes={status} symbols={symbols}
          onOpen={path => { void openFile(path) }} onExpand={toggleFolder} onNew={() => newFile()} onNewFolder={() => newFolder()} onWorkspace={chooseFolder}
          onRefresh={() => { void refreshFiles(); reloadFromDisk() }} onJump={line => editor.current?.jump(line)} onContext={explorerMenu} onKey={explorerKey}
          onMove={(entry, folder) => { void moveEntry(entry, (folder ? folder + '/' : '') + entry.name) }} />}
        {shownSide === 'search' && <SearchPanel search={fs.search} remote={remote} focusKey={searchFocus} seed={searchSeed} onOpen={(path, line, column, length) => jumpTo({ path, line, column, length })} />}
        {shownSide === 'git' && <SourceControl status={status} busy={Boolean(job) || gitBusy} error={gitError} commit={commit} log={log} onCommitText={setCommit}
          onDiff={(change, index) => { void openDiff(change, index) }} onStage={(change, index) => { void updateStage(change, index) }} onAction={gitAction}
          onStageAll={unstage => { void stageAll(unstage) }} onDiscard={discard} onBranch={event => { void branchMenu(event) }}
          onInit={() => { void api.gitInit(workspace.root).then(() => refreshGit()).catch(notify) }} onRefresh={() => { void refreshGit(); void refreshLog() }} onGraph={() => setFullView('graph')} />}
        {shownSide === 'packages' && <PackagesPanel key={workspace.root} state={packageState} busy={Boolean(job)} onOpen={path => { void openFile(path) }}
          onSearch={api.search} onAction={packageAction} onRefresh={() => { void refreshPackages() }} />}
        {shownSide === 'remote' && <RemotePanel overview={servers} onRefresh={() => { void refreshServers() }} {...remoteActions}
          hostId={workspace.remote ?? null} onOpenUrl={openLink} notify={notify}
          onMenu={(event, items) => setMenu({ x: event.clientX, y: event.clientY, items })} />}
        </div>
        <SplitGrip vertical value={workspaceWidth} min={180} max={sideMax} change={setSideWidth} onActive={setResizing} />
      </aside>}
      </div>

      <main className="island main">
        <div className="tab-strip" onDoubleClick={event => { if (event.target === event.currentTarget || (event.target as Element).classList.contains('tab-scroll')) toggleMaximize('editor') }}>
          <div className="tab-scroll" role="tablist" aria-label="Open files" ref={tabSlider.ref}>
            {tabs.map((tab, index) => <div key={tab.id} className={'tab' + (tab.id === selected ? ' is-active' : '') + (tabDrag?.tab === tab.id ? ' is-dragging' : '') + (shownTabs.includes(tab) && tab.id !== selected ? ' is-shown' : '')} data-slide={tab.id === selected ? '' : undefined}
              onPointerDown={event => tabPointerDown(event, tab)}
              onAuxClick={event => { if (event.button === 1) closeTab(tab) }}
              onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, items: [
                { label: 'Close', icon: X, shortcut: mod + '+W', action: () => closeTab(tab) },
                { label: 'Close others', action: () => { const others = tabs.filter(item => item.id !== tab.id); if (others.some(dirty)) askDiscard('Close other tabs?', 'Some have unsaved changes.', () => closeTabs(others)); else closeTabs(others) } },
                { label: 'Close saved tabs', action: () => closeTabs(tabs.filter(item => !dirty(item))) },
                'separator',
                { label: 'Open to the side', icon: Columns2, shortcut: tab.id === selected ? mod + '+\\' : undefined, action: () => splitRight(tab) },
                { label: 'Open below', icon: Rows2, action: () => splitRight(tab, 'bottom') },
                ...(!remote && desktop && !tab.diff ? [{ label: 'History of this file…', action: () => openHistory(tab.path) }] : []),
                { label: 'Copy relative path', icon: Copy, action: () => copyText(tab.path) },
                ...(desktop && !remote ? [{ label: 'Reveal in file manager', icon: FolderSearch, action: () => { void home.reveal(absolute(parentPath(tab.path))).catch(notify) } }] : []),
              ] }) }}>
              <button role="tab" type="button" id={'file-tab-' + index} aria-controls="editor-panel" aria-selected={tab.id === selected} className="tab-select"
                title={tab.path} onClick={() => { if (!suppressTabClick.current) activate(tab.id) }}
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
            {!active.diff && conflictCount(active.contents) > 0 && <button className="text-btn merge-open" onClick={() => { setMergeFor(active.id); setFullView('merge') }} title="Resolve the conflicts side by side: yours, the result, and the incoming version">Merge editor</button>}
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
          {tabDrag && <div className="tab-drag-layer" aria-hidden="true">
            {tabDrag.target?.kind === 'pane' && <div className="drop-preview" style={{ left: tabDrag.target.box.left, top: tabDrag.target.box.top, width: tabDrag.target.box.width, height: tabDrag.target.box.height }}>
              <i style={zoneBox(tabDrag.target.zone)} />
            </div>}
            {tabDrag.target?.kind === 'strip' && <div className="drop-caret" style={{ left: tabDrag.target.left - 1, top: tabDrag.target.top, height: tabDrag.target.height }} />}
            <div className="tab-ghost" style={{ transform: `translate(${tabDrag.x + 14}px, ${tabDrag.y + 12}px)` }}>{fileName(tabs.find(tab => tab.id === tabDrag.tab)?.path ?? '')}</div>
          </div>}
          {active || panes.length > 1 ? <PaneGrid layout={layout} renderPane={renderPane} onLayout={setLayout} onResizing={setResizing} /> : <div className="empty-editor" data-pane={focused}>
            <div className="empty-inner">
              <p className="empty-title">{workspace.name}</p>
              <div className="empty-keys">
                <button onClick={() => openPalette('')}><span>Find a file</span><kbd>{mod}+P</kbd></button>
                <button onClick={() => openPalette('>')}><span>Run a command</span><kbd>{mod}+Shift+K</kbd></button>
                <button onClick={() => newFile()}><span>New file</span></button>
                <button onClick={() => showSide('search')}><span>Find in files</span><kbd>{mod}+Shift+F</kbd></button>
                <button onClick={() => showDrawer('terminal', true)}><span>Open terminal</span><kbd>{mod}+J</kbd></button>
                <button onClick={openOverview}><span>Overview</span><kbd>{mod}+Alt+O</kbd></button>
                <button onClick={goHome}><span>Back to Home</span><kbd>{mod}+Shift+H</kbd></button>
              </div>
            </div>
          </div>}
        </section>
      </main>

      <div className={'slot slot-right' + (showRight && !maximized ? ' is-open' : '')} aria-hidden={!showRight || undefined}>
      {rightMounted && <aside className="island right-island" style={{ width: rightTrack }} aria-label="Right bar" inert={!showRight || undefined}>
        <SplitGrip vertical value={-rightTrack} min={-Math.min(640, frame.width * 0.5)} max={-260} change={value => setRightWidth(Math.round(-value))} onActive={setResizing} />
        <nav className="right-views" role="tablist" aria-label="Right bar">
          {([['canvas', 'Canvas', Network], ['chat', 'Assistant', Sparkles]] as const).map(([key, label, glyph]) =>
            <button key={key} role="tab" aria-selected={rightView === key} className={rightView === key ? 'is-active' : ''} onClick={() => toggleRight(key, true)}><Icon glyph={glyph} size={13} />{label}</button>)}
          <span className="flex-1" />
          <IconButton glyph={X} label="Hide the right bar" onClick={() => setRightOpen(false)} />
        </nav>
        <div className="right-body">
          {rightView === 'canvas' && <MiniCanvas graph={graph} root={workspace.root} active={active && !active.diff ? active.path : undefined} onOpen={path => { void openFile(path) }} onExpand={() => setGraphView(true)} />}
          {(chatEverOpen || rightView === 'chat') && <div className="right-chat" hidden={rightView !== 'chat'}>
            <Chat settings={{ provider: settings.aiProvider, model: settings.aiModel, effort: settings.aiEffort, ollamaUrl: settings.ollamaUrl, ollamaModel: settings.ollamaModel, githubModel: settings.githubModel, autoApproveEdits: settings.aiAutoApprove }}
              host={agentHost} projectKey={(workspace.remote ?? '') + workspace.root} focusKey={chatFocus} onSettings={() => onSettings('ai')} onClose={() => setRightOpen(false)} />
          </div>}
        </div>
      </aside>}
      </div>

      <div className={'slot slot-drawer' + (drawerOpen && (!maximized || maximized === 'terminal') ? ' is-open' : '')} aria-hidden={!drawerOpen || undefined}>
      {(drawerMounted || sessions.length > 0) && <section className="island drawer" style={{ height: maximized === 'terminal' ? undefined : actualDrawerHeight }} aria-label="Terminal island" inert={!drawerOpen || undefined}>
        <SplitGrip value={actualDrawerHeight} min={128} max={drawerMax} change={setDrawerHeight} onActive={setResizing} />
        <div className="drawer-nav">
          <div className="drawer-tabs" role="tablist" aria-label="Console views" ref={drawerSlider.ref}>
            {drawerTabs.map(({ key, label }) => <button key={key} type="button" role="tab" aria-selected={drawer === key} data-slide={drawer === key ? '' : undefined}
              className={'drawer-tab' + (drawer === key ? ' is-active' : '')} onClick={() => showDrawer(key, true)}>
              {label}{key === 'problems' && problems.length > 0 && <span className="nav-count">{Math.min(99, problems.length)}</span>}
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
            theme={theme} fontSize={settings.terminalFontSize} fontFamily={settings.editorFont} cursor={settings.terminalCursor} shell={settings.terminalShell} scrollback={settings.terminalScrollback} copyOnSelect={settings.terminalCopyOnSelect}
            onReady={value => { if (session.id === activeSession || !terminal.current) terminal.current = value }}
            onExit={id => setSessions(previous => previous.map(item => item.id === id ? { ...item, exited: true } : item))} />)}
          {desktop && drawer === 'terminal' && !sessions.length && <div className="console-scroll"><button className="text-btn" onClick={() => remote ? remoteSession() : newSession()}><Icon glyph={Plus} size={13} />New terminal</button></div>}
          {!desktop && drawer === 'terminal' && <div className="console-scroll"><div className="console-banner"><Icon glyph={TerminalSquare} />The local shell is available in the Still desktop app.</div></div>}
          {drawer === 'output' && <Output entries={output} sample={sampleRun}
            onInput={job?.kind === 'run' ? text => { void invoke('job_input', { id: job.id, text }).catch(notify) } : undefined} />}
          {drawer === 'problems' && <Problems items={problems} jump={jumpTo} />}
          {(drawer === 'database' || dbVisited) && <div className="drawer-keep" hidden={drawer !== 'database'}>
            <DatabasePanel root={workspace.root} remote={remote} focus={dbFocus} notify={message => toast(message)}
              files={async () => (await fs.files()).filter(item => !item.directory).map(item => item.path)} readFile={path => fs.read(path)} />
          </div>}
          {drawer === 'profile' && <ProfilePanel data={profile?.data ?? null} path={profile?.path ?? null} running={profiling} canRun={!profileWhy && !job} why={profileWhy}
            onRun={memory => { void startProfile(memory) }} onOpen={(file, line) => { if (/^([A-Za-z]:)?[\\/]/.test(file)) notify('That function is in ' + file + ', outside the project.'); else jumpTo({ path: file, line }) }} />}
          {drawer === 'tests' && <TestsPanel report={testReport} running={testsRunning} canRun={!testsWhy && !job} why={testsWhy} onRun={runTestsFrom} onJump={jumpToTest} coverage={settings.testCoverage} onCoverage={value => update({ testCoverage: value })}
            onRunId={id => { void runTests(id, id.includes('#') || id.endsWith('.java') || !/\.py(::|$)/.test(id) && testLanguage === 'java' ? 'java' : 'python') }}
            watch={testWatch} onWatch={value => { setTestWatch(value); if (value) notify('Watching: the tests run again each time you save.') }} />}
          {drawer === 'debug' && <DebugPanel session={debug} canDebug={!debugWhy && Boolean(active) && !job} why={debugWhy} breakpointCount={Object.values(breakpoints).reduce((sum, lines) => sum + lines.length, 0)}
            watches={watches} onStart={() => { void startDebug() }} onCommand={debugCommand} onFrame={index => debugSend({ op: 'frame', index })}
            onEval={expression => debugSend({ op: 'eval', expression })} onWatches={changeWatches} onJump={(file, line) => jumpTo({ path: file, line })}
            output={<Output entries={output} sample={false} onInput={job?.kind === 'run' ? text => { void invoke('job_input', { id: job.id, text }).catch(notify) } : undefined} />} />}
        </div>
      </section>}
      </div>
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
      {container?.config && <button className={'status-item' + (containerOn ? ' status-strong' : '')} onClick={containerMenu} title={container.note ?? (container.name + ' · ' + container.config)}>
        <span className={'status-dot' + (container.state === 'running' ? '' : ' inactive')} />Dev container{containerOn ? (container.state === 'running' ? ' · in use' : ' · not started') : container.state === 'running' ? ' · running' : ''}
      </button>}
      {job && <button className="status-item" onClick={() => showDrawer('output')}><span className="status-dot busy" />{job.kind === 'run' ? 'Running' : job.kind === 'git' ? 'Git ' + job.action : 'Packages'}…</button>}
      {settings.autoSave !== 'off' && <span className="status-item status-optional" title="Auto save is on">Auto save</span>}
      <div className="flex-1" />
      {active && <><span className="status-item">Ln {cursor.line}, Col {cursor.column}{cursor.selected ? ` (${cursor.selected} selected)` : ''}</span>
        <button className="status-item status-optional" onClick={() => onSettings('editor')} title="Indentation settings">Spaces: {tabSize}</button>
        <span className="status-item status-language">{active.binary === 'pdf' ? 'PDF' : active.binary === 'image' ? 'Image' : mode}</span>
        {activeServerLanguage && activeServer && activeServer !== 'none' && <button className="status-item status-optional" title={typeof activeServer === 'object' ? activeServer.name + ' is running. Click to restart it.' : 'Starting the language server…'}
          onClick={() => restartServer(activeServerLanguage)}><span className={'status-dot' + (activeServer === 'starting' ? ' busy' : '')} />{typeof activeServer === 'object' ? activeServer.name : 'Starting…'}</button>}</>}
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
    {fullView === 'history' && historyFor && <FullView title={'History · ' + fileName(historyFor.path)} project={workspace.name} onClose={() => { setFullView(null); requestAnimationFrame(() => editor.current?.focus()) }}>
      <div className="full-side island side history-side">
        <nav className="side-views" role="tablist" aria-label="History">
          {(['local', 'commits'] as const).map(kind => <button key={kind} role="tab" aria-selected={historyFor.tab === kind} className={historyFor.tab === kind ? 'is-active' : ''} onClick={() => { setHistoryFor({ ...historyFor, tab: kind }); setHistoryPick(null) }}><span style={{ display: 'inline' }}>{kind === 'local' ? 'Saved versions' : 'Commits'}</span></button>)}
        </nav>
        <div className="history-list">
          {historyFor.tab === 'local' && (historyItems.local.length ? historyItems.local.map(item => <button key={item.id} className={'history-row' + (historyPick?.key === 'local:' + item.id ? ' is-active' : '')}
            onClick={() => { void history.read(workspace.root, historyFor.path, item.id).then(text => setHistoryPick({ key: 'local:' + item.id, label: 'Saved ' + new Date(item.time).toLocaleString(), before: text })).catch(notify) }}>
            <b>{relativeTime(item.time)}</b><span>{new Date(item.time).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · {(item.size / 1024).toFixed(1)} KB</span>
          </button>) : <p className="full-empty">No saved versions yet. Still keeps a copy each time you save, for a week.</p>)}
          {historyFor.tab === 'commits' && (historyItems.commits.length ? historyItems.commits.map(commit => <button key={commit.hash} className={'history-row' + (historyPick?.key === commit.hash ? ' is-active' : '')}
            onClick={() => { void history.showAt(workspace.root, commit.hash, commit.path).then(text => setHistoryPick({ key: commit.hash, label: commit.subject + ' · ' + commit.hash.slice(0, 7), before: text })).catch(notify) }}>
            <b>{commit.subject}</b><span>{commit.author} · {relativeTime(commit.time * 1000)} · {commit.hash.slice(0, 7)}{commit.path !== historyFor.path ? ' · was ' + fileName(commit.path) : ''}</span>
          </button>) : <p className="full-empty">{status.branch ? 'This file has no commits yet.' : 'This project is not a Git repository.'}</p>)}
        </div>
      </div>
      <div className="full-main">
        {historyPick ? <>
          <header className="full-main-head"><b>{historyPick.label}</b><span className="muted">left: that version · right: now</span>
            <button className="text-btn primary" onClick={() => restoreVersion(historyFor.path, historyPick.before)}>Restore this version</button></header>
          <div className="full-editor"><Editor key={historyPick.key} path={historyFor.path} text={tabs.find(tab => tab.path === historyFor.path && !tab.diff)?.contents ?? ''}
            diff={{ before: historyPick.before, after: tabs.find(tab => tab.path === historyFor.path && !tab.diff)?.contents ?? '' }} options={{ ...editorOptions, layout: 'split' }} diagnostics={[]} onEdit={() => {}} onCursor={() => {}} handle={() => {}} /></div>
        </> : <p className="full-empty">Choose a version to compare it with the file as it is now.</p>}
      </div>
    </FullView>}
    {fullView === 'pulls' && <FullView title="Pull requests" project={workspace.name} onClose={() => { setFullView(null); requestAnimationFrame(() => editor.current?.focus()) }}>
      <PullRequests rootPath={workspace.root} notify={notify} onLink={openLink} onCheckedOut={() => { void refreshGit(); void refreshFiles() }} />
    </FullView>}
    {fullView === 'files' && <FullView title="Files" project={workspace.name} onClose={() => { setFullView(null); requestAnimationFrame(() => editor.current?.focus()) }}>
      <div className="full-side island side">
        <Explorer workspace={workspace} directories={shownDirectories} expanded={expanded} active={filePreview?.path ?? active?.path} changes={status} symbols={[]}
          onOpen={path => { void fs.read(path).then(text => setFilePreview({ path, text })).catch(notify) }} onExpand={toggleFolder} onNew={() => newFile()} onNewFolder={() => newFolder()} onWorkspace={chooseFolder}
          onRefresh={() => { void refreshFiles(); reloadFromDisk() }} onJump={() => {}} onContext={explorerMenu} onKey={explorerKey}
          onMove={(entry, folder) => { void moveEntry(entry, (folder ? folder + '/' : '') + entry.name) }} />
      </div>
      <div className="full-main">
        {filePreview ? <>
          <header className="full-main-head"><b>{filePreview.path}</b><button className="text-btn primary" onClick={() => { setFullView(null); void openFile(filePreview.path) }}>Open in editor</button></header>
          <div className="full-editor"><Editor key={filePreview.path} path={filePreview.path} text={filePreview.text} readOnly options={{ ...editorOptions, changes: false, errors: false }} diagnostics={[]} onEdit={() => {}} onCursor={() => {}} handle={() => {}} /></div>
        </> : <p className="full-empty">Choose a file to preview it here. Open it in the editor when you want to change it.</p>}
      </div>
    </FullView>}
    {fullView === 'graph' && <FullView title="Commit graph" project={workspace.name} onClose={() => { setFullView(null); requestAnimationFrame(() => editor.current?.focus()) }}>
      <GitGraph rootPath={workspace.root} notify={notify} editorOptions={editorOptions} onOpenFile={path => { setFullView(null); void openFile(path) }} />
    </FullView>}
    {fullView === 'merge' && mergeFor && (() => {
      const tab = tabs.find(item => item.id === mergeFor)
      if (!tab) return null
      return <FullView title={'Merge · ' + fileName(tab.path)} project={workspace.name} onClose={() => { setFullView(null); requestAnimationFrame(() => editor.current?.focus()) }}>
        <MergeEditor rootPath={workspace.root} path={tab.path} text={tab.contents} editorOptions={editorOptions} onChange={text => edited(tab, text)}
          onResolved={() => { void (async () => {
            await store(latest.current.tabs.find(item => item.id === tab.id))
            await api.stage(workspace.root, { path: tab.path, index: 'U', worktree: 'U' }, false)
            await refreshGit()
            notify(fileName(tab.path) + ' is resolved and staged.')
            setFullView(null)
          })().catch(notify) }} />
      </FullView>
    })()}
    {fullView === 'git' && <FullView title="Git" project={workspace.name} onClose={() => { setFullView(null); requestAnimationFrame(() => editor.current?.focus()) }}>
      <div className="full-side island side">
        <SourceControl status={status} busy={Boolean(job) || gitBusy} error={gitError} commit={commit} log={log} onCommitText={setCommit}
          onDiff={(change, index) => { void api.diff(workspace.root, change, index).then(diff => setGitPreview({ path: change.path, diff, staged: index })).catch(notify) }}
          onStage={(change, index) => { void updateStage(change, index) }} onAction={gitAction}
          onStageAll={unstage => { void stageAll(unstage) }} onDiscard={discard} onBranch={event => { void branchMenu(event) }}
          onInit={() => { void api.gitInit(workspace.root).then(() => refreshGit()).catch(notify) }} onRefresh={() => { void refreshGit(); void refreshLog() }} onGraph={() => setFullView('graph')} />
      </div>
      <div className="full-main">
        {gitPreview ? <>
          <header className="full-main-head"><b>{gitPreview.path}</b><span className="muted">{gitPreview.staged ? 'Staged changes' : 'Working tree'}</span>
            <button className="text-btn" onClick={() => { setFullView(null); void openFile(gitPreview.path) }}>Open file</button></header>
          <div className="full-editor"><Editor key={gitPreview.path + gitPreview.staged} path={gitPreview.path} text={gitPreview.diff.after} diff={gitPreview.diff} options={{ ...editorOptions, layout: 'split' }} diagnostics={[]} onEdit={() => {}} onCursor={() => {}} handle={() => {}} /></div>
        </> : <p className="full-empty">{status.changes.length ? 'Choose a change to see what is different.' : 'Nothing has changed since the last commit.'}</p>}
      </div>
    </FullView>}
    {graphView && <CanvasView graph={graph} error={graphError} root={workspace.root} project={workspace.name} active={active && !active.diff ? active.path : undefined} changed={changedPaths}
      onOpen={path => { setGraphView(false); void openFile(path) }} onClose={() => { setGraphView(false); requestAnimationFrame(() => editor.current?.focus()) }} />}
    {idleShown && <Idle leaving={!idle} sources={tabs.filter(tab => !tab.diff).map(tab => ({ path: tab.path, project: workspace.name, text: tab.contents, edited: edits[tab.path]?.at(-1)?.time }))} onWake={wake} />}
    {palette !== null && <Palette commands={commands} files={fileItems} start={palette} onClose={closePalette} symbols={findSymbols} />}
    {dialog && <Dialog dialog={dialog} close={() => setDialog(null)} />}
    {runConfig && <RunConfigDialog file={fileName(runConfig)} args={runArgs[runConfig] ?? ''} env={runEnv[runConfig] ?? ''} dotenv={settings.loadDotEnv} onClose={() => setRunConfig(null)}
      onSave={(args, env, andRun) => {
        const path = runConfig
        setRunArgs(previous => ({ ...previous, [path]: args }))
        setRunEnv(previous => ({ ...previous, [path]: env }))
        setRunConfig(null)
        if (andRun && active?.path === path) void run(false, { args, env })
      }} />}
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

/** True while `open`, and for a moment after it turns false, so an island can slide away before it unmounts. */
function usePresence(open: boolean, ms = 260) {
  const [present, setPresent] = useState(open)
  useEffect(() => {
    if (open) { setPresent(true); return }
    const timer = setTimeout(() => setPresent(false), ms)
    return () => clearTimeout(timer)
  }, [open, ms])
  return open || present
}

/** A fullscreen view over the workspace (Files, Git), like the canvas and the journal. */
type ViewportInfo = { top: number; height: number; lines: number; topLine: number }
type Viewports = { get: (pane: string) => ViewportInfo | null; subscribe: (listener: () => void) => () => void }

/** A side-by-side Markdown preview that follows its editor's scrolling. */
function FollowingPreview({ viewports, pane, ...props }: { viewports: Viewports; pane: string } & Omit<React.ComponentProps<typeof Preview>, 'syncLine'>) {
  const line = useSyncExternalStore(viewports.subscribe, () => viewports.get(pane)?.topLine ?? 1)
  return <Preview {...props} syncLine={line} />
}

function FullView({ title, project, onClose, children }: { title: string; project: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('.modal-backdrop, .menu, .cm-panels')) return
      event.preventDefault(); onClose()
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [onClose])
  return <div className="graph-view full-view" role="dialog" aria-label={title}>
    <header className="graph-head">
      <span className="graph-crumbs"><b>Still</b><i>/</i>{project}<i>/</i>{title}</span>
      <button className="quiet-link" onClick={onClose}>Esc to return</button>
    </header>
    <div className="full-body">{children}</div>
  </div>
}
