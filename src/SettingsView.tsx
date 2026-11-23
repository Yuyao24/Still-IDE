import { useEffect, useMemo, useState } from 'react'
import {
  Check, Code2, Copy, FileDown, FolderOpen, FolderSearch, Import, Info, Keyboard, Palette, Pencil, Plus, Server, SquareTerminal, Trash2, X,
} from 'lucide-react'
import { type AppPaths, type PlanItem, type ShellOption, type SshOverview, desktop, home, hostLabel, mod, pickFolder, ssh } from './bridge'
import { blankHost, HostDialog } from './Remote'
import { editorFonts, useSettings } from './settings'
import { type Theme, type ThemeColors, editableColors, exportTheme, isHex, parseTheme, presets, resolve } from './themes'
import { Icon, IconButton, Segmented, Toggle } from './ui'

export type SettingsSection = 'appearance' | 'editor' | 'terminal' | 'projects' | 'remote' | 'shortcuts' | 'about'

const sections: { id: SettingsSection; label: string; icon: typeof Palette }[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'editor', label: 'Editor', icon: Code2 },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'projects', label: 'Projects', icon: FolderOpen },
  { id: 'remote', label: 'Servers', icon: Server },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'about', label: 'About & uninstall', icon: Info },
]

export default function SettingsView({ section, onSection, onClose, notify }: {
  section: SettingsSection; onSection: (section: SettingsSection) => void; onClose: () => void; notify: (message: unknown) => void
}) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    document.querySelector<HTMLElement>('.settings-nav button.is-active')?.focus({ preventScroll: true })
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="modal-backdrop settings-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="settings" role="dialog" aria-modal="true" aria-label="Settings" onKeyDown={event => { if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement && event.target.type === 'color')) { event.stopPropagation(); onClose() } }}>
      <nav className="settings-nav" aria-label="Settings sections">
        <p className="section-label px-3 pb-2 pt-1">Settings</p>
        {sections.map(item => <button key={item.id} className={section === item.id ? 'is-active' : ''} aria-current={section === item.id ? 'page' : undefined}
          onClick={() => onSection(item.id)}><Icon glyph={item.icon} size={14} />{item.label}</button>)}
      </nav>
      <div className="settings-body">
        <header className="settings-head"><h2>{sections.find(item => item.id === section)?.label}</h2><IconButton glyph={X} label="Close settings" onClick={onClose} /></header>
        <div className="settings-scroll">
          {section === 'appearance' && <Appearance notify={notify} />}
          {section === 'editor' && <EditorSettings />}
          {section === 'terminal' && <TerminalSettings />}
          {section === 'projects' && <ProjectSettings notify={notify} />}
          {section === 'remote' && <ServerSettings notify={notify} />}
          {section === 'shortcuts' && <Shortcuts />}
          {section === 'about' && <About notify={notify} />}
        </div>
      </div>
    </section>
  </div>
}

function ThemeSwatch({ theme, active, onClick }: { theme: Theme; active: boolean; onClick: () => void }) {
  const { colors: c } = resolve(theme)
  return <button className={'theme-card' + (active ? ' is-active' : '')} onClick={onClick} aria-pressed={active} title={theme.name}>
    <span className="theme-preview" style={{ background: c.editor, borderColor: c.line }}>
      <span className="theme-preview-side" style={{ background: c.panel, borderColor: c.line }}>
        <i style={{ background: c.accent }} /><i style={{ background: c.muted }} /><i style={{ background: c.muted }} />
      </span>
      <span className="theme-preview-code">
        <i style={{ background: c.keyword, width: '28%' }} /><i style={{ background: c.function, width: '42%' }} />
        <i style={{ background: c.comment, width: '60%' }} />
        <i style={{ background: c.string, width: '36%', marginLeft: 8 }} /><i style={{ background: c.number, width: '18%' }} />
        <i style={{ background: c.type, width: '48%' }} />
      </span>
    </span>
    <span className="theme-name">{active && <Icon glyph={Check} size={12} />}{theme.name}</span>
  </button>
}

