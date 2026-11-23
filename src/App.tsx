import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { CircleAlert, X } from 'lucide-react'
import { type SshHost, type Workspace, ssh } from './bridge'
import Home, { type OpenOptions } from './Home'
import Ide from './Ide'
import SettingsView, { type SettingsSection } from './SettingsView'
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
  const theme = useMemo(() => activeTheme(settings, systemDark), [settings, systemDark])

  useLayoutEffect(() => { applySettings(settings, systemDark) }, [settings, systemDark])
  useEffect(() => { void loadSettings().then(loaded => { setSettings(loaded); saveSettings(loaded) }) }, [])
  useEffect(() => {
    const query = darkQuery()
    const change = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
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
    {toast && <div className="toast" role="status"><Icon glyph={CircleAlert} /><span className="flex-1">{toast}</span><IconButton glyph={X} label="Dismiss message" onClick={() => setToast('')} /></div>}
  </SettingsContext.Provider>
}
