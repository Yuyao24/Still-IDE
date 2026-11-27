import { createContext, useContext } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { type Theme, applySyntax, applyTheme, findTheme, presets , resolve as resolveTheme } from './themes'
import { desktop } from './bridge'
import { type Snippet, setCustomSnippets } from './completion'
import { setSpellWords } from './spell'

export interface Settings {
  theme: string
  followSystem: boolean
  lightTheme: string
  darkTheme: string
  customThemes: Theme[]
  uiFontSize: number
  editorFont: string
  editorFontSize: number
  editorLineHeight: number
  ligatures: boolean
  tabSize: 'auto' | 2 | 4 | 8
  wordWrap: boolean
  lineNumbers: boolean
  highlightLine: boolean
  autoSave: 'off' | 'delay' | 'blur'
  diffLayout: 'inline' | 'split'
  terminalShell: string
  terminalFontSize: number
  terminalCursor: 'block' | 'bar' | 'underline'
  newProjectTemplate: string
  newProjectGit: boolean
  confirmDelete: boolean
  idleMinutes: number
  smoothCaret: boolean
  journal: boolean
  autocomplete: boolean
  autoUpdate: boolean
  aiProvider: 'anthropic' | 'ollama' | 'github'
  aiModel: string
  aiEffort: 'low' | 'medium' | 'high'
  ollamaUrl: string
  ollamaModel: string
  aiAutoApprove: boolean
  githubModel: string
  aiComplete: boolean
  aiCompleteProvider: 'anthropic' | 'ollama' | 'github'
  aiCompleteModel: string
  syntaxTheme: string
  cursorStyle: 'line' | 'block' | 'underline'
  cursorBlink: boolean
  occurrences: boolean
  whitespace: 'none' | 'trailing' | 'all'
  indentGuides: boolean
  closeBrackets: boolean
  scrollPastEnd: boolean
  folding: boolean
  errors: boolean
  gitGutter: boolean
  trimOnSave: boolean
  finalNewline: boolean
  reduceMotion: boolean
  autoHideTopBar: boolean
  settingsVersion: number
  newProjectReadme: boolean
  newProjectRequirements: boolean
  openOnStart: 'last' | 'readme'
  formatOnSave: boolean
  /** A small map of the file beside each editor (its own strip, not the right bar). */
  minimap: boolean
  /** Formatting (Settings → Formatting); a project's own config file wins. */
  javaFormatStyle: 'google' | 'aosp'
  pythonLineLength: number
  pythonIndent: number
  pythonQuotes: 'double' | 'single' | 'preserve'
  webIndent: number
  webTabs: boolean
  webSemicolons: boolean
  webQuotes: 'double' | 'single'
  webPrintWidth: number
  webTrailingCommas: 'all' | 'es5' | 'none'
  cStyle: 'LLVM' | 'Google' | 'Chromium' | 'Mozilla' | 'WebKit' | 'Microsoft' | 'GNU'
  cIndent: number
  rustIndent: number
  inlineBlame: boolean
  /** Fill in __init__ / the constructor when a new class is started. */
  fillConstructors: boolean
  docTemplates: boolean
  autoFString: boolean
  continueComments: boolean
  hotExit: boolean
  shellIntegration: boolean
  spellCheck: boolean
  /** When a file moves or is renamed, offer to update the imports that point at it. */
  updateImports: boolean
  spellWords: string[]
  /** Keep the header of the function or class you're in pinned at the top of the editor. */
  stickyScroll: boolean
  /** Load the project's .env file into runs, debugging and tests. */
  loadDotEnv: boolean
  /** When the debugger stops for an exception. */
  pauseOnExceptions: 'uncaught' | 'all' | 'none'
  /** Measure which lines the tests run (pytest-cov) and mark them in the editor. */
  testCoverage: boolean
  /** Show the language server's hints (parameter names, inferred types) in the code. */
  inlayHints: boolean
  /** Shortcut preset and your own keys (action id → key, '' to turn a preset key off). */
  keymap: 'still' | 'vscode' | 'jetbrains'
  keybindings: Record<string, string>
  /** Experimental: a picture behind the window (a data URL), how faded it is, and a tint over it. */
  backgroundImage: string
  backgroundFade: number
  backgroundTint: string
  backgroundTintStrength: number
  /** Experimental: how surfaces are drawn, and how much of the background shows through them. */
  surfaceStyle: 'paper' | 'frosted' | 'liquid'
  translucency: number
  lintWithRuff: boolean
  /** Start Pyright, jdtls, typescript-language-server and others when they're installed. */
  languageServers: boolean
  customSnippets: Snippet[]
  openLastProject: boolean
  terminalScrollback: number
  terminalCopyOnSelect: boolean
}

