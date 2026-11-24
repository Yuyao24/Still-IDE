import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Check, Code2, Copy, FileDown, FolderOpen, FolderSearch, Import, Info, Keyboard, Palette, Pencil, Plus, Search, Server, SquareTerminal, Trash2, X, Sparkles } from 'lucide-react'
import { type AppPaths, type PlanItem, type ShellOption, type SshOverview, desktop, home, hostLabel, mod, pickFolder, ssh } from './bridge'
import { blankHost, HostDialog } from './Remote'
import { editorFonts, useSettings } from './settings'
import { findUpdate } from './updates'
import { type GithubModel, claudeModels, githubFallbackModels, githubModels, keys, ollamaModels } from './ai'
import { type Theme, type ThemeColors, editableColors, exportTheme, isHex, parseTheme, presets, resolve } from './themes'
import { Icon, IconButton, Segmented, Toggle } from './ui'

export type SettingsSection = 'appearance' | 'editor' | 'ai' | 'terminal' | 'projects' | 'remote' | 'shortcuts' | 'about'

const sections: { id: SettingsSection; label: string; icon: typeof Palette }[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'editor', label: 'Editor', icon: Code2 },
  { id: 'ai', label: 'AI', icon: Sparkles },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'projects', label: 'Projects', icon: FolderOpen },
  { id: 'remote', label: 'Servers', icon: Server },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'about', label: 'About & uninstall', icon: Info },
]

export default function SettingsView({ section, onSection, onClose, notify }: {
  section: SettingsSection; onSection: (section: SettingsSection) => void; onClose: () => void; notify: (message: unknown) => void
}) {
  const [query, setQuery] = useState('')
  const body = useRef<HTMLDivElement>(null)
  const [matches, setMatches] = useState<number | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    searchInput.current?.focus({ preventScroll: true })
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  const term = query.trim().toLowerCase()
  // Searching shows every section and hides what doesn't match: whole groups when their title
  // matches, otherwise just the matching rows inside them.
  useLayoutEffect(() => {
    const root = body.current
    if (!root) return
    const rows = '.setting-row, .theme-card, .color-field, .form-grid > label, .shortcut-row'
    let count = 0
    root.querySelectorAll<HTMLElement>('[data-search-hidden]').forEach(node => node.removeAttribute('data-search-hidden'))
    if (!term) { setMatches(null); return }
    const words = term.split(/\s+/)
    const hit = (text: string) => { const lower = text.toLowerCase(); return words.every(word => lower.includes(word)) }
    root.querySelectorAll<HTMLElement>('.settings-section').forEach(sectionNode => {
      let visibleGroups = 0
      sectionNode.querySelectorAll<HTMLElement>('.settings-group').forEach(group => {
        const title = group.querySelector('h3')?.textContent ?? ''
        if (hit(title + ' ' + (sectionNode.dataset.label ?? ''))) { visibleGroups++; count += Math.max(1, group.querySelectorAll(rows).length); return }
        let visible = 0
        group.querySelectorAll<HTMLElement>(rows).forEach(row => { if (hit(row.textContent ?? '')) { visible++ } else row.setAttribute('data-search-hidden', '') })
        group.querySelectorAll<HTMLElement>(':scope > p, :scope > .help, .theme-grid > p, .settings-caption, .import-box').forEach(node => node.setAttribute('data-search-hidden', ''))
        if (!visible) group.setAttribute('data-search-hidden', '')
        else { visibleGroups++; count += visible }
      })
      if (!visibleGroups) sectionNode.setAttribute('data-search-hidden', '')
    })
    setMatches(count)
  })
  const shown = term ? sections : sections.filter(item => item.id === section)
  return <div className="modal-backdrop settings-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="settings" role="dialog" aria-modal="true" aria-label="Settings" onKeyDown={event => {
      if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement && event.target.type === 'color')) {
        event.stopPropagation()
        if (query && event.target === searchInput.current) setQuery(''); else onClose()
      }
    }}>
      <nav className="settings-nav" aria-label="Settings sections">
        <label className="settings-search">
          <Icon glyph={Search} size={13} />
          <input ref={searchInput} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search settings" aria-label="Search settings" spellCheck={false} />
          {query && <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); searchInput.current?.focus() }}><Icon glyph={X} size={12} /></button>}
        </label>
        {sections.map(item => <button key={item.id} className={!term && section === item.id ? 'is-active' : ''} aria-current={!term && section === item.id ? 'page' : undefined}
          onClick={() => { setQuery(''); onSection(item.id) }}><Icon glyph={item.icon} size={14} />{item.label}</button>)}
      </nav>
      <div className="settings-body">
        <header className="settings-head"><h2>{term ? (matches === 0 ? 'No matching settings' : 'Results for “' + query.trim() + '”') : sections.find(item => item.id === section)?.label}</h2><IconButton glyph={X} label="Close settings" onClick={onClose} /></header>
        <div className="settings-scroll" ref={body}>
          {shown.map(item => <div key={item.id} className="settings-section" data-label={item.label}>
            {term && <p className="settings-section-label">{item.label}</p>}
            {item.id === 'appearance' && <Appearance notify={notify} />}
            {item.id === 'editor' && <EditorSettings />}
            {item.id === 'ai' && <AiSettingsView />}
            {item.id === 'terminal' && <TerminalSettings />}
            {item.id === 'projects' && <ProjectSettings notify={notify} />}
            {item.id === 'remote' && <ServerSettings notify={notify} />}
            {item.id === 'shortcuts' && <Shortcuts />}
            {item.id === 'about' && <About notify={notify} />}
          </div>)}
          {term && matches === 0 && <p className="help settings-none">Nothing matches “{query.trim()}”. Try a shorter word, like “font”, “tab” or “theme”.</p>}
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
      <div className="settings-group-head"><h3>Syntax colours</h3></div>
      <p className="help mb-3">Colour the code with another theme's palette while keeping {theme.name} for everything else. Only {theme.kind} palettes are offered, so code stays readable.</p>
      <div className="theme-grid syntax-grid">
        <SyntaxSwatch label={'Match ' + theme.name} theme={theme} active={!settings.syntaxTheme || settings.syntaxTheme === theme.id || !all.some(item => item.id === settings.syntaxTheme && item.kind === theme.kind)} onClick={() => update({ syntaxTheme: '' })} />
        {all.filter(item => item.kind === theme.kind && item.id !== theme.id).map(item => <SyntaxSwatch key={item.id} label={item.name} theme={item} background={resolved.editor} active={settings.syntaxTheme === item.id} onClick={() => update({ syntaxTheme: item.id })} />)}
      </div>
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

    <section className="settings-group">
      <h3>Window</h3>
      <Toggle label="Hide the top bar until the pointer reaches it" description="Gives the editor the whole window. Move the pointer to the top edge to show the bar." checked={settings.autoHideTopBar} onChange={value => update({ autoHideTopBar: value })} />
    </section>

    <section className="settings-group">
      <h3>Motion</h3>
      <Toggle label="Reduce motion" description="Islands, menus and the canvas appear without sliding or fading." checked={settings.reduceMotion} onChange={value => update({ reduceMotion: value })} />

    </section>
  </>
}

