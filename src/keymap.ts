// Keyboard shortcuts you can change: a preset (Still's own keys, or familiar ones from VS Code or
// JetBrains IDEs) plus any keys you set yourself. These are checked before everything else, so a
// key set here wins over the built-in one.
export const keyActions: { id: string; label: string }[] = [
  { id: 'palette.files', label: 'Find a file' },
  { id: 'palette.commands', label: 'Run a command' },
  { id: 'palette.symbols', label: 'Go to symbol in project' },
  { id: 'save', label: 'Save' },
  { id: 'close', label: 'Close tab' },
  { id: 'next-tab', label: 'Next tab' },
  { id: 'prev-tab', label: 'Previous tab' },
  { id: 'split', label: 'Split editor right' },
  { id: 'run', label: 'Run the file' },
  { id: 'debug', label: 'Debug the file' },
  { id: 'tests', label: 'Run all tests' },
  { id: 'format', label: 'Format document' },
  { id: 'rename', label: 'Rename symbol' },
  { id: 'definition', label: 'Go to definition' },
  { id: 'references', label: 'Find all references' },
  { id: 'quickfix', label: 'Quick fix' },
  { id: 'refactor', label: 'Refactor…' },
  { id: 'extract-variable', label: 'Extract variable' },
  { id: 'extract-method', label: 'Extract method or function' },
  { id: 'goto-line', label: 'Go to line' },
  { id: 'comment', label: 'Toggle comment' },
  { id: 'terminal', label: 'Show or hide the terminal' },
  { id: 'side.files', label: 'Files' },
  { id: 'side.search', label: 'Search in files' },
  { id: 'side.git', label: 'Git' },
  { id: 'commit', label: 'Commit' },
  { id: 'push', label: 'Push' },
  { id: 'pull', label: 'Pull' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'minimap', label: 'Minimap' },
  { id: 'focus', label: 'Focus mode' },
  { id: 'overview', label: 'Overview' },
  { id: 'home', label: 'Go to Home' },
  { id: 'settings', label: 'Settings' },
]

export type KeyPreset = 'still' | 'vscode' | 'jetbrains'
export const keyPresets: Record<KeyPreset, { label: string; keys: Record<string, string> }> = {
  still: { label: 'Still', keys: {} },
  vscode: { label: 'VS Code', keys: {
    'palette.commands': 'Mod+Shift+P', 'palette.files': 'Mod+P', 'palette.symbols': 'Mod+T', 'goto-line': 'Mod+G', 'terminal': 'Mod+`',
    'side.files': 'Mod+Shift+E', 'side.search': 'Mod+Shift+F', 'side.git': 'Mod+Shift+G', 'run': 'Mod+F5', 'debug': 'F5', 'format': 'Shift+Alt+F',
    'rename': 'F2', 'definition': 'F12', 'references': 'Shift+F12', 'quickfix': 'Mod+.', 'refactor': 'Mod+Shift+R', 'split': 'Mod+\\', 'next-tab': 'Mod+PageDown', 'prev-tab': 'Mod+PageUp',
  } },
  jetbrains: { label: 'JetBrains', keys: {
    'palette.commands': 'Mod+Shift+A', 'palette.files': 'Mod+Shift+N', 'palette.symbols': 'Mod+Alt+Shift+N', 'goto-line': 'Mod+G', 'terminal': 'Alt+F12',
    'side.files': 'Alt+1', 'side.git': 'Alt+9', 'side.search': 'Mod+Shift+F', 'run': 'Shift+F10', 'debug': 'Shift+F9', 'tests': 'Mod+Shift+F10', 'format': 'Mod+Alt+L',
    'rename': 'Shift+F6', 'definition': 'Mod+B', 'references': 'Alt+F7', 'quickfix': 'Alt+Enter', 'refactor': 'Mod+Alt+Shift+T', 'extract-variable': 'Mod+Alt+V', 'extract-method': 'Mod+Alt+M', 'commit': 'Mod+K', 'push': 'Mod+Shift+K', 'pull': 'Mod+T',
    'next-tab': 'Alt+ArrowRight', 'prev-tab': 'Alt+ArrowLeft', 'close': 'Mod+F4', 'settings': 'Mod+Alt+S', 'comment': 'Mod+/',
  } },
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** A key press as text, e.g. "Mod+Shift+P" (Mod is Ctrl, or Cmd on a Mac). Null for a bare modifier. */
export function comboOf(event: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null
  const parts: string[] = []
  if (isMac ? event.metaKey : event.ctrlKey) parts.push('Mod')
  if (isMac && event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  // Letters and digits by their key position, so Shift and keyboard layouts don't change them.
  const code = event.code
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5)
    : code === 'Backquote' ? '`' : code === 'Backslash' ? '\\' : code === 'Slash' ? '/' : code === 'Period' ? '.' : code === 'Comma' ? ',' : code === 'Minus' ? '-' : code === 'Equal' ? '='
      : event.key.length === 1 ? event.key.toUpperCase() : event.key
  parts.push(key)
  return parts.join('+')
}

export function describeCombo(combo: string) {
  return combo.replace(/Mod/g, isMac ? '⌘' : 'Ctrl').replace(/Arrow(Up|Down|Left|Right)/g, (_m, side: string) => ({ Up: '↑', Down: '↓', Left: '←', Right: '→' } as Record<string, string>)[side])
}

/** The keys in effect: the preset's, then yours (an empty value turns a preset key off). */
export function bindings(preset: KeyPreset, custom: Record<string, string>) {
  const merged: Record<string, string> = { ...keyPresets[preset]?.keys }
  for (const [action, combo] of Object.entries(custom)) { if (combo) merged[action] = combo; else delete merged[action] }
  return merged
}