export const defaults: Settings = {
  theme: 'still-light',
  followSystem: false,
  lightTheme: 'still-light',
  darkTheme: 'still-dark',
  customThemes: [],
  uiFontSize: 13,
  editorFont: '"IBM Plex Mono"',
  editorFontSize: 14,
  editorLineHeight: 1.6,
  ligatures: false,
  tabSize: 'auto',
  wordWrap: true,
  lineNumbers: true,
  highlightLine: true,
  autoSave: 'off',
  diffLayout: 'inline',
  terminalShell: '',
  terminalFontSize: 14,
  terminalCursor: 'block',
  newProjectTemplate: 'python',
  newProjectGit: true,
  confirmDelete: true,
  idleMinutes: 5,
  smoothCaret: true,
  journal: true,
  autocomplete: true,
  autoUpdate: true,
  aiProvider: 'anthropic',
  aiModel: 'claude-opus-5-5',
  aiEffort: 'medium',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: '',
  aiAutoApprove: false,
  githubModel: 'openai/gpt-4.1',
  aiComplete: false,
  aiCompleteProvider: 'anthropic',
  aiCompleteModel: 'claude-opus-5-5',
  syntaxTheme: '',
  cursorStyle: 'line',
  cursorBlink: true,
  occurrences: true,
  whitespace: 'none',
  indentGuides: true,
  closeBrackets: true,
  scrollPastEnd: false,
  folding: true,
  errors: true,
  gitGutter: true,
  trimOnSave: false,
  finalNewline: false,
  reduceMotion: false,
  autoHideTopBar: false,
  settingsVersion: 2,
  newProjectReadme: true,
  newProjectRequirements: true,
  openOnStart: 'last',
  formatOnSave: false,
  minimap: false,
  javaFormatStyle: 'google',
  pythonLineLength: 88,
  pythonIndent: 4,
  pythonQuotes: 'double',
  webIndent: 2,
  webTabs: false,
  webSemicolons: true,
  webQuotes: 'double',
  webPrintWidth: 80,
  webTrailingCommas: 'all',
  cStyle: 'LLVM',
  cIndent: 2,
  rustIndent: 4,
  inlineBlame: true,
  fillConstructors: true,
  docTemplates: true,
  autoFString: true,
  continueComments: false,
  hotExit: true,
  shellIntegration: true,
  spellCheck: true,
  updateImports: true,
  spellWords: [],
  stickyScroll: true,
  loadDotEnv: true,
  pauseOnExceptions: 'uncaught',
  testCoverage: false,
  inlayHints: true,
  keymap: 'still',
  keybindings: {},
  backgroundImage: '',
  backgroundFade: 55,
  backgroundTint: '#7c6f64',
  backgroundTintStrength: 0,
  surfaceStyle: 'paper',
  translucency: 0,
  lintWithRuff: true,
  languageServers: true,
  customSnippets: [],
  openLastProject: false,
  terminalScrollback: 5000,
  terminalCopyOnSelect: false,
}