function Appearance({ notify }: { notify: (message: unknown) => void }) {
  const { settings, theme, update } = useSettings()
  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')
  const all = [...presets, ...settings.customThemes]
  const chooseTheme = (id: string) => {
    const picked = all.find(item => item.id === id)
    if (!picked) return
    if (settings.followSystem) update(picked.kind === 'dark' ? { darkTheme: id } : { lightTheme: id })
    else update({ theme: id })
  }
  const activeId = theme.id

  function editColor(key: keyof ThemeColors, value: string) {
    if (theme.custom) {
      update({ customThemes: settings.customThemes.map(item => item.id === theme.id ? { ...item, colors: { ...item.colors, [key]: value } } : item) })
      return
    }
    const resolved = resolve(theme).colors
    const copy: Theme = {
      ...theme, id: 'custom-' + Date.now().toString(36), name: theme.name + ' (custom)', custom: true, basedOn: theme.id,
      colors: { ...theme.colors, bar: resolved.bar, selection: resolved.selection, variable: resolved.variable, operator: resolved.operator, [key]: value },
    }
    update({ customThemes: [...settings.customThemes, copy], ...(settings.followSystem ? (copy.kind === 'dark' ? { darkTheme: copy.id } : { lightTheme: copy.id }) : { theme: copy.id }) })
  }
  function patchCustom(change: Partial<Theme>) {
    update({ customThemes: settings.customThemes.map(item => item.id === theme.id ? { ...item, ...change } : item) })
  }
  function removeCustom() {
    const fallback = theme.basedOn ?? (theme.kind === 'dark' ? 'still-dark' : 'still-light')
    update({
      customThemes: settings.customThemes.filter(item => item.id !== theme.id),
      theme: settings.theme === theme.id ? fallback : settings.theme,
      darkTheme: settings.darkTheme === theme.id ? 'still-dark' : settings.darkTheme,
      lightTheme: settings.lightTheme === theme.id ? 'still-light' : settings.lightTheme,
    })
  }
  function runImport() {
    try {
      const imported = parseTheme(importText)
      update({ customThemes: [...settings.customThemes, imported], theme: imported.id, followSystem: false })
      setImporting(false); setImportText('')
      notify('Imported ' + imported.name + '.')
    } catch (error) { notify(error) }
  }
  const resolved = resolve(theme).colors

  return <>
    <section className="settings-group">
      <div className="settings-group-head"><h3>Theme</h3>
        <div className="flex gap-1">
          <button className="text-btn" onClick={() => setImporting(value => !value)}><Icon glyph={Import} size={13} />Import</button>
          <button className="text-btn" onClick={() => { void navigator.clipboard.writeText(exportTheme(theme)).then(() => notify('Copied ' + theme.name + ' as JSON.')) }}><Icon glyph={FileDown} size={13} />Export</button>
        </div>
      </div>
      {importing && <div className="import-box">
        <textarea className="field font-mono" rows={6} value={importText} onChange={event => setImportText(event.target.value)} spellCheck={false}
          placeholder={'{\n  "name": "My theme",\n  "kind": "dark",\n  "colors": { "editor": "#1b1b1d", "accent": "#7aa2c7", … }\n}'} />
        <div className="flex justify-end gap-2 mt-2"><button className="text-btn" onClick={() => setImporting(false)}>Cancel</button><button className="text-btn primary" onClick={runImport} disabled={!importText.trim()}>Import theme</button></div>
      </div>}
      <Toggle label="Match the system appearance" description="Switch between a light and a dark theme with your operating system."
        checked={settings.followSystem} onChange={value => update({ followSystem: value, ...(value ? { [theme.kind === 'dark' ? 'darkTheme' : 'lightTheme']: theme.id } : { theme: theme.id }) })} />
      {settings.followSystem ? <>
        <p className="settings-caption">Dark</p>
        <div className="theme-grid">{all.filter(item => item.kind === 'dark').map(item => <ThemeSwatch key={item.id} theme={item} active={settings.darkTheme === item.id} onClick={() => update({ darkTheme: item.id })} />)}</div>
        <p className="settings-caption">Light</p>
        <div className="theme-grid">{all.filter(item => item.kind === 'light').map(item => <ThemeSwatch key={item.id} theme={item} active={settings.lightTheme === item.id} onClick={() => update({ lightTheme: item.id })} />)}</div>
      </> : <>
        <p className="settings-caption">Dark</p>
        <div className="theme-grid">{all.filter(item => item.kind === 'dark').map(item => <ThemeSwatch key={item.id} theme={item} active={activeId === item.id} onClick={() => chooseTheme(item.id)} />)}</div>
        <p className="settings-caption">Light</p>
        <div className="theme-grid">{all.filter(item => item.kind === 'light').map(item => <ThemeSwatch key={item.id} theme={item} active={activeId === item.id} onClick={() => chooseTheme(item.id)} />)}</div>
      </>}
    </section>

    <section className="settings-group">
      <div className="settings-group-head">
        <h3>Customize {theme.name}</h3>
        {theme.custom && <button className="text-btn danger" onClick={removeCustom}><Icon glyph={Trash2} size={13} />Delete theme</button>}
      </div>
      <p className="help mb-3">{theme.custom ? 'Changes apply instantly and are saved with your settings.' : 'Editing a color creates your own copy of this theme; the preset stays as it is.'}</p>
      {theme.custom && <div className="grid grid-cols-[1fr_auto] gap-3 mb-4 items-end">
        <label className="field-label">Name<input className="field mt-1" value={theme.name} onChange={event => patchCustom({ name: event.target.value })} /></label>
        <Segmented label="Theme kind" value={theme.kind} onChange={kind => patchCustom({ kind })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
      </div>}
      {(['Interface', 'Syntax', 'Status'] as const).map(group => <div key={group} className="mb-4">
        <p className="settings-caption">{group}</p>
        <div className="color-grid">
          {editableColors.filter(item => item.group === group).map(item => <ColorField key={item.key} label={item.label} value={resolved[item.key]} onChange={value => editColor(item.key, value)} />)}
        </div>
      </div>)}
      {theme.custom && <Toggle label="Italic comments" checked={theme.italicComments !== false} onChange={value => patchCustom({ italicComments: value })} />}
    </section>

    <section className="settings-group">
      <h3>Text</h3>
      <div className="setting-row"><span className="setting-text"><span>Interface size</span><small>Sidebar, tabs and menus</small></span>
        <Segmented label="Interface size" value={settings.uiFontSize} onChange={value => update({ uiFontSize: value })} options={[12, 13, 14, 15].map(value => ({ value, label: value + 'px' }))} /></div>
      <div className="setting-row"><span className="setting-text"><span>Code font</span><small>Editor and terminal. Fonts other than JetBrains Mono must be installed.</small></span>
        <select className="field w-52" value={settings.editorFont} onChange={event => update({ editorFont: event.target.value })}>
          {editorFonts.map(font => <option key={font.value} value={font.value}>{font.label}</option>)}
          {!editorFonts.some(font => font.value === settings.editorFont) && <option value={settings.editorFont}>{settings.editorFont}</option>}
        </select></div>
      <NumberRow label="Code font size" value={settings.editorFontSize} min={10} max={24} onChange={value => update({ editorFontSize: value })} />
      <NumberRow label="Line height" value={settings.editorLineHeight} min={1.2} max={2.2} step={0.1} onChange={value => update({ editorLineHeight: Math.round(value * 10) / 10 })} />
      <Toggle label="Font ligatures" description="Render => and != as single glyphs in fonts that support them." checked={settings.ligatures} onChange={value => update({ ligatures: value })} />
    </section>
  </>
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const hex6 = value.length === 4 ? '#' + value.slice(1).split('').map(char => char + char).join('') : value.slice(0, 7)
  return <label className="color-field">
    <input type="color" value={hex6} onChange={event => onChange(event.target.value)} aria-label={label} />
    <span className="truncate">{label}</span>
    <input className="color-hex" value={text} spellCheck={false} aria-label={label + ' hex value'}
      onChange={event => { setText(event.target.value); if (isHex(event.target.value)) onChange(event.target.value.toLowerCase()) }}
      onBlur={() => setText(value)} />
  </label>
}

function NumberRow({ label, value, min, max, step = 1, onChange, description }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void; description?: string }) {
  return <div className="setting-row"><span className="setting-text"><span>{label}</span>{description && <small>{description}</small>}</span>
    <span className="stepper">
      <button type="button" onClick={() => onChange(Math.max(min, +(value - step).toFixed(2)))} aria-label={'Decrease ' + label}>−</button>
      <span>{value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, +(value + step).toFixed(2)))} aria-label={'Increase ' + label}>+</button>
    </span>
  </div>
}

