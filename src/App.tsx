import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { CircleAlert, X } from 'lucide-react'
import { type SshHost, type Workspace, home, launcher, nameHost, setPasswordPrompt, ssh } from './bridge'
import Home, { type OpenOptions } from './Home'
import Ide from './Ide'
import SettingsView, { type SettingsSection } from './SettingsView'
import { LoginPrompt, PasswordDialog } from './Remote'
import { type Update, findUpdate, installUpdate } from './updates'
import { type Settings, SettingsContext, activeTheme, applySettings, cachedSettings, loadSettings, saveSettings } from './settings'
import { findTheme } from './themes'
import { Icon, IconButton } from './ui'

type View = { kind: 'home' } | { kind: 'workspace'; workspace: Workspace; options?: OpenOptions }

const darkQuery = () => matchMedia('(prefers-color-scheme: dark)')

export default function App() {
  const [settings, setSettings] = useState<Settings>(cachedSettings)
  const [systemDark, setSystemDark] = useState(() => darkQuery().matches)
  const [view, setView] = useState<View>({ kind: 'home' })
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null)
  const [toast, setToast] = useState('')
  const [pending, setPending] = useState<Update | null>(null)
  const [installing, setInstalling] = useState<number | null>(null)
  // Look for a newer build a few seconds after starting, and then every six hours.
  useEffect(() => {
    if (!settings.autoUpdate) return
    const look = () => { void findUpdate().then(found => { if (found) setPending(found) }).catch(() => {}) }
    const first = setTimeout(look, 5000)
    const repeat = setInterval(look, 6 * 3600 * 1000)
    return () => { clearTimeout(first); clearInterval(repeat) }
  }, [settings.autoUpdate])
  useEffect(() => {
    const manual = (event: Event) => setPending((event as CustomEvent<Update>).detail)
    addEventListener('still-update', manual)
    return () => removeEventListener('still-update', manual)
  }, [])
  const [asking, setAsking] = useState<{ host: string; retry: boolean; answer: (value: string | null) => void } | null>(null)
  // Sign-in questions from SSH (password, key passphrase, verification code), one at a time.
  const [logins, setLogins] = useState<{ request: number; host: string; prompt: string; kind: string; retry: boolean }[]>([])
  useEffect(() => {
    if (!isTauri()) return
    const stop = listen<{ request: number; host: string; prompt: string; kind: string; retry: boolean }>('ssh-prompt', ({ payload }) => setLogins(previous => [...previous, payload]))
    return () => { void stop.then(unlisten => unlisten()) }
  }, [])
  useEffect(() => {
    setPasswordPrompt((host, retry) => new Promise(answer => setAsking({ host, retry, answer })))
    return () => setPasswordPrompt(null)
  }, [])
  const theme = useMemo(() => activeTheme(settings, systemDark), [settings, systemDark])

  useLayoutEffect(() => { applySettings(settings, systemDark) }, [settings, systemDark])
  // The window opens hidden; show it after the first frame in the theme's colours, and keep the
  // native background matching so resizing never flashes white.
  useEffect(() => {
    if (!isTauri()) return
    const window = getCurrentWindow()
    const color = getComputedStyle(document.documentElement).getPropertyValue('--editor').trim()
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
    if (match) void window.setBackgroundColor([parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16), 255]).catch(() => {})
  }, [theme])
  useEffect(() => {
    if (!isTauri()) return
    // Not requestAnimationFrame: a hidden page gets no frames, so it would never fire.
    const timer = setTimeout(() => { void getCurrentWindow().show().catch(() => {}) }, 30)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => {
    void loadSettings().then(async loaded => {
      setSettings(loaded); saveSettings(loaded)
      // Started with a folder or file (still ., Open with Still): open that.
      const target = await launcher.target()
      if (target) {
        try {
          // Windows paths use backslashes; either kind of slash separates the folder from the file.
          const folder = target.directory ? target.path : target.path.replace(/[\\/][^\\/]*$/, '') || '/'
          const workspace = await home.open(folder)
          setView({ kind: 'workspace', workspace, options: target.directory ? undefined : { file: target.path.split(/[\\/]/).at(-1) } })
          return
        } catch { /* fall through to the usual start */ }
      }
      // Optionally pick up where you left off: the most recently opened local project.
      if (!loaded.openLastProject || !isTauri()) return
      try {
        const state = await home.state()
        const last = state.projects.filter(project => !project.missing && project.lastOpened).sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0))[0]
        if (last) { const workspace = await home.open(last.path); setView(view => view.kind === 'home' ? { kind: 'workspace', workspace } : view) }
      } catch { /* stay on Home */ }
    })
  }, [])
  useEffect(() => {
    const query = darkQuery()
    const change = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  // This is an app, not a web page: no reload keys, no print dialog, and no browser menu outside text.
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      const meta = event.ctrlKey || event.metaKey
      if (key === 'f5' || (meta && key === 'r') || (meta && key === 'g' && !(event.target as Element | null)?.closest?.('.cm-editor'))) event.preventDefault()
    }
    const menu = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (event.defaultPrevented || target?.closest('input, textarea, [contenteditable="true"], .cm-content, .xterm, .console-scroll, .doc-preview')) return
      event.preventDefault()
    }
    addEventListener('keydown', keys)
    addEventListener('contextmenu', menu)
    return () => { removeEventListener('keydown', keys); removeEventListener('contextmenu', menu) }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 5600)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    document.title = view.kind === 'workspace' ? view.workspace.name + ' — Still' : 'Still'
  }, [view])

  const update = useCallback((change: Partial<Settings>) => {
    setSettings(previous => {
      const next = { ...previous, ...change }
      // Remember the last light and dark choice so the toggle can flip between them.
      if (change.theme) {
        const picked = findTheme(change.theme, next.customThemes)
        if (picked.kind === 'dark') next.darkTheme = picked.id
        else next.lightTheme = picked.id
      }
      saveSettings(next)
      return next
    })
  }, [])

  const notify = useCallback((message: unknown) => setToast(message instanceof Error ? message.message : String(message)), [])

  const toggleTheme = useCallback(() => {
    const target = theme.kind === 'dark' ? settings.lightTheme : settings.darkTheme
    const fallback = theme.kind === 'dark' ? 'still-light' : 'still-dark'
    const chosen = findTheme(target, settings.customThemes)
    update({ followSystem: false, theme: chosen.kind !== theme.kind ? chosen.id : fallback })
  }, [theme, settings, update])

  const openRemote = useCallback(async (host: SshHost, path: string) => {
    nameHost(host.id, host.name)
    const root = await ssh.resolve(host.id, path)
    setView({ kind: 'workspace', workspace: { root, name: root.split('/').filter(Boolean).at(-1) ?? root, remote: host.id, hostName: host.name } })
  }, [])

  const context = useMemo(() => ({ settings, theme, update }), [settings, theme, update])
  const openSettings = (section?: SettingsSection) => setSettingsSection(section ?? settingsSection ?? 'appearance')

  return <SettingsContext.Provider value={context}>
    {(settings.backgroundImage || settings.translucency > 0 || settings.surfaceStyle !== 'paper') && <div className="backdrop" aria-hidden="true" />}
    {view.kind === 'home'
      ? <Home onOpen={(workspace, options) => setView({ kind: 'workspace', workspace, options })} onOpenRemote={openRemote}
          onSettings={section => openSettings(section as SettingsSection | undefined)} onToggleTheme={toggleTheme} notify={notify} />
      : <Ide key={(view.workspace.remote ?? 'local') + ':' + view.workspace.root} workspace={view.workspace} initial={view.options}
          onHome={() => setView({ kind: 'home' })} onSwitch={workspace => setView({ kind: 'workspace', workspace })}
          onSettings={openSettings} onToggleTheme={toggleTheme} notify={notify} />}
    {settingsSection && <SettingsView section={settingsSection} onSection={setSettingsSection} onClose={() => setSettingsSection(null)} notify={notify} />}
    {logins[0] && <LoginPrompt key={logins[0].request} host={logins[0].host} prompt={logins[0].prompt} kind={logins[0].kind} retry={logins[0].retry}
      onAnswer={answer => { const request = logins[0].request; setLogins(previous => previous.slice(1)); void invoke('ssh_prompt_answer', { request, answer }).catch(() => {}) }} />}
    {asking && <PasswordDialog host={asking.host} retry={asking.retry} onAnswer={value => { asking.answer(value); setAsking(null) }} />}
    {pending && <div className="update-bar" role="status">
      <span>{installing === null ? <>Still {pending.version} is ready.</> : <>Downloading Still {pending.version}… {Math.round(installing * 100)}%</>}</span>
      {installing === null && <>
        <button className="text-btn primary" onClick={() => {
          setInstalling(0)
          void installUpdate(pending, setInstalling).catch(error => { setInstalling(null); notify('The update could not be installed: ' + (error instanceof Error ? error.message : String(error))) })
        }}>Restart to update</button>
        <button className="quiet-link" onClick={() => setPending(null)}>Later</button>
      </>}
      {installing !== null && <i className="update-progress" style={{ transform: `scaleX(${installing})` }} />}
    </div>}
    {toast && <div className="toast" role="status"><Icon glyph={CircleAlert} /><span className="flex-1">{toast}</span><IconButton glyph={X} label="Dismiss message" onClick={() => setToast('')} /></div>}
  </SettingsContext.Provider>
}
