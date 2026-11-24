import { createContext, useContext } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { type Theme, applySyntax, applyTheme, findTheme, presets } from './themes'
import { desktop } from './bridge'

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
  aiProvider: 'anthropic' | 'ollama'
  aiModel: string
  aiEffort: 'low' | 'medium' | 'high'
  ollamaUrl: string
  ollamaModel: string
  aiAutoApprove: boolean
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
  bounce: boolean
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
  autocomplete: false,
  autoUpdate: true,
  aiProvider: 'anthropic',
  aiModel: 'claude-opus-5-5',
  aiEffort: 'medium',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: '',
  aiAutoApprove: false,
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
  bounce: true,
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
  if (!Array.isArray(merged.customThemes)) merged.customThemes = []
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
  classes.toggle('smooth-caret', settings.smoothCaret)
  classes.toggle('cursor-block', settings.cursorStyle === 'block')
  classes.toggle('cursor-underline', settings.cursorStyle === 'underline')
  classes.toggle('reduce-motion', settings.reduceMotion)
  classes.toggle('no-bounce', !settings.bounce)
  watchKeyRepeat()
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