function EditorSettings() {
  const { settings, update } = useSettings()
  return <>
    <section className="settings-group">
      <h3>Editing</h3>
      <div className="setting-row"><span className="setting-text"><span>Tab size</span><small>Auto uses 4 spaces for Python, Java, Rust, Go and C, and 2 elsewhere.</small></span>
        <Segmented label="Tab size" value={String(settings.tabSize)} onChange={value => update({ tabSize: value === 'auto' ? 'auto' : Number(value) as 2 | 4 | 8 })}
          options={[{ value: 'auto', label: 'Auto' }, { value: '2', label: '2' }, { value: '4', label: '4' }, { value: '8', label: '8' }]} /></div>
      <Toggle label="Wrap long lines" checked={settings.wordWrap} onChange={value => update({ wordWrap: value })} />
      <Toggle label="Line numbers" checked={settings.lineNumbers} onChange={value => update({ lineNumbers: value })} />
      <Toggle label="Highlight the current line" checked={settings.highlightLine} onChange={value => update({ highlightLine: value })} />
      <div className="setting-row"><span className="setting-text"><span>Auto save</span><small>Save after a short pause, or when the editor loses focus.</small></span>
        <Segmented label="Auto save" value={settings.autoSave} onChange={value => update({ autoSave: value })}
          options={[{ value: 'off', label: 'Off' }, { value: 'delay', label: 'After delay' }, { value: 'blur', label: 'On focus change' }]} /></div>
    </section>
    <section className="settings-group">
      <h3>Diffs and files</h3>
      <div className="setting-row"><span className="setting-text"><span>Diff layout</span></span>
        <Segmented label="Diff layout" value={settings.diffLayout} onChange={value => update({ diffLayout: value })} options={[{ value: 'inline', label: 'Inline' }, { value: 'split', label: 'Side by side' }]} /></div>
      <Toggle label="Confirm before deleting files" description="Local files go to the system trash either way." checked={settings.confirmDelete} onChange={value => update({ confirmDelete: value })} />
    </section>
    <section className="settings-group">
      <h3>Calm</h3>
      <Toggle label="Smooth caret" description="The caret glides to its new position instead of jumping." checked={settings.smoothCaret} onChange={value => update({ smoothCaret: value })} />
      <div className="setting-row"><span className="setting-text"><span>Idle screen</span><small>After this long without input, show drifting code, the time and today's numbers. Any key brings you back.</small></span>
        <Segmented label="Idle screen" value={String(settings.idleMinutes)} onChange={value => update({ idleMinutes: Number(value) })}
          options={[{ value: '0', label: 'Off' }, { value: '2', label: '2 min' }, { value: '5', label: '5 min' }, { value: '10', label: '10 min' }, { value: '20', label: '20 min' }]} /></div>
      <Toggle label="Keep a journal" description="Notes saves, runs and commits on this computer. Shown on Home under Today." checked={settings.journal} onChange={value => update({ journal: value })} />
    </section>
  </>
}

