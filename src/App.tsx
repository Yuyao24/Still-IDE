import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { CircleAlert, X } from 'lucide-react'
import { type SshHost, type Workspace, nameHost, setPasswordPrompt, ssh } from './bridge'
import Home, { type OpenOptions } from './Home'
import Ide from './Ide'
import SettingsView, { type SettingsSection } from './SettingsView'
import { PasswordDialog } from './Remote'
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
  useEffect(() => {
    setPasswordPrompt((host, retry) => new Promise(answer => setAsking({ host, retry, answer })))
    return () => setPasswordPrompt(null)
  }, [])
  const theme = useMemo(() => activeTheme(settings, systemDark), [settings, systemDark])

  useLayoutEffect(() => { applySettings(settings, systemDark) }, [settings, systemDark])
  useEffect(() => { void loadSettings().then(loaded => { setSettings(loaded); saveSettings(loaded) }) }, [])
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
    {view.kind === 'home'
      ? <Home onOpen={(workspace, options) => setView({ kind: 'workspace', workspace, options })} onOpenRemote={openRemote}
          onSettings={section => openSettings(section as SettingsSection | undefined)} onToggleTheme={toggleTheme} notify={notify} />
      : <Ide key={(view.workspace.remote ?? 'local') + ':' + view.workspace.root} workspace={view.workspace} initial={view.options}
          onHome={() => setView({ kind: 'home' })} onSwitch={workspace => setView({ kind: 'workspace', workspace })}
          onSettings={openSettings} onToggleTheme={toggleTheme} notify={notify} />}
    {settingsSection && <SettingsView section={settingsSection} onSection={setSettingsSection} onClose={() => setSettingsSection(null)} notify={notify} />}
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