function SyntaxSwatch({ theme, label, active, onClick, background }: { theme: Theme; label: string; active: boolean; onClick: () => void; background?: string }) {
  const { colors: c } = resolve(theme)
  const line = (parts: [string, string][]) => <span className="syntax-line">{parts.map(([text, color], index) => <span key={index} style={{ color }}>{text}</span>)}</span>
  return <button className={'theme-card syntax-card' + (active ? ' is-active' : '')} onClick={onClick} aria-pressed={active} title={label}>
    <span className="syntax-preview" style={{ background: background ?? c.editor }}>
      {line([['def ', c.keyword], ['orbit', c.function], ['(', c.operator], ['r', c.variable], [')', c.operator], [':', c.operator]])}
      {line([['  # minutes', c.comment]])}
      {line([['  return ', c.keyword], ['2', c.number], [' * ', c.operator], ['Pi', c.type], ['(', c.operator], ['"km"', c.string], [')', c.operator]])}
    </span>
    <span className="theme-name">{active && <Icon glyph={Check} size={12} />}{label}</span>
  </button>
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
      <Toggle label="Suggest completions while typing" description="Off: press Ctrl+Space to see suggestions. Either way, Tab accepts a suggestion and Enter always starts a new line." checked={settings.autocomplete} onChange={value => update({ autocomplete: value })} />
      <Toggle label="Close brackets and quotes automatically" description="Typing ( [ { or a quote adds the closing one." checked={settings.closeBrackets} onChange={value => update({ closeBrackets: value })} />
      <div className="setting-row"><span className="setting-text"><span>Auto save</span><small>Save after a short pause, or when the editor loses focus.</small></span>
        <Segmented label="Auto save" value={settings.autoSave} onChange={value => update({ autoSave: value })}
          options={[{ value: 'off', label: 'Off' }, { value: 'delay', label: 'After delay' }, { value: 'blur', label: 'On focus change' }]} /></div>
      <Toggle label="Trim trailing spaces when saving" checked={settings.trimOnSave} onChange={value => update({ trimOnSave: value })} />
      <Toggle label="End files with a newline when saving" checked={settings.finalNewline} onChange={value => update({ finalNewline: value })} />
    </section>
    <section className="settings-group">
      <h3>Display</h3>
      <Toggle label="Line numbers" checked={settings.lineNumbers} onChange={value => update({ lineNumbers: value })} />
      <Toggle label="Highlight the current line" checked={settings.highlightLine} onChange={value => update({ highlightLine: value })} />
      <Toggle label="Highlight other uses of the word under the caret" checked={settings.occurrences} onChange={value => update({ occurrences: value })} />
      <Toggle label="Indent guides" description="Thin lines at each indentation level." checked={settings.indentGuides} onChange={value => update({ indentGuides: value })} />
      <Toggle label="Code folding" description="Arrows beside the line numbers fold blocks away." checked={settings.folding} onChange={value => update({ folding: value })} />
      <div className="setting-row"><span className="setting-text"><span>Show whitespace</span></span>
        <Segmented label="Show whitespace" value={settings.whitespace} onChange={value => update({ whitespace: value })}
          options={[{ value: 'none', label: 'None' }, { value: 'trailing', label: 'Trailing' }, { value: 'all', label: 'All' }]} /></div>
      <Toggle label="Scroll past the last line" checked={settings.scrollPastEnd} onChange={value => update({ scrollPastEnd: value })} />
    </section>
    <section className="settings-group">
      <h3>Caret</h3>
      <div className="setting-row"><span className="setting-text"><span>Caret style</span></span>
        <Segmented label="Caret style" value={settings.cursorStyle} onChange={value => update({ cursorStyle: value })}
          options={[{ value: 'line', label: 'Line' }, { value: 'block', label: 'Block' }, { value: 'underline', label: 'Underline' }]} /></div>
      <Toggle label="Blinking caret" checked={settings.cursorBlink} onChange={value => update({ cursorBlink: value })} />
      <Toggle label="Smooth caret" description="The caret glides to its new position instead of jumping." checked={settings.smoothCaret} onChange={value => update({ smoothCaret: value })} />
    </section>
    <section className="settings-group">
      <h3>Checks and changes</h3>
      <Toggle label="Show errors while typing" description="Underlines syntax errors as you type. Python files are also checked for undefined names (and, with pyflakes installed, unused imports and more)." checked={settings.errors} onChange={value => update({ errors: value })} />
      <Toggle label="Mark lines changed since the last commit" description="A green bar for added lines, amber for changed lines and a red mark where lines were removed." checked={settings.gitGutter} onChange={value => update({ gitGutter: value })} />
    </section>
    <section className="settings-group">
      <h3>Diffs and files</h3>
      <div className="setting-row"><span className="setting-text"><span>Diff layout</span></span>
        <Segmented label="Diff layout" value={settings.diffLayout} onChange={value => update({ diffLayout: value })} options={[{ value: 'inline', label: 'Inline' }, { value: 'split', label: 'Side by side' }]} /></div>
      <Toggle label="Confirm before deleting files" description="Local files go to the system trash either way." checked={settings.confirmDelete} onChange={value => update({ confirmDelete: value })} />
    </section>
    <section className="settings-group">
      <h3>Calm</h3>
      <div className="setting-row"><span className="setting-text"><span>Idle screen</span><small>After this long without input, show drifting code, the time and today's numbers. Any key brings you back.</small></span>
        <Segmented label="Idle screen" value={String(settings.idleMinutes)} onChange={value => update({ idleMinutes: Number(value) })}
          options={[{ value: '0', label: 'Off' }, { value: '2', label: '2 min' }, { value: '5', label: '5 min' }, { value: '10', label: '10 min' }, { value: '20', label: '20 min' }]} /></div>
      <Toggle label="Keep a journal" description="Notes saves, runs and commits on this computer. Shown on Home under Journal." checked={settings.journal} onChange={value => update({ journal: value })} />
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
    <div className="setting-row"><span className="setting-text"><span>Scrollback</span><small>Lines kept above the screen in each terminal.</small></span>
      <Segmented label="Scrollback" value={String(settings.terminalScrollback)} onChange={value => update({ terminalScrollback: Number(value) })}
        options={[{ value: '1000', label: '1k' }, { value: '5000', label: '5k' }, { value: '10000', label: '10k' }, { value: '50000', label: '50k' }]} /></div>
    <Toggle label="Copy selected text automatically" description="Selecting text in the terminal copies it, as in many Linux terminals." checked={settings.terminalCopyOnSelect} onChange={value => update({ terminalCopyOnSelect: value })} />
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
    <section className="settings-group">
      <h3>Startup</h3>
      <Toggle label="Reopen the last project when Still starts" description="Off: Still opens on Home." checked={settings.openLastProject} onChange={value => update({ openLastProject: value })} />
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
    <p className="help mt-4">{overview?.client ?? 'OpenSSH client not detected.'} Still runs your system's ssh, so keys, agents, ~/.ssh/config, ProxyJump and known_hosts behave exactly as in a terminal. Passwords, key passphrases and verification codes are asked for in a dialog when a server needs them; passwords are kept in memory until you quit and never written to disk.</p>
    {editing && <HostDialog host={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
  </section>
}

const shortcutGroups: { title: string; items: [string, string][] }[] = [
  { title: 'General', items: [['Command palette and file finder', 'K / P'], ['Commands only', 'Shift+K'], ['Settings', ','], ['Go to Home', 'Shift+H'], ['Open folder', 'O'], ['New project (Home)', 'N'], ['Zoom code in / out / reset', '= / - / 0']] },
  { title: 'Editor', items: [['Save / save all', 'S / Shift+S'], ['Close tab', 'W'], ['Next / previous tab', 'Tab / Shift+Tab'], ['Find in file', 'F'], ['Find in all files', 'Shift+F'], ['Go to line', 'Alt+G'], ['Toggle comment', '/'], ['Select next match', 'D'], ['Duplicate line', 'Shift+D'], ['Go to definition', '!F12 / Click'], ['Rename in this file', '!F2'], ['Add a cursor', '!Alt+Click'], ['Next problem', '!F8']] },
  { title: 'Run', items: [['Run active file', 'Enter'], ['Check or compile only', 'Shift+Enter']] },
  { title: 'Layout', items: [['Overview of everything', '↑'], ['Focus mode', '.'], ['Show or hide the sidebar', 'B'], ['Files', 'Shift+E'], ['Search', 'Shift+F'], ['Git', 'Shift+G'], ['Packages', 'Shift+U'], ['Servers', 'Shift+R'], ['Canvas', 'Shift+D'], ['Chat', 'Shift+A'], ['Terminal', 'J'], ['New terminal', 'Shift+`'], ['Fullscreen the focused island', 'Shift+M']] },
]

function Shortcuts() {
  return <>{shortcutGroups.map(group => <section key={group.title} className="settings-group">
    <h3>{group.title}</h3>
    {group.items.map(([label, keys]) => <div key={label} className="setting-row shortcut-row"><span className="setting-text"><span>{label}</span></span>
      <span className="flex gap-1">{keys.replace(/^!/, '').split(' / ').map(key => <kbd key={key}>{keys.startsWith('!') ? key : key === 'Click' ? mod + '+Click' : mod + '+' + key}</kbd>)}</span></div>)}
  </section>)}</>
}

function AiSettingsView() {
  const { settings, update } = useSettings()
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState('')
  const [models, setModels] = useState<string[] | null>(null)
  const [ollamaError, setOllamaError] = useState('')
  useEffect(() => { void keys.status().then(setHasKey).catch(() => setHasKey(false)) }, [])
  function loadModels() {
    setOllamaError('')
    void ollamaModels(settings.ollamaUrl).then(list => { setModels(list); if (!settings.ollamaModel && list[0]) update({ ollamaModel: list[0] }) })
      .catch(() => { setModels(null); setOllamaError("Couldn't reach Ollama at that address. Is it running? (ollama serve)") })
  }
  useEffect(() => { if (settings.aiProvider === 'ollama' || settings.aiCompleteProvider === 'ollama') loadModels() }, [settings.aiProvider, settings.aiCompleteProvider, settings.ollamaUrl])
  return <>
    <section className="settings-group">
      <h3>Assistant</h3>
      <div className="setting-row"><span className="setting-text"><span>Provider</span><small>Claude runs on Anthropic's servers with your API key. GitHub Models gives your GitHub account access to GPT, Llama, DeepSeek, Mistral and others. Ollama runs a model on this computer.</small></span>
        <Segmented label="Provider" value={settings.aiProvider} onChange={value => update({ aiProvider: value })} options={[{ value: 'anthropic', label: 'Claude' }, { value: 'github', label: 'GitHub' }, { value: 'ollama', label: 'Ollama' }]} /></div>
      <Toggle label="Apply the agent's file edits without asking" description="Off: every edit shows a diff to approve. Commands always ask first." checked={settings.aiAutoApprove} onChange={value => update({ aiAutoApprove: value })} />
    </section>
    {settings.aiProvider === 'anthropic' && <section className="settings-group">
      <h3>Claude</h3>
      <form className="form-grid" onSubmit={event => {
        event.preventDefault()
        void keys.set(draft).then(() => { setDraft(''); setHasKey(true); setMessage('Saved in the system keychain.') }).catch(error => setMessage(String(error)))
      }}>
        <label>Anthropic API key<input className="field" type="password" value={draft} onChange={event => setDraft(event.target.value)} placeholder={hasKey ? 'A key is saved. Paste a new one to replace it.' : 'sk-ant-…'} autoComplete="off" spellCheck={false} /></label>
        <div className="flex items-center gap-2">
          <button className="text-btn primary" type="submit" disabled={!draft.trim()}>Save key</button>
          {hasKey && <button className="text-btn" type="button" onClick={() => { void keys.set(null).then(() => { setHasKey(false); setMessage('Key removed.') }) }}>Remove key</button>}
          <span className="help">{message || (hasKey ? 'A key is saved.' : 'Create one at console.anthropic.com → API keys.')}</span>
        </div>
      </form>
      <div className="setting-row"><span className="setting-text"><span>Model</span><small>Opus is the most capable; Sonnet is faster; Haiku is quickest and cheapest.</small></span>
        <select className="field" style={{ width: 200 }} value={settings.aiModel} onChange={event => update({ aiModel: event.target.value })}>{claudeModels.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></div>
      <div className="setting-row"><span className="setting-text"><span>Effort</span><small>How long Claude thinks before answering. Higher is slower and uses more tokens.</small></span>
        <Segmented label="Effort" value={settings.aiEffort} onChange={value => update({ aiEffort: value })} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} /></div>
      <p className="help">Requests go straight from Still to Anthropic with your key and are billed to your account. The key is kept in your system's keychain, not in Still's settings file.</p>
    </section>}
    {settings.aiProvider === 'github' && <GithubSettings />}
    <InlineSuggestionSettings ollama={models} />
    {settings.aiProvider === 'ollama' && <section className="settings-group">
      <h3>Ollama</h3>
      <div className="form-grid">
        <label>Server address<input className="field" value={settings.ollamaUrl} onChange={event => update({ ollamaUrl: event.target.value })} spellCheck={false} /></label>
      </div>
      <div className="setting-row"><span className="setting-text"><span>Model</span><small>Pick a model that supports tools (for example qwen3, llama3.1 or mistral-nemo) for the agent.</small></span>
        {models?.length ? <select className="field" style={{ width: 200 }} value={settings.ollamaModel} onChange={event => update({ ollamaModel: event.target.value })}>{models.map(model => <option key={model}>{model}</option>)}</select>
          : <button className="text-btn" onClick={loadModels}>Look for models</button>}</div>
      {ollamaError && <p className="form-error">{ollamaError}</p>}
      {models && !models.length && <p className="help">Ollama is running but has no models. Run <code>ollama pull qwen3</code> in a terminal.</p>}
    </section>}
  </>
}

function GithubSettings() {
  const { settings, update } = useSettings()
  const [hasToken, setHasToken] = useState<boolean | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState('')
  const [models, setModels] = useState<GithubModel[]>(githubFallbackModels)
  const load = () => { void keys.get('github').then(token => token ? githubModels(token).then(list => { if (list.length) setModels(list) }) : undefined).catch(error => setMessage(String(error instanceof Error ? error.message : error))) }
  useEffect(() => { void keys.status('github').then(value => { setHasToken(value); if (value) load() }).catch(() => setHasToken(false)) }, [])
  return <section className="settings-group">
    <h3>GitHub Models</h3>
    <form className="form-grid" onSubmit={event => {
      event.preventDefault()
      void keys.set(draft, 'github').then(() => { setDraft(''); setHasToken(true); setMessage('Saved in the system keychain.'); load() }).catch(error => setMessage(String(error)))
    }}>
      <label>GitHub token<input className="field" type="password" value={draft} onChange={event => setDraft(event.target.value)} placeholder={hasToken ? 'A token is saved. Paste a new one to replace it.' : 'github_pat_…'} autoComplete="off" spellCheck={false} /></label>
      <div className="flex items-center gap-2">
        <button className="text-btn primary" type="submit" disabled={!draft.trim()}>Save token</button>
        {hasToken && <button className="text-btn" type="button" onClick={() => { void keys.set(null, 'github').then(() => { setHasToken(false); setMessage('Token removed.') }) }}>Remove token</button>}
        <span className="help">{message || (hasToken ? 'A token is saved.' : 'github.com → Settings → Developer settings → Fine-grained tokens, with the “Models: read” permission.')}</span>
      </div>
    </form>
    <div className="setting-row"><span className="setting-text"><span>Model</span><small>Models marked “tools” can act as the agent (edit files, run commands); others answer questions. Copilot plans get higher limits.</small></span>
      <select className="field" style={{ width: 240 }} value={settings.githubModel} onChange={event => update({ githubModel: event.target.value })}>
        {!models.some(model => model.id === settings.githubModel) && <option value={settings.githubModel}>{settings.githubModel}</option>}
        {models.map(model => <option key={model.id} value={model.id}>{model.name}{model.publisher ? ' · ' + model.publisher : ''}{model.tools ? ' · tools' : ''}</option>)}
      </select></div>
  </section>
}

function InlineSuggestionSettings({ ollama }: { ollama: string[] | null }) {
  const { settings, update } = useSettings()
  const provider = settings.aiCompleteProvider
  const choices = provider === 'anthropic' ? claudeModels.map(model => ({ id: model.id, label: model.label + (model.id.includes('haiku') ? ' (fastest)' : '') }))
    : provider === 'github' ? githubFallbackModels.map(model => ({ id: model.id, label: model.name + ' · ' + model.publisher }))
    : (ollama ?? []).map(name => ({ id: name, label: name }))
  return <section className="settings-group">
    <h3>Inline suggestions</h3>
    <Toggle label="Suggest code as you type (AI)" description="Grey text appears after the caret, from a whole line to a whole function. Tab accepts it, Esc dismisses it. Word suggestions work without this." checked={settings.aiComplete} onChange={value => update({ aiComplete: value })} />
    <div className="setting-row"><span className="setting-text"><span>Suggestions come from</span><small>Uses the key or token saved above. Ollama works offline; coding models such as qwen2.5-coder fill in the middle of code best.</small></span>
      <Segmented label="Suggestion provider" value={provider} onChange={value => update({ aiCompleteProvider: value, aiCompleteModel: value === 'anthropic' ? 'claude-opus-5-5' : value === 'github' ? 'openai/gpt-4.1-mini' : (ollama?.[0] ?? '') })}
        options={[{ value: 'anthropic', label: 'Claude' }, { value: 'github', label: 'GitHub' }, { value: 'ollama', label: 'Ollama' }]} /></div>
    <div className="setting-row"><span className="setting-text"><span>Suggestion model</span><small>Smaller models answer faster, which matters more here than in chat.</small></span>
      <select className="field" style={{ width: 240 }} value={settings.aiCompleteModel} onChange={event => update({ aiCompleteModel: event.target.value })}>
        {!choices.some(choice => choice.id === settings.aiCompleteModel) && <option value={settings.aiCompleteModel}>{settings.aiCompleteModel || 'Choose a model'}</option>}
        {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select></div>
  </section>
}

function UpdateCheck() {
  const { settings, update } = useSettings()
  const [state, setState] = useState<'idle' | 'checking' | 'current' | 'error'>('idle')
  return <div className="mt-3">
    <div className="flex items-center gap-3">
      <button className="text-btn" disabled={state === 'checking'} onClick={() => {
        setState('checking')
        void findUpdate().then(found => {
          if (found) { dispatchEvent(new CustomEvent('still-update', { detail: found })); setState('idle') }
          else setState('current')
        }).catch(() => setState('error'))
      }}>{state === 'checking' ? 'Checking…' : 'Check for updates'}</button>
      <span className="help">{state === 'current' ? 'You have the newest build.' : state === 'error' ? "Couldn't reach GitHub. The repository needs to be public for updates." : ''}</span>
    </div>
    <Toggle label="Check for updates automatically" description="Looks for a newer build when Still starts and every few hours. Updates install only when you choose Restart to update." checked={settings.autoUpdate} onChange={value => update({ autoUpdate: value })} />
  </div>
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
      {desktop && <UpdateCheck />}
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