function TerminalSettings() {
  const { settings, update } = useSettings()
  const [shells, setShells] = useState<ShellOption[]>([])
  useEffect(() => { void home.shells().then(setShells).catch(() => {}) }, [])
  return <section className="settings-group">
    <h3>Terminal</h3>
    <div className="setting-row"><span className="setting-text"><span>Shell</span><small>Default uses $SHELL on macOS and Linux, and Windows PowerShell on Windows.</small></span>
      <select className="field w-56" value={settings.terminalShell} onChange={event => update({ terminalShell: event.target.value })}>
        <option value="">Default</option>
        {shells.map(shell => <option key={shell.path} value={shell.path}>{shell.name} — {shell.path}</option>)}
      </select></div>
    <NumberRow label="Font size" value={settings.terminalFontSize} min={10} max={24} onChange={value => update({ terminalFontSize: value })} />
    <div className="setting-row"><span className="setting-text"><span>Cursor</span></span>
      <Segmented label="Cursor" value={settings.terminalCursor} onChange={value => update({ terminalCursor: value })}
        options={[{ value: 'block', label: 'Block' }, { value: 'bar', label: 'Bar' }, { value: 'underline', label: 'Underline' }]} /></div>
    <p className="help mt-2">Terminal colors follow the active theme.</p>
  </section>
}