export const editorFonts = [
  { label: 'IBM Plex Mono', value: '"IBM Plex Mono"' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono Variable"' },
  { label: 'System monospace', value: 'ui-monospace, SFMono-Regular, Menlo' },
  { label: 'Cascadia Code', value: '"Cascadia Code", "Cascadia Mono"' },
  { label: 'Fira Code', value: '"Fira Code"' },
  { label: 'Consolas', value: 'Consolas' },
  { label: 'Menlo', value: 'Menlo' },
]

const cacheKey = 'still.settings'

function merge(value: unknown): Settings {
  const stored = value && typeof value === 'object' ? value as Partial<Settings> : {}
  const merged = { ...defaults, ...stored }
  // Version 2: word suggestions became smart and on by default; AI completion is its own setting.
  if (!stored.settingsVersion || stored.settingsVersion < 2) { merged.autocomplete = true; merged.settingsVersion = 2 }
  if (!Array.isArray(merged.customThemes)) merged.customThemes = []
  if (!Array.isArray(merged.spellWords)) merged.spellWords = []
  return merged
}

/** Synchronous first read from the web view cache, so the first paint uses the right theme. */
export function cachedSettings(): Settings {
  try {
    const legacy = localStorage.getItem('still.theme')
    const cached = localStorage.getItem(cacheKey)
    if (cached) return merge(JSON.parse(cached))
    if (legacy === 'light') return { ...defaults, theme: 'still-light' }
  } catch { /* storage unavailable */ }
  return defaults
}

export async function loadSettings(): Promise<Settings> {
  if (!desktop) return cachedSettings()
  try {
    const stored = await invoke<Record<string, unknown>>('settings_get')
    if (stored && Object.keys(stored).length) return merge(stored)
  } catch { /* fall back to the cache */ }
  return cachedSettings()
}

let timer: ReturnType<typeof setTimeout> | undefined
export function saveSettings(settings: Settings) {
  try { localStorage.setItem(cacheKey, JSON.stringify(settings)) } catch { /* storage unavailable */ }
  if (!desktop) return
  clearTimeout(timer)
  timer = setTimeout(() => { void invoke('settings_set', { settings }).catch(() => {}) }, 250)
}

export function activeTheme(settings: Settings, systemDark: boolean): Theme {
  const id = settings.followSystem ? (systemDark ? settings.darkTheme : settings.lightTheme) : settings.theme
  return findTheme(id, settings.customThemes)
}

/** The theme whose code colours are used, when it isn't the editor theme itself. Only themes of the same kind (light or dark) apply. */
export function syntaxThemeFor(settings: Settings, theme: Theme): Theme | null {
  if (!settings.syntaxTheme || settings.syntaxTheme === theme.id) return null
  const found = [...presets, ...settings.customThemes].find(item => item.id === settings.syntaxTheme)
  return found && found.kind === theme.kind ? found : null
}

export function applySettings(settings: Settings, systemDark: boolean) {
  const theme = activeTheme(settings, systemDark)
  applyTheme(theme)
  const syntax = syntaxThemeFor(settings, theme)
  if (syntax) applySyntax(syntax)
  const root = document.documentElement.style
  root.setProperty('--ui-font-size', settings.uiFontSize + 'px')
  root.setProperty('--font-mono', settings.editorFont + ', ui-monospace, Consolas, monospace')
  root.setProperty('--editor-font-size', settings.editorFontSize + 'px')
  root.setProperty('--editor-line-height', String(settings.editorLineHeight))
  root.setProperty('--ligatures', settings.ligatures ? 'contextual common-ligatures' : 'none')
  root.setProperty('--font-features', settings.ligatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0')
  const classes = document.documentElement.classList
  // Experimental surfaces: a background picture, glass, and see-through panels.
  const backdrop = Boolean(settings.backgroundImage) || settings.translucency > 0 || settings.surfaceStyle !== 'paper'
  classes.toggle('has-backdrop', backdrop)
  classes.toggle('surface-frosted', settings.surfaceStyle === 'frosted')
  classes.toggle('surface-liquid', settings.surfaceStyle === 'liquid')
  const resolved = resolveTheme(theme).colors
  classes.toggle('theme-dark', theme.kind === 'dark')
  const solid = resolved.editor
  root.setProperty('--editor-solid', solid)
  root.setProperty('--backdrop-image', settings.backgroundImage ? `url("${settings.backgroundImage}")` : 'none')
  root.setProperty('--backdrop-fade', String(Math.max(0, Math.min(100, settings.backgroundFade)) / 100))
  root.setProperty('--backdrop-tint', settings.backgroundTint || '#000000')
  root.setProperty('--backdrop-tint-strength', String(Math.max(0, Math.min(100, settings.backgroundTintStrength)) / 100))
  if (backdrop) {
    // Panels let the background through: glass needs a little even at no translucency.
    const glass = settings.surfaceStyle === 'paper' ? 0 : 18
    const alpha = Math.max(18, 100 - Math.max(settings.translucency, glass))
    for (const key of ['editor', 'panel', 'rail', 'bar', 'drawer'] as const) root.setProperty('--' + key, `color-mix(in srgb, ${resolved[key] ?? solid} ${alpha}%, transparent)`)
  }
  classes.toggle('smooth-caret', settings.smoothCaret)
  classes.toggle('cursor-block', settings.cursorStyle === 'block')
  classes.toggle('cursor-underline', settings.cursorStyle === 'underline')
  classes.toggle('reduce-motion', settings.reduceMotion)
  watchKeyRepeat()
  setCustomSnippets(settings.customSnippets)
  setSpellWords(Array.isArray(settings.spellWords) ? settings.spellWords : [])
  return theme
}

export interface SettingsContextValue {
  settings: Settings
  theme: Theme
  update: (change: Partial<Settings>) => void
}

export const SettingsContext = createContext<SettingsContextValue>({ settings: defaults, theme: findTheme('still-dark', []), update: () => {} })
export const useSettings = () => useContext(SettingsContext)

let watching = false
/** Marks the page while a key auto-repeats, so the gliding caret can keep up. */
function watchKeyRepeat() {
  if (watching) return
  watching = true
  const root = document.documentElement
  addEventListener('keydown', event => { if (event.repeat) root.classList.add('caret-repeat') }, true)
  addEventListener('keyup', () => requestAnimationFrame(() => root.classList.remove('caret-repeat')), true)
  addEventListener('blur', () => root.classList.remove('caret-repeat'))
}
