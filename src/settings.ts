import { createContext, useContext } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { type Theme, applyTheme, findTheme } from './themes'
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

export function applySettings(settings: Settings, systemDark: boolean) {
  const theme = activeTheme(settings, systemDark)
  applyTheme(theme)
  const root = document.documentElement.style
  root.setProperty('--ui-font-size', settings.uiFontSize + 'px')
  root.setProperty('--font-mono', settings.editorFont + ', ui-monospace, Consolas, monospace')
  root.setProperty('--editor-font-size', settings.editorFontSize + 'px')
  root.setProperty('--editor-line-height', String(settings.editorLineHeight))
  root.setProperty('--ligatures', settings.ligatures ? 'contextual common-ligatures' : 'none')
  root.setProperty('--font-features', settings.ligatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0')
  document.documentElement.classList.toggle('smooth-caret', settings.smoothCaret)
  return theme
}

export interface SettingsContextValue {
  settings: Settings
  theme: Theme
  update: (change: Partial<Settings>) => void
}

export const SettingsContext = createContext<SettingsContextValue>({ settings: defaults, theme: findTheme('still-dark', []), update: () => {} })
export const useSettings = () => useContext(SettingsContext)