function ProjectSettings({ notify }: { notify: (message: unknown) => void }) {
  const { settings, update } = useSettings()
  const [root, setRoot] = useState<string | null>(null)
  useEffect(() => { void home.state().then(state => setRoot(state.projectsRoot)).catch(() => {}) }, [])
  async function change() {
    try {
      const path = await pickFolder('Choose your projects folder')
      if (path) setRoot(await home.setRoot(path))
    } catch (error) { notify(error) }
  }
  return <>
    <section className="settings-group">
      <h3>Projects folder</h3>
      <p className="help mb-3">New projects are created here, and every folder inside it appears on Home. Individual projects can live anywhere else too; open them with {mod}+O or choose “Somewhere else” when creating one.</p>
      <div className="path-box">
        <Icon glyph={FolderOpen} size={14} /><span className="truncate flex-1">{root ?? 'Not chosen yet'}</span>
        {root && desktop && <IconButton glyph={FolderSearch} label="Reveal in file manager" onClick={() => { void home.reveal(root).catch(notify) }} />}
        <button className="text-btn" onClick={() => { void change() }} disabled={!desktop}>{root ? 'Change…' : 'Choose…'}</button>
      </div>
      <p className="help mt-2">Changing the folder never moves or deletes existing projects.</p>
    </section>
    <section className="settings-group">
      <h3>New projects</h3>
      <div className="setting-row"><span className="setting-text"><span>Default template</span></span>
        <select className="field w-44" value={settings.newProjectTemplate} onChange={event => update({ newProjectTemplate: event.target.value })}>
          <option value="python">Python</option><option value="java">Java</option><option value="node">JavaScript</option><option value="empty">Empty</option><option value="sample">Orbit Lab sample</option>
        </select></div>
      <Toggle label="Initialize a Git repository" checked={settings.newProjectGit} onChange={value => update({ newProjectGit: value })} />
    </section>
  </>
}

function ServerSettings({ notify }: { notify: (message: unknown) => void }) {
  const [overview, setOverview] = useState<SshOverview | null>(null)
  const [editing, setEditing] = useState<typeof blankHost | null>(null)
  const refresh = () => { void ssh.hosts().then(setOverview).catch(notify) }
  useEffect(refresh, [])
  return <section className="settings-group">
    <div className="settings-group-head"><h3>Saved servers</h3><button className="text-btn" onClick={() => setEditing(blankHost)} disabled={!desktop}><Icon glyph={Plus} size={13} />Add server</button></div>
    {!desktop && <p className="help">SSH connections are available in the Still desktop app.</p>}
    {overview?.saved.map(host => <div className="setting-row" key={host.id}>
      <span className="setting-text"><span>{host.name}</span><small>{hostLabel(host)}{host.jump ? ' · via ' + host.jump : ''}{host.forwards.length ? ' · forwards ' + host.forwards.join(', ') : ''}</small></span>
      <span className="flex gap-1">
        <IconButton glyph={Pencil} label={'Edit ' + host.name} onClick={() => setEditing(host)} />
        <IconButton glyph={Trash2} label={'Remove ' + host.name} onClick={() => { void ssh.remove(host.id).then(refresh).catch(notify) }} />
      </span>
    </div>)}
    {overview && !overview.saved.length && <p className="help">No saved servers.</p>}
    {!!overview?.imported.length && <>
      <p className="settings-caption mt-4">From ~/.ssh/config (read-only)</p>
      {overview.imported.map(host => <div className="setting-row" key={host.id}><span className="setting-text"><span>{host.name}</span><small>{hostLabel(host)}</small></span></div>)}
    </>}
    <p className="help mt-4">{overview?.client ?? 'OpenSSH client not detected.'} Still runs your system's ssh, so keys, agents, ~/.ssh/config, ProxyJump and known_hosts behave exactly as in a terminal. Passwords and host-key prompts appear in the terminal. Still never stores passwords.</p>
    {editing && <HostDialog host={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
  </section>
}

const shortcutGroups: { title: string; items: [string, string][] }[] = [
  { title: 'General', items: [['Command palette and file finder', 'K / P'], ['Commands only', 'Shift+K'], ['Settings', ','], ['Go to Home', 'Shift+H'], ['Open folder', 'O'], ['New project (Home)', 'N']] },
  { title: 'Editor', items: [['Save', 'S'], ['Close tab', 'W'], ['Next / previous tab', 'Tab / Shift+Tab'], ['Find in file', 'F'], ['Find in all files', 'Shift+F'], ['Go to line', 'Alt+G'], ['Toggle comment', '/']] },
  { title: 'Run', items: [['Run active file', 'Enter'], ['Check or compile only', 'Shift+Enter']] },
  { title: 'Layout', items: [['Overview of everything', '↑'], ['Focus mode', '.'], ['Toggle the left island', 'B'], ['Toggle the terminal island', 'J'], ['New terminal', 'Shift+`'], ['Files', 'Shift+E'], ['Git', 'Shift+G']] },
]

function Shortcuts() {
  return <>{shortcutGroups.map(group => <section key={group.title} className="settings-group">
    <h3>{group.title}</h3>
    {group.items.map(([label, keys]) => <div key={label} className="setting-row"><span className="setting-text"><span>{label}</span></span>
      <span className="flex gap-1">{keys.split(' / ').map(key => <kbd key={key}>{mod + '+' + key}</kbd>)}</span></div>)}
  </section>)}</>
}

function About({ notify }: { notify: (message: unknown) => void }) {
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const [plan, setPlan] = useState<PlanItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirm, setConfirm] = useState('')
  useEffect(() => { if (desktop) void home.paths().then(setPaths).catch(notify) }, [])
  const grouped = useMemo(() => ({
    remove: plan?.filter(item => item.action === 'remove' || item.action === 'package') ?? [],
    keep: plan?.filter(item => item.action === 'keep') ?? [],
    rescue: plan?.filter(item => item.action === 'rescue') ?? [],
  }), [plan])
  async function inspect() {
    setLoading(true)
    try { setPlan(await home.uninstallPlan()) } catch (error) { notify(error) } finally { setLoading(false) }
  }
  return <>
    <section className="settings-group">
      <h3>Still {paths?.version ?? ''}</h3>
      <p className="help">A keyboard-centric editor for Python, Java and more, built with Tauri, Rust and React.</p>
      {paths && <>
        <p className="settings-caption mt-4">Still keeps its own data here</p>
        {paths.directories.map(dir => <div key={dir} className="path-box mb-1"><span className="truncate flex-1 font-mono text-[11px]">{dir}</span>
          <IconButton glyph={Copy} label="Copy path" onClick={() => { void navigator.clipboard.writeText(dir) }} /></div>)}
      </>}
    </section>
    <section className="settings-group danger-zone">
      <h3>Uninstall Still</h3>
      <p className="help mb-3">Removes the app and everything it stored on this computer: settings, themes, saved servers, caches, web view storage, shortcuts and installer entries. Your projects folder and every project are left exactly where they are. Your SSH keys and ~/.ssh files are never touched.</p>
      {!desktop && <p className="help">Uninstalling is available in the desktop app. You can also run the scripts in the uninstall folder of the source code.</p>}
      {desktop && !plan && <button className="text-btn danger" onClick={() => { void inspect() }} disabled={loading}><Icon glyph={Trash2} size={13} />{loading ? 'Checking this computer…' : 'Review what will be removed…'}</button>}
      {plan && <div className="uninstall-plan">
        <p className="settings-caption">Will be removed</p>
        {grouped.remove.length ? grouped.remove.map(item => <p key={item.detail} className="plan-item remove"><Icon glyph={X} size={12} />{item.action === 'package' ? 'Installed program: ' + item.detail : item.detail}</p>)
          : <p className="help">Nothing installed was found besides this running copy.</p>}
        {grouped.rescue.map(item => <p key={item.detail} className="plan-item"><Icon glyph={FolderOpen} size={12} />Moved to safety first: {item.detail}</p>)}
        <p className="settings-caption mt-3">Kept</p>
        {grouped.keep.map(item => <p key={item.detail} className="plan-item keep"><Icon glyph={Check} size={12} />{item.detail}</p>)}
        <p className="plan-item keep"><Icon glyph={Check} size={12} />Every project folder, your SSH keys, Git, Python, Java and Node</p>
        <label className="field-label mt-4">Type <b>uninstall</b> to confirm
          <input className="field mt-1" value={confirm} onChange={event => setConfirm(event.target.value)} spellCheck={false} autoComplete="off" /></label>
        <div className="flex gap-2 mt-2">
          <button className="text-btn" onClick={() => { setPlan(null); setConfirm('') }}>Cancel</button>
          <button className="text-btn primary danger" disabled={confirm.trim().toLowerCase() !== 'uninstall'}
            onClick={() => { void home.uninstall(confirm).catch(notify) }}><Icon glyph={Trash2} size={13} />Quit and uninstall</button>
        </div>
        <p className="help mt-2">Still closes, finishes removing itself in the background, and shows a notification when done.</p>
      </div>}
    </section>
  </>
}
